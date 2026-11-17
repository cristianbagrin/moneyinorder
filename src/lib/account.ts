// The one account for all of Chris's apps, at account.cristianbagrin.com: sign-in, and this app's keyring
// (the only thing Money in Order keeps there; the budget itself stays in this app's own vault).
// The password goes only here, to be checked; it never goes to Money in Order's server.

import { APP, isKeyring, KEYRING, type Keyring } from './keys'

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

type Item = { k: string; v: unknown; t: number }

/** This app's keyring in the account, and when it was last written (the account keeps the newest write). */
export async function readKeyring(token: string): Promise<Ok<{ ring: Keyring | null; t: number }> | Fail> {
  const r = await call<{ changes: Item[] }>('sync', { app: APP, since: 0, changes: [] }, token)
  if (!r.ok) return r
  const item = (r.changes ?? []).find((c) => c.k === KEYRING)
  return { ok: true, ring: isKeyring(item?.v) ? item.v : null, t: item?.t ?? 0 }
}

/**
 * Write the keyring over the one written at `after` (a write stamped older than what's stored would be dropped),
 * then read it back: what the account holds now, which is someone else's if another device wrote one meanwhile.
 */
export async function writeKeyring(token: string, ring: Keyring, after: number): Promise<Ok<{ ring: Keyring | null; t: number }> | Fail> {
  const w = await call<object>('sync', { app: APP, since: 0, changes: [{ k: KEYRING, v: ring, t: Math.max(Date.now(), after + 1) }] }, token)
  if (!w.ok) return w
  return readKeyring(token)
}

/** The same keyring (the account stores it as canonical JSON, so compare the parts that matter). */
export const sameKeyring = (a: Keyring | null, b: Keyring | null) =>
  !!a && !!b && a.created === b.created && a.salt === b.salt && a.pw.ct === b.pw.ct && a.rk.ct === b.rk.ct
