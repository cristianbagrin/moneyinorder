// Signing in with the shared account, and everything that hangs on it: the keyring, the recovery key, and the
// move of a budget from the old Money in Order accounts.
//
//   1. The email and password go to account.cristianbagrin.com (login, or signup), which hands back a session.
//   2. The account's keyring (`@mio/keyring`) gives the data key:
//      - opened with the password: sign in to that budget;
//      - the password no longer opens it (it was reset or changed on the account page): a device that still holds
//        the key wraps it again under the new password; any other device asks for the recovery key, then does so;
//      - no keyring yet: the budget of an old Money in Order account for this email moves over (see migrate), or,
//        without one, this device's budget becomes the account's. Either way a recovery key is made and shown.
//
// A sign-in can need a second answer from the person (another password, a recovery key): `step` says which, and the
// flow waits in `ctx` (in memory only) for it.

import * as A from './account'
import * as K from './keys'
import { hasNews, merge } from './merge'
import { getDB, persistNow, replaceDB, swapDB } from './store'
import * as S from './sync'
import { emptyDB, type DB } from './types'

export type Step =
  /** signed in and syncing; `recovery` is a new recovery key to show */
  | { kind: 'done'; recovery?: string }
  /** this email has an account already (when creating one) */
  | { kind: 'exists' }
  /** the old Money in Order account took this password, but the shared account for the email has another one */
  | { kind: 'account-password' }
  /** an old Money in Order account exists for this email, under another password */
  | { kind: 'old-password' }
  /** the password doesn't open the keyring and this device doesn't hold the key */
  | { kind: 'recovery' }
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
  /** the keyring that the password didn't open */
  ring?: K.Keyring
  ringT?: number
}

let ctx: Ctx | null = null
/** An unfinished sign-in waiting on `step`'s answer. */
let started: { email: string; password: string; replace: () => boolean } | null = null

const fail = (message: string): Step => ({ kind: 'fail', message })
const WRONG = 'That email and password don’t match'
const OFFLINE = 'Couldn’t reach the server. Check your connection and try again'

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

/**
 * Sign in (or, with `create`, make the account) and start syncing. `replace` is asked before an account's budget
 * replaces the one on this device.
 */
export async function signIn(email: string, password: string, opts: { create?: boolean; replace?: () => boolean } = {}): Promise<Step> {
  email = S.normalizeEmail(email)
  const replace = opts.replace ?? (() => true)
  ctx = null
  started = { email, password, replace }
  try {
    const auth = opts.create ? await A.signup(email, password) : await A.login(email, password)
    if (!auth.ok) {
      if (opts.create && auth.code === 'exists') return { kind: 'exists' }
      if (auth.code !== 'wrong') return failed(auth)
      // Maybe an old Money in Order account with this password, and no shared account (or one with another password).
      const old = await oldAccount(email, password)
      if (!old.vault) return fail(WRONG)
      const made = await A.signup(email, password)
      if (!made.ok) return made.code === 'exists' ? { kind: 'account-password' } : failed(made)
      ctx = { email, password, token: made.token, replace }
      return await afterAuth()
    }
    ctx = { email, password, token: auth.token, replace }
    return await afterAuth()
  } catch (e) {
    if (e instanceof Stop) return e.step
    console.error(e)
    return fail(OFFLINE)
  }
}

/** The shared account's own password, when it differs from the old Money in Order one just typed. */
export async function withAccountPassword(password: string): Promise<Step> {
  if (!started) return fail('Start again')
  try {
    const auth = await A.login(started.email, password)
    if (!auth.ok) return auth.code === 'wrong' ? fail('That isn’t the password of your account') : failed(auth)
    ctx = { email: started.email, password, token: auth.token, replace: started.replace, oldPassword: started.password }
    return await afterAuth()
  } catch (e) {
    if (e instanceof Stop) return e.step
    console.error(e)
    return fail(OFFLINE)
  }
}

/** The old Money in Order account's password, when it differs from the shared account's; null to go on without it. */
export async function withOldPassword(password: string | null): Promise<Step> {
  if (!ctx) return fail('Start again')
  if (password === null) ctx.skipOld = true
  else ctx.oldPassword = password
  try {
    return await afterAuth()
  } catch (e) {
    if (e instanceof Stop) return e.step
    console.error(e)
    return fail(OFFLINE)
  }
}

