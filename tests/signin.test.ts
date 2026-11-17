import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import worker, { type Env } from '../worker/index'
import { emptyDB, type DB, type Txn } from '../src/lib/types'
import { accounts, accountService, ACCOUNT_API, resetPassword } from './fake-account'
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  objects.clear()
  accounts.clear()
})

describe('a new account', () => {
  it('starts with this device’s budget, a keyring and a recovery key; a second device joins with the password', async () => {
    const a = await device(budget('A'))
    const step = await on(a, () => a.signin.signIn('Ana@Example.com ', 'first password', { create: true }))
    expect(step.kind).toBe('done')
    const recovery = (step as { recovery: string }).recovery
    expect(recovery).toMatch(/^([0-9A-Z]{4}-){6}[0-9A-Z]{2}$/)
    expect(a.sync.syncStatus()).toMatchObject({ email: 'ana@example.com', state: 'idle', dirty: false, pending: recovery, legacy: false })
    await on(a, () => a.signin.recoverySaved())
    expect(a.sync.syncStatus().pending).toBe(null)
    // The account holds only the wrapped key; the budget is in the vault, encrypted.
    const ring = keyring('ana@example.com')
    expect(Object.keys(ring).sort()).toEqual(['created', 'pw', 'rk', 'salt', 'v'])
    expect(countUnder('vaults/')).toBe(1)
    expect([...objects.values()].some((o) => o.data.includes('Living'))).toBe(false)

    const b = await device(budget('B'))
    let asked = 0
    const joined = await on(b, () => b.signin.signIn('ana@example.com', 'first password', { replace: () => (asked++, true) }))
    expect(joined).toEqual({ kind: 'done', recovery: undefined })
    expect(asked).toBe(1)
    expect(ids(b.S.getDB())).toEqual(['tA'])
    expect(b.sync.syncStatus().code).toBe(a.sync.syncStatus().code)

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

  it('an account made in another app (no keyring yet) gets this device’s budget', async () => {
    accounts.set('cb@example.com', { email: 'cb@example.com', password: 'brain password', sessions: new Set(), items: new Map(), seq: 0 })
    const a = await device(budget('A'))
    const step = await on(a, () => a.signin.signIn('cb@example.com', 'brain password'))
    expect(step.kind).toBe('done')
    expect((step as { recovery?: string }).recovery).toBeTruthy()
    expect(keyring('cb@example.com')).toBeTruthy()
  })
})

describe('a forgotten password', () => {
  it('after a reset, a new device asks for the recovery key, refuses a wrong one, then opens with the new password too', async () => {
    const a = await device(budget('A'))
    const made = await on(a, () => a.signin.signIn('ana@example.com', 'first password', { create: true }))
    const recovery = (made as { recovery: string }).recovery
    resetPassword('ana@example.com', 'second password')

    const c = await device()
    expect(await on(c, () => c.signin.signIn('ana@example.com', 'second password'))).toEqual({ kind: 'recovery' })
    expect((await on(c, () => c.signin.withRecoveryKey('not a key'))).kind).toBe('fail')
    const other = c.keys.formatRecoveryKey(c.keys.newRecoveryKey())
    expect(await on(c, () => c.signin.withRecoveryKey(other))).toEqual({ kind: 'fail', message: 'That recovery key doesn’t open this account' })
    expect(c.sync.syncStatus().email).toBe(null)
    // Typed by hand: lower case, spaces for dashes.
    const typed = recovery.toLowerCase().replace(/-/g, ' ')
    expect((await on(c, () => c.signin.withRecoveryKey(typed))).kind).toBe('done')
    expect(ids(c.S.getDB())).toEqual(['tA'])

    // The keyring opens with the new password now: the next device needs no recovery key.
    const d = await device()
    expect((await on(d, () => d.signin.signIn('ana@example.com', 'second password'))).kind).toBe('done')
    expect(ids(d.S.getDB())).toEqual(['tA'])
    // And the recovery key still works.
    expect(await c.keys.unlockWithRecovery(keyring('ana@example.com'), c.keys.parseRecoveryKey(recovery)!)).toBeTruthy()
  })

  it('a device that still holds the key keeps syncing, and its next sign-in wraps the key under the new password', async () => {
    const a = await device(budget('A'))
    await on(a, () => a.signin.signIn('ana@example.com', 'first password', { create: true }))
    const before = keyring('ana@example.com')
    resetPassword('ana@example.com', 'second password')
    // Still syncing with the key it holds, although its session ended.
    await on(a, async () => {
      a.S.commit({ txns: [txn('afterReset', 'cA')] })
      await a.sync.syncNow()
    })
    expect(a.sync.syncStatus()).toMatchObject({ state: 'idle', dirty: false })
    expect(await on(a, () => a.signin.signIn('ana@example.com', 'second password'))).toEqual({ kind: 'done', recovery: undefined })
    const after = keyring('ana@example.com')
    expect(after.created).toBe(before.created)
    expect(after.rk).toEqual(before.rk)
    expect(await a.keys.unlockWithPassword(after, 'second password')).toBeTruthy()

    const b = await device()
    expect((await on(b, () => b.signin.signIn('ana@example.com', 'second password'))).kind).toBe('done')
    expect(ids(b.S.getDB())).toEqual(['afterReset', 'tA'])
  })

  it('a new recovery key replaces the old one, signing in again when the session ended', async () => {
    const a = await device(budget('A'))
    const made = await on(a, () => a.signin.signIn('ana@example.com', 'first password', { create: true }))
    const old = a.keys.parseRecoveryKey((made as { recovery: string }).recovery)!
    const next = await on(a, () => a.signin.replaceRecoveryKey())
    expect(next.kind).toBe('done')
    const fresh = a.keys.parseRecoveryKey((next as { recovery: string }).recovery)!
    expect(await a.keys.unlockWithRecovery(keyring('ana@example.com'), old)).toBe(null)
    expect(await a.keys.unlockWithRecovery(keyring('ana@example.com'), fresh)).toBeTruthy()

    resetPassword('ana@example.com', 'second password')
    expect(await on(a, () => a.signin.replaceRecoveryKey())).toEqual({ kind: 'password' })
    expect((await on(a, () => a.signin.replaceRecoveryKey('wrong password'))).kind).toBe('fail')
    expect((await on(a, () => a.signin.replaceRecoveryKey('second password'))).kind).toBe('done')
    // Signing in there also renewed the password wrap.
    expect(await a.keys.unlockWithPassword(keyring('ana@example.com'), 'second password')).toBeTruthy()
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
    accounts.set('old@example.com', { email: 'old@example.com', password: 'brain password', sessions: new Set(), items: new Map(), seq: 0 })
    const tablet = await device()
    expect(await on(tablet, () => tablet.signin.signIn('old@example.com', 'old password'))).toEqual({ kind: 'account-password' })
    expect((await on(tablet, () => tablet.signin.withAccountPassword('still wrong'))).kind).toBe('fail')
    expect((await on(tablet, () => tablet.signin.withAccountPassword('brain password'))).kind).toBe('done')
    expect(ids(tablet.S.getDB())).toEqual(['tP'])
    expect(await tablet.keys.unlockWithPassword(keyring('old@example.com'), 'brain password')).toBeTruthy()
  })

  it('asks for the old password when the account’s password doesn’t open the old budget, or goes on without it', async () => {
    const phone = await device(budget('P'))
    await oldAccount(phone, 'old@example.com', 'old password')
    accounts.set('old@example.com', { email: 'old@example.com', password: 'brain password', sessions: new Set(), items: new Map(), seq: 0 })
    const tablet = await device()
    expect(await on(tablet, () => tablet.signin.signIn('old@example.com', 'brain password'))).toEqual({ kind: 'old-password' })
    expect((await on(tablet, () => tablet.signin.withOldPassword('not it either'))).kind).toBe('fail')
    expect((await on(tablet, () => tablet.signin.withOldPassword('old password'))).kind).toBe('done')
    expect(ids(tablet.S.getDB())).toEqual(['tP'])

    // Going on without it: this device's budget starts the account, the old one stays where it was.
    accounts.clear()
    objects.clear()
    await oldAccount(phone, 'old@example.com', 'old password')
    accounts.set('old@example.com', { email: 'old@example.com', password: 'brain password', sessions: new Set(), items: new Map(), seq: 0 })
    const other = await device(budget('O'))
    expect(await on(other, () => other.signin.signIn('old@example.com', 'brain password'))).toEqual({ kind: 'old-password' })
    expect((await on(other, () => other.signin.withOldPassword(null))).kind).toBe('done')
    expect(ids(other.S.getDB())).toEqual(['tO'])
    expect(countUnder('moved/')).toBe(0)
  })

  it('a device still signed in to the old account moves with the shared account’s password', async () => {
    const phone = await device(budget('P'))
    await oldAccount(phone, 'old@example.com', 'old password')
    accounts.set('old@example.com', { email: 'old@example.com', password: 'brain password', sessions: new Set(), items: new Map(), seq: 0 })
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
