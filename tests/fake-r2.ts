// An in-memory stand-in for the R2 bucket the Worker uses (worker/bucket.ts), with R2's conditional puts.
import type { Bucket, PutOptions, StoredObject } from '../worker/bucket'

type Entry = { data: string; customMetadata: Record<string, string>; etag: string }
// On globalThis, so a test that reloads its modules still talks to the same server.
const g = globalThis as { fakeR2?: Map<string, Entry> }
export const objects = (g.fakeR2 ??= new Map())
let etags = 0

const meta = (key: string, e: Entry): StoredObject => ({ key, etag: e.etag, customMetadata: { ...e.customMetadata } })

/** How many objects are stored under a prefix. */
export const countUnder = (prefix: string) => [...objects.keys()].filter((k) => k.startsWith(prefix)).length

export const bucket: Bucket = {
  async head(key) {
    const e = objects.get(key)
    return e ? meta(key, e) : null
  },
  async get(key) {
    const e = objects.get(key)
    return e ? { ...meta(key, e), text: async () => e.data } : null
  },
  async put(key, data, opts: PutOptions = {}) {
    const e = objects.get(key)
    const c = opts.onlyIf
    if (c instanceof Headers) {
      if (c.get('If-None-Match') === '*' && e) return null
    } else if (c?.etagMatches !== undefined && e?.etag !== c.etagMatches) return null
    const next = { data, customMetadata: opts.customMetadata ?? {}, etag: `${++etags}-${Math.random()}` }
    objects.set(key, next)
    return meta(key, next)
  },
  async delete(keys) {
    for (const k of typeof keys === 'string' ? [keys] : keys) objects.delete(k)
  },
  // Pages of two, so callers must follow the cursor as they must with R2.
  async list({ prefix = '', cursor } = {}) {
    const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
    const from = cursor ? Number(cursor) : 0
    const page = all.slice(from, from + 2)
    const truncated = from + 2 < all.length
    return { objects: page.map((k) => meta(k, objects.get(k)!)), truncated, cursor: truncated ? String(from + 2) : undefined }
  },
}
