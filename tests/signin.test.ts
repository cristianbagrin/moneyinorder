import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import worker, { type Env } from '../worker/index'
import * as AK from '../src/lib/account-keyring'
import { emptyDB, type DB, type Txn } from '../src/lib/types'
import { accounts, accountService, ACCOUNT_API, makeAccount, resetPassword } from './fake-account'
import { bucket, countUnder, objects } from './fake-r2'

// Sign-in with the shared account, the keyring and recovery key, and the move from the old accounts: devices
// (each its own copy of the app's modules and IndexedDB) against the real Worker over an in-memory R2 bucket and
// a stand-in for the account service. Real WebCrypto throughout.

vi.setConfig({ testTimeout: 60_000 })

const env = vi.hoisted(() => ({ kv: new Map<string, unknown>() }))
vi.mock('idb-keyval', () => ({
  get: async (k: string) => structuredClone(env.kv.get(k)),
  set: async (k: string, v: unknown) => void env.kv.set(k, structuredClone(v)),
  update: async (k: string, f: (v: unknown) => unknown) => void env.kv.set(k, structuredClone(f(structuredClone(env.kv.get(k))))),
}))

const ok = { limit: async () => ({ success: true }) }
const workerEnv: Env = { ASSETS: { fetch: async () => new Response('') }, DATA: bucket, VAULT_RATE_LIMITER: ok, ACCOUNT_RATE_LIMITER: ok }

type Device = {
  kv: Map<string, unknown>
  S: typeof import('../src/lib/store')
  sync: typeof import('../src/lib/sync')
  signin: typeof import('../src/lib/signin')
  keys: typeof import('../src/lib/keys')
}

async function device(db?: DB): Promise<Device> {
  vi.resetModules()
  const kv = new Map<string, unknown>()
  env.kv = kv
  const d = {
    kv,
    S: await import('../src/lib/store'),
    sync: await import('../src/lib/sync'),
    signin: await import('../src/lib/signin'),
    keys: await import('../src/lib/keys'),
  }
  ;(await import('../src/lib/account')).setAccountApi(ACCOUNT_API)
  if (db) d.S.replaceDB(db)
  return d
}

/** What a device keeps in IndexedDB. */
const get = async (d: Device, k: string) => structuredClone(d.kv.get(k)) as { key: string }

/** Run something as this device. */
async function on<T>(d: Device, fn: () => Promise<T> | T): Promise<T> {
  env.kv = d.kv
  vi.setSystemTime(Date.now() + 60_000)
  return fn()
}

function txn(id: string, cat: string): Txn {
  return { id, u: Date.now(), date: '2026-10-01', cat, amt: -100, cur: 'TWD', base: -100 }
}

function budget(tag: string): DB {
  const db = emptyDB()
  db.groups[`g${tag}`] = { id: `g${tag}`, u: 1, name: 'Every day', order: 0 }
  db.cats[`c${tag}`] = { id: `c${tag}`, u: 1, name: 'Living', group: `g${tag}`, order: 0 }
  db.txns[`t${tag}`] = { ...txn(`t${tag}`, `c${tag}`), u: 1 }
  return db
}

const ids = (db: DB) => Object.keys(db.txns).sort()
const keyring = (email: string) => {
  const item = accounts.get(email)?.items.get('@mio/keyring')
  return item?.v ? JSON.parse(item.v) : null
}
const accountRing = (email: string) => {
  const item = accounts.get(email)?.items.get('@account/keyring')
  return item?.v ? JSON.parse(item.v) : null
}
/** An item as an app that sends no precondition (the versions live before this one) writes it. */
function putItem(email: string, k: string, v: unknown) {
  const a = accounts.get(email)!
  a.items.set(k, { v: JSON.stringify(v), t: Date.now(), seq: ++a.seq })
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
  Object.assign(globalThis, {
    // Every device listens on the one window and document; these tests never fire their events.
    window: { addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' },
    BroadcastChannel: undefined,
  })
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (url.startsWith(ACCOUNT_API)) return accountService(url, init)
    return worker.fetch(new Request('http://local' + url, init), workerEnv)
  })
})

