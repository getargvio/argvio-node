import { bench, describe } from 'vitest'

import { createClient } from '../src/client.js'
import { Tier } from '../src/tier.js'
import { StaticProvider } from '../src/consent.js'
import { readProcessResourceUsage } from '../src/taxonomy.js'

const disabledClient = createClient('key', 'benchcli', '1.0.0', { disabled: true })
const liveClient = createClient('key', 'benchcli', '1.0.0', {
  endpoint: 'http://127.0.0.1:1',
  consentProvider: new StaticProvider(Tier.Basic),
  exportTimeoutMs: 50,
})

// The memory and CPU read happens once per recordCommand at Tier.Basic+.
// Compare these against the Anonymous client, which skips it, to see the
// cost of the two counter reads: it should be in the noise.
const anonymousClient = createClient('key', 'benchcli', '1.0.0', {
  endpoint: 'http://127.0.0.1:1',
  consentProvider: new StaticProvider(Tier.Anonymous),
  exportTimeoutMs: 50,
})

describe('resource usage overhead', () => {
  bench('readProcessResourceUsage', () => {
    readProcessResourceUsage()
  })

  bench('recordCommand at Anonymous (no resource usage)', () => {
    anonymousClient.recordCommand({ path: 'benchcli run', durationMs: 12, exitCode: 0 })
  })

  bench('recordCommand at Basic (with resource usage)', () => {
    liveClient.recordCommand({ path: 'benchcli run', durationMs: 12, exitCode: 0 })
  })
})

describe('record* call overhead', () => {
  bench('disabled client: recordCommandInvocation + recordExitCode + recordLatency', () => {
    disabledClient.recordCommandInvocation('benchcli run', ['flag'])
    disabledClient.recordExitCode('benchcli run', 0)
    disabledClient.recordLatency('benchcli run', 12)
  })

  bench('instrumented client: recordCommandInvocation + recordExitCode + recordLatency', () => {
    liveClient.recordCommandInvocation('benchcli run', ['flag'])
    liveClient.recordExitCode('benchcli run', 0)
    liveClient.recordLatency('benchcli run', 12)
  })
})
