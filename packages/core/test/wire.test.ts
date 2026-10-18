import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SpanStatusCode } from '@opentelemetry/api'
import type { Attributes } from '@opentelemetry/api'
import { describe, expect, it, vi } from 'vitest'

import {
  AttrActivationFeature,
  AttrCommandName,
  AttrDurationMs,
  AttrErrorMessage,
  AttrErrorType,
  AttrExitCode,
  AttrFlagNames,
  AttrInstallId,
  AttrInstallMethod,
  AttrBinarySizeBytes,
  AttrCpuTimeMs,
  AttrPeakRssBytes,
  AttrSessionId,
  AttrStartupDurationMs,
  Client,
  ErrorCategory,
  EventCommandCompleted,
  EventCommandInvoked,
  EventErrorRaised,
  EventFeatureActivated,
  EventHelpViewed,
  EventSessionStarted,
  Tier,
} from '../src/index.js'
import {
  commandName,
  loadOrCreateInstallId,
  readBinarySizeBytes,
  readProcessResourceUsage,
  readStartupDurationMs,
} from '../src/taxonomy.js'

interface LogRecord {
  eventName: string
  attributes: Attributes
}

interface SpanRecord {
  name: string
  startTime: number
  endTime?: number
  attributes: Attributes
  status?: { code: SpanStatusCode }
}

// Captures what a Client hands to OTel, so tests can assert on the exact
// wire names the server's allowlist expects.
function capturingClient(
  tier: Tier,
  installIdPath = join(mkdtempSync(join(tmpdir(), 'argvio-')), 'id'),
  installMethod?: string,
) {
  const logs: LogRecord[] = []
  const spans: SpanRecord[] = []
  const client = new Client({
    cliName: 'testcli',
    installIdPath,
    installMethod,
    disabled: false,
    initError: null,
    tier,
    queueSize: 100,
    shutdownTimeoutMs: 1000,
    logger: {
      emit: (rec: { eventName?: string; attributes?: Attributes }) => {
        logs.push({ eventName: rec.eventName ?? '', attributes: rec.attributes ?? {} })
      },
    },
    tracer: {
      startSpan: (name: string, opts: { startTime: number; attributes: Attributes }) => {
        const span: SpanRecord = { name, startTime: opts.startTime, attributes: opts.attributes }
        spans.push(span)
        return {
          setStatus: (status: { code: SpanStatusCode }) => {
            span.status = status
          },
          end: (endTime: number) => {
            span.endTime = endTime
          },
        }
      },
    },
  } as unknown as ConstructorParameters<typeof Client>[0])
  const event = (name: string) => logs.find((l) => l.eventName === name)
  return { client, logs, spans, event }
}

