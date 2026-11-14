// The part of Cloudflare R2's Worker binding the sync server uses, typed here so the app's TypeScript setup
// (DOM types) can check the Worker too, and so tests can stand in an in-memory bucket (tests/fake-r2.ts).
//
// R2 is strongly consistent (a read, head or list sees every write that finished, from anywhere), and a
// conditional put is checked against the stored object atomically, as part of the write itself.
//
// One bucket holds what Netlify kept in three Blobs stores, under the same names as key prefixes:
//   vaults/<vault id>                  the encrypted snapshot; customMetadata.rev is its revision
//   vault-changes/<vault id>/<change>  encrypted changes on top of that snapshot
//   accounts/<email hash>              "1": this email has an account

export interface StoredObject {
  key: string
  etag: string
  customMetadata?: Record<string, string>
}

export interface StoredBody extends StoredObject {
  text(): Promise<string>
}

export interface PutOptions {
  customMetadata?: Record<string, string>
  /** `{ etagMatches }` writes only over that exact object; `If-None-Match: *` only where nothing is stored yet. */
  onlyIf?: { etagMatches?: string } | Headers
}

export interface Bucket {
  head(key: string): Promise<StoredObject | null>
  get(key: string): Promise<StoredBody | null>
  /** Resolves to null, writing nothing, when `onlyIf` doesn't hold. */
  put(key: string, value: string, options?: PutOptions): Promise<StoredObject | null>
  delete(keys: string | string[]): Promise<void>
  list(options?: { prefix?: string; cursor?: string }): Promise<{ objects: StoredObject[]; truncated: boolean; cursor?: string }>
}

/** Every key under a prefix (R2 pages its listings). */
export async function keysUnder(bucket: Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = []
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix, cursor })
    for (const o of page.objects) keys.push(o.key)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return keys
}

/** Put-if-absent: the write fails (null) when the key already holds something. */
export const ifNew = () => new Headers({ 'If-None-Match': '*' })
