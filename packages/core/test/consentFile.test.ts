import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Tier } from '../src/tier.js'
import { FileConsentProvider } from '../src/consentFile.js'

describe('FileConsentProvider', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'argvio-consent-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips store/resolve', () => {
    const path = join(dir, 'nested', 'argvio-consent.json')
    const provider = new FileConsentProvider('mycli', { path })
    provider.store(Tier.Full)
    expect(provider.resolve()).toBe(Tier.Full)
  })

  it('throws for a missing file', () => {
    const provider = new FileConsentProvider('mycli', { path: join(dir, 'missing.json') })
    expect(() => provider.resolve()).toThrow()
  })

  it('throws for malformed JSON', () => {
    const path = join(dir, 'bad.json')
    const provider = new FileConsentProvider('mycli', { path })
    provider.store(Tier.Basic)
    // Corrupt it after a valid write.
    writeFileSync(path, '{not json')
    expect(() => provider.resolve()).toThrow()
  })

  it('throws for an unknown tier value', () => {
    const path = join(dir, 'unknown-tier.json')
    writeFileSync(path, JSON.stringify({ tier: 'super-admin' }))
    const provider = new FileConsentProvider('mycli', { path })
    expect(() => provider.resolve()).toThrow()
  })

  it('rejects storing an invalid tier', () => {
    const provider = new FileConsentProvider('mycli', { path: join(dir, 'x.json') })
    // @ts-expect-error intentionally invalid for the test
    expect(() => provider.store(99)).toThrow()
  })
})