describe('wire format', () => {
  it('emits no identifiers at Tier.Anonymous', async () => {
    const { client, spans, event } = capturingClient(Tier.Anonymous)
    client.recordSessionStart()
    client.recordCommandInvocation('testcli sub', ['verbose'])
    client.recordCommand({
      path: 'testcli sub',
      flagNames: ['verbose'],
      durationMs: 3,
      exitCode: 0,
    })
    await client.flush(500)

    expect(event(EventCommandInvoked)?.attributes[AttrCommandName]).toBe('sub')
    expect(event(EventCommandInvoked)?.attributes).not.toHaveProperty(AttrFlagNames)
    expect(event(EventSessionStarted)?.attributes).not.toHaveProperty(AttrInstallId)
    expect(event(EventSessionStarted)?.attributes).not.toHaveProperty(AttrSessionId)
    expect(spans[0]?.attributes).not.toHaveProperty(AttrFlagNames)
    expect(event(EventCommandCompleted)?.attributes[AttrCommandName]).toBe('sub')
    expect(event(EventCommandCompleted)?.attributes).not.toHaveProperty(AttrSessionId)
    expect(event(EventCommandCompleted)?.attributes).not.toHaveProperty(AttrInstallId)
    expect(event(EventErrorRaised)).toBeUndefined()
  })

  it('adds session, install, flag names and the error category at Tier.Basic', async () => {
    const { client, logs, event } = capturingClient(Tier.Basic)
    client.recordSessionStart()
    client.recordSessionStart()
    client.recordCommandInvocation('testcli sub', ['verbose'])
    client.recordCommand({ path: 'testcli sub', durationMs: 1500, exitCode: 3 })
    client.recordError('testcli sub', ErrorCategory.Internal)
    await client.flush(500)

    expect(logs.filter((l) => l.eventName === EventSessionStarted)).toHaveLength(1)
    const started = event(EventSessionStarted)?.attributes ?? {}
    expect(started[AttrInstallId]).toMatch(/^[0-9a-f-]{36}$/)
    expect(started[AttrSessionId]).toBeTruthy()
    expect(event(EventCommandInvoked)?.attributes[AttrFlagNames]).toEqual(['verbose'])

    // Every later event ties back to the same session and install, so the
    // server can follow one install across commands.
    for (const name of [EventCommandInvoked, EventCommandCompleted, EventErrorRaised]) {
      expect(event(name)?.attributes[AttrSessionId], name).toBe(started[AttrSessionId])
      expect(event(name)?.attributes[AttrInstallId], name).toBe(started[AttrInstallId])
    }
    expect(event(EventCommandCompleted)?.attributes[AttrExitCode]).toBe(3)
    expect(event(EventCommandCompleted)?.attributes[AttrDurationMs]).toBe(1500)
    expect(event(EventErrorRaised)?.attributes[AttrErrorType]).toBe('internal')
    expect(event(EventErrorRaised)?.attributes).not.toHaveProperty(AttrErrorMessage)
  })

  it('reports the install method at every tier, and only when set', async () => {
    for (const tier of [Tier.Anonymous, Tier.Basic]) {
      const { client, event } = capturingClient(tier, undefined, 'brew')
      client.recordSessionStart()
      await client.flush(500)
      expect(event(EventSessionStarted)?.attributes[AttrInstallMethod], String(tier)).toBe('brew')
    }

    const { client, event } = capturingClient(Tier.Basic)
    client.recordSessionStart()
    await client.flush(500)
    expect(event(EventSessionStarted)?.attributes).not.toHaveProperty(AttrInstallMethod)
  })

  it('reports feature activations at Tier.Basic+, once per feature, tied to the install', async () => {
    for (const tier of [Tier.Basic, Tier.Full, Tier.OptIn]) {
      const { client, logs, event } = capturingClient(tier)
      client.recordSessionStart()
      client.recordFeatureActivated('export-csv', 'testcli sub')
      client.recordFeatureActivated('export-csv')
      client.recordFeatureActivated('dark-mode')
      await client.flush(500)

      const activations = logs.filter((l) => l.eventName === EventFeatureActivated)
      expect(
        activations.map((l) => l.attributes[AttrActivationFeature]),
        String(tier),
      ).toEqual(['export-csv', 'dark-mode'])
      const first = activations[0]?.attributes ?? {}
      const started = event(EventSessionStarted)?.attributes ?? {}
      expect(first[AttrCommandName]).toBe('sub')
      expect(first[AttrSessionId]).toBe(started[AttrSessionId])
      expect(first[AttrInstallId]).toBe(started[AttrInstallId])
      expect(activations[1]?.attributes).not.toHaveProperty(AttrCommandName)
    }
  })

  it('emits no feature activation at Tier.Anonymous', async () => {
    const { client, logs } = capturingClient(Tier.Anonymous)
    client.recordFeatureActivated('export-csv', 'testcli sub')
    await client.flush(500)
    expect(logs.filter((l) => l.eventName === EventFeatureActivated)).toHaveLength(0)
    expect(client.stats().belowTierDropped).toBe(1)
  })

  it('truncates the feature name to the server max_length and ignores an empty one', async () => {
    const { client, logs } = capturingClient(Tier.Basic)
    client.recordFeatureActivated('x'.repeat(100))
    client.recordFeatureActivated('')
    await client.flush(500)
    const activations = logs.filter((l) => l.eventName === EventFeatureActivated)
    expect(activations).toHaveLength(1)
    expect(activations[0]?.attributes[AttrActivationFeature]).toBe('x'.repeat(64))
  })

  it('records each command as a cli.command.<name> span', async () => {
    const { client, spans } = capturingClient(Tier.Basic)
    client.recordCommand({
      path: 'testcli deploy push',
      flagNames: ['force'],
      startMs: 1_000,
      durationMs: 250,
      exitCode: 2,
    })
    await client.flush(500)

    expect(spans).toHaveLength(1)
    const span = spans[0]!
    expect(span.name).toBe('cli.command.deploy.push')
    expect(span.attributes[AttrCommandName]).toBe('deploy.push')
    expect(span.attributes[AttrExitCode]).toBe(2)
    expect(span.attributes[AttrDurationMs]).toBe(250)
    expect(span.attributes[AttrFlagNames]).toEqual(['force'])
    expect(span.startTime).toBe(1_000)
    expect(span.endTime).toBe(1_250)
    expect(span.status?.code).toBe(SpanStatusCode.ERROR)
  })

  it('reports peak memory and CPU time on the span at Tier.Basic+, in bytes and milliseconds', async () => {
    for (const tier of [Tier.Basic, Tier.Full, Tier.OptIn]) {
      const { client, spans, event } = capturingClient(tier)
      client.recordCommand({ path: 'testcli run', durationMs: 10, exitCode: 0 })
      await client.flush(500)

      const attrs = spans[0]!.attributes
      expect(AttrPeakRssBytes).toBe('cli.process.peak_rss_bytes')
      expect(AttrCpuTimeMs).toBe('cli.process.cpu_time_ms')
      expect(Number.isInteger(attrs[AttrPeakRssBytes])).toBe(true)
      expect(Number.isInteger(attrs[AttrCpuTimeMs])).toBe(true)
      // Bytes, not the kilobytes the OS reports: a Node process is well over 1 MiB.
      expect(attrs[AttrPeakRssBytes] as number).toBeGreaterThan(1024 * 1024)
      // The server's allowlist only accepts these on the span.
      expect(event(EventCommandCompleted)?.attributes).not.toHaveProperty(AttrPeakRssBytes)
      expect(event(EventCommandCompleted)?.attributes).not.toHaveProperty(AttrCpuTimeMs)
    }
  })

  it('sends no memory or CPU figures at Tier.Anonymous', async () => {
    const { client, spans, logs } = capturingClient(Tier.Anonymous)
    client.recordCommand({ path: 'testcli run', durationMs: 10, exitCode: 0 })
    await client.flush(500)

    expect(spans[0]!.attributes).not.toHaveProperty(AttrPeakRssBytes)
    expect(spans[0]!.attributes).not.toHaveProperty(AttrCpuTimeMs)
    for (const log of logs) {
      expect(log.attributes).not.toHaveProperty(AttrPeakRssBytes)
      expect(log.attributes).not.toHaveProperty(AttrCpuTimeMs)
    }
  })

  it('omits the figures, and still records the command, when the OS call fails', async () => {
    const resourceUsage = vi.spyOn(process, 'resourceUsage').mockImplementation(() => {
      throw new Error('ENOSYS')
    })
    const cpuUsage = vi.spyOn(process, 'cpuUsage').mockImplementation(() => {
      throw new Error('ENOSYS')
    })
    try {
      const { client, spans } = capturingClient(Tier.Basic)
      client.recordCommand({ path: 'testcli run', durationMs: 10, exitCode: 0 })
      await client.flush(500)

      expect(spans).toHaveLength(1)
      expect(spans[0]!.attributes[AttrDurationMs]).toBe(10)
      expect(spans[0]!.attributes).not.toHaveProperty(AttrPeakRssBytes)
      expect(spans[0]!.attributes).not.toHaveProperty(AttrCpuTimeMs)
    } finally {
      resourceUsage.mockRestore()
      cpuUsage.mockRestore()
    }
  })

  it('normalises kilobytes to bytes and microseconds to milliseconds', () => {
    const resourceUsage = vi
      .spyOn(process, 'resourceUsage')
      .mockReturnValue({ maxRSS: 2048 } as NodeJS.ResourceUsage)
    const cpuUsage = vi.spyOn(process, 'cpuUsage').mockReturnValue({ user: 1_500, system: 2_000 })
    try {
      expect(readProcessResourceUsage()).toEqual({ peakRssBytes: 2_097_152, cpuTimeMs: 4 })
    } finally {
      resourceUsage.mockRestore()
      cpuUsage.mockRestore()
    }
  })

  it('treats zero, negative and non-finite readings as not reported', () => {
    const resourceUsage = vi
      .spyOn(process, 'resourceUsage')
      .mockReturnValue({ maxRSS: 0 } as NodeJS.ResourceUsage)
    const cpuUsage = vi.spyOn(process, 'cpuUsage').mockReturnValue({ user: NaN, system: 0 })
    try {
      expect(readProcessResourceUsage()).toEqual({})
    } finally {
      resourceUsage.mockRestore()
      cpuUsage.mockRestore()
    }
  })

  it('keeps raw error detail out of Tier.Full, which only classifies errors', async () => {
    const { client, event } = capturingClient(Tier.Full)
    client.recordError('testcli sub', ErrorCategory.Network)
    client.recordHelpFlagUsage('testcli sub')
    await client.flush(500)

    expect(event(EventErrorRaised)?.attributes[AttrErrorType]).toBe('network')
    expect(event(EventErrorRaised)?.attributes).not.toHaveProperty(AttrErrorMessage)
    expect(event(EventHelpViewed)?.attributes[AttrCommandName]).toBe('sub')
  })
})