// Every device here is a fresh copy of the modules sharing one process, so a sync one test leaves scheduled
// would fire during the next test, with that test's device storage. Real devices never share like this.
const realSetTimeout = globalThis.setTimeout
const scheduled = new Set<ReturnType<typeof setTimeout>>()
globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => {
  const t = realSetTimeout(() => {
    scheduled.delete(t)
    fn(...a)
  }, ms)
  scheduled.add(t)
  return t
}) as typeof setTimeout
afterEach(() => {
  for (const t of scheduled) clearTimeout(t)
  scheduled.clear()
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  objects.clear()
  accounts.clear()
})

describe('a new account', () => {
  it('starts with this device’s budget, the account’s keyring and recovery key; a second device joins with the password', async () => {
    const a = await device(budget('A'))
    const step = await on(a, () => a.signin.signIn('Ana@Example.com ', 'first password', { create: true }))
    expect(step.kind).toBe('done')
    const recovery = (step as { recovery: string }).recovery
    expect(recovery).toMatch(/^([0-9A-Z]{4}-){6}[0-9A-Z]{2}$/)
    expect(a.sync.syncStatus()).toMatchObject({ email: 'ana@example.com', state: 'idle', dirty: false, pending: recovery, legacy: false, master: true })
    await on(a, () => a.signin.recoverySaved())
    expect(a.sync.syncStatus().pending).toBe(null)
    // The account holds only wrapped keys: the master key under the password and the recovery key, the budget's
    // key under the master key. The budget is in the vault, encrypted.
    const acct = accountRing('ana@example.com')
    expect(Object.keys(acct).sort()).toEqual(['created', 'id', 'pw', 'rk', 'rkid', 'salt', 'v'])
    expect(await AK.isCurrentRecovery(acct, recovery)).toBe(true)
    const ring = keyring('ana@example.com')
    expect(Object.keys(ring).sort()).toEqual(['created', 'mk', 'mkid', 'v'])
    expect(ring.mkid).toBe(acct.id)
    expect(countUnder('vaults/')).toBe(1)
    expect([...objects.values()].some((o) => o.data.includes('Living'))).toBe(false)

    const b = await device(budget('B'))
    let asked = 0
    const joined = await on(b, () => b.signin.signIn('ana@example.com', 'first password', { replace: () => (asked++, true) }))
    expect(joined).toEqual({ kind: 'done', recovery: undefined })
    expect(asked).toBe(1)
    expect(ids(b.S.getDB())).toEqual(['tA'])
    expect(b.sync.syncStatus().code).toBe(a.sync.syncStatus().code)
    expect(b.sync.syncStatus().master).toBe(true)

    // Edits travel both ways.
    await on(b, async () => {
      b.S.commit({ txns: [txn('fromB', 'cA')] })
      await b.sync.syncNow()
    })
    await on(a, () => a.sync.syncNow())
    expect(ids(a.S.getDB())).toEqual(['fromB', 'tA'])
  })

  it('creating an account for a taken email says so; a wrong password changes nothing', async () => {
    const a = await device(budget('A'))
    await on(a, () => a.signin.signIn('ana@example.com', 'first password', { create: true }))
    const b = await device(budget('B'))
    expect(await on(b, () => b.signin.signIn('ana@example.com', 'other password', { create: true }))).toEqual({ kind: 'exists' })
    expect((await on(b, () => b.signin.signIn('ana@example.com', 'wrong password'))).kind).toBe('fail')
    expect((await on(b, () => b.signin.signIn('nobody@example.com', 'first password'))).kind).toBe('fail')
    expect(await on(b, () => b.signin.signIn('ana@example.com', 'first password', { replace: () => false }))).toEqual({ kind: 'cancelled' })
    expect(ids(b.S.getDB())).toEqual(['tB'])
    expect(b.sync.syncStatus().email).toBe(null)
  })

  it('an account made in another app (no keys yet) gets this device’s budget and the account’s first recovery key', async () => {
    makeAccount('cb@example.com', 'brain password')
    const a = await device(budget('A'))
    const step = await on(a, () => a.signin.signIn('cb@example.com', 'brain password'))
    expect(step.kind).toBe('done')
    expect((step as { recovery?: string }).recovery).toBeTruthy()
    expect(keyring('cb@example.com').mkid).toBe(accountRing('cb@example.com').id)
  })

  it('an account whose keys another app made: the same master key, no new recovery key', async () => {
    makeAccount('tdw@example.com', 'the password')
    const other = await AK.createAccountRing('the password')
    putItem('tdw@example.com', '@account/keyring', other.ring)
    const a = await device(budget('A'))
    expect(await on(a, () => a.signin.signIn('tdw@example.com', 'the password'))).toEqual({ kind: 'done', recovery: undefined })
    expect(keyring('tdw@example.com').mkid).toBe(other.ring.id)
    expect(accountRing('tdw@example.com')).toEqual(other.ring)
    // That app's recovery key opens this budget too.
    resetPassword('tdw@example.com', 'new password')
    const b = await device()
    expect(await on(b, () => b.signin.signIn('tdw@example.com', 'new password'))).toEqual({ kind: 'recovery' })
    expect((await on(b, () => b.signin.withRecoveryKey(other.recovery))).kind).toBe('done')
    expect(ids(b.S.getDB())).toEqual(['tA'])
  })
})

