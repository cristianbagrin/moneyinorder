// An in-memory stand-in for the shared account service (account.cristianbagrin.com, chinesebrain `site/worker.js`):
// the same routes, answers and rules as far as Money in Order uses them. tests/e2e runs against the real one.

type Item = { v: string | null; t: number; seq: number }
interface Acct {
  email: string
  password: string
  sessions: Set<string>
  items: Map<string, Item>
  seq: number
  /** items written with a precondition: only another such write replaces them */
  guarded: Set<string>
}

const g = globalThis as { fakeAccounts?: Map<string, Acct> }
export const accounts = (g.fakeAccounts ??= new Map())
export const ACCOUNT_API = 'https://account.test/api'

function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const fail = (status: number, code: string, error: string) => json({ error, code }, status)
let n = 0
const session = (a: Acct) => {
  const t = `${a.email}.${++n}`
  a.sessions.add(t)
  return t
}

/** An account as made by another app (Chinese Brain, At Peace): nothing synced yet. */
export function makeAccount(email: string, password: string) {
  accounts.set(email, { email, password, sessions: new Set(), items: new Map(), seq: 0, guarded: new Set() })
}

/** Set a new password as a reset link does: every session ends. */
export function resetPassword(email: string, password: string) {
  const a = accounts.get(email)!
  a.password = password
  a.sessions.clear()
}

export async function accountService(url: string, init: RequestInit = {}): Promise<Response> {
  const path = url.slice(ACCOUNT_API.length + 1)
  const body = init.body ? JSON.parse(String(init.body)) : {}
  const bearer = new Headers(init.headers).get('Authorization')?.replace(/^Bearer /, '') ?? ''
  const email = String(body.email ?? '').trim().toLowerCase()
  const authed = () => [...accounts.values()].find((a) => a.sessions.has(bearer))
  switch (path) {
    case 'signup': {
      if (String(body.password).length < 8) return fail(400, 'short', 'Use at least 8 characters for your password.')
      if (accounts.has(email)) return fail(409, 'exists', 'This email already has an account. Sign in instead.')
      const a: Acct = { email, password: body.password, sessions: new Set(), items: new Map(), seq: 0, guarded: new Set() }
      accounts.set(email, a)
      return json({ token: session(a), email })
    }
    case 'login': {
      const a = accounts.get(email)
      if (!a || a.password !== body.password) return fail(401, 'wrong', 'That email and password don’t match.')
      return json({ token: session(a), email })
    }
    case 'logout': {
      const a = authed()
      if (!a) return fail(401, 'signed_out', 'You’re signed out. Sign in again.')
      a.sessions.delete(bearer)
      return json({ ok: true })
    }
    case 'sync': {
      const a = authed()
      if (!a) return fail(401, 'signed_out', 'You’re signed out. Sign in again.')
      const app = String(body.app)
      const mine = new Set<string>()
      const rejected = new Set<string>()
      for (const c of body.changes ?? []) {
        if (!String(c.k).startsWith(`@${app}/`)) continue
        const v = c.v == null ? null : canon(c.v)
        const old = a.items.get(c.k)
        const t = Math.min(Number(c.t) || 0, Date.now())
        // A precondition (`if`: the `s` read) beats the times; an item written with one needs one from then on.
        const cond = c.if !== undefined && c.if !== null
        if (cond ? c.if !== (old?.seq ?? 0) : app === 'account' || a.guarded.has(c.k)) {
          rejected.add(c.k)
          continue
        }
        if (!cond && old && old.t > t) continue
        if (cond) a.guarded.add(c.k)
        mine.add(c.k)
        if (old && old.v === v) continue
        a.items.set(c.k, { v, t: Math.max(t, old?.t ?? 0), seq: ++a.seq })
      }
      const changes = [...a.items.entries()]
        .filter(([k, i]) => k.startsWith(`@${app}/`) && (i.seq > (Number(body.since) || 0) || rejected.has(k)) && !mine.has(k))
        .map(([k, i]) => ({ k, v: i.v == null ? null : JSON.parse(i.v), t: i.t, s: i.seq }))
      return json({ seq: a.seq, more: false, changes, ...(rejected.size ? { rejected: [...rejected] } : {}) })
    }
  }
  return fail(404, 'not_found', 'Not found.')
}
