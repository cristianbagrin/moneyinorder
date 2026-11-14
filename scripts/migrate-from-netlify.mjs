// Moves the sync data from Netlify Blobs to the Worker's R2 bucket. Every blob is ciphertext or a hash, but
// it is still the budget: this script never prints a blob's contents, and dumps stay out of git (.gitignore).
//
//   node scripts/migrate-from-netlify.mjs export <dump-dir>                 read every Netlify Blobs store into <dump-dir>
//   node scripts/migrate-from-netlify.mjs check  <dump-dir>                 the dump's files match its manifests
//   node scripts/migrate-from-netlify.mjs import <dump-dir> --remote|--local write the dump into R2
//   node scripts/migrate-from-netlify.mjs verify <dump-dir> --remote|--local R2 holds everything in the dump
//
// export needs NETLIFY_TOKEN and the Blobs client, which the app no longer depends on:
//   npm install --no-save @netlify/blobs@11.1.4
// import and verify go through Wrangler's R2 binding: --remote uses the account Wrangler is logged in to
// (`npx wrangler login`, or CLOUDFLARE_API_TOKEN); --local writes where `wrangler dev` keeps its data
// (.wrangler/state, or --persist-to <dir> as given to `wrangler dev`). --bucket <name> overrides the bucket.
//
// Dump layout (the same as a backup made by hand): <dump-dir>/<store>/_manifest.json lists
// { key, file, bytes, sha256, etag, metadata } per blob, and <dump-dir>/<store>/<file> holds its exact bytes
// (file = encodeURIComponent(key)). In R2 each store becomes a key prefix: <store>/<key> (see worker/bucket.ts),
// and a vault's metadata.rev becomes its customMetadata.rev.
//
// Safe to run again, and after the new site is in use: import never overwrites. What is already in R2 and equal
// is skipped. A vault that R2 holds in a different version (the app on Cloudflare has written it since, or the
// dump is newer) is not replaced: the dump's snapshot is added to that vault's change log instead, which devices
// merge record by record, newest edit winning, exactly like any other change. Nothing either side wrote is lost.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE_ID = '64c8d96a-50c3-4fac-9c6a-dd5c69730fcd'
const STORES = ['accounts', 'vaults', 'vault-changes']
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG = path.join(ROOT, 'wrangler.jsonc')

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
/** Keys are hashes; a short prefix is enough to tell them apart in a report. */
const short = (key) => (key.length > 20 ? key.slice(0, 12) + '…' : key)

function fail(msg) {
  console.error(msg)
  process.exit(1)
}

function args() {
  const [cmd, dir, ...rest] = process.argv.slice(2)
  const opt = (name) => {
    const i = rest.indexOf(name)
    return i >= 0 ? (rest[i + 1] ?? fail(`${name} needs a value`)) : undefined
  }
  if (!cmd || !dir) fail('Usage: node scripts/migrate-from-netlify.mjs export|check|import|verify <dump-dir> [--remote|--local] [--persist-to <dir>] [--bucket <name>]')
  return { cmd, dir: path.resolve(dir), remote: rest.includes('--remote'), local: rest.includes('--local'), persistTo: opt('--persist-to'), bucket: opt('--bucket') }
}

// ---------------------------------------------------------------- export (Netlify -> dump)

async function exportDump(dir) {
  const token = process.env.NETLIFY_TOKEN || fail('Set NETLIFY_TOKEN (a Netlify personal access token).')
  if (existsSync(dir) && (await readdir(dir)).length) fail(`${dir} isn't empty: export into a new folder.`)
  let blobs
  try {
    blobs = await import('@netlify/blobs')
  } catch {
    fail('Install the Blobs client first: npm install --no-save @netlify/blobs@11.1.4')
  }
  const { stores } = await blobs.listStores({ siteID: SITE_ID, token })
  console.log(`Netlify stores: ${stores.join(', ')}`)
  const unknown = stores.filter((s) => !STORES.includes(s))
  if (unknown.length) console.warn(`! Not used by the app, dumped anyway but not imported: ${unknown.join(', ')}`)
  for (const name of stores) {
    const store = blobs.getStore({ name, siteID: SITE_ID, token })
    const { blobs: list } = await store.list()
    await mkdir(path.join(dir, name), { recursive: true })
    const manifest = []
    for (const { key } of list) {
      const entry = await store.getWithMetadata(key, { type: 'arrayBuffer' })
      if (!entry) fail(`${name}/${short(key)} vanished while exporting: run export again into a new folder.`)
      const bytes = Buffer.from(entry.data)
      const file = encodeURIComponent(key)
      await writeFile(path.join(dir, name, file), bytes)
      manifest.push({ key, file, bytes: bytes.length, sha256: sha256(bytes), etag: entry.etag, metadata: entry.metadata ?? {} })
    }
    await writeFile(path.join(dir, name, '_manifest.json'), JSON.stringify(manifest, null, 2))
    console.log(`  ${name}: ${manifest.length} blobs, ${manifest.reduce((n, e) => n + e.bytes, 0)} bytes`)
  }
  await checkDump(dir)
}

