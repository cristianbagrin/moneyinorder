// The keys behind sync, shared with the one account at account.cristianbagrin.com.
//
// Each budget has a data key (DK): 32 random bytes made once, on the first device. The vault's id and its
// encryption key are derived from it, so the servers never see it. The account keeps a keyring for it (the
// synced item `@mio/keyring`): DK encrypted under the account's master key (see account-keyring.ts), so the
// account's password and its one recovery key open it, as they open every app's.
//
//   keyring (v 2)   { v: 2, mkid, mk: AES-GCM over DK under HKDF(MK, "mio/dk-wrap"), created }
//   vault id        hex(SHA-256(HKDF(DK, "mio/vault-id")))
//   vault key       HKDF(DK, "mio/vault-key") as AES-256-GCM
//
// Keyrings from before the account's master key (v 1) wrapped DK under the password and a recovery key of this
// app's own; they still open (a sign-in moves them to v 2):
//   password wrap   PBKDF2-SHA256(password NFC, random 16-byte salt, 600,000 rounds) → AES-GCM over DK
//   recovery wrap   HKDF-SHA256(recovery key bytes, info "mio/recovery") → AES-GCM over DK
//
// WebCrypto only.

import { unwrapAppKey, wrapAppKey, type Box } from './account-keyring'

export const APP = 'mio'
export const KEYRING = `@${APP}/keyring`
const PW_ROUNDS = 600_000
const enc = new TextEncoder()

export interface Wrapped {
  iv: string
  ct: string
}

export interface Keyring {
  v: 1
  /** the password wrap's PBKDF2 salt (base64) */
  salt: string
  pw: Wrapped
  rk: Wrapped
  /** when the data key was made: the same for the life of the budget, so a device can tell its key belongs here */
  created: number
}

export function b64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function unb64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export const hex = (b: ArrayBuffer | Uint8Array) =>
  [...(b instanceof Uint8Array ? b : new Uint8Array(b))].map((x) => x.toString(16).padStart(2, '0')).join('')

export const random = (n: number) => crypto.getRandomValues(new Uint8Array(n))

/** A new data key. */
export const newDataKey = () => random(32)

async function hkdf(secret: Uint8Array, info: string, usage: 'aes' | 'bits'): Promise<CryptoKey | ArrayBuffer> {
  const base = await crypto.subtle.importKey('raw', secret as BufferSource, 'HKDF', false, ['deriveKey', 'deriveBits'])
  const alg = { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) }
  if (usage === 'bits') return crypto.subtle.deriveBits(alg, base, 256)
  return crypto.subtle.deriveKey(alg, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

const hkdfKey = (secret: Uint8Array, info: string) => hkdf(secret, info, 'aes') as Promise<CryptoKey>

async function wrap(key: CryptoKey, data: Uint8Array): Promise<Wrapped> {
  const iv = random(12)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data as BufferSource))
  return { iv: b64(iv), ct: b64(ct) }
}

/** The data key, or null when this key doesn't open it (AES-GCM checks). */
async function unwrap(key: CryptoKey, w: Wrapped | undefined): Promise<Uint8Array | null> {
  if (!w?.iv || !w.ct) return null
  try {
    const dk = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(w.iv) as BufferSource }, key, unb64(w.ct) as BufferSource))
    return dk.length === 32 ? dk : null
  } catch {
    return null
  }
}

async function passwordKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: PW_ROUNDS },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

const recoveryKek = (rk: Uint8Array) => hkdfKey(rk, `${APP}/recovery`)

// ---------------------------------------------------------------- recovery keys

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A new recovery key: 16 random bytes. */
export const newRecoveryKey = () => random(16)

/** 26 characters in groups of four: `K7QM-2XRA-9F3T-HW8C-PJ4N-QD6V-RT`. */
export function formatRecoveryKey(bytes: Uint8Array): string {
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let s = ''
  for (let i = 0; i < 26; i++) {
    s = CROCKFORD[Number(n & 31n)] + s
    n >>= 5n
  }
  return s.match(/.{1,4}/g)!.join('-')
}

/** The bytes of a recovery key as typed (any case, with or without dashes and spaces), or null when it can't be one. */
export function parseRecoveryKey(text: string): Uint8Array | null {
  const s = text.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')
  if (s.length !== 26) return null
  let n = 0n
  for (const ch of s) {
    const v = CROCKFORD.indexOf(ch)
    if (v < 0) return null
    n = (n << 5n) | BigInt(v)
  }
  if (n >> 128n) return null // 130 bits written, the top two always 0
  const out = new Uint8Array(16)
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(n & 255n)
    n >>= 8n
  }
  return out
}

// ---------------------------------------------------------------- the keyring