describe('a forgotten password', () => {
  it('after a reset, a new device asks for the account’s recovery key, refuses a wrong one, then opens with the new password too', async () => {
    const a = await device(budget('A'))
    const made = await on(a, () => a.signin.signIn('ana@example.com', 'first password', { create: true }))
    const recovery = (made as { recovery: string }).recovery
    resetPassword('ana@example.com', 'second password')

    const c = await device()
    expect(await on(c, () => c.signin.signIn('ana@example.com', 'second password'))).toEqual({ kind: 'recovery' })
    expect((await on(c, () => c.signin.withRecoveryKey('not a key'))).kind).toBe('fail')
    const other = AK.formatRecovery(c.keys.newRecoveryKey())
    expect(await on(c, () => c.signin.withRecoveryKey(other))).toEqual({ kind: 'fail', message: 'That recovery key doesn’t open this account' })
    expect(c.sync.syncStatus().email).toBe(null)
    // Typed by hand: lower case, spaces for dashes.
    const typed = recovery.toLowerCase().replace(/-/g, ' ')
    expect((await on(c, () => c.signin.withRecoveryKey(typed))).kind).toBe('done')
    expect(ids(c.S.getDB())).toEqual(['tA'])

    // The account's keys open with the new password now: the next device needs no recovery key.
    const d = await device()
    expect((await on(d, () => d.signin.signIn('ana@example.com', 'second password'))).kind).toBe('done')
    expect(ids(d.S.getDB())).toEqual(['tA'])
    // And the recovery key still works.
    expect(await AK.openWithRecovery(accountRing('ana@example.com'), recovery)).toBeTruthy()
  })

  it('a device that still holds the keys keeps syncing, and its next sign-in wraps them under the new password', async () => {
    const a = await device(budget('A'))
    await on(a, () => a.signin.signIn('ana@example.com', 'first password', { create: true }))
    await on(a, () => a.signin.recoverySaved())
    const before = accountRing('ana@example.com')
    resetPassword('ana@example.com', 'second password')
    // Still syncing with the key it holds, although its session ended.
    await on(a, async () => {
      a.S.commit({ txns: [txn('afterReset', 'cA')] })
      await a.sync.syncNow()
    })
    expect(a.sync.syncStatus()).toMatchObject({ state: 'idle', dirty: false })
    expect(await on(a, () => a.signin.signIn('ana@example.com', 'second password'))).toEqual({ kind: 'done', recovery: undefined })
    const after = accountRing('ana@example.com')
    expect(after.id).toBe(before.id)
    expect(after.rk).toEqual(before.rk)
    expect(await AK.openWithPassword(after, 'second password')).toBeTruthy()

    const b = await device()
    expect((await on(b, () => b.signin.signIn('ana@example.com', 'second password'))).kind).toBe('done')
    expect(ids(b.S.getDB())).toEqual(['afterReset', 'tA'])
  })

  it('a new recovery key replaces the account’s, signing in again when the session ended', async () => {
    const a = await device(budget('A'))
    const made = await on(a, () => a.signin.signIn('ana@example.com', 'first password', { create: true }))
    const old = (made as { recovery: string }).recovery
    const next = await on(a, () => a.signin.replaceRecoveryKey())
    expect(next.kind).toBe('done')
    const fresh = (next as { recovery: string }).recovery
    expect(a.sync.syncStatus().pending).toBe(fresh)
    expect(await AK.openWithRecovery(accountRing('ana@example.com'), old)).toBe(null)
    expect(await AK.openWithRecovery(accountRing('ana@example.com'), fresh)).toBeTruthy()

    resetPassword('ana@example.com', 'second password')
    expect(await on(a, () => a.signin.replaceRecoveryKey())).toEqual({ kind: 'password' })
    expect((await on(a, () => a.signin.replaceRecoveryKey('wrong password'))).kind).toBe('fail')
    expect((await on(a, () => a.signin.replaceRecoveryKey('second password'))).kind).toBe('done')
    // Signing in there also renewed the password wrap (with the master key this device holds).
    expect(await AK.openWithPassword(accountRing('ana@example.com'), 'second password')).toBeTruthy()
  })
})