// Pretends to be a Node single executable application whose binary is `size`
// bytes, for the duration of `fn`.
async function asSea(size: number | null, fn: () => Promise<void> | void): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process, 'execPath')!
  const getBuiltinModule = vi
    .spyOn(process, 'getBuiltinModule')
    .mockImplementation(((id: string) =>
      id === 'node:sea' ? { isSea: () => size !== null } : undefined) as never)
  const execPath = join(mkdtempSync(join(tmpdir(), 'argvio-sea-')), 'mycli')
  writeFileSync(execPath, Buffer.alloc(size ?? 0))
  Object.defineProperty(process, 'execPath', { ...original, value: execPath })
  try {
    await fn()
  } finally {
    Object.defineProperty(process, 'execPath', original)
    getBuiltinModule.mockRestore()
  }
}

describe('session start binary size and startup overhead', () => {
  it('reports startup overhead in whole milliseconds at Tier.Basic+, on the session start only', async () => {
    const uptime = vi.spyOn(process, 'uptime').mockReturnValue(0.4567)
    try {
      for (const tier of [Tier.Basic, Tier.Full, Tier.OptIn]) {
        const { client, logs, event } = capturingClient(tier)
        client.recordSessionStart()
        client.recordCommand({ path: 'testcli run', durationMs: 5, exitCode: 0 })
        await client.flush(500)

        expect(AttrStartupDurationMs).toBe('cli.startup.duration_ms')
        expect(event(EventSessionStarted)?.attributes[AttrStartupDurationMs]).toBe(457)
        for (const log of logs.filter((l) => l.eventName !== EventSessionStarted)) {
          expect(log.attributes).not.toHaveProperty(AttrStartupDurationMs)
          expect(log.attributes).not.toHaveProperty(AttrBinarySizeBytes)
        }
      }
    } finally {
      uptime.mockRestore()
    }
  })

  it('reads startup overhead when recordSessionStart is called, not when the job runs', async () => {
    const uptime = vi.spyOn(process, 'uptime').mockReturnValue(0.25)
    try {
      const { client, event } = capturingClient(Tier.Basic)
      client.recordSessionStart()
      uptime.mockReturnValue(9)
      await client.flush(500)
      expect(event(EventSessionStarted)?.attributes[AttrStartupDurationMs]).toBe(250)
    } finally {
      uptime.mockRestore()
    }
  })

  it('sends neither at Tier.Anonymous', async () => {
    await asSea(4096, async () => {
      const { client, event } = capturingClient(Tier.Anonymous)
      client.recordSessionStart()
      await client.flush(500)

      expect(event(EventSessionStarted)).toBeDefined()
      expect(event(EventSessionStarted)?.attributes).not.toHaveProperty(AttrStartupDurationMs)
      expect(event(EventSessionStarted)?.attributes).not.toHaveProperty(AttrBinarySizeBytes)
    })
  })

  it('reports the binary size at Tier.Basic+ when running as a single executable application', async () => {
    await asSea(4096, async () => {
      for (const tier of [Tier.Basic, Tier.Full, Tier.OptIn]) {
        const { client, event } = capturingClient(tier)
        client.recordSessionStart()
        await client.flush(500)

        expect(AttrBinarySizeBytes).toBe('cli.binary.size_bytes')
        expect(event(EventSessionStarted)?.attributes[AttrBinarySizeBytes]).toBe(4096)
      }
    })
  })

  it('omits the binary size when not a single executable application', async () => {
    const { client, event } = capturingClient(Tier.Basic)
    client.recordSessionStart()
    await client.flush(500)

    expect(event(EventSessionStarted)?.attributes).not.toHaveProperty(AttrBinarySizeBytes)
    expect(readBinarySizeBytes()).toBeUndefined()
  })

  it('omits the binary size, and still starts the session, when it cannot be read', async () => {
    const getBuiltinModule = vi.spyOn(process, 'getBuiltinModule').mockImplementation((() => {
      throw new Error('boom')
    }) as never)
    try {
      const { client, event } = capturingClient(Tier.Basic)
      client.recordSessionStart()
      await client.flush(500)

      expect(event(EventSessionStarted)).toBeDefined()
      expect(event(EventSessionStarted)?.attributes).not.toHaveProperty(AttrBinarySizeBytes)
    } finally {
      getBuiltinModule.mockRestore()
    }
  })

  it('omits the binary size when the file is empty or missing, never sending zero', async () => {
    await asSea(0, () => {
      // isSea() is true here, but the file is empty.
      expect(readBinarySizeBytes()).toBeUndefined()
    })
    const getBuiltinModule = vi
      .spyOn(process, 'getBuiltinModule')
      .mockImplementation((() => ({ isSea: () => true })) as never)
    const original = Object.getOwnPropertyDescriptor(process, 'execPath')!
    Object.defineProperty(process, 'execPath', { ...original, value: '/nonexistent/mycli' })
    try {
      expect(readBinarySizeBytes()).toBeUndefined()
    } finally {
      Object.defineProperty(process, 'execPath', original)
      getBuiltinModule.mockRestore()
    }
  })

  it('omits the binary size where process.getBuiltinModule is missing', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'getBuiltinModule')!
    Object.defineProperty(process, 'getBuiltinModule', { ...original, value: undefined })
    try {
      expect(readBinarySizeBytes()).toBeUndefined()
    } finally {
      Object.defineProperty(process, 'getBuiltinModule', original)
    }
  })

  it('omits startup overhead when it is zero, negative, non-finite or throws', () => {
    for (const value of [0, -1, NaN, Infinity]) {
      const uptime = vi.spyOn(process, 'uptime').mockReturnValue(value)
      try {
        expect(readStartupDurationMs()).toBeUndefined()
      } finally {
        uptime.mockRestore()
      }
    }
    const uptime = vi.spyOn(process, 'uptime').mockImplementation(() => {
      throw new Error('ENOSYS')
    })
    try {
      expect(readStartupDurationMs()).toBeUndefined()
    } finally {
      uptime.mockRestore()
    }
  })

  it('does not report on a second recordSessionStart', async () => {
    const { client, logs } = capturingClient(Tier.Basic)
    client.recordSessionStart()
    client.recordSessionStart()
    await client.flush(500)
    expect(logs.filter((l) => l.eventName === EventSessionStarted)).toHaveLength(1)
  })
})

describe('commandName', () => {
  it.each([
    ['testcli deploy push', 'deploy.push'],
    ['testcli', 'testcli'],
    ['', 'testcli'],
    ['other sub', 'other.sub'],
  ])('%j -> %j', (path, want) => {
    expect(commandName('testcli', path)).toBe(want)
  })
})

describe('loadOrCreateInstallId', () => {
  it('is stable, replaces a corrupt file, and is empty when it cannot persist', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'argvio-')), 'nested', 'id')
    const first = loadOrCreateInstallId(path)
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(loadOrCreateInstallId(path)).toBe(first)

    writeFileSync(path, 'not-a-uuid')
    const replaced = loadOrCreateInstallId(path)
    expect(replaced).not.toBe(first)
    expect(replaced).toMatch(/^[0-9a-f-]{36}$/)

    expect(loadOrCreateInstallId(join(path, 'under-a-file'))).toBe('')
    expect(loadOrCreateInstallId(undefined)).toBe('')
  })
})