/** A keyring for a data key, wrapped under the password and a recovery key. */
export async function makeKeyring(dk: Uint8Array, password: string, rk: Uint8Array, created = Date.now()): Promise<Keyring> {
  const salt = random(16)
  const [pw, rkw] = await Promise.all([wrap(await passwordKey(password, salt), dk), wrap(await recoveryKek(rk), dk)])
  return { v: 1, salt: b64(salt), pw, rk: rkw, created }
}

export function isKeyring(v: unknown): v is Keyring {
  const k = v as Keyring | null
  return !!k && typeof k === 'object' && k.v === 1 && typeof k.salt === 'string' && !!k.pw && !!k.rk && typeof k.created === 'number'
}

// ---------------------------------------------------------------- the keyring under the account's master key

/** DK under the account's master key (`mkid` names it). */
export interface MasterRing {
  v: 2
  mkid: string
  mk: Box
  created: number
}

/**
 * Any keyring the account may hold: v 2, v 1, or v 1 on its way to v 2 (the master key's wrap added, the old
 * wraps not yet dropped: a move interrupted between its two writes).
 */
export type AnyRing = MasterRing | (Keyring & { mkid?: string; mk?: Box })

export function isMasterRing(v: unknown): v is MasterRing {
  const k = v as MasterRing | null
  return !!k && typeof k === 'object' && k.v === 2 && typeof k.mkid === 'string' && typeof k.mk?.ct === 'string' && typeof k.created === 'number'
}

export const isAnyRing = (v: unknown): v is AnyRing => isMasterRing(v) || isKeyring(v)

/** This keyring's wrap under the master key `mkid`, if it has one. */
export const masterWrap = (r: AnyRing, mkid: string): Box | null => (r.mkid === mkid && r.mk?.ct ? r.mk : null)

export async function masterRing(dk: Uint8Array, mk: Uint8Array, mkid: string, created: number): Promise<MasterRing> {
  return { v: 2, mkid, mk: await wrapAppKey(mk, APP, dk), created }
}

export const openMasterWrap = (mk: Uint8Array, box: Box) => unwrapAppKey(mk, APP, box)

export async function unlockWithPassword(k: Keyring, password: string): Promise<Uint8Array | null> {
  return unwrap(await passwordKey(password, unb64(k.salt)), k.pw)
}

export async function unlockWithRecovery(k: Keyring, rk: Uint8Array): Promise<Uint8Array | null> {
  return unwrap(await recoveryKek(rk), k.rk)
}

/** The same keyring with the password wrap made again under `password` (a new salt). */
export async function rewrapPassword(k: Keyring, dk: Uint8Array, password: string): Promise<Keyring> {
  const salt = random(16)
  return { ...k, salt: b64(salt), pw: await wrap(await passwordKey(password, salt), dk) }
}

/** The same keyring under a new recovery key: the old one stops working. */
export async function rewrapRecovery(k: Keyring, dk: Uint8Array, rk: Uint8Array): Promise<Keyring> {
  return { ...k, rk: await wrap(await recoveryKek(rk), dk) }
}

// ---------------------------------------------------------------- the vault, from the data key

/** The vault's id (names it on the server) and its AES-GCM key. */
export async function vaultKeys(dk: Uint8Array): Promise<{ id: string; key: CryptoKey }> {
  const idBits = (await hkdf(dk, `${APP}/vault-id`, 'bits')) as ArrayBuffer
  const [id, key] = await Promise.all([crypto.subtle.digest('SHA-256', idBits), hkdfKey(dk, `${APP}/vault-key`)])
  return { id: hex(id), key }
}

// ---------------------------------------------------------------- moving from the old accounts

/**
 * Where an old account's budget went: its data key, encrypted under the old account's secret, left next to the
 * old vault. A device still on the old account finds it on its next sync and moves on its own.
 */
export async function sealMoved(dk: Uint8Array, oldSecret: string): Promise<string> {
  const w = await wrap(await hkdfKey(enc.encode(oldSecret), `${APP}/moved`), dk)
  return JSON.stringify({ v: 1, ...w })
}

export async function openMoved(blob: string, oldSecret: string): Promise<Uint8Array | null> {
  try {
    const w = JSON.parse(blob) as Wrapped & { v: number }
    if (w.v !== 1) return null
    return unwrap(await hkdfKey(enc.encode(oldSecret), `${APP}/moved`), w)
  } catch {
    return null
  }
}

/** The data key as kept in this device's sync settings (`code`), and back. */
export const DK_PREFIX = 'dk1.'
export const codeOf = (dk: Uint8Array) => DK_PREFIX + b64(dk)
export const dkOf = (code: string | null | undefined): Uint8Array | null => (code?.startsWith(DK_PREFIX) ? unb64(code.slice(DK_PREFIX.length)) : null)
