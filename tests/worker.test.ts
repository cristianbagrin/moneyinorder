import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import worker, { SECURITY_HEADERS, type Env } from '../worker/index'
import { bucket, countUnder, objects } from './fake-r2'

// The Worker's routing, limits and headers. The sync logic itself runs against the same handlers in sync-log and tabs.

const ID = 'a'.repeat(64)
/** Each limiter counts on its own, as each rate limiting binding does. */
const counts: Map<string, number>[] = []
const limiter = (max: number) => {
  const used = new Map<string, number>()
  counts.push(used)
  return {
    async limit({ key }: { key: string }) {
      used.set(key, (used.get(key) ?? 0) + 1)
      return { success: used.get(key)! <= max }
    },
  }
}
const env: Env = {
  ASSETS: { fetch: async (req) => new Response('asset ' + new URL(req.url).pathname) },
  DATA: bucket,
  VAULT_RATE_LIMITER: limiter(120),
  ACCOUNT_RATE_LIMITER: limiter(30),
}
const call = (path: string, init: RequestInit = {}, ip = '1.2.3.4') =>
  worker.fetch(new Request('https://moneyinorder.cristianbagrin.com' + path, { ...init, headers: { 'CF-Connecting-IP': ip, ...init.headers } }), env)

beforeEach(() => {
  objects.clear()
  for (const used of counts) used.clear()
})

describe('the Worker', () => {
  it('leaves everything outside /api/ to the static files', async () => {
    expect(await (await call('/')).text()).toBe('asset /')
    expect(await (await call('/assets/x.js')).text()).toBe('asset /assets/x.js')
  })

  it('answers 404 for unknown API paths and 400 for bad ids', async () => {
    expect((await call('/api/nothing')).status).toBe(404)
    expect((await call('/api/vault/')).status).toBe(404)
    expect((await call(`/api/vault/${ID}/more`)).status).toBe(404)
    expect((await call('/api/vault/xyz')).status).toBe(400)
    expect((await call('/api/account/XYZ')).status).toBe(400)
  })

  it('notes an account once', async () => {
    expect((await call(`/api/account/${ID}`, { method: 'HEAD' })).status).toBe(404)
    expect((await call(`/api/account/${ID}`, { method: 'PUT' })).status).toBe(201)
    expect((await call(`/api/account/${ID}`, { method: 'PUT' })).status).toBe(409)
    expect((await call(`/api/account/${ID}`, { method: 'HEAD' })).status).toBe(200)
    expect((await call(`/api/account/${ID}`, { method: 'DELETE' })).status).toBe(405)
  })

  it('writes a vault only on top of the revision it names', async () => {
    const put = (base: string, body = 'v1.x', covers = '') =>
      call(`/api/vault/${ID}`, { method: 'PUT', body, headers: { 'X-Base-Rev': base, 'X-Covers': covers } })
    expect((await call(`/api/vault/${ID}`)).status).toBe(404)
    expect((await put('', 'v1.a')).status).toBe(428)
    expect((await put('new', 'nope')).status).toBe(400)
    const first = await put('new', 'v1.a')
    expect(first.status).toBe(201)
    const rev = first.headers.get('X-Rev')!
    expect((await put('new', 'v1.b')).status).toBe(412)
    expect((await put('someone-else', 'v1.b')).status).toBe(412)

    const post = await call(`/api/vault/${ID}`, { method: 'POST', body: 'v1.change' })
    expect(post.status).toBe(201)
    const change = post.headers.get('X-Change')!
    expect(change).toMatch(/^[0-9a-f]{16}$/)

    const pulled = await call(`/api/vault/${ID}`, { headers: { 'X-Sync': '2' } })
    expect(pulled.headers.get('Content-Type')).toBe('application/json')
    expect(await pulled.json()).toEqual({ rev, changes: [change], snap: 'v1.a', add: [[change, 'v1.change']] })
    const known = await call(`/api/vault/${ID}`, { headers: { 'X-Sync': '2', 'X-Have-Rev': rev, 'X-Have': change } })
    expect(await known.json()).toEqual({ rev, changes: [change], add: [] })

    const second = await put(rev, 'v1.b', change)
    expect(second.status).toBe(201)
    expect(countUnder('vault-changes/')).toBe(0)
    const legacy = await call(`/api/vault/${ID}`)
    expect(legacy.headers.get('X-Rev')).toBe(second.headers.get('X-Rev'))
    expect(await legacy.text()).toBe('v1.b')
    expect((await call(`/api/vault/${ID}`, { headers: { 'X-Have-Rev': second.headers.get('X-Rev')! } })).status).toBe(204)

    expect((await call(`/api/vault/${ID}`, { method: 'DELETE' })).status).toBe(204)
    expect(objects.size).toBe(0)
  })

  it('limits requests per IP: 120 a minute for vaults, 30 for accounts', async () => {
    for (let i = 0; i < 30; i++) expect((await call(`/api/account/${ID}`)).status).toBe(404)
    const limited = await call(`/api/account/${ID}`)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('Cache-Control')).toBe('no-store')
    expect((await call(`/api/account/${ID}`, {}, '5.6.7.8')).status).toBe(404)
    for (let i = 0; i < 120; i++) expect((await call(`/api/vault/${ID}`)).status).toBe(404)
    expect((await call(`/api/vault/${ID}`)).status).toBe(429)
  })

  it('sends the same security headers as the static files', async () => {
    const res = await call(`/api/vault/${ID}`)
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(k)).toBe(v)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const file = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')
    const all = file.split('\n/*\n')[1]
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(all).toContain(`  ${k}: ${v}\n`)
  })
})