// ---------------------------------------------------------------- the dump

/** Every store in the dump with its entries and their bytes, each checked against its manifest. */
async function readDump(dir) {
  if (!existsSync(dir)) fail(`No dump at ${dir}`)
  const out = []
  for (const name of (await readdir(dir)).sort()) {
    const manifestFile = path.join(dir, name, '_manifest.json')
    if (!existsSync(manifestFile)) continue
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
    const entries = []
    for (const e of manifest) {
      const bytes = await readFile(path.join(dir, name, e.file))
      if (bytes.length !== e.bytes || sha256(bytes) !== e.sha256) fail(`${name}/${short(e.key)}: file doesn't match its manifest. Stopping before anything is written.`)
      entries.push({ ...e, data: bytes })
    }
    out.push({ name, entries })
  }
  if (!out.length) fail(`No <store>/_manifest.json under ${dir}`)
  const unknown = out.filter((s) => !STORES.includes(s.name)).map((s) => s.name)
  if (unknown.length) fail(`The dump has stores the app doesn't use (${unknown.join(', ')}). Move them out of ${dir} and run again.`)
  for (const { name, entries } of out) {
    for (const e of entries) {
      const ok = name === 'vault-changes' ? /^[0-9a-f]{64}\/[0-9a-f]{16}$/.test(e.key) : /^[0-9a-f]{64}$/.test(e.key)
      if (!ok) fail(`${name}/${short(e.key)}: not a key the app makes. Stopping before anything is written.`)
    }
  }
  return out
}

async function checkDump(dir) {
  const dump = await readDump(dir)
  for (const { name, entries } of dump) console.log(`  ${name}: ${entries.length} blobs, all match the manifest`)
  return dump
}

// ---------------------------------------------------------------- R2 through Wrangler

async function openBucket({ remote, local, persistTo, bucket }) {
  if (remote === local) fail('Say where: --remote (the real bucket) or --local (wrangler dev’s copy).')
  let wrangler
  try {
    wrangler = await import('wrangler')
  } catch {
    fail('Run npm install first (Wrangler is a dev dependency).')
  }
  const name = bucket ?? 'moneyinorder-data'
  let configPath = CONFIG
  let tmp
  if (remote || bucket) {
    // A throwaway config with only the bucket, marked remote so Wrangler talks to the real one.
    tmp = await mkdtemp(path.join(tmpdir(), 'mio-migrate-'))
    configPath = path.join(tmp, 'wrangler.json')
    const r2 = { binding: 'DATA', bucket_name: name, ...(remote ? { remote: true } : {}) }
    await writeFile(configPath, JSON.stringify({ name: 'moneyinorder-migrate', account_id: '1da66eb742220c8ae068a08cdeeaade3', compatibility_date: '2026-11-01', r2_buckets: [r2] }))
  }
  const persist = remote ? false : { path: path.join(path.resolve(persistTo ?? path.join(ROOT, '.wrangler/state')), 'v3') }
  const proxy = await wrangler.getPlatformProxy({ configPath, persist, remoteBindings: remote })
  console.log(remote ? `R2 bucket ${name} (remote)` : `R2 bucket ${name} (local: ${persist.path})`)
  return {
    r2: proxy.env.DATA,
    async close() {
      await proxy.dispose()
      if (tmp) await rm(tmp, { recursive: true, force: true })
    },
  }
}

const ifNew = () => new Headers({ 'If-None-Match': '*' })

async function bytesOf(obj) {
  return Buffer.from(await obj.arrayBuffer())
}

