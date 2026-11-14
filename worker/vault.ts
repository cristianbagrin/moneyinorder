import { ifNew, keysUnder, type Bucket, type StoredObject } from './bucket'

// One encrypted snapshot per account (or, from before accounts, per sync code). The id is a hash made on
// the device and the content is encrypted there, so this server only ever handles ciphertext.
//
// Every write gets a new revision id, stored in the object's metadata and returned as X-Rev.
// A write must name the revision it was based on (X-Base-Rev), so two devices can never
// silently overwrite each other: the loser gets 412, pulls, merges and tries again.
// (Custom headers rather than If-Match / ETag, so caches and proxies on the way can't consume them.)
//
// Next to that snapshot, a vault keeps a short log of changes: each one an encrypted set of the
// records a device changed since its last upload (POST). Records merge commutatively and idempotently,
// so changes need no revision check: the vault's data is the snapshot merged with every change, in any
// order. A device now and then writes the whole merged budget as a new snapshot (PUT) and names the
// changes it folded in (X-Covers); only those are dropped, so a change appended meanwhile survives.
// Clients that send X-Sync: 2 get the snapshot and changes they lack in one JSON reply; older clients
// keep getting the bare snapshot.

const MAX_BYTES = 4 * 1024 * 1024
/** A client that never folds changes into a snapshot is asked to (409) once this many are waiting. */
const MAX_CHANGES = 100
const CHANGE_ID = /^[0-9a-f]{16}$/

const snapshotKey = (id: string) => `vaults/${id}`
const changePrefix = (id: string) => `vault-changes/${id}/`

async function changeIds(bucket: Bucket, id: string): Promise<string[]> {
  const prefix = changePrefix(id)
  return (await keysUnder(bucket, prefix)).map((k) => k.slice(prefix.length))
}

/** Change ids from a comma-separated header (anything malformed is ignored). */
function idList(header: string | null): string[] {
  return (header ?? '').split(',').filter((c) => CHANGE_ID.test(c))
}

function revOf(meta: StoredObject | null): string | null {
  const rev = meta?.customMetadata?.rev
  return typeof rev === 'string' ? rev : null
}

const noStore = { 'Cache-Control': 'no-store' }

export async function vault(req: Request, id: string, bucket: Bucket): Promise<Response> {
  if (!/^[0-9a-f]{64}$/.test(id)) return new Response('Bad id', { status: 400 })

  if (req.method === 'GET' || req.method === 'HEAD') {
    const meta = await bucket.head(snapshotKey(id))
    if (!meta) return new Response(null, { status: 404, headers: noStore })
    const rev = revOf(meta) ?? ''
    if (req.method === 'GET' && req.headers.get('X-Sync') === '2') {
      // Everything the client lacks: the snapshot when it changed, and the changes it hasn't got.
      const changes = await changeIds(bucket, id)
      const have = new Set(idList(req.headers.get('X-Have')))
      let snap: string | undefined
      let snapRev = rev
      if (!rev || req.headers.get('X-Have-Rev') !== rev) {
        const entry = await bucket.get(snapshotKey(id))
        if (!entry) return new Response(null, { status: 404, headers: noStore })
        snap = await entry.text()
        snapRev = revOf(entry) ?? rev
      }
      const add = (
        await Promise.all(
          changes
            .filter((c) => !have.has(c))
            .map(async (c) => [c, await (await bucket.get(changePrefix(id) + c))?.text()] as const),
        )
      ).filter((e): e is readonly [string, string] => typeof e[1] === 'string')
      const body = JSON.stringify({ rev: snapRev, changes, snap, add })
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', ...noStore } })
    }
    if (rev && req.headers.get('X-Have-Rev') === rev) {
      return new Response(null, { status: 204, headers: { 'X-Rev': rev, ...noStore } })
    }
    if (req.method === 'HEAD') return new Response(null, { status: 200, headers: { 'X-Rev': rev, ...noStore } })
    const entry = await bucket.get(snapshotKey(id))
    if (!entry) return new Response(null, { status: 404, headers: noStore })
    return new Response(await entry.text(), {
      status: 200,
      headers: { 'X-Rev': revOf(entry) ?? rev, 'Content-Type': 'text/plain', ...noStore },
    })
  }

  if (req.method === 'PUT') {
    const body = await req.text()
    if (!body.startsWith('v1.') || body.length > MAX_BYTES) return new Response('Bad payload', { status: 400 })
    const base = req.headers.get('X-Base-Rev')
    if (!base) return new Response('X-Base-Rev required', { status: 428 })
    const meta = await bucket.head(snapshotKey(id))
    const current = meta ? (revOf(meta) ?? '') : null
    const stale = base === 'new' ? current !== null : current !== base
    if (stale) return new Response('Changed elsewhere', { status: 412, headers: noStore })
    const rev = crypto.randomUUID()
    // The check and the write are one atomic step: R2 writes only over the exact object checked above,
    // or only where there is none yet, and otherwise writes nothing.
    const written = await bucket.put(snapshotKey(id), body, {
      customMetadata: { rev },
      onlyIf: meta ? { etagMatches: meta.etag } : ifNew(),
    })
    if (!written) return new Response('Changed elsewhere', { status: 412, headers: noStore })
    // The snapshot holds these changes now. (If a delete fails, the change is merged again: harmless.)
    const covered = idList(req.headers.get('X-Covers')).map((c) => changePrefix(id) + c)
    if (covered.length) await bucket.delete(covered).catch(() => {})
    return new Response(null, { status: 201, headers: { 'X-Rev': rev, ...noStore } })
  }

  if (req.method === 'POST') {
    const body = await req.text()
    if (!body.startsWith('v1.') || body.length > MAX_BYTES) return new Response('Bad payload', { status: 400 })
    // Changes only go on top of a snapshot: without one the client uploads everything instead.
    if (!(await bucket.head(snapshotKey(id)))) return new Response(null, { status: 404, headers: noStore })
    if ((await changeIds(bucket, id)).length >= MAX_CHANGES) return new Response('Too many changes', { status: 409, headers: noStore })
    const change = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    await bucket.put(changePrefix(id) + change, body)
    return new Response(null, { status: 201, headers: { 'X-Change': change, ...noStore } })
  }

  if (req.method === 'DELETE') {
    const changes = (await changeIds(bucket, id)).map((c) => changePrefix(id) + c)
    // R2 deletes at most 1000 keys per call; a vault never has more than MAX_CHANGES.
    if (changes.length) await bucket.delete(changes).catch(() => {})
    await bucket.delete(snapshotKey(id))
    return new Response(null, { status: 204 })
  }

  return new Response('Method not allowed', { status: 405 })
}
