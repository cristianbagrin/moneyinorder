// Signing in with the shared account, and everything that hangs on it: the keys, the recovery key, and the
// move of a budget from the old Money in Order accounts.
//
//   1. The email and password go to account.cristianbagrin.com (login, or signup), which hands back a session.
//   2. The account's keyring (`@account/keyring`, see account-keyring.ts) gives the master key (MK): opened with
//      the password, or with the MK this device holds, or with the account's recovery key. The first app to need
//      it makes it, and shows its recovery key: one key for the whole account, in every app.
//   3. This app's keyring (`@mio/keyring`) gives the data key (DK) under MK. A keyring from before MK (v 1, under
//      the password and Money in Order's own recovery key) is opened the old way and moved under MK: the MK wrap
//      is added and read back before the old wraps go (see settle). The DK never changes, nor does the budget.
//   4. No keyring for this app yet: the budget of an old Money in Order account for this email moves over (see
//      migrate), or, without one, this device's budget becomes the account's.
//
// Every keyring write names the version it read (`if`): the account refuses it when another device or app wrote
// in between, and the step starts over from what is there now.
//
// A sign-in can need a second answer from the person (another password, a recovery key): `step` says which, and
// the flow waits in `ctx` (in memory only) for it.

import { get, set } from 'idb-keyval'
import * as A from './account'
import * as AK from './account-keyring'
import * as K from './keys'
import { hasNews, merge } from './merge'
import { getDB, persistNow, replaceDB, swapDB } from './store'
import * as S from './sync'
import { emptyDB, type DB } from './types'

export type Step =
  /**
   * signed in and syncing; `recovery` is a new recovery key to show (for the whole account); `covered`: this
   * budget's keys moved under the account's recovery key, which already existed
   */
  | { kind: 'done'; recovery?: string; covered?: boolean }
  /** this email has an account already (when creating one) */
  | { kind: 'exists' }
  /** the old Money in Order account took this password, but the shared account for the email has another one */
  | { kind: 'account-password' }
  /** an old Money in Order account exists for this email, under another password */
  | { kind: 'old-password' }
  /** the password doesn't open the keys and this device doesn't hold them; `old`: Money in Order's own key from before */
  | { kind: 'recovery'; old?: boolean }
  | { kind: 'cancelled' }
  /** something to tell the person: a wrong password, a lock, no connection */
  | { kind: 'fail'; message: string }

interface Ctx {
  email: string
  /** the shared account's password, as just checked by a successful sign-in */
  password: string
  token: string
  replace: () => boolean
  /** a password typed that may be the old Money in Order account's */
  oldPassword?: string
  /** the person chose to go on without the old account's budget */
  skipOld?: boolean
  /** recovery keys typed so far (the account's, maybe Money in Order's own from before) */
  keys: string[]
  /** what the last step asked */
  asked?: Step
}

let ctx: Ctx | null = null
/** An unfinished sign-in waiting on `step`'s answer. */
let started: { email: string; password: string; replace: () => boolean } | null = null

const fail = (message: string): Step => ({ kind: 'fail', message })
const WRONG = 'That email and password don’t match'
const OFFLINE = 'Couldn’t reach the server. Check your connection and try again'
const CHANGED = 'Your account changed on another device just now. Sign in again'
const NOT_A_KEY = 'That doesn’t look like a recovery key. It has 26 letters and digits'
const WRONG_KEY = 'That recovery key doesn’t open this account'

class Stop extends Error {
  constructor(readonly step: Step) {
    super('stop')
  }
}

function failed(r: A.Fail): Step {
  if (r.code === 'wrong') return fail(WRONG)
  return fail(r.message)
}

/** Forget an unfinished sign-in (the person went back). */
export function cancelSignIn() {
  ctx = null
  started = null
}

/** Run a step; a Stop is its answer, anything else a connection problem. */
async function guard(run: () => Promise<Step>): Promise<Step> {
  try {
    return await run()
  } catch (e) {
    if (e instanceof Stop) return e.step
    console.error(e)
    return fail(OFFLINE)
  }
}

/**
 * Sign in (or, with `create`, make the account) and start syncing. `replace` is asked before an account's budget
 * replaces the one on this device.
 */
