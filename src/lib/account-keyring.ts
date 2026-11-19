// The account keyring: one master key (MK) and one recovery key for the whole cristianbagrin.com account, so one
// password and one recovery key open every app's data key. The scheme is defined, with the rules every app keeps,
// in the account service's repo (chinesebrain `site/public/acct/keyring.js`); this is the same scheme in
// TypeScript. tests/account-keyring.test.ts opens the keyring that repo's tests open.
//
//   @account/keyring  { v: 1, id, salt, pw, rk, rkid, created }  (sync app 'account', written only with `if`)
//     pw    AES-GCM over MK, key PBKDF2-SHA256(password NFC, salt, 600,000), additional data "account/keyring/pw"
//     rk    AES-GCM over MK, key HKDF(recovery key, "account/recovery"), additional data "account/keyring/rk"
//     id    hex(HKDF(MK, "account/key-id"))[0..16];  rkid  hex(HKDF(recovery key, "account/recovery-id"))[0..16]
//   an app's data key under MK: AES-GCM, key HKDF(MK, "<app>/dk-wrap"), additional data "<app>/keyring/mk"
//
// The recovery key is 16 random bytes as 26 Crockford base32 characters, the bits read from the left (the
// account's keys, shown by any app, read the same everywhere; Money in Order's older per-app keys were written
// from the right, see keys.ts).

const ROUNDS = 600_000
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const enc = new TextEncoder()

export interface Box {
  iv: string
  ct: string
}

export interface AccountRing {
  v: 1
  id: string
  salt: string
  pw: Box
  rk: Box
  rkid: string
  created: number
}

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n))

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

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

// ---------------------------------------------------------------- the recovery key as text

export function formatRecovery(bytes: Uint8Array): string {
  let bits = 0
  let n = 0
  let out = ''
  for (const b of bytes) {
    bits = (bits << 8) | b
    n += 8
    while (n >= 5) {
      out += ALPHABET[(bits >>> (n - 5)) & 31]
      n -= 5
    }
    bits &= (1 << n) - 1
  }
  if (n > 0) out += ALPHABET[(bits << (5 - n)) & 31]
  return out.match(/.{1,4}/g)!.join('-')
}

/** 16 bytes, or null when the text can't be an account recovery key. */
export function parseRecovery(text: string): Uint8Array | null {
  const s = String(text || '').toUpperCase().replace(/[\s\-_.]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (s.length !== 26) return null
  const out = new Uint8Array(16)
  let bits = 0
  let n = 0
  let k = 0
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch)
    if (v < 0) return null
    bits = (bits << 5) | v
    n += 5
    if (n >= 8) {
      if (k < 16) out[k++] = (bits >>> (n - 8)) & 255
      n -= 8
    }
    bits &= (1 << n) - 1
  }
  return k === 16 && bits === 0 ? out : null
}

// ---------------------------------------------------------------- keys

async function hkdfBits(secret: Uint8Array, info: string): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', secret as BufferSource, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) }, base, 256))
}

async function hkdfKey(secret: Uint8Array, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', secret as BufferSource, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) }, base, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
}

async function passwordKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: ROUNDS }, base, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
}

async function seal(key: CryptoKey, data: Uint8Array, label: string): Promise<Box> {
  const iv = random(12)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(label) }, key, data as BufferSource)
  return { iv: b64(iv), ct: b64(new Uint8Array(ct)) }
}

async function open(key: CryptoKey, box: Box | undefined, label: string): Promise<Uint8Array | null> {
  if (!box || typeof box.iv !== 'string' || typeof box.ct !== 'string') return null
  try {
    const out = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) as BufferSource, additionalData: enc.encode(label) }, key, unb64(box.ct) as BufferSource),
    )
    return out.length === 32 ? out : null
  } catch {
    return null
  }
}

export const keyId = async (mk: Uint8Array) => hex(await hkdfBits(mk, 'account/key-id')).slice(0, 16)
const recoveryId = async (rk: Uint8Array) => hex(await hkdfBits(rk, 'account/recovery-id')).slice(0, 16)

// ---------------------------------------------------------------- the account keyring

export function isAccountRing(r: unknown): r is AccountRing {
  const k = r as AccountRing | null
  return (
    !!k &&
    typeof k === 'object' &&
    k.v === 1 &&
    typeof k.id === 'string' &&
    typeof k.salt === 'string' &&
    typeof k.pw?.ct === 'string' &&
    typeof k.rk?.ct === 'string' &&
    typeof k.created === 'number'
  )
}

/** A new master key, its keyring, and the recovery key to show. */
export async function createAccountRing(password: string): Promise<{ mk: Uint8Array; recovery: string; ring: AccountRing }> {
  const mk = random(32)
  const rk = random(16)
  const salt = random(16)
  const [pw, rkBox, id, rkid] = await Promise.all([
    passwordKey(password, salt).then((k) => seal(k, mk, 'account/keyring/pw')),
    hkdfKey(rk, 'account/recovery').then((k) => seal(k, mk, 'account/keyring/rk')),
    keyId(mk),
    recoveryId(rk),
  ])
  return { mk, recovery: formatRecovery(rk), ring: { v: 1, id, salt: b64(salt), pw, rk: rkBox, rkid, created: Date.now() } }
}

export async function openWithPassword(ring: AccountRing, password: string): Promise<Uint8Array | null> {
  const mk = await open(await passwordKey(password, unb64(ring.salt)), ring.pw, 'account/keyring/pw')
  return mk && (await keyId(mk)) === ring.id ? mk : null
}

export async function openWithRecovery(ring: AccountRing, text: string): Promise<Uint8Array | null> {
  const rk = parseRecovery(text)
  if (!rk) return null
  const mk = await open(await hkdfKey(rk, 'account/recovery'), ring.rk, 'account/keyring/rk')
  return mk && (await keyId(mk)) === ring.id ? mk : null
}

export async function rewrapAccountPassword(ring: AccountRing, mk: Uint8Array, password: string): Promise<AccountRing> {
  const salt = random(16)
  return { ...ring, salt: b64(salt), pw: await seal(await passwordKey(password, salt), mk, 'account/keyring/pw') }
}

/** A new recovery key for the account: the old one stops working, in every app, once this keyring is written. */
export async function newAccountRecovery(ring: AccountRing, mk: Uint8Array): Promise<{ recovery: string; ring: AccountRing }> {
  const rk = random(16)
  const [box, rkid] = await Promise.all([hkdfKey(rk, 'account/recovery').then((k) => seal(k, mk, 'account/keyring/rk')), recoveryId(rk)])
  return { recovery: formatRecovery(rk), ring: { ...ring, rk: box, rkid } }
}

/** This recovery key is the one the account keyring holds now. */
export async function isCurrentRecovery(ring: AccountRing, text: string): Promise<boolean> {
  const rk = parseRecovery(text)
  return !!rk && ring.rkid === (await recoveryId(rk))
}

// ---------------------------------------------------------------- an app's data key under MK

export async function wrapAppKey(mk: Uint8Array, app: string, dk: Uint8Array): Promise<Box> {
  return seal(await hkdfKey(mk, `${app}/dk-wrap`), dk, `${app}/keyring/mk`)
}

export async function unwrapAppKey(mk: Uint8Array, app: string, box: Box | undefined): Promise<Uint8Array | null> {
  return open(await hkdfKey(mk, `${app}/dk-wrap`), box, `${app}/keyring/mk`)
}
