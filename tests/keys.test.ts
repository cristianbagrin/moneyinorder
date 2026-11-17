import { describe, expect, it } from 'vitest'
import * as K from '../src/lib/keys'

// The data key, its keyring (password and recovery wraps), recovery keys as text, and the vault keys it gives.

describe('recovery keys', () => {
  it('are 26 Crockford characters in groups of four and read back exactly', () => {
    for (let i = 0; i < 200; i++) {
      const rk = K.newRecoveryKey()
      const text = K.formatRecoveryKey(rk)
      expect(text).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{2}$/)
      expect(text.replace(/-/g, '')).toHaveLength(26)
      expect(K.parseRecoveryKey(text)).toEqual(rk)
    }
  })

  it('read in any case, with spaces or without dashes, and with look-alike letters', () => {
    const rk = new Uint8Array(16).map((_, i) => i * 17)
    const text = K.formatRecoveryKey(rk)
    expect(K.parseRecoveryKey(text.toLowerCase())).toEqual(rk)
    expect(K.parseRecoveryKey(text.replace(/-/g, ''))).toEqual(rk)
    expect(K.parseRecoveryKey(' ' + text.replace(/-/g, ' ') + ' ')).toEqual(rk)
    const withOs = K.formatRecoveryKey(new Uint8Array(16)) // all zeros
    expect(K.parseRecoveryKey(withOs.replace(/0/g, 'o'))).toEqual(new Uint8Array(16))
  })

  it('refuse what cannot be a key', () => {
    expect(K.parseRecoveryKey('')).toBeNull()
    expect(K.parseRecoveryKey('ABCD')).toBeNull()
    expect(K.parseRecoveryKey('U'.repeat(26))).toBeNull() // U is not in the alphabet
    expect(K.parseRecoveryKey('Z'.repeat(26))).toBeNull() // more than 128 bits
  })
})

describe('the keyring', () => {
  it('opens with the password and with the recovery key, and with nothing else', async () => {
    const dk = K.newDataKey()
    const rk = K.newRecoveryKey()
    const ring = await K.makeKeyring(dk, 'correct horse', rk)
    expect(K.isKeyring(ring)).toBe(true)
    expect(K.isKeyring(JSON.parse(JSON.stringify(ring)))).toBe(true)
    expect(await K.unlockWithPassword(ring, 'correct horse')).toEqual(dk)
    expect(await K.unlockWithPassword(ring, 'correct horsf')).toBeNull()
    expect(await K.unlockWithRecovery(ring, rk)).toEqual(dk)
    expect(await K.unlockWithRecovery(ring, K.newRecoveryKey())).toBeNull()
    // the salt is random, not the email
    const again = await K.makeKeyring(dk, 'correct horse', rk)
    expect(again.salt).not.toBe(ring.salt)
  })

  it('takes the password in NFC, so the same password typed on another keyboard opens it', async () => {
    const dk = K.newDataKey()
    const ring = await K.makeKeyring(dk, 'café au lait', K.newRecoveryKey())
    expect(await K.unlockWithPassword(ring, 'café au lait')).toEqual(dk)
  })

  it('re-wraps under a new password: the old one stops working, the recovery key keeps working', async () => {
    const dk = K.newDataKey()
    const rk = K.newRecoveryKey()
    const ring = await K.makeKeyring(dk, 'first password', rk, 1234)
    const next = await K.rewrapPassword(ring, dk, 'second password')
    expect(next.created).toBe(1234)
    expect(next.rk).toEqual(ring.rk)
    expect(await K.unlockWithPassword(next, 'first password')).toBeNull()
    expect(await K.unlockWithPassword(next, 'second password')).toEqual(dk)
    expect(await K.unlockWithRecovery(next, rk)).toEqual(dk)
  })

  it('a recovery unlock after a password reset, then a re-wrap, opens with the new password', async () => {
    const dk = K.newDataKey()
    const rk = K.newRecoveryKey()
    const ring = await K.makeKeyring(dk, 'forgotten one', rk)
    expect(await K.unlockWithPassword(ring, 'the new one')).toBeNull()
    const typed = K.parseRecoveryKey(K.formatRecoveryKey(rk).toLowerCase())!
    const got = await K.unlockWithRecovery(ring, typed)
    expect(got).toEqual(dk)
    const fixed = await K.rewrapPassword(ring, got!, 'the new one')
    expect(await K.unlockWithPassword(fixed, 'the new one')).toEqual(dk)
  })

  it('a new recovery key replaces the old one', async () => {
    const dk = K.newDataKey()
    const old = K.newRecoveryKey()
    const ring = await K.makeKeyring(dk, 'a password', old)
    const fresh = K.newRecoveryKey()
    const next = await K.rewrapRecovery(ring, dk, fresh)
    expect(await K.unlockWithRecovery(next, old)).toBeNull()
    expect(await K.unlockWithRecovery(next, fresh)).toEqual(dk)
    expect(await K.unlockWithPassword(next, 'a password')).toEqual(dk)
  })

  it('a tampered wrap does not open', async () => {
    const dk = K.newDataKey()
    const ring = await K.makeKeyring(dk, 'a password', K.newRecoveryKey())
    const bytes = K.unb64(ring.pw.ct)
    bytes[3] ^= 1
    expect(await K.unlockWithPassword({ ...ring, pw: { ...ring.pw, ct: K.b64(bytes) } }, 'a password')).toBeNull()
  })
})

describe('vault keys and the move from old accounts', () => {
  it('are the same for the same data key and differ between keys', async () => {
    const dk = K.newDataKey()
    const a = await K.vaultKeys(dk)
    const b = await K.vaultKeys(new Uint8Array(dk))
    expect(a.id).toMatch(/^[0-9a-f]{64}$/)
    expect(a.id).toBe(b.id)
    expect((await K.vaultKeys(K.newDataKey())).id).not.toBe(a.id)
    // b's key opens what a's encrypts
    const iv = new Uint8Array(12)
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, a.key, new TextEncoder().encode('hi'))
    expect(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, b.key, ct))).toBe('hi')
  })

  it('the moved note opens only with the old secret', async () => {
    const dk = K.newDataKey()
    const note = await K.sealMoved(dk, 'aa'.repeat(32))
    expect(await K.openMoved(note, 'aa'.repeat(32))).toEqual(dk)
    expect(await K.openMoved(note, 'ab'.repeat(32))).toBeNull()
    expect(await K.openMoved('nonsense', 'aa'.repeat(32))).toBeNull()
  })

  it('keeps the data key in the sync settings as text', () => {
    const dk = K.newDataKey()
    expect(K.dkOf(K.codeOf(dk))).toEqual(dk)
    expect(K.dkOf('ABCDE-FGHJK-MNPQR-STUVW')).toBeNull()
  })
})