export async function signIn(email: string, password: string, opts: { create?: boolean; replace?: () => boolean } = {}): Promise<Step> {
  email = S.normalizeEmail(email)
  const replace = opts.replace ?? (() => true)
  ctx = null
  started = { email, password, replace }
  return guard(async () => {
    const auth = opts.create ? await A.signup(email, password) : await A.login(email, password)
    if (!auth.ok) {
      if (opts.create && auth.code === 'exists') return { kind: 'exists' }
      if (auth.code !== 'wrong') return failed(auth)
      // Maybe an old Money in Order account with this password, and no shared account (or one with another password).
      const old = await oldAccount(email, password)
      if (!old.vault) return fail(WRONG)
      const made = await A.signup(email, password)
      if (!made.ok) return made.code === 'exists' ? { kind: 'account-password' } : failed(made)
      ctx = { email, password, token: made.token, replace, keys: [] }
      return afterAuth()
    }
    ctx = { email, password, token: auth.token, replace, keys: [] }
    return afterAuth()
  })
}

/** The shared account's own password, when it differs from the old Money in Order one just typed. */
export async function withAccountPassword(password: string): Promise<Step> {
  if (!started) return fail('Start again')
  return guard(async () => {
    const auth = await A.login(started!.email, password)
    if (!auth.ok) return auth.code === 'wrong' ? fail('That isn’t the password of your account') : failed(auth)
    ctx = { email: started!.email, password, token: auth.token, replace: started!.replace, oldPassword: started!.password, keys: [] }
    return afterAuth()
  })
}

/** The old Money in Order account's password, when it differs from the shared account's; null to go on without it. */
export async function withOldPassword(password: string | null): Promise<Step> {
  if (!ctx) return fail('Start again')
  if (password === null) ctx.skipOld = true
  else ctx.oldPassword = password
  return guard(afterAuth)
}

/** A recovery key, when the password no longer opens the keys. */
export async function withRecoveryKey(text: string): Promise<Step> {
  const c = ctx
  if (!c) return fail('Start again')
  if (!AK.parseRecovery(text) && !K.parseRecoveryKey(text)) return fail(NOT_A_KEY)
  const asked = c.asked
  c.keys.push(text)
  const step = await guard(afterAuth)
  // Asked the same again: this key opened nothing new.
  if (step.kind === 'recovery' && asked?.kind === 'recovery' && !!step.old === !!asked.old) {
    c.keys.pop()
    return fail(WRONG_KEY)
  }
  return step
}

// ---------------------------------------------------------------- the keys

/** The keys a sign-in ends with: this budget's data key, and the account's master key (null: the password and
 * this device couldn't open it, but this device holds the data key, so it keeps syncing). */
interface Keys {
  dk: Uint8Array
  created: number
  mk: Uint8Array | null
  /** a recovery key to show: the account's, just made (or made earlier and not saved yet) */
  recovery?: string
  /** this sign-in moved Money in Order's keyring from its own recovery key to the account's */
  moved?: boolean
}

const RETRY = Symbol('retry')
const DRAFT = 'mio-recovery-draft'

/**
 * A recovery key just made, kept on this device before the keyring holding it is written: if the sign-in stops
 * right after (a closed tab, no connection), the next one still shows it.
 */
async function keepDraft(email: string, key: string | undefined) {
  await set(DRAFT, key ? { email, key } : undefined)
}

async function draftFor(email: string): Promise<string | null> {
  const d = (await get(DRAFT)) as { email: string; key: string } | undefined
  return d?.email === email ? d.key : null
}

/**
 * Get this budget's keys, making or moving keyrings as needed, until both the account's keyring and this app's
 * are as they should be. `fresh` is the data key to keep when this app has no keyring yet (a new budget, or one
 * moved from an old account); without it, no keyring gives null.
 */
async function settle(c: Ctx, fresh?: { dk: Uint8Array; created: number }): Promise<Keys | Step | null> {
  for (let i = 0; i < 4; i++) {
    const r = await settleOnce(c, fresh)
    if (r !== RETRY) return r
  }
  return fail(CHANGED)
}