/** The recovery key, when the password no longer opens the keyring. */
export async function withRecoveryKey(text: string): Promise<Step> {
  if (!ctx?.ring) return fail('Start again')
  const rk = K.parseRecoveryKey(text)
  if (!rk) return fail('That doesn’t look like a recovery key. It has 26 letters and digits')
  const dk = await K.unlockWithRecovery(ctx.ring, rk)
  if (!dk) return fail('That recovery key doesn’t open this account')
  try {
    // From now on the password opens it again.
    const ring = await saveRing(await K.rewrapPassword(ctx.ring, dk, ctx.password), ctx.ringT ?? 0)
    return await joinBudget(dk, ring.created)
  } catch (e) {
    if (e instanceof Stop) return e.step
    console.error(e)
    return fail(OFFLINE)
  }
}

// ---------------------------------------------------------------- the steps

async function afterAuth(): Promise<Step> {
  const c = ctx!
  const read = await A.readKeyring(c.token)
  if (!read.ok) return failed(read)
  if (read.ring) return unlock(read.ring, read.t)
  // No keyring: an old Money in Order account's budget moves over, or this device's budget starts the account.
  const old = c.skipOld ? null : await oldAccount(c.email, c.oldPassword ?? c.password)
  if (old?.vault) return migrate(old)
  if (old?.known && !c.oldPassword) return { kind: 'old-password' }
  if (old?.known && c.oldPassword) return fail('That isn’t the password of your old Money in Order account')
  return create()
}

/** Open a keyring with the password, or with the key this device holds, or ask for the recovery key. */
async function unlock(ring: K.Keyring, t: number): Promise<Step> {
  const c = ctx!
  let dk = await K.unlockWithPassword(ring, c.password)
  if (!dk) {
    // The password changed. A device that holds this budget's key wraps it again under the new password.
    const held = S.syncConfig()
    const mine = held && held.email === c.email && held.ring === ring.created ? K.dkOf(held.code) : null
    if (!mine) {
      c.ring = ring
      c.ringT = t
      return { kind: 'recovery' }
    }
    dk = mine
    ring = await saveRing(await K.rewrapPassword(ring, dk, c.password), t)
  }
  return joinBudget(dk, ring.created)
}

/** Write a keyring; throws Stop when the account refuses it or another device's keyring won meanwhile. */
async function saveRing(ring: K.Keyring, after: number): Promise<K.Keyring> {
  const w = await A.writeKeyring(ctx!.token, ring, after)
  if (!w.ok) throw new Stop(failed(w))
  if (!A.sameKeyring(w.ring, ring)) throw new Stop(fail('Your account changed on another device just now. Sign in again'))
  return ring
}

/** Sync the budget of a data key on this device. */
async function joinBudget(dk: Uint8Array, created: number, recovery?: string): Promise<Step> {
  const c = ctx!
  const code = K.codeOf(dk)
  const extra = { token: c.token, ring: created, ...(recovery ? { pending: recovery } : {}) }
  const held = S.syncConfig()
  ctx = null
  started = null
  if (held?.code === code) {
    await S.updateAccount({ ...extra, email: c.email })
    void S.syncNow()
    return { kind: 'done', recovery }
  }
  // A device of the same account still on its old secret: the same budget, so its edits merge in.
  if (held?.email === c.email && !K.dkOf(held.code)) {
    await S.enableSync(code, c.email, extra)
    return { kind: 'done', recovery }
  }
  const r = await S.join(code, c.email, c.replace, extra)
  if (r === 'cancelled') return { kind: 'cancelled' }
  if (r === 'error') return fail(OFFLINE)
  // A keyring without a vault (its first upload never finished): this device's budget fills it.
  if (r === 'empty') await S.enableSync(code, c.email, extra)
  return { kind: 'done', recovery }
}

