/// <reference types="node" />
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { COLLECTIONS, type DB } from '../../src/lib/types'
import { bigDB } from '../fixtures/big'

// One recovery key for the whole account, end to end, from the state live accounts are in today: Money in Order
// and Ten Dollar Words each with a keyring of their own (made here by the versions live before this one), then
// moved by this version, against the real account service and this app's real Worker (both `wrangler dev`).
// Ten Dollar Words runs in this process: its own account code, per browser, over its own server code in memory.
//
//   E2E_APP=http://localhost:4174 E2E_ACCOUNT=http://localhost:8791/api E2E_MAIL_PORT=8792 \
//   E2E_TDW=../tendollarwords E2E_MIO_OLD=<a checkout of 53d4d7e with node_modules linked> npx vitest run tests/e2e/one-key
//
// (The account Worker as in account.e2e.test.ts: --var MAIL_API:http://127.0.0.1:8792/emails --var RESEND_API_KEY:test.)

const APP = process.env.E2E_APP
const ACCOUNT = process.env.E2E_ACCOUNT
const MAIL_PORT = Number(process.env.E2E_MAIL_PORT ?? 0)
const TDW = process.env.E2E_TDW
const MIO_OLD = process.env.E2E_MIO_OLD
const TDW_BEFORE = '2718ffa' // Ten Dollar Words 4.0.0

vi.setConfig({ testTimeout: 300_000 })

const env = vi.hoisted(() => ({ kv: new Map<string, unknown>() }))
vi.mock('idb-keyval', () => ({
  get: async (k: string) => structuredClone(env.kv.get(k)),
  set: async (k: string, v: unknown) => void env.kv.set(k, structuredClone(v)),
  update: async (k: string, f: (v: unknown) => unknown) => void env.kv.set(k, structuredClone(f(structuredClone(env.kv.get(k))))),
}))

/* eslint-disable @typescript-eslint/no-explicit-any */
type Mio = { kv: Map<string, unknown>; S: any; sync: any; signin: any; keys: any; account: any }

/** A Money in Order device: this version's code, or (`old`) the version live before it. */
async function mio(opts: { db?: DB; kv?: Map<string, unknown>; old?: boolean } = {}): Promise<Mio> {
  vi.resetModules()
  const kv = opts.kv ?? new Map<string, unknown>()
  env.kv = kv
  const base = opts.old ? `${MIO_OLD}/src/lib` : '../../src/lib'
  const d: Mio = {
    kv,
    S: await import(/* @vite-ignore */ `${base}/store.ts`),
    sync: await import(/* @vite-ignore */ `${base}/sync.ts`),
    signin: await import(/* @vite-ignore */ `${base}/signin.ts`),
    keys: await import(/* @vite-ignore */ `${base}/keys.ts`),
    account: await import(/* @vite-ignore */ `${base}/account.ts`),
  }
  d.account.setAccountApi(ACCOUNT!)
  if (opts.db) d.S.replaceDB(opts.db)
  if (opts.kv) await on(d, () => d.sync.initSync())
  return d
}

async function on<T>(d: Mio, fn: () => Promise<T> | T): Promise<T> {
  env.kv = d.kv
  return fn()
}

function records(db: DB): string {
  return JSON.stringify(COLLECTIONS.map((c) => Object.values(db[c]).sort((a, b) => (a.id < b.id ? -1 : 1))))
}

const mails: { to: string[]; text: string }[] = []
let mailServer: Server | null = null
const who = `chris-${Date.now().toString(36)}@e2e.example.com`
let realFetch: typeof fetch