async function settleOnce(c: Ctx, fresh?: { dk: Uint8Array; created: number }): Promise<Keys | Step | null | typeof RETRY> {
  const [app, acct] = await Promise.all([A.readKeyring(c.token), A.readAccountRing(c.token)])
  if (!app.ok) return failed(app)
  if (!acct.ok) return failed(acct)
  const held = S.syncConfig()
  const mine = held?.email === c.email ? held : null
  let ar = acct.ring

  // 1. The master key: the password, or this device's copy, or a recovery key.
  let mk: Uint8Array | null = null
  let fixPassword = false
  if (ar) {
    mk = await AK.openWithPassword(ar, c.password)
    if (!mk) {
      const copy = mine?.mk ? AK.unb64(mine.mk) : null
      if (copy && (await AK.keyId(copy)) === ar.id) mk = copy
      for (const key of c.keys) mk ??= await AK.openWithRecovery(ar, key)
      // The password changed (a reset by email, say): it opens the account's keys again from now on.
      fixPassword = !!mk
    }
  }

  // 2. The data key.
  const ring = app.ring
  let dk: Uint8Array | null = null
  let created: number
  if (ring) {
    created = ring.created
    const box = mk && ar ? K.masterWrap(ring, ar.id) : null
    if (box) dk = await K.openMasterWrap(mk!, box)
    if (!dk && K.isKeyring(ring)) dk = await K.unlockWithPassword(ring, c.password)
    if (!dk && mine?.ring === ring.created) dk = K.dkOf(mine.code)
    if (!dk && K.isKeyring(ring)) {
      for (const key of c.keys) {
        const rk = K.parseRecoveryKey(key)
        if (!dk && rk) dk = await K.unlockWithRecovery(ring, rk)
      }
    }
    if (!dk) {
      if (ar && !mk) return ask({ kind: 'recovery' })
      // Opened with the account's keys, but this budget's keyring is still under Money in Order's own from before.
      if (K.isKeyring(ring)) return ask({ kind: 'recovery', old: !!ar })
      return fail('Your synced budget is locked with keys your account no longer has. Sign in on a device that still syncs it')
    }
  } else {
    if (!fresh) return null
    // A new keyring goes under the account's master key, so that has to open first.
    if (ar && !mk) return ask({ kind: 'recovery' })
    dk = fresh.dk
    created = fresh.created
  }
  // The data key opened, but not the account's keys: this device keeps syncing; Settings asks for the recovery key.
  if (ar && !mk) return { dk, created, mk: null }

  // 3. The account's keyring: made by the first app that needs it, or its password wrap renewed.
  let recovery: string | undefined
  if (!ar) {
    const made = await AK.createAccountRing(c.password)
    await keepDraft(c.email, made.recovery)
    const w = await A.writeAccountRing(c.token, made.ring, acct.s)
    if (!w.ok) return failed(w)
    if (!w.written) {
      // Another app or device made it first: use theirs.
      await keepDraft(c.email, undefined)
      return RETRY
    }
    const back = await A.readAccountRing(c.token)
    if (!back.ok) return failed(back)
    if (back.ring?.id !== made.ring.id) return RETRY
    ar = back.ring
    mk = made.mk
    recovery = made.recovery
  } else if (fixPassword) {
    const w = await A.writeAccountRing(c.token, await AK.rewrapAccountPassword(ar, mk!, c.password), acct.s)
    if (!w.ok) return failed(w)
    if (!w.written) return RETRY
  }
  if (!recovery) {
    // A key made earlier and not saved yet is shown again, while it is still the account's.
    const draft = await draftFor(c.email)
    if (draft && (await AK.isCurrentRecovery(ar, draft))) recovery = draft
    else if (draft) await keepDraft(c.email, undefined)
  }

  // 4. This app's keyring under the master key. A keyring from before gets the new wrap next to its old ones
  //    first; they go only once the new one reads back.
  const v1 = !!ring && K.isKeyring(ring)
  if (!ring || !K.isMasterRing(ring) || ring.mkid !== ar.id) {
    let s = app.s
    if (ring && K.isKeyring(ring) && !K.masterWrap(ring, ar.id)) {
      const step1 = { ...ring, mkid: ar.id, mk: await AK.wrapAppKey(mk!, K.APP, dk) }
      const w = await A.writeKeyring(c.token, step1, s)
      if (!w.ok) return failed(w)
      if (!w.written) return RETRY
      const back = await A.readKeyring(c.token)
      if (!back.ok) return failed(back)
      const box = back.ring ? K.masterWrap(back.ring, ar.id) : null
      if (!box || K.hex((await K.openMasterWrap(mk!, box)) ?? new Uint8Array()) !== K.hex(dk)) return RETRY
      s = back.s
    }
    const w = await A.writeKeyring(c.token, await K.masterRing(dk, mk!, ar.id, created), s)
    if (!w.ok) return failed(w)
    if (!w.written) return RETRY
    const back = await A.readKeyring(c.token)
    if (!back.ok) return failed(back)
    const box = back.ring && K.isMasterRing(back.ring) ? K.masterWrap(back.ring, ar.id) : null
    if (!box || K.hex((await K.openMasterWrap(mk!, box)) ?? new Uint8Array()) !== K.hex(dk)) return RETRY
  }
  return { dk, created, mk, recovery, moved: v1 }
}

