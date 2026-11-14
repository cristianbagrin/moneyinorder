import { account } from './account'
import type { Bucket } from './bucket'
import { vault } from './vault'

// The whole server: the built app (dist/, served by Workers Static Assets with the headers in public/_headers)
// and the two sync routes. Only /api/* reaches this code (see run_worker_first in wrangler.jsonc).

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> }
  DATA: Bucket
  VAULT_RATE_LIMITER: RateLimiter
  ACCOUNT_RATE_LIMITER: RateLimiter
}

/** public/_headers gives the app's pages these too; tests/worker.test.ts keeps the two the same. */
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' https://cdn.jsdelivr.net https://latest.currency-api.pages.dev; manifest-src 'self'; worker-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
}

const ROUTE = /^\/api\/(vault|account)\/([^/]+)$/

function secured(res: Response): Response {
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v)
  return out
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req)
    const m = url.pathname.match(ROUTE)
    if (!m) return secured(new Response('Not found', { status: 404 }))
    const [, route, id] = m
    // Per client IP and domain, like the Netlify limits these replace: 120 vault and 30 account requests a minute.
    const limiter = route === 'vault' ? env.VAULT_RATE_LIMITER : env.ACCOUNT_RATE_LIMITER
    const { success } = await limiter.limit({ key: `${req.headers.get('CF-Connecting-IP') ?? ''}|${url.hostname}` })
    if (!success) return secured(new Response('Too many requests', { status: 429, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } }))
    return secured(route === 'vault' ? await vault(req, id, env.DATA) : await account(req, id, env.DATA))
  },
}
