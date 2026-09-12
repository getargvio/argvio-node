import { describe, expect, it, afterEach, vi } from 'vitest'

import { createClient } from '../src/client.js'
import { Tier, ErrorCategory } from '../src/tier.js'
import { StaticProvider } from '../src/consent.js'

// Every test uses a loopback endpoint that nothing listens on, and a
// tiny export timeout, so batch processors never actually succeed a
// network call (and the test suite never depends on network access).
const NOWHERE = 'http://127.0.0.1:1'

function makeClient(tier: Tier = Tier.Anonymous) {
  return createClient('test-key', 'testcli', '1.0.0', {
    endpoint: NOWHERE,
    consentProvider: new StaticProvider(tier),
    exportTimeoutMs: 50,
    shutdownTimeoutMs: 200,
  })
}

describe('createClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('never throws on bad options', () => {
    expect(() =>
      createClient('', '', '', { transport: 'grpc', endpoint: 'not a url at all!!' }),
    ).not.toThrow()
  })

  it('returns a disabled client when disabled: true', () => {
    const client = createClient('key', 'cli', '1.0.0', { disabled: true })
    expect(client.disabled).toBe(true)
    expect(client.tier).toBe(Tier.Anonymous)
  })

  it('returns a disabled client when ARGVIO_DISABLED=1', () => {
    vi.stubEnv('ARGVIO_DISABLED', '1')
    const client = createClient('key', 'cli', '1.0.0')
    expect(client.disabled).toBe(true)
  })

  it('returns a disabled client when DO_NOT_TRACK requests it', () => {
    vi.stubEnv('DO_NOT_TRACK', '1')
    const client = createClient('key', 'cli', '1.0.0')
    expect(client.disabled).toBe(true)
  })

  it('resolves the tier from a ConsentProvider', () => {
    const client = makeClient(Tier.Full)
    expect(client.disabled).toBe(false)
    expect(client.tier).toBe(Tier.Full)
  })

  it('falls back to defaultTier when the ConsentProvider throws', () => {
    const client = createClient('key', 'cli', '1.0.0', {
      endpoint: NOWHERE,
      defaultTier: Tier.Basic,
      consentProvider: {
        resolve: () => {
          throw new Error('boom')
        },
      },
    })
    expect(client.tier).toBe(Tier.Basic)
  })
})

describe('Client record* methods are always safe to call', () => {
  it('never throw on a disabled client', () => {
    const client = createClient('key', 'cli', '1.0.0', { disabled: true })
    expect(() => {
      client.recordSessionStart()
      client.recordSessionEnd()
      client.recordCommandInvocation('cli sub', ['flag'])
      client.recordExitCode('cli sub', 1)
      client.recordLatency('cli sub', 12)
      client.recordHelpFlagUsage('cli sub')
      client.recordError('cli sub', ErrorCategory.Network)
    }).not.toThrow()
  })

  it('never throw on a live client, even with malformed input', () => {
    const client = makeClient(Tier.OptIn)
    expect(() => {
      // @ts-expect-error intentionally wrong types for the robustness test
      client.recordCommandInvocation(null, undefined)
      // @ts-expect-error intentionally wrong types for the robustness test
      client.recordError(undefined, 'not-a-real-category')
    }).not.toThrow()
  })
})

describe('tier gating', () => {
  it('drops recordError below Tier.Full and counts it', () => {
    const client = makeClient(Tier.Basic)
    client.recordError('cli sub', ErrorCategory.Internal)
    expect(client.stats().belowTierDropped).toBeGreaterThan(0)
  })

  it('allows recordError at Tier.Full', () => {
    const client = makeClient(Tier.Full)
    client.recordError('cli sub', ErrorCategory.Internal)
    expect(client.stats().belowTierDropped).toBe(0)
  })

  it('optIn() returns undefined below Tier.OptIn', () => {
    const client = makeClient(Tier.Full)
    expect(client.optIn()).toBeUndefined()
  })

  it('optIn() returns a usable scope at Tier.OptIn', () => {
    const client = makeClient(Tier.OptIn)
    const scope = client.optIn()
    expect(scope).toBeDefined()
    expect(() => scope?.recordErrorDetail('cli sub', new Error('detail'))).not.toThrow()
  })

  it('recordLatency and recordExitCode work at every tier, including Anonymous', () => {
    const client = makeClient(Tier.Anonymous)
    expect(() => {
      client.recordLatency('cli sub', 5)
      client.recordExitCode('cli sub', 0)
    }).not.toThrow()
    expect(client.stats().belowTierDropped).toBe(0)
  })
})

describe('queue overflow', () => {
  it('counts drops instead of blocking when the queue is full', () => {
    const client = createClient('key', 'cli', '1.0.0', {
      endpoint: NOWHERE,
      consentProvider: new StaticProvider(Tier.Basic),
      queueSize: 1,
      exportTimeoutMs: 50,
    })
    for (let i = 0; i < 50; i++) {
      client.recordCommandInvocation(`cli sub${i}`, [])
    }
    expect(client.stats().queueOverflowDropped).toBeGreaterThan(0)
  })
})

describe('flush / shutdown', () => {
  it('shutdown is idempotent and safe to call/record against afterward', async () => {
    const client = makeClient(Tier.Basic)
    client.recordSessionStart()
    await client.shutdown(200)
    await expect(client.shutdown(200)).resolves.toBeUndefined()
    expect(() => client.recordExitCode('cli sub', 0)).not.toThrow()
  })

  it('is a safe no-op on a disabled client', async () => {
    const client = createClient('key', 'cli', '1.0.0', { disabled: true })
    await expect(client.flush(50)).resolves.toBeUndefined()
    await expect(client.shutdown(50)).resolves.toBeUndefined()
  })

  it('flush resolves within its timeout even against an unreachable endpoint', async () => {
    const client = makeClient(Tier.Basic)
    client.recordCommandInvocation('cli sub', [])
    const start = Date.now()
    await client.flush(100)
    expect(Date.now() - start).toBeLessThan(2000)
  })
})
