import { describe, expect, it } from 'vitest'
import { onOldAddress } from '../src/ui/moved'

describe('the old address says the app moved', () => {
  it('shows only on Netlify addresses', () => {
    expect(onOldAddress('moneyinorder.netlify.app')).toBe(true)
    expect(onOldAddress('money-in-order.netlify.app')).toBe(true)
    expect(onOldAddress('deploy-preview-3--money-in-order.netlify.app')).toBe(true)
    expect(onOldAddress('moneyinorder.cristianbagrin.com')).toBe(false)
    expect(onOldAddress('localhost')).toBe(false)
    expect(onOldAddress('evilnetlify.app')).toBe(false)
  })
})
