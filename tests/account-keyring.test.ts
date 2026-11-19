import { describe, expect, it } from 'vitest'
import * as AK from '../src/lib/account-keyring'
import * as K from '../src/lib/keys'
import fixture from './fixtures/account-keyring.json'

// The account's keyring, the same scheme as the account service's (chinesebrain site/public/acct/keyring.js):
// fixtures/account-keyring.json was made there, and opens here.

describe('the account keyring', () => {
  it('opens the shared fixture with its password and recovery key, and its Money in Order wrap gives the data key', async () => {
    const ring = fixture.ring as AK.AccountRing
    expect(AK.isAccountRing(ring)).toBe(true)
    const mk = (await AK.openWithPassword(ring, fixture.password))!
    expect(AK.b64(mk)).toBe(fixture.mk)
    expect(AK.b64((await AK.openWithRecovery(ring, fixture.recovery.toLowerCase()))!)).toBe(fixture.mk)
    expect(await AK.isCurrentRecovery(ring, fixture.recovery)).toBe(true)
    expect(AK.b64((await K.openMasterWrap(mk, fixture.mio))!)).toBe(fixture.dk)
    expect(await K.openMasterWrap(mk, fixture.tdw)).toBe(null)
    expect(await AK.openWithPassword(ring, 'fixture password')).toBe(null)
  })

  it('a password change and a new recovery key keep the master key; the old key stops working', async () => {
    const made = await AK.createAccountRing('first password')
    expect(made.recovery).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{2}$/)
    const moved = await AK.rewrapAccountPassword(made.ring, made.mk, 'second password')
    expect(await AK.openWithPassword(moved, 'first password')).toBe(null)
    expect(await AK.openWithPassword(moved, 'second password')).toEqual(made.mk)
    const next = await AK.newAccountRecovery(moved, made.mk)
    expect(await AK.openWithRecovery(next.ring, made.recovery)).toBe(null)
    expect(await AK.openWithRecovery(next.ring, next.recovery)).toEqual(made.mk)
    expect(await AK.isCurrentRecovery(next.ring, made.recovery)).toBe(false)
  })

  it('reads keys as typed, and refuses what cannot be one', () => {
    const bytes = new Uint8Array(16).map((_, i) => i * 17)
    const text = AK.formatRecovery(bytes)
    expect(AK.parseRecovery(text.toLowerCase().replace(/-/g, ' '))).toEqual(bytes)
    expect(AK.parseRecovery(text.replace(/0/g, 'o'))).toEqual(bytes)
    expect(AK.parseRecovery('ABCD')).toBe(null)
    expect(AK.parseRecovery('U'.repeat(26))).toBe(null)
  })

  it('a keyring of this app under the master key: v 2, the same data key', async () => {
    const made = await AK.createAccountRing('pw pw pw pw')
    const dk = K.newDataKey()
    const ring = await K.masterRing(dk, made.mk, made.ring.id, 123)
    expect(K.isMasterRing(ring)).toBe(true)
    expect(K.isKeyring(ring)).toBe(false)
    expect(await K.openMasterWrap(made.mk, K.masterWrap(ring, made.ring.id)!)).toEqual(dk)
    expect(K.masterWrap(ring, 'other')).toBe(null)
  })
})
