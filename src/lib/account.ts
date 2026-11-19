// The one account for all of Chris's apps, at account.cristianbagrin.com: sign-in, this app's keyring and the
// account's own (the only things Money in Order keeps there; the budget itself stays in this app's own vault).
// The password goes only here, to be checked; it never goes to Money in Order's server.

import { isAccountRing, type AccountRing } from './account-keyring'
import { APP, isAnyRing, KEYRING, type AnyRing } from './keys'

const DEFAULT_API = 'https://account.cristianbagrin.com/api'
let api: string | null = null

/**
 * Where the account service is. On a local development address, `localStorage['mio-account-api']` points the app
 * at a local copy (`wrangler dev` of the account Worker); everywhere else it is the real one.
 */
export function accountApi(): string {
  if (api) return api
  try {
    const host = typeof location === 'object' ? location.hostname : ''
    if (host === 'localhost' || host === '127.0.0.1') {
      const dev = localStorage.getItem('mio-account-api')
      if (dev) return dev.replace(/\/$/, '')
    }
  } catch {
    // no localStorage: the real service
  }
  return DEFAULT_API
}

/** For tests and scripts outside a browser. */
export function setAccountApi(url: string | null) {
  api = url ? url.replace(/\/$/, '') : null
}

export type Fail = { ok: false; status: number; code: string; message: string }
export type Ok<T> = { ok: true } & T

const UNREACHABLE: Fail = { ok: false, status: 0, code: 'network', message: 'Couldn’t reach the account service. Check your connection and try again' }

async function call<T>(path: string, body?: unknown, token?: string): Promise<Ok<T> | Fail> {
  let res: Response
  try {
    res = await fetch(`${accountApi()}/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    return UNREACHABLE
  }
  let data: Record<string, unknown> = {}
  try {
    data = await res.json()
  } catch {
    // an empty or broken answer
  }
  if (!res.ok) {
    const message = typeof data.error === 'string' ? data.error.replace(/\.$/, '') : 'Something went wrong. Try again in a moment'
    return { ok: false, status: res.status, code: typeof data.code === 'string' ? data.code : 'server', message }
  }
  return { ok: true, ...(data as T) }
}

type Session = { token: string; email: string }

export const login = (email: string, password: string) => call<Session>('login', { email, password })
export const signup = (email: string, password: string) => call<Session>('signup', { email, password })
export const logout = (token: string) => call<object>('logout', {}, token)

type Item = { k: string; v: unknown; t: number; s?: number }
type SyncReply = { changes?: Item[]; rejected?: string[] }

/** An item of `app` as the account holds it: its value, and the `s` a write over it must name. */
async function readItem(token: string, app: string, k: string): Promise<Ok<{ v: unknown; s: number; t: number }> | Fail> {
  const r = await call<SyncReply>('sync', { app, since: 0, changes: [] }, token)
  if (!r.ok) return r
  const item = (r.changes ?? []).find((c) => c.k === k)
  return { ok: true, v: item?.v ?? null, s: item?.s ?? 0, t: item?.t ?? 0 }
}

/**
 * Write an item over the one read at `s` (0: none). The account refuses it when anything changed it since, so two
 * devices or apps never write over each other: `written` says whether this write landed.
 */
async function writeItem(token: string, app: string, k: string, v: unknown, s: number): Promise<Ok<{ written: boolean }> | Fail> {
  const r = await call<SyncReply>('sync', { app, since: 0, changes: [{ k, v, t: Date.now(), if: s }] }, token)
  if (!r.ok) return r
  return { ok: true, written: !(r.rejected ?? []).includes(k) }
}

export type RingRead = Ok<{ ring: AnyRing | null; s: number }>

/** This app's keyring in the account (`ring` is null when there is none, or it is not one this version knows). */
export async function readKeyring(token: string): Promise<RingRead | Fail> {
  const r = await readItem(token, APP, KEYRING)
  if (!r.ok) return r
  return { ok: true, ring: isAnyRing(r.v) ? r.v : null, s: r.s }
}

export const writeKeyring = (token: string, ring: AnyRing, s: number) => writeItem(token, APP, KEYRING, ring, s)

export const ACCOUNT_RING = '@account/keyring'

/** The account's keyring (its master key), shared by every app. */
export async function readAccountRing(token: string): Promise<Ok<{ ring: AccountRing | null; s: number }> | Fail> {
  const r = await readItem(token, 'account', ACCOUNT_RING)
  if (!r.ok) return r
  return { ok: true, ring: isAccountRing(r.v) ? r.v : null, s: r.s }
}

export const writeAccountRing = (token: string, ring: AccountRing, s: number) => writeItem(token, 'account', ACCOUNT_RING, ring, s)
