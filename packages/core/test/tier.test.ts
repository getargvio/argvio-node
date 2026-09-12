import { describe, expect, it } from 'vitest'

import {
  Tier,
  tierAllows,
  clampTier,
  tierToString,
  parseTier,
  isValidTier,
  ErrorCategory,
  isValidErrorCategory,
} from '../src/tier.js'

describe('tierAllows', () => {
  it('allows the same tier and everything below it', () => {
    expect(tierAllows(Tier.Full, Tier.Basic)).toBe(true)
    expect(tierAllows(Tier.Full, Tier.Full)).toBe(true)
  })

  it('rejects tiers above the resolved tier', () => {
    expect(tierAllows(Tier.Full, Tier.OptIn)).toBe(false)
    expect(tierAllows(Tier.Basic, Tier.Full)).toBe(false)
  })
})

describe('clampTier', () => {
  it('returns the lower of tier and ceiling', () => {
    expect(clampTier(Tier.OptIn, Tier.Basic)).toBe(Tier.Basic)
    expect(clampTier(Tier.Anonymous, Tier.Full)).toBe(Tier.Anonymous)
  })
})

describe('tierToString / parseTier', () => {
  it('round-trips every known tier', () => {
    for (const tier of [Tier.Anonymous, Tier.Basic, Tier.Full, Tier.OptIn]) {
      expect(parseTier(tierToString(tier))).toBe(tier)
    }
  })

  it('fails closed to undefined on unknown strings', () => {
    expect(parseTier('super-admin')).toBeUndefined()
    expect(parseTier('')).toBeUndefined()
  })
})

describe('isValidTier', () => {
  it('accepts only the four known tiers', () => {
    expect(isValidTier(Tier.Anonymous)).toBe(true)
    expect(isValidTier(Tier.OptIn)).toBe(true)
    expect(isValidTier(99)).toBe(false)
    expect(isValidTier(-1)).toBe(false)
  })
})

describe('isValidErrorCategory', () => {
  it('accepts every declared category', () => {
    for (const category of Object.values(ErrorCategory)) {
      expect(isValidErrorCategory(category)).toBe(true)
    }
  })

  it('rejects arbitrary strings', () => {
    expect(isValidErrorCategory('totally-made-up')).toBe(false)
  })
})