describe('moving from the old accounts', () => {
  /** An old Money in Order account, as the app made them: the budget under the password's secret, the email noted. */
  async function oldAccount(d: Device, email: string, password: string) {
    await on(d, async () => {
      const secret = await d.sync.legacySecret(email, password)
      await fetch(await d.sync.legacyEmailUrl(email), { method: 'PUT' })
      await d.sync.enableSync(secret, email)
    })
  }

  it('moves the whole budget, verified, with every device’s unsent edits, and retires the old vault', async () => {
    // The phone and the laptop sync an old account.
    const phone = await device(budget('P'))
    await oldAccount(phone, 'old@example.com', 'old password')
    const laptop = await device()
    await on(laptop, async () => {
      const secret = await laptop.sync.legacySecret('old@example.com', 'old password')
      await laptop.sync.join(secret, 'old@example.com')
    })
    expect(ids(laptop.S.getDB())).toEqual(['tP'])
    const oldVault = [...objects.keys()].find((k) => k.startsWith('vaults/'))!
    // Both log something the other hasn't got; the phone's edit isn't uploaded yet.
    await on(laptop, async () => {
      laptop.S.commit({ txns: [txn('laptopEdit', 'cP')] })
      await laptop.sync.syncNow()
    })
    await on(phone, () => phone.S.commit({ txns: [txn('phoneUnsent', 'cP')] }))
    expect(phone.sync.syncStatus()).toMatchObject({ legacy: true, dirty: true })

    // The phone signs in with the new version: the same email and password.
    const step = await on(phone, () => phone.signin.signIn('old@example.com', 'old password'))
    expect(step.kind).toBe('done')
    expect((step as { recovery?: string }).recovery).toBeTruthy()
    expect(phone.sync.syncStatus()).toMatchObject({ legacy: false, dirty: false, state: 'idle' })
    expect(ids(phone.S.getDB())).toEqual(['laptopEdit', 'phoneUnsent', 'tP'])
    // A shared account was made with the same password, and the old vault is still there, retired.
    expect(accounts.get('old@example.com')?.password).toBe('old password')
    expect(objects.has(oldVault)).toBe(true)
    expect(countUnder('moved/')).toBe(1)
    expect(countUnder('vaults/')).toBe(2)

    // The laptop, still on the old account, logs something and syncs: it follows the move with its edit.
    await on(laptop, async () => {
      laptop.S.commit({ txns: [txn('laptopLate', 'cP')] })
      await laptop.sync.syncNow()
    })
    expect(laptop.sync.syncStatus()).toMatchObject({ legacy: false, code: phone.sync.syncStatus().code, dirty: false })
    await on(phone, () => phone.sync.syncNow())
    expect(ids(phone.S.getDB())).toEqual(['laptopEdit', 'laptopLate', 'phoneUnsent', 'tP'])

    // A new device signs in with the password and gets all of it.
    const tablet = await device()
    expect((await on(tablet, () => tablet.signin.signIn('old@example.com', 'old password'))).kind).toBe('done')
    expect(ids(tablet.S.getDB())).toEqual(['laptopEdit', 'laptopLate', 'phoneUnsent', 'tP'])
  })

  it('a device that never synced the old account takes its budget in place of its own', async () => {
    const phone = await device(budget('P'))
    await oldAccount(phone, 'old@example.com', 'old password')
    const fresh = await device(budget('F'))
    let asked = 0
    const step = await on(fresh, () => fresh.signin.signIn('old@example.com', 'old password', { replace: () => (asked++, true) }))
    expect(step.kind).toBe('done')
    expect(asked).toBe(1)
    expect(ids(fresh.S.getDB())).toEqual(['tP'])
  })

  it('asks for the account’s own password when it differs from the old one', async () => {
    const phone = await device(budget('P'))
    await oldAccount(phone, 'old@example.com', 'old password')
    makeAccount('old@example.com', 'brain password')
    const tablet = await device()
    expect(await on(tablet, () => tablet.signin.signIn('old@example.com', 'old password'))).toEqual({ kind: 'account-password' })
    expect((await on(tablet, () => tablet.signin.withAccountPassword('still wrong'))).kind).toBe('fail')
    expect((await on(tablet, () => tablet.signin.withAccountPassword('brain password'))).kind).toBe('done')
    expect(ids(tablet.S.getDB())).toEqual(['tP'])
    expect(await AK.openWithPassword(accountRing('old@example.com'), 'brain password')).toBeTruthy()
    expect(keyring('old@example.com').v).toBe(2)
  })

  it('asks for the old password when the account’s password doesn’t open the old budget, or goes on without it', async () => {
    const phone = await device(budget('P'))
    await oldAccount(phone, 'old@example.com', 'old password')
    makeAccount('old@example.com', 'brain password')
    const tablet = await device()
    expect(await on(tablet, () => tablet.signin.signIn('old@example.com', 'brain password'))).toEqual({ kind: 'old-password' })
    expect((await on(tablet, () => tablet.signin.withOldPassword('not it either'))).kind).toBe('fail')
    expect((await on(tablet, () => tablet.signin.withOldPassword('old password'))).kind).toBe('done')
    expect(ids(tablet.S.getDB())).toEqual(['tP'])

    // Going on without it: this device's budget starts the account, the old one stays where it was.
    accounts.clear()
    objects.clear()
    await oldAccount(phone, 'old@example.com', 'old password')
    makeAccount('old@example.com', 'brain password')
    const other = await device(budget('O'))
    expect(await on(other, () => other.signin.signIn('old@example.com', 'brain password'))).toEqual({ kind: 'old-password' })
    expect((await on(other, () => other.signin.withOldPassword(null))).kind).toBe('done')
    expect(ids(other.S.getDB())).toEqual(['tO'])
    expect(countUnder('moved/')).toBe(0)
  })

  it('a device still signed in to the old account moves with the shared account’s password', async () => {
    const phone = await device(budget('P'))
    await oldAccount(phone, 'old@example.com', 'old password')
    makeAccount('old@example.com', 'brain password')
    expect((await on(phone, () => phone.signin.signIn('old@example.com', 'brain password'))).kind).toBe('done')
    expect(phone.sync.syncStatus().legacy).toBe(false)
    expect(ids(phone.S.getDB())).toEqual(['tP'])
  })

  it('a move interrupted after the old vault was retired finishes on the next sign-in', async () => {
    const phone = await device(budget('P'))
    await oldAccount(phone, 'old@example.com', 'old password')
    // The keyring write fails once: the account service is unreachable just then.
    const real = globalThis.fetch
    let cut = true
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (cut && url.endsWith('/sync') && String(init?.body).includes('@mio/keyring')) {
        cut = false
        throw new TypeError('Failed to fetch')
      }
      return real(url, init)
    })
    try {
      expect((await on(phone, () => phone.signin.signIn('old@example.com', 'old password'))).kind).toBe('fail')
    } finally {
      vi.stubGlobal('fetch', real)
    }
    expect(countUnder('moved/')).toBe(1)
    expect(keyring('old@example.com')).toBe(null)
    // Still syncing (it follows the move on its own), and the next sign-in makes the keyring.
    await on(phone, () => phone.sync.syncNow())
    expect(phone.sync.syncStatus().legacy).toBe(false)
    const step = await on(phone, () => phone.signin.signIn('old@example.com', 'old password'))
    expect(step.kind).toBe('done')
    const tablet = await device()
    expect((await on(tablet, () => tablet.signin.signIn('old@example.com', 'old password'))).kind).toBe('done')
    expect(ids(tablet.S.getDB())).toEqual(['tP'])
  })

  it('sync-code devices from before accounts keep syncing', async () => {
    const a = await device(budget('A'))
    const b = await device()
    await on(a, () => a.sync.enableSync('ABCDE-FGHJK-MNPQR-STUVW'))
    await on(b, () => b.sync.enableSync('ABCDE-FGHJK-MNPQR-STUVW'))
    expect(ids(b.S.getDB())).toEqual(['tA'])
    expect(b.sync.syncStatus().legacy).toBe(false)
  })
})

