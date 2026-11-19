/// <reference types="node" />
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as AK from '../../src/lib/account-keyring'
import { COLLECTIONS, type DB } from '../../src/lib/types'
import { bigDB } from '../fixtures/big'

// End to end, against real servers: this app's Worker (`npm run serve`, local R2) and the shared account Worker
// (chinesebrain `site/`, `npx wrangler dev`, local Durable Objects), with real WebCrypto. Skipped unless both are named:
//
//   E2E_APP=http://localhost:4174 E2E_ACCOUNT=http://localhost:8791/api E2E_MAIL_PORT=8792 npx vitest run tests/e2e
//
// The account Worker must send its emails to E2E_MAIL_PORT, where this test reads the password-reset link:
//   npx wrangler dev --port 8791 --var MAIL_API:http://127.0.0.1:8792/emails --var RESEND_API_KEY:test

const APP = process.env.E2E_APP
const ACCOUNT = process.env.E2E_ACCOUNT
const MAIL_PORT = Number(process.env.E2E_MAIL_PORT ?? 0)

vi.setConfig({ testTimeout: 180_000 })

const env = vi.hoisted(() => ({ kv: new Map<string, unknown>() }))
vi.mock('idb-keyval', () => ({
  get: async (k: string) => structuredClone(env.kv.get(k)),
  set: async (k: string, v: unknown) => void env.kv.set(k, structuredClone(v)),
  update: async (k: string, f: (v: unknown) => unknown) => void env.kv.set(k, structuredClone(f(structuredClone(env.kv.get(k))))),
}))

type Device = {
  kv: Map<string, unknown>
  S: typeof import('../../src/lib/store')
  sync: typeof import('../../src/lib/sync')
  signin: typeof import('../../src/lib/signin')
  keys: typeof import('../../src/lib/keys')
  account: typeof import('../../src/lib/account')
}

async function device(db?: DB): Promise<Device> {
  vi.resetModules()
  const kv = new Map<string, unknown>()
  env.kv = kv
  const d = {
    kv,
    S: await import('../../src/lib/store'),
    sync: await import('../../src/lib/sync'),
    signin: await import('../../src/lib/signin'),
    keys: await import('../../src/lib/keys'),
    account: await import('../../src/lib/account'),
  }
  d.account.setAccountApi(ACCOUNT!)
  if (db) d.S.replaceDB(db)
  return d
}

async function on<T>(d: Device, fn: () => Promise<T> | T): Promise<T> {
  env.kv = d.kv
  return fn()
}

/** Every record, in a stable order: two budgets with the same records give the same text. */
function records(db: DB): string {
  return JSON.stringify(COLLECTIONS.map((c) => Object.values(db[c]).sort((a, b) => (a.id < b.id ? -1 : 1))))
}
const count = (db: DB) => COLLECTIONS.reduce((n, c) => n + Object.keys(db[c]).length, 0)

const mails: { to: string[]; text: string }[] = []
let mailServer: Server | null = null
const run = `${Date.now().toString(36)}`
const email = (who: string) => `${who}-${run}@e2e.example.com`

async function keyringOf(token: string, d: Device) {
  const r = await d.account.readKeyring(token)
  if (!r.ok) throw new Error(r.message)
  return r.ring
}

async function accountRingOf(token: string, d: Device) {
  const r = await d.account.readAccountRing(token)
  if (!r.ok) throw new Error(r.message)
  return r.ring
}