/** A new keyring for this device's budget: the first device of this account in Money in Order. */
async function create(): Promise<Step> {
  const c = ctx!
  const dk = K.newDataKey()
  const rk = K.newRecoveryKey()
  const ring = await K.makeKeyring(dk, c.password, rk)
  const w = await A.writeKeyring(c.token, ring, 0)
  if (!w.ok) return failed(w)
  // Another device made one at the same moment: use that one.
  if (!A.sameKeyring(w.ring, ring)) return w.ring ? unlock(w.ring, w.t) : fail(OFFLINE)
  const recovery = K.formatRecoveryKey(rk)
  ctx = null
  started = null
  await S.enableSync(K.codeOf(dk), c.email, { token: c.token, ring: ring.created, pending: recovery })
  return { kind: 'done', recovery }
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
  const rk = K.newRecoveryKey()
  const ring = await K.makeKeyring(dk, c.password, rk)
  const read = await A.readKeyring(c.token)
  if (!read.ok) return failed(read)
  if (read.ring) {
    const theirs = await K.unlockWithPassword(read.ring, c.password)
    if (theirs && K.hex(theirs) !== K.hex(dk)) return fail('Your account changed on another device just now. Sign in again')
    if (theirs) return finishMove(dk, read.ring.created, same, data, remote)
  }
  const w = await A.writeKeyring(c.token, ring, read.t)
  if (!w.ok) return failed(w)
  if (!A.sameKeyring(w.ring, ring)) return fail('Your account changed on another device just now. Sign in again')
  return finishMove(dk, ring.created, same, data, remote, K.formatRecoveryKey(rk))
}

async function finishMove(dk: Uint8Array, created: number, same: boolean, data: DB, remote: DB, recovery?: string): Promise<Step> {
  const c = ctx!
  if (same) replaceDB(data)
  else swapDB(data)
  await persistNow()
  ctx = null
  started = null
  await S.enableSync(K.codeOf(dk), c.email, { token: c.token, ring: created, ...(recovery ? { pending: recovery } : {}) })
  // The budget as this device now syncs it holds everything the old account had.
  if (!(await vaultHolds(dk, [remote]))) console.error('moved budget is missing records')
  return { kind: 'done', recovery }
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

export type KeyStep = { kind: 'done'; recovery: string } | { kind: 'password' } | { kind: 'fail'; message: string }

/**
 * A new recovery key for the budget on this device (the old one stops working). Needs the session; when it has
 * expired (a password change signs out every other device), `password` signs in again first.
 */
export async function replaceRecoveryKey(password?: string): Promise<KeyStep> {
  const held = S.syncConfig()
  const dk = K.dkOf(held?.code)
  if (!held?.email || !dk) return { kind: 'fail', message: 'Sign in first' }
  let token = held.token
  if (password !== undefined) {
    const auth = await A.login(held.email, password)
    if (!auth.ok) return { kind: 'fail', message: auth.code === 'wrong' ? 'That password isn’t right' : auth.message }
    token = auth.token
  }
  if (!token) return { kind: 'password' }
  const read = await A.readKeyring(token)
  if (!read.ok) return read.code === 'signed_out' ? { kind: 'password' } : { kind: 'fail', message: read.message }
  let ring = read.ring
  if (ring && held.ring !== undefined && ring.created !== held.ring) {
    return { kind: 'fail', message: 'This device’s budget isn’t the one in your account. Sign out and sign in again' }
  }
  if (ring) {
    // Just checked: a password that no longer opens the keyring gets its wrap renewed too.
    if (password !== undefined && !(await K.unlockWithPassword(ring, password))) ring = await K.rewrapPassword(ring, dk, password)
  } else {
    // A device that moved from an old account on its own, before any keyring: make it now.
    if (password === undefined) return { kind: 'password' }
    ring = await K.makeKeyring(dk, password, K.newRecoveryKey())
  }
  const rk = K.newRecoveryKey()
  const next = await K.rewrapRecovery(ring, dk, rk)
  const w = await A.writeKeyring(token, next, read.t)
  if (!w.ok) return { kind: 'fail', message: w.message }
  if (!A.sameKeyring(w.ring, next)) return { kind: 'fail', message: 'Your account changed on another device just now. Try again' }
  const recovery = K.formatRecoveryKey(rk)
  await S.updateAccount({ token, ring: next.created, pending: recovery })
  return { kind: 'done', recovery }
}

/** The person saved the recovery key: stop showing it. */
export const recoverySaved = () => S.updateAccount({ pending: undefined })

/** Sign out on this device: the session and the key are forgotten, the budget stays. */
export async function signOut() {
  const token = S.syncConfig()?.token
  await S.disableSync()
  if (token) await A.logout(token).catch(() => {})
}