const post = (path: string, body: unknown, token?: string) =>
  realFetch(`${ACCOUNT}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })

/** An item in the account, read as an app would. */
async function item(app: string, k: string, password: string) {
  const { token } = await (await post('login', { email: who, password })).json()
  const r = await (await post('sync', { app, since: 0, changes: [] }, token)).json()
  return r.changes.find((c: { k: string }) => c.k === k)?.v ?? null
}

/** A reset by email, as the account service does it. */
async function reset(password: string) {
  mails.length = 0
  expect((await post('forgot', { email: who, app: 'mio' })).status).toBe(200)
  const token = mails.find((m) => m.to.includes(who))!.text.match(/\/reset#([^\s]+)/)![1]
  expect((await post('reset', { token, password })).status).toBe(200)
}

describe.skipIf(!APP || !ACCOUNT || !MAIL_PORT || !TDW || !MIO_OLD)('one recovery key, from today’s two keys, end to end', () => {
  let T: any // tests/tdw-device.mjs of Ten Dollar Words
  let tdwServer: any
  let AK: any

  beforeAll(async () => {
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true })
    Object.assign(globalThis, {
      window: { addEventListener() {}, removeEventListener() {} },
      document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' },
      BroadcastChannel: undefined,
    })
    realFetch = globalThis.fetch
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => realFetch(url.startsWith('/') ? APP + url : url, init))
    mailServer = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        mails.push(JSON.parse(body))
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"id":"x"}')
      })
    })
    await new Promise<void>((r) => mailServer!.listen(MAIL_PORT, '127.0.0.1', r))
    T = await import(/* @vite-ignore */ `${TDW}/tests/tdw-device.mjs`)
    tdwServer = T.appServer()
    AK = await import('../../src/lib/account-keyring')
  })
  afterAll(() => {
    mailServer?.close()
    for (const b of open) b.close()
  })

  const open: { close: () => void }[] = []
  const tdw = (rev?: string) => {
    const b = T.browser({ shared: (u: string, i: RequestInit) => realFetch(u, i), sharedApi: `${ACCOUNT}/`, app: tdwServer, rev })
    open.push(b)
    return b
  }
  const tick = () => new Promise((r) => setTimeout(r, 0))

  // What the steps share.
  const P1 = 'first password'
  const P2 = 'second password'
  const P3 = 'third password'
  let budget: string
  let mioOldKey: string
  let tdwOldKey: string
  let accountKey: string
  let mioPhone: Mio
  let mioOldTab: Mio
  let tdwLaptop: any

  it('today: Money in Order and Ten Dollar Words, each with its own keyring, recovery key and data (the versions live now)', async () => {
    const phone = await mio({ db: bigDB({ from: '2024-01', months: 18, seed: 21 }), old: true })
    const made = await on(phone, () => phone.signin.signIn(who, P1, { create: true }))
    expect(made.kind).toBe('done')
    mioOldKey = made.recovery
    await on(phone, () => phone.signin.recoverySaved())
    budget = records(phone.S.getDB())
    const tab = await mio({ old: true })
    expect((await on(tab, () => tab.signin.signIn(who, P1))).kind).toBe('done')
    expect(records(tab.S.getDB())).toBe(budget)
    mioOldTab = tab

    const laptop = tdw(TDW_BEFORE)
    expect(JSON.parse(JSON.stringify(await laptop.Account.signIn(who, P1)))).toEqual({ done: true })
    tdwOldKey = laptop.Account.state().recoveryKey
    laptop.Account.savedRecoveryKey()
    laptop.Store.setKey('AIza-chris')
    laptop.Store.saveSettings({ ...laptop.Store.getSettings(), defaultBudget: 1230 })
    await tick()
    await laptop.Account.pushNow()
    expect(laptop.acc().dirty).toBe(false)
    tdwLaptop = laptop

    expect((await item('mio', '@mio/keyring', P1)).v).toBe(1)
    expect((await item('tdw', '@tdw/keyring', P1)).v).toBe(1)
    expect(await item('account', '@account/keyring', P1)).toBe(null)
    // The phone runs this version from now on, with what it kept (its budget, as the app would load it).
    mioPhone = await mio({ kv: phone.kv, db: phone.S.getDB() })
    expect(mioPhone.sync.syncStatus()).toMatchObject({ email: who, master: false, legacy: false })
  })

  it('Money in Order moves first: the account’s recovery key is made and shown; the data is the same', async () => {
    const step = await on(mioPhone, () => mioPhone.signin.switchToAccountKeys(P1))
    expect(step.kind).toBe('done')
    accountKey = step.recovery
    expect(accountKey).toMatch(/^([0-9A-Z]{4}-){6}[0-9A-Z]{2}$/)
    expect(mioPhone.sync.syncStatus()).toMatchObject({ master: true, pending: accountKey, replaced: true })
    await on(mioPhone, () => mioPhone.signin.recoverySaved())
    const acct = await item('account', '@account/keyring', P1)
    expect(await AK.isCurrentRecovery(acct, accountKey)).toBe(true)
    const ring = await item('mio', '@mio/keyring', P1)
    expect(Object.keys(ring).sort()).toEqual(['created', 'mk', 'mkid', 'v'])
    await on(mioPhone, () => mioPhone.sync.syncNow())
    expect(records(mioPhone.S.getDB())).toBe(budget)
    // Money in Order's own key from before opens nothing now.
    expect(await mioPhone.keys.unlockWithRecovery(ring, mioPhone.keys.parseRecoveryKey(mioOldKey))).toBe(null)

    // The tab still running the version from before: syncs on, and can't write over the moved keyring.
    await on(mioOldTab, async () => {
      mioOldTab.S.commit({ txns: [{ id: 'oldTab', u: Date.now(), date: '2025-06-01', cat: 'rta', amt: 3, cur: 'TWD', base: 3 }] })
      await mioOldTab.sync.syncNow()
    })
    expect(mioOldTab.sync.syncStatus()).toMatchObject({ state: 'idle', dirty: false })
    expect((await on(mioOldTab, () => mioOldTab.signin.replaceRecoveryKey(P1))).kind).toBe('fail')
    const fresh = await mio({ old: true })
    expect((await on(fresh, () => fresh.signin.signIn(who, P1))).kind).toBe('fail')
    expect(await item('mio', '@mio/keyring', P1)).toEqual(ring)
    await on(mioPhone, () => mioPhone.sync.syncNow())
    expect(mioPhone.S.getDB().txns.oldTab).toBeTruthy()
    budget = records(mioPhone.S.getDB())
  })

  it('then Ten Dollar Words: the laptop switches with the password, no new key; its old tab can’t undo it', async () => {
    const laptop = tdw()
    for (const [k, v] of tdwLaptop.storage) laptop.storage.set(k, v)
    expect(laptop.Account.state().switchKeys).toBe(true)
    expect(JSON.parse(JSON.stringify(await laptop.Account.reauth(P1)))).toEqual({ done: true, covered: true })
    expect(laptop.Account.state()).toMatchObject({ switchKeys: false, recoveryKey: '' })
    const ring = await item('tdw', '@tdw/keyring', P1)
    expect(Object.keys(ring).sort()).toEqual(['created', 'kid', 'mk', 'mkid', 'v'])
    expect(ring.mkid).toBe((await item('account', '@account/keyring', P1)).id)
    expect(laptop.Store.getKey()).toBe('AIza-chris')
    expect(laptop.Store.getSettings().defaultBudget).toBe(1230)
    // The 4.0 tab: still syncing with the key it holds; a new recovery key from it is refused.
    await tdwLaptop.Account.newRecoveryKey().catch(() => {})
    expect(await item('tdw', '@tdw/keyring', P1)).toEqual(ring)
    tdwLaptop.Store.setKey('AIza-from-old-tab')
    await tick()
    await tdwLaptop.Account.pushNow()
    await laptop.Account.pull(true)
    expect(laptop.Store.getKey()).toBe('AIza-from-old-tab')
    tdwLaptop = laptop
  })

  it('a fresh device in each app signs in with the password alone', async () => {
    const tablet = await mio()
    expect(await on(tablet, () => tablet.signin.signIn(who, P1))).toEqual({ kind: 'done', recovery: undefined })
    expect(records(tablet.S.getDB())).toBe(budget)
    const desk = tdw()
    expect(JSON.parse(JSON.stringify(await desk.Account.signIn(who, P1)))).toEqual({ done: true })
    expect(desk.Store.getKey()).toBe('AIza-from-old-tab')
    expect(desk.Store.getSettings().defaultBudget).toBe(1230)
  })

  it('after a reset by email, the account’s key opens both apps; the old per-app keys don’t', async () => {
    await reset(P2)
    const tablet = await mio()
    expect(await on(tablet, () => tablet.signin.signIn(who, P2))).toEqual({ kind: 'recovery' })
    expect((await on(tablet, () => tablet.signin.withRecoveryKey(mioOldKey))).kind).toBe('fail')
    expect((await on(tablet, () => tablet.signin.withRecoveryKey(tdwOldKey))).kind).toBe('fail')
    expect((await on(tablet, () => tablet.signin.withRecoveryKey(accountKey))).kind).toBe('done')
    expect(records(tablet.S.getDB())).toBe(budget)
    // Money in Order renewed the account's password wrap: Ten Dollar Words needs only the new password.
    const desk = tdw()
    expect(JSON.parse(JSON.stringify(await desk.Account.signIn(who, P2)))).toEqual({ done: true })
    expect(desk.Store.getKey()).toBe('AIza-from-old-tab')
  })

  it('a new recovery key made in Ten Dollar Words recovers Money in Order after the next reset', async () => {
    const desk = tdw()
    await desk.Account.signIn(who, P2)
    const fresh = await desk.Account.newRecoveryKey()
    desk.Account.savedRecoveryKey()
    await reset(P3)
    const phone = await mio()
    expect(await on(phone, () => phone.signin.signIn(who, P3))).toEqual({ kind: 'recovery' })
    expect((await on(phone, () => phone.signin.withRecoveryKey(accountKey))).kind).toBe('fail')
    expect((await on(phone, () => phone.signin.withRecoveryKey(fresh))).kind).toBe('done')
    expect(records(phone.S.getDB())).toBe(budget)
    // The devices that were signed in all along still hold their keys, and sync.
    await on(mioPhone, () => mioPhone.sync.syncNow())
    expect(records(mioPhone.S.getDB())).toBe(budget)
    expect(await on(mioPhone, () => mioPhone.signin.signIn(who, P3))).toEqual({ kind: 'done', recovery: undefined })
    expect(await AK.openWithPassword(await item('account', '@account/keyring', P3), P3)).toBeTruthy()
  })
})
