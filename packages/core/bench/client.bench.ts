import { bench, describe } from 'vitest'

import { createClient } from '../src/client.js'
import { Tier } from '../src/tier.js'
import { StaticProvider } from '../src/consent.js'

const disabledClient = createClient('key', 'benchcli', '1.0.0', { disabled: true })
const liveClient = createClient('key', 'benchcli', '1.0.0', {
  endpoint: 'http://127.0.0.1:1',
  consentProvider: new StaticProvider(Tier.Basic),
  exportTimeoutMs: 50,
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