/** Ask the person, and remember what was asked. */
function ask(step: Step): Step {
  if (ctx) ctx.asked = step
  return step
}

const isStep = (r: Keys | Step | null): r is Step => !!r && 'kind' in r

/** What the sync settings keep of these keys. */
const kept = (k: Keys, token: string): Pick<S.SyncConfig, 'token' | 'ring' | 'pending' | 'mk' | 'replaced'> => ({
  token,
  ring: k.created,
  mk: k.mk ? AK.b64(k.mk) : undefined,
  pending: k.recovery,
  replaced: k.recovery && k.moved ? true : undefined,
})

const done = (k: Keys): Step => ({ kind: 'done', recovery: k.recovery, ...(k.moved && !k.recovery ? { covered: true } : {}) })

// ---------------------------------------------------------------- the steps

async function afterAuth(): Promise<Step> {
  const c = ctx!
  const k = await settle(c)
  if (isStep(k)) return k
  if (k) return joinBudget(k)
  // No keyring: an old Money in Order account's budget moves over, or this device's budget starts the account.
  const old = c.skipOld ? null : await oldAccount(c.email, c.oldPassword ?? c.password)
  if (old?.vault) return migrate(old)
  if (old?.known && !c.oldPassword) return { kind: 'old-password' }
  if (old?.known && c.oldPassword) return fail('That isn’t the password of your old Money in Order account')
  return create()
}

/** Sync the budget of a data key on this device. */
async function joinBudget(k: Keys): Promise<Step> {
  const c = ctx!
  const code = K.codeOf(k.dk)
  const extra = kept(k, c.token)
  const held = S.syncConfig()
  ctx = null
  started = null
  if (held?.code === code) {
    await S.updateAccount({ ...extra, email: c.email })
    void S.syncNow()
    return done(k)
  }
  // A device of the same account still on its old secret: the same budget, so its edits merge in.
  if (held?.email === c.email && !K.dkOf(held.code)) {
    await S.enableSync(code, c.email, extra)
    return done(k)
  }
  const r = await S.join(code, c.email, c.replace, extra)
  if (r === 'cancelled') return { kind: 'cancelled' }
  if (r === 'error') return fail(OFFLINE)
  // A keyring without a vault (its first upload never finished): this device's budget fills it.
  if (r === 'empty') await S.enableSync(code, c.email, extra)
  return done(k)
}

/** A new data key for this device's budget: the first device of this account in Money in Order. */
async function create(): Promise<Step> {
  const c = ctx!
  const fresh = { dk: K.newDataKey(), created: Date.now() }
  const k = await settle(c, fresh)
  if (isStep(k)) return k
  if (!k) return fail(OFFLINE)
  // Another device made one at the same moment: use that one.
  if (K.hex(k.dk) !== K.hex(fresh.dk)) return joinBudget(k)
  ctx = null
  started = null
  await S.enableSync(K.codeOf(k.dk), c.email, kept(k, c.token))
  return done(k)
}

// ---------------------------------------------------------------- moving from the old accounts

interface Old {
  /** the old vault's reply, when this password (or the secret this device holds) opens it */
  vault?: S.VaultReply
  secret?: string
  /** an old account exists for this email */
  known: boolean
}