describe('one recovery key for the whole account (keyrings from before it)', () => {
  /**
   * An account as the previous version left it: this budget's keyring under the password and Money in Order's own
   * recovery key, its vault, and a device syncing it with the data key (no master key).
   */
  async function before(email: string, password: string, db = budget('A')) {
    makeAccount(email, password)
    const d = await device(db)
    const dk = d.keys.newDataKey()
    const rk = d.keys.newRecoveryKey()
    const ring = await d.keys.makeKeyring(dk, password, rk)
    putItem(email, '@mio/keyring', ring)
    const login = await (await accountService(`${ACCOUNT_API}/login`, { method: 'POST', body: JSON.stringify({ email, password }) })).json()
    await on(d, () => d.sync.enableSync(d.keys.codeOf(dk), email, { token: login.token, ring: ring.created }))
    expect(d.sync.syncStatus()).toMatchObject({ state: 'idle', master: false })
    return { d, dk, ring, appKey: d.keys.formatRecoveryKey(rk) }
  }

  it('Money in Order first: the account’s keys are made, the budget’s key moves under them, the same data', async () => {
    const { d, dk, ring, appKey } = await before('ana@example.com', 'the password')
    await on(d, async () => {
      d.S.commit({ txns: [txn('unsent', 'cA')] })
    })
    const step = await on(d, () => d.signin.switchToAccountKeys('the password'))
    expect(step.kind).toBe('done')
    const recovery = (step as { recovery: string }).recovery
    expect(await AK.isCurrentRecovery(accountRing('ana@example.com'), recovery)).toBe(true)
    expect(d.sync.syncStatus()).toMatchObject({ master: true, pending: recovery })
    // Same data key, same budget, same vault: nothing re-encrypted.
    const moved = keyring('ana@example.com')
    expect(moved).toMatchObject({ v: 2, created: ring.created, mkid: accountRing('ana@example.com').id })
    expect(Object.keys(moved).sort()).toEqual(['created', 'mk', 'mkid', 'v'])
    expect(d.sync.syncStatus().code).toBe(d.keys.codeOf(dk))
    await on(d, () => d.sync.syncNow())
    expect(countUnder('vaults/')).toBe(1)
    // Money in Order's own recovery key opens nothing now; the account's does.
    expect(await d.keys.unlockWithRecovery(moved, d.keys.parseRecoveryKey(appKey)!)).toBe(null)
    resetPassword('ana@example.com', 'new password')
    const b = await device()
    expect(await on(b, () => b.signin.signIn('ana@example.com', 'new password'))).toEqual({ kind: 'recovery' })
    expect(await on(b, () => b.signin.withRecoveryKey(appKey))).toEqual({ kind: 'fail', message: 'That recovery key doesn’t open this account' })
    expect((await on(b, () => b.signin.withRecoveryKey(recovery))).kind).toBe('done')
    expect(ids(b.S.getDB())).toEqual(['tA', 'unsent'])
  })

  it('a sign-in on a new device moves it too; the recovery key is shown until saved, on the device that made it', async () => {
    const { d } = await before('ana@example.com', 'the password')
    const b = await device()
    const step = await on(b, () => b.signin.signIn('ana@example.com', 'the password'))
    const recovery = (step as { recovery: string }).recovery
    expect(recovery).toBeTruthy()
    expect(ids(b.S.getDB())).toEqual(['tA'])
    // Not saved yet: signing in again on that device shows the same key, as long as it is the account's.
    expect(await on(b, () => b.signin.signIn('ana@example.com', 'the password'))).toEqual({ kind: 'done', recovery })
    await on(b, () => b.signin.recoverySaved())
    expect(await on(b, () => b.signin.signIn('ana@example.com', 'the password'))).toEqual({ kind: 'done', recovery: undefined })
    // The old device keeps syncing with its data key, and gets the master key with the password.
    await on(d, async () => {
      d.S.commit({ txns: [txn('oldDevice', 'cA')] })
      await d.sync.syncNow()
    })
    expect(await on(d, () => d.signin.switchToAccountKeys('the password'))).toEqual({ kind: 'done', recovery: undefined })
    expect(d.sync.syncStatus().master).toBe(true)
    await on(b, () => b.sync.syncNow())
    expect(ids(b.S.getDB())).toEqual(['oldDevice', 'tA'])
  })

  it('another app moved first: no new recovery key, the budget’s key goes under the account’s', async () => {
    const { d, dk } = await before('ana@example.com', 'the password')
    const other = await AK.createAccountRing('the password')
    putItem('ana@example.com', '@account/keyring', other.ring)
    const b = await device()
    expect(await on(b, () => b.signin.signIn('ana@example.com', 'the password'))).toEqual({ kind: 'done', recovery: undefined, covered: true })
    expect(keyring('ana@example.com').mkid).toBe(other.ring.id)
    expect(await d.keys.openMasterWrap(other.mk, keyring('ana@example.com').mk)).toEqual(dk)
    expect(accountRing('ana@example.com')).toEqual(other.ring)
  })

  it('a move cut off between its writes finishes on the next sign-in, and the old wraps go only after the new one reads back', async () => {
    const { d, ring } = await before('ana@example.com', 'the password')
    const real = globalThis.fetch
    const writes: unknown[] = []
    // The second write of this app's keyring (the one that drops the old wraps) never arrives.
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      if (url.endsWith('/sync') && body.includes('"@mio/keyring"') && body.includes('"if"')) {
        writes.push(JSON.parse(body).changes[0].v)
        if (writes.length === 2) throw new TypeError('Failed to fetch')
      }
      return real(url, init)
    })
    let first
    try {
      first = await on(d, () => d.signin.switchToAccountKeys('the password'))
    } finally {
      vi.stubGlobal('fetch', real)
    }
    expect(first.kind).toBe('fail')
    // Halfway: the master key's wrap is there, next to the old ones, which still work.
    const half = keyring('ana@example.com')
    expect(half).toMatchObject({ v: 1, pw: ring.pw, rk: ring.rk, mkid: accountRing('ana@example.com').id })
    expect(await d.keys.unlockWithPassword(half, 'the password')).toBeTruthy()
    const recovery = (await get(d, 'mio-recovery-draft')).key
    // Still syncing meanwhile, and a new device signs in.
    await on(d, () => d.sync.syncNow())
    expect(d.sync.syncStatus().state).toBe('idle')
    const b = await device()
    expect(await on(b, () => b.signin.signIn('ana@example.com', 'the password'))).toEqual({ kind: 'done', recovery: undefined, covered: true })
    expect(keyring('ana@example.com')).toMatchObject({ v: 2, created: ring.created })
    expect(keyring('ana@example.com').pw).toBeUndefined()
    // The device that made the key still has it to show.
    expect(await on(d, () => d.signin.switchToAccountKeys('the password'))).toEqual({ kind: 'done', recovery })
  })

  it('cut off right after the account’s keys were written: the same recovery key comes back, nothing is made twice', async () => {
    const { d } = await before('ana@example.com', 'the password')
    const real = globalThis.fetch
    let cut = true
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const res = await real(url, init)
      if (cut && String(init?.body ?? '').includes('"@account/keyring"') && String(init?.body).includes('"if"')) {
        cut = false
        throw new TypeError('Failed to fetch') // written, but the answer never came
      }
      return res
    })
    try {
      expect((await on(d, () => d.signin.switchToAccountKeys('the password'))).kind).toBe('fail')
    } finally {
      vi.stubGlobal('fetch', real)
    }
    const id = accountRing('ana@example.com').id
    const step = await on(d, () => d.signin.switchToAccountKeys('the password'))
    expect(step.kind).toBe('done')
    expect(accountRing('ana@example.com').id).toBe(id)
    expect(await AK.isCurrentRecovery(accountRing('ana@example.com'), (step as { recovery: string }).recovery)).toBe(true)
  })

  it('two devices moving at once: one master key, one recovery key that works, both on the same budget', async () => {
    const { d } = await before('ana@example.com', 'the password')
    const b = await device()
    const real = globalThis.fetch
    let raced = false
    let bStep: unknown
    // Just as d writes the account's keyring, b signs in and moves everything first.
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (!raced && env.kv === d.kv && String(init?.body ?? '').includes('"@account/keyring"') && String(init?.body).includes('"if"')) {
        raced = true
        bStep = await on(b, () => b.signin.signIn('ana@example.com', 'the password'))
        env.kv = d.kv
      }
      return real(url, init)
    })
    let dStep
    try {
      dStep = await on(d, () => d.signin.switchToAccountKeys('the password'))
    } finally {
      vi.stubGlobal('fetch', real)
    }
    expect(raced).toBe(true)
    const recovery = (bStep as { recovery: string }).recovery
    expect(recovery).toBeTruthy()
    // d lost the race: it uses b's keys and shows no key of its own (the one it made never reached the account).
    expect(dStep).toEqual({ kind: 'done', recovery: undefined })
    expect(await AK.isCurrentRecovery(accountRing('ana@example.com'), recovery)).toBe(true)
    expect(d.sync.syncStatus().code).toBe(b.sync.syncStatus().code)
    expect(d.sync.syncStatus().master).toBe(true)
    expect(keyring('ana@example.com').v).toBe(2)
  })

  it('reset before the move, the account’s keys made elsewhere after it: asks for Money in Order’s old key once', async () => {
    const { d, appKey } = await before('ana@example.com', 'old password')
    resetPassword('ana@example.com', 'new password')
    const other = await AK.createAccountRing('new password')
    putItem('ana@example.com', '@account/keyring', other.ring)
    const b = await device()
    expect(await on(b, () => b.signin.signIn('ana@example.com', 'new password'))).toEqual({ kind: 'recovery', old: true })
    expect(await on(b, () => b.signin.withRecoveryKey(other.recovery))).toEqual({ kind: 'fail', message: 'That recovery key doesn’t open this account' })
    expect(await on(b, () => b.signin.withRecoveryKey(appKey))).toEqual({ kind: 'done', recovery: undefined, covered: true })
    expect(ids(b.S.getDB())).toEqual(['tA'])
    // A device holding the data key needs neither.
    expect((await on(d, () => d.signin.switchToAccountKeys('new password'))).kind).toBe('done')
  })

  it('an app that sends no precondition (the version live today) can’t write over the moved keyring', async () => {
    const { d } = await before('ana@example.com', 'the password')
    await on(d, () => d.signin.switchToAccountKeys('the password'))
    const moved = keyring('ana@example.com')
    const login = await (await accountService(`${ACCOUNT_API}/login`, { method: 'POST', body: JSON.stringify({ email: 'ana@example.com', password: 'the password' }) })).json()
    const fresh = await d.keys.makeKeyring(d.keys.newDataKey(), 'the password', d.keys.newRecoveryKey())
    const res = await (await accountService(`${ACCOUNT_API}/sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${login.token}` },
      body: JSON.stringify({ app: 'mio', since: 0, changes: [{ k: '@mio/keyring', v: fresh, t: Date.now() + 10_000 }] }),
    })).json()
    expect(res.rejected).toEqual(['@mio/keyring'])
    expect(keyring('ana@example.com')).toEqual(moved)
  })

  it('the account started over elsewhere: a device holding the data key puts it under the new master key', async () => {
    const { d, dk } = await before('ana@example.com', 'the password')
    await on(d, () => d.signin.switchToAccountKeys('the password'))
    const other = await AK.createAccountRing('the password')
    const a = accounts.get('ana@example.com')!
    a.items.set('@account/keyring', { v: JSON.stringify(other.ring), t: Date.now(), seq: ++a.seq })
    expect((await on(d, () => d.signin.signIn('ana@example.com', 'the password'))).kind).toBe('done')
    expect(keyring('ana@example.com').mkid).toBe(other.ring.id)
    expect(await d.keys.openMasterWrap(other.mk, keyring('ana@example.com').mk)).toEqual(dk)
  })
})