/** Every key under a prefix. */
async function keysUnder(r2, prefix) {
  const keys = []
  let cursor
  do {
    const page = await r2.list({ prefix, cursor })
    for (const o of page.objects) keys.push(o.key)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return keys
}

/** Where a vault snapshot from the dump goes when R2 already holds another version of that vault. */
const mergeKey = (e) => `vault-changes/${e.key}/${e.sha256.slice(0, 16)}`

// ---------------------------------------------------------------- import (dump -> R2)

async function importDump(opts) {
  const dump = await checkDump(opts.dir)
  const { r2, close } = await openBucket(opts)
  const tally = {}
  const count = (what) => (tally[what] = (tally[what] ?? 0) + 1)
  const problems = []
  try {
    // Accounts and change logs first, snapshots last: a vault is only visible to the app once its log is in.
    const order = ['accounts', 'vault-changes', 'vaults']
    for (const { name, entries } of dump.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))) {
      for (const e of entries) {
        const key = `${name}/${e.key}`
        const customMetadata = Object.fromEntries(Object.entries(e.metadata ?? {}).filter(([, v]) => typeof v === 'string'))
        const written = await r2.put(key, e.data, { customMetadata, onlyIf: ifNew() })
        if (written) {
          count(`${name}: written`)
          continue
        }
        // Already there: equal, or a different version.
        const have = await r2.get(key)
        const same = have && sha256(await bytesOf(have)) === e.sha256 && (name !== 'vaults' || (have.customMetadata?.rev ?? '') === (e.metadata?.rev ?? ''))
        if (same || name === 'accounts') {
          count(`${name}: already there`)
          continue
        }
        if (name === 'vault-changes') {
          problems.push(`${short(e.key)}: R2 holds a different change under this id; left as it is`)
          count(`${name}: conflict, left alone`)
          continue
        }
        // A vault R2 holds in another version: add the dump's snapshot to its change log, to be merged in.
        const merged = await r2.put(mergeKey(e), e.data, { onlyIf: ifNew() })
        count(merged ? 'vaults: differs in R2, added as a change to merge' : 'vaults: differs in R2, already added as a change')
      }
    }
  } finally {
    await close()
  }
  for (const [what, n] of Object.entries(tally)) console.log(`  ${what}: ${n}`)
  for (const p of problems) console.warn(`! ${p}`)
  console.log(problems.length ? 'Imported, with the problems above.' : 'Imported. Now run verify.')
  if (problems.length) process.exitCode = 1
}

// ---------------------------------------------------------------- verify (R2 has the dump)

async function verify(opts) {
  const dump = await readDump(opts.dir)
  const { r2, close } = await openBucket(opts)
  let bad = 0
  try {
    // Vaults a device has written since the import: their old changes may have been folded in and dropped.
    const rewritten = new Set()
    for (const e of dump.find((s) => s.name === 'vaults')?.entries ?? []) {
      const head = await r2.head(`vaults/${e.key}`)
      if (head && (head.customMetadata?.rev ?? '') !== (e.metadata?.rev ?? '')) rewritten.add(e.key)
    }
    for (const { name, entries } of dump) {
      const inR2 = new Set(await keysUnder(r2, `${name}/`))
      let same = 0
      let merged = 0
      for (const e of entries) {
        const obj = await r2.get(`${name}/${e.key}`)
        const hash = obj ? sha256(await bytesOf(obj)) : null
        const revOk = name !== 'vaults' || (obj?.customMetadata?.rev ?? '') === (e.metadata?.rev ?? '')
        if (obj && hash === e.sha256 && revOk) same++
        else if (obj && name === 'vaults' && (await r2.get(mergeKey(e))) && sha256(await bytesOf(await r2.get(mergeKey(e)))) === e.sha256) merged++
        else if (obj && name === 'accounts') same++
        else if (!obj && name === 'vault-changes' && rewritten.has(e.key.split('/')[0])) merged++ // folded into a newer snapshot since
        else {
          bad++
          console.warn(`! ${name}/${short(e.key)}: ${obj ? 'differs from the dump' : 'missing from R2'}`)
        }
      }
      const extra = [...inR2].filter((k) => !entries.some((e) => `${name}/${e.key}` === k)).length
      console.log(
        `  ${name}: dump ${entries.length}, R2 ${inR2.size}; identical ${same}` +
          (merged ? `, ${name === 'vaults' ? 'merged in as a change' : 'gone from R2 since (folded into a snapshot)'} ${merged}` : '') +
          (extra ? `, ${extra} more in R2 than in the dump (written since)` : ''),
      )
    }
  } finally {
    await close()
  }
  if (bad) fail(`${bad} blob(s) are missing or differ. Run import again, then verify.`)
  console.log('Verified: everything in the dump is in R2.')
}

const opts = args()
if (opts.cmd === 'export') await exportDump(opts.dir)
else if (opts.cmd === 'check') await checkDump(opts.dir)
else if (opts.cmd === 'import') await importDump(opts)
else if (opts.cmd === 'verify') await verify(opts)
else fail(`Unknown command ${opts.cmd}`)