/** The old Money in Order account for this email: its budget if the password (or this device) opens it. */
async function oldAccount(email: string, password: string): Promise<Old> {
  const held = S.syncConfig()
  const secrets = [...(held?.email === email && !K.dkOf(held.code) ? [held.code] : []), await S.legacySecret(email, password)]
  for (const secret of [...new Set(secrets)]) {
    const { id } = await S.derive(secret)
    const res = await S.pullVault(id)
    if (res.status === 200) return { vault: (await res.json()) as S.VaultReply, secret, known: true }
    if (res.status !== 404) throw new Stop(fail(OFFLINE))
  }
  const known = await fetch(await S.legacyEmailUrl(email), { method: 'HEAD', cache: 'no-store' })
  if (known.status !== 200 && known.status !== 404) throw new Stop(fail(OFFLINE))
  return { known: known.status === 200 }
}

/** Everything `have` holds is in `got` too. */
const holds = (got: DB, have: DB) => !hasNews(got, have)

/**
 * Move an old account's budget into a new vault under a new data key, verify it reads back whole, and only then
 * retire the old vault (a note next to it: the new key, for the old secret; the old data stays). Then the keyring.
 * Every step can run again after an interruption: a vault that already moved gives back the key it moved to.
 */
async function migrate(old: Old): Promise<Step> {
  const c = ctx!
  const secret = old.secret!
  const oldKeys = await S.derive(secret)
  const remote = (await S.openReply(old.vault!, oldKeys.key)) ?? emptyDB()
  let dk = old.vault!.moved ? await K.openMoved(old.vault!.moved, secret) : null
  const held = S.syncConfig()
  // This device synced that old account (or already followed its move): the same budget, maybe with edits not
  // uploaded yet.
  const same = held?.code === secret || (!!dk && held?.code === K.codeOf(dk))
  if (!same && !c.replace()) return { kind: 'cancelled' }
  const data = same ? merge(getDB(), remote) : remote
  if (!dk) {
    dk = K.newDataKey()
    const keys = await K.vaultKeys(dk)
    const put = await fetch(`/api/vault/${keys.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain', 'X-Base-Rev': 'new' },
      body: await S.seal(data, keys.key),
    })
    if (!put.ok) return fail(OFFLINE)
    // Read it back: the old vault is retired only once the new one holds everything.
    if (!(await vaultHolds(dk, [remote, data]))) return fail('Couldn’t move your budget safely. Nothing changed. Try again')
    const note = await fetch(`/api/vault/${oldKeys.id}/moved`, { method: 'PUT', body: await K.sealMoved(dk, secret) })
    if (note.status === 409) {
      // Another device moved it first: use its key, and drop the copy made here.
      const theirs = await fetch(`/api/vault/${oldKeys.id}/moved`, { cache: 'no-store' })
      const other = theirs.ok ? await K.openMoved(await theirs.text(), secret) : null
      await fetch(`/api/vault/${keys.id}`, { method: 'DELETE' }).catch(() => {})
      if (!other) return fail(OFFLINE)
      dk = other
    } else if (!note.ok) return fail(OFFLINE)
  }

  // The keyring, unless another device made one meanwhile.
  const k = await settle(c, { dk, created: Date.now() })
  if (isStep(k)) return k
  if (!k || K.hex(k.dk) !== K.hex(dk)) return fail(CHANGED)
  return finishMove(k, same, data, remote)
}

async function finishMove(k: Keys, same: boolean, data: DB, remote: DB): Promise<Step> {
  const c = ctx!
  if (same) replaceDB(data)
  else swapDB(data)
  await persistNow()
  ctx = null
  started = null
  await S.enableSync(K.codeOf(k.dk), c.email, kept(k, c.token))
  // The budget as this device now syncs it holds everything the old account had.
  if (!(await vaultHolds(k.dk, [remote]))) console.error('moved budget is missing records')
  return done(k)
}

/** The vault of a data key holds every record of each of these budgets. */
async function vaultHolds(dk: Uint8Array, budgets: DB[]): Promise<boolean> {
  const keys = await K.vaultKeys(dk)
  const res = await S.pullVault(keys.id)
  if (res.status !== 200) return false
  const got = await S.openReply((await res.json()) as S.VaultReply, keys.key)
  return !!got && budgets.every((b) => holds(got, b))
}

// ---------------------------------------------------------------- signed in

export type KeyStep =
  | { kind: 'done'; recovery?: string; covered?: boolean }
  | { kind: 'password' }
  | { kind: 'recovery'; old?: boolean }
  | { kind: 'fail'; message: string }

/**
 * Put this device on the account's keys (its master key): a device signed in before the account had one, or since
 * the password changed. Needs the password; after a reset by email also the recovery key. May make the account's
 * recovery key (shown as `recovery`), when no app has made one yet.
 */
export async function switchToAccountKeys(password: string, recovery?: string): Promise<KeyStep> {
  const held = S.syncConfig()
  const dk = K.dkOf(held?.code)
  if (!held?.email || !dk) return { kind: 'fail', message: 'Sign in first' }
  if (recovery !== undefined && !AK.parseRecovery(recovery) && !K.parseRecoveryKey(recovery)) return { kind: 'fail', message: NOT_A_KEY }
  try {
    const auth = await A.login(held.email, password)
    if (!auth.ok) return { kind: 'fail', message: auth.code === 'wrong' ? 'That password isn’t right' : auth.message }
    const c: Ctx = { email: held.email, password, token: auth.token, replace: () => true, keys: recovery ? [recovery] : [] }
    // A device that moved from an old account on its own, before any keyring: its budget's keyring is made now.
    const k = await settle(c, { dk, created: held.ring ?? Date.now() })
    if (isStep(k)) {
      if (k.kind === 'recovery') return recovery ? { kind: 'fail', message: WRONG_KEY } : { kind: 'recovery', old: k.old }
      return k.kind === 'fail' ? k : { kind: 'fail', message: OFFLINE }
    }
    if (!k || K.hex(k.dk) !== K.hex(dk)) return { kind: 'fail', message: 'This device’s budget isn’t the one in your account. Sign out and sign in again' }
    if (!k.mk) return recovery ? { kind: 'fail', message: WRONG_KEY } : { kind: 'recovery' }
    await S.updateAccount(kept(k, auth.token))
    return { kind: 'done', recovery: k.recovery, ...(k.moved && !k.recovery ? { covered: true } : {}) }
  } catch (e) {
    console.error(e)
    return { kind: 'fail', message: OFFLINE }
  }
}

/**
 * A new recovery key for the account (the old one stops working, in every app). Needs the account's master key on
 * this device and a session; without them, `password` (and maybe a recovery key) gets them first.
 */
export async function replaceRecoveryKey(password?: string, recovery?: string): Promise<KeyStep> {
  let held = S.syncConfig()
  if (!held?.email || !K.dkOf(held.code)) return { kind: 'fail', message: 'Sign in first' }
  if (!held.mk || !held.token || password !== undefined) {
    if (password === undefined) return { kind: 'password' }
    const r = await switchToAccountKeys(password, recovery)
    // The account had no recovery key yet: the one just made is the new one.
    if (r.kind !== 'done' || r.recovery) return r
    held = S.syncConfig()!
  }
  try {
    const acct = await A.readAccountRing(held.token!)
    if (!acct.ok) return acct.code === 'signed_out' && password === undefined ? { kind: 'password' } : { kind: 'fail', message: acct.message }
    const mk = AK.unb64(held.mk!)
    if (!acct.ring || acct.ring.id !== (await AK.keyId(mk))) return { kind: 'fail', message: 'Your account’s keys changed on another device. Sign out and sign in again' }
    const next = await AK.newAccountRecovery(acct.ring, mk)
    await keepDraft(held.email!, next.recovery)
    const w = await A.writeAccountRing(held.token!, next.ring, acct.s)
    if (!w.ok) return { kind: 'fail', message: w.message }
    if (!w.written) {
      await keepDraft(held.email!, undefined)
      return { kind: 'fail', message: 'Your account changed on another device just now. Try again' }
    }
    await S.updateAccount({ pending: next.recovery, replaced: undefined })
    return { kind: 'done', recovery: next.recovery }
  } catch (e) {
    console.error(e)
    return { kind: 'fail', message: OFFLINE }
  }
}

/** The person saved the recovery key: stop showing it. */
export async function recoverySaved() {
  await keepDraft('', undefined)
  await S.updateAccount({ pending: undefined, replaced: undefined })
}

/** Sign out on this device: the session and the keys are forgotten, the budget stays. */
export async function signOut() {
  const token = S.syncConfig()?.token
  await S.disableSync()
  if (token) await A.logout(token).catch(() => {})
}