describe.skipIf(!APP || !ACCOUNT)('end to end, both Workers running locally', () => {
  beforeAll(async () => {
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
    Object.assign(globalThis, {
      window: { addEventListener() {}, removeEventListener() {} },
      document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' },
      BroadcastChannel: undefined,
    })
    const real = globalThis.fetch
    // The app's own relative URLs go to its Worker.
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => real(url.startsWith('/') ? APP + url : url, init))
    if (MAIL_PORT) {
      mailServer = createServer((req, res) => {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          mails.push(JSON.parse(body))
          res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"id":"x"}')
        })
      })
      await new Promise<void>((r) => mailServer!.listen(MAIL_PORT, '127.0.0.1', r))
    }
  })
  afterAll(() => mailServer?.close())

  it('new account, then a second device', async () => {
    const who = email('new')
    const a = await device(bigDB({ from: '2025-01', months: 6, seed: 3 }))
    const made = await on(a, () => a.signin.signIn(who, 'first password', { create: true }))
    expect(made.kind).toBe('done')
    expect((made as { recovery: string }).recovery).toMatch(/^([0-9A-Z]{4}-){6}[0-9A-Z]{2}$/)
    expect(a.sync.syncStatus()).toMatchObject({ state: 'idle', dirty: false, legacy: false })
    const ring = await keyringOf(a.sync.syncConfig()!.token!, a)
    expect(ring && Object.keys(ring).sort()).toEqual(['created', 'mk', 'mkid', 'v'])
    expect((await accountRingOf(a.sync.syncConfig()!.token!, a))?.id).toBe(ring && 'mkid' in ring ? ring.mkid : null)

    const b = await device()
    expect((await on(b, () => b.signin.signIn(who, 'first password'))).kind).toBe('done')
    expect(records(b.S.getDB())).toBe(records(a.S.getDB()))
    await on(b, async () => {
      b.S.commit({ txns: [{ id: 'e2eB', u: Date.now(), date: '2025-06-01', cat: 'rta', amt: 1, cur: 'TWD', base: 1 }] })
      await b.sync.syncNow()
    })
    await on(a, () => a.sync.syncNow())
    expect(a.S.getDB().txns.e2eB).toBeTruthy()
  })

  it('a creation for a taken email, a wrong password and a wrong recovery key are refused', async () => {
    const who = email('wrong')
    const a = await device()
    expect((await on(a, () => a.signin.signIn(who, 'first password', { create: true }))).kind).toBe('done')
    const b = await device()
    expect(await on(b, () => b.signin.signIn(who, 'other password', { create: true }))).toEqual({ kind: 'exists' })
    expect(await on(b, () => b.signin.signIn(who, 'not the password'))).toEqual({ kind: 'fail', message: 'That email and password don’t match' })
    expect(b.sync.syncStatus().email).toBe(null)
  })

  it.skipIf(!MAIL_PORT)('password reset by email → recovery key unlock → re-wrap; a device holding the key re-wraps on its own', async () => {
    const who = email('reset')
    const a = await device(bigDB({ from: '2025-03', months: 3, seed: 5 }))
    const made = await on(a, () => a.signin.signIn(who, 'first password', { create: true }))
    const recovery = (made as { recovery: string }).recovery

    // Forgot password: the real reset flow of the account service.
    const forgot = await fetch(`${ACCOUNT}/forgot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: who, app: 'mio' }) })
    expect(forgot.status).toBe(200)
    const mail = mails.find((m) => m.to.includes(who))!
    const token = mail.text.match(/\/reset#([^\s]+)/)![1]
    const reset = await fetch(`${ACCOUNT}/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password: 'second password' }) })
    expect(reset.status).toBe(200)

    // A still signs out of the account (the reset ended every session) but keeps syncing with the key it holds.
    await on(a, async () => {
      a.S.commit({ txns: [{ id: 'afterReset', u: Date.now(), date: '2025-05-02', cat: 'rta', amt: 1, cur: 'TWD', base: 1 }] })
      await a.sync.syncNow()
    })
    expect(a.sync.syncStatus()).toMatchObject({ state: 'idle', dirty: false })
    expect(await on(a, () => a.signin.replaceRecoveryKey())).toEqual({ kind: 'password' })
    await on(a, () => a.signin.recoverySaved())

    // A new device: the new password signs in, but doesn't open the keyring.
    const c = await device()
    expect(await on(c, () => c.signin.signIn(who, 'second password'))).toEqual({ kind: 'recovery' })
    const other = AK.formatRecovery(c.keys.newRecoveryKey())
    expect(await on(c, () => c.signin.withRecoveryKey(other))).toEqual({ kind: 'fail', message: 'That recovery key doesn’t open this account' })
    expect((await on(c, () => c.signin.withRecoveryKey(recovery.toLowerCase()))).kind).toBe('done')
    expect(c.S.getDB().txns.afterReset).toBeTruthy()
    expect(records(c.S.getDB())).toBe(records(a.S.getDB()))

    // Re-wrapped: the next device needs only the new password.
    const d = await device()
    expect((await on(d, () => d.signin.signIn(who, 'second password'))).kind).toBe('done')

    // Device-held key: change the password on the account page this time, then sign A in again.
    const login = await d.account.login(who, 'second password')
    if (!login.ok) throw new Error(login.message)
    const changed = await fetch(`${ACCOUNT}/password`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` }, body: JSON.stringify({ old: 'second password', next: 'third password' }) })
    expect(changed.status).toBe(200)
    const before = await accountRingOf(login.token, d)
    expect(await on(a, () => a.signin.signIn(who, 'third password'))).toEqual({ kind: 'done', recovery: undefined })
    const after = await accountRingOf(a.sync.syncConfig()!.token!, a)
    expect(after!.id).toBe(before!.id)
    expect(after!.rk).toEqual(before!.rk)
    expect(await AK.openWithPassword(after!, 'third password')).toBeTruthy()
    expect(await AK.openWithRecovery(after!, recovery)).toBeTruthy()
  })

  it('migrates an old account with real data, losslessly, and its other device follows', async () => {
    const who = email('old')
    const budget = bigDB({ from: '2024-01', months: 24, seed: 11 })
    // An old Money in Order account, made as the previous version did.
    const phone = await device(budget)
    // The budget as the app holds it (loading it fills in what the fixture leaves out).
    const start = count(phone.S.getDB())
    const startIds = COLLECTIONS.flatMap((c) => Object.keys(phone.S.getDB()[c]).map((id) => `${c}/${id}`))
    // Every record the old budget had, and the app may add its own as time passes (this month's plan, say).
    const holdsAll = (db: DB) => startIds.every((k) => !!(db as unknown as Record<string, Record<string, unknown>>)[k.split('/')[0]][k.slice(k.indexOf('/') + 1)])
    const secret = await on(phone, async () => {
      const s = await phone.sync.legacySecret(who, 'old password')
      expect((await fetch(await phone.sync.legacyEmailUrl(who), { method: 'PUT' })).status).toBe(201)
      await phone.sync.enableSync(s, who)
      return s
    })
    expect(phone.sync.syncStatus()).toMatchObject({ state: 'idle', dirty: false, legacy: true })
    const laptop = await device()
    await on(laptop, () => laptop.sync.join(secret, who))
    expect(records(laptop.S.getDB())).toBe(records(phone.S.getDB()))
    // An edit on the laptop that reached the old vault, and one on the phone that hasn't been uploaded.
    await on(laptop, async () => {
      laptop.S.commit({ txns: [{ id: 'laptopEdit', u: Date.now(), date: '2025-12-01', cat: 'rta', amt: 5, cur: 'TWD', base: 5 }] })
      await laptop.sync.syncNow()
    })
    await on(phone, () => phone.S.commit({ txns: [{ id: 'phoneUnsent', u: Date.now(), date: '2025-12-02', cat: 'rta', amt: 7, cur: 'TWD', base: 7 }] }))
    const oldId = (await phone.sync.derive(secret)).id

    const step = await on(phone, () => phone.signin.signIn(who, 'old password'))
    expect(step.kind).toBe('done')
    expect((step as { recovery?: string }).recovery).toBeTruthy()
    expect(phone.sync.syncStatus()).toMatchObject({ state: 'idle', dirty: false, legacy: false })
    const after = phone.S.getDB()
    expect(after.txns.laptopEdit && after.txns.phoneUnsent).toBeTruthy()
    expect(holdsAll(after)).toBe(true)
    expect(count(after)).toBeGreaterThanOrEqual(start + 2)

    // The old vault is retired, not gone.
    const old = await (await fetch(`${APP}/api/vault/${oldId}`, { headers: { 'X-Sync': '2' } })).json()
    expect(old.snap).toBeTruthy()
    expect(old.moved).toBeTruthy()
    expect((await fetch(`${APP}/api/vault/${oldId}`, { method: 'POST', body: 'v1.x' })).status).toBe(410)

    // The laptop, still on the old account, follows with a late edit.
    await on(laptop, async () => {
      laptop.S.commit({ txns: [{ id: 'laptopLate', u: Date.now(), date: '2025-12-03', cat: 'rta', amt: 9, cur: 'TWD', base: 9 }] })
      await laptop.sync.syncNow()
    })
    expect(laptop.sync.syncStatus()).toMatchObject({ legacy: false, code: phone.sync.syncStatus().code, dirty: false })

    // A new device with just the email and password gets every record, exactly.
    await on(phone, () => phone.sync.syncNow())
    const tablet = await device()
    expect((await on(tablet, () => tablet.signin.signIn(who, 'old password'))).kind).toBe('done')
    expect(records(tablet.S.getDB())).toBe(records(phone.S.getDB()))
    expect(records(tablet.S.getDB())).toBe(records(laptop.S.getDB()))
    expect(holdsAll(tablet.S.getDB())).toBe(true)
    expect(count(tablet.S.getDB())).toBeGreaterThanOrEqual(start + 3)
  })

  it('migrates when the shared account already exists with another password', async () => {
    const who = email('both')
    const phone = await device(bigDB({ from: '2025-01', months: 4, seed: 13 }))
    await on(phone, async () => {
      await fetch(await phone.sync.legacyEmailUrl(who), { method: 'PUT' })
      await phone.sync.enableSync(await phone.sync.legacySecret(who, 'old password'), who)
    })
    const made = await phone.account.signup(who, 'brain password')
    expect(made.ok).toBe(true)
    const tablet = await device()
    expect(await on(tablet, () => tablet.signin.signIn(who, 'old password'))).toEqual({ kind: 'account-password' })
    expect((await on(tablet, () => tablet.signin.withAccountPassword('brain password'))).kind).toBe('done')
    expect(records(tablet.S.getDB())).toBe(records(phone.S.getDB()))
  })
})
