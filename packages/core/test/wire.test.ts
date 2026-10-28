import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SpanStatusCode } from '@opentelemetry/api'
import type { Attributes } from '@opentelemetry/api'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AttrActivationFeature,
  AttrAuthState,
  AttrCommandName,
  AttrConfigCustomizedCount,
  AttrDurationMs,
  AttrErrorMessage,
  AttrCounterLabel,
  AttrCounterName,
  AttrMeasureLabel,
  AttrMeasureName,
  AttrErrorReason,
  AttrErrorType,
  AttrExitCode,
  AttrFlagNames,
  AttrInstallId,
  AttrInstallMethod,
  AttrBinarySizeBytes,
  AttrCpuTimeMs,
  AttrPeakRssBytes,
  AttrRuntimeName,
  AttrRuntimeVersion,
  AttrSessionId,
  AttrShell,
  AttrStdoutIsTty,
  AttrTerminal,
  AttrStartupDurationMs,
  AuthState,
  Client,
  ErrorCategory,
  createClient,
  EventCommandCompleted,
  EventCommandInvoked,
  EventErrorRaised,
  EventFeatureActivated,
  EventHelpViewed,
  EventSessionStarted,
  MAX_CONFIG_CUSTOMIZED_COUNT,
  MEASURE_BUCKET_BOUNDARIES_MS,
  MetricCounter,
  MetricMeasure,
  Tier,
} from '../src/index.js'
import {
  commandName,
  loadOrCreateInstallId,
  readBinarySizeBytes,
  readProcessResourceUsage,
  readStartupDurationMs,
} from '../src/taxonomy.js'
import { stubStdoutIsTty } from './stdoutTty.js'

interface LogRecord {
  eventName: string
  attributes: Attributes
}

interface MetricAdd {
  value: number
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
  extra: Record<string, unknown> = {},
) {
  const logs: LogRecord[] = []
  const spans: SpanRecord[] = []
  const errorCounts: MetricAdd[] = []
  const counterAdds: MetricAdd[] = []
  const measureRecords: MetricAdd[] = []
  const client = new Client({
    cliName: 'testcli',
    installIdPath,
    installMethod,
    ...extra,
    disabled: false,
    initError: null,
    tier,
    queueSize: 100,
    shutdownTimeoutMs: 1000,
    errorEventsCounter: {
      add: (value: number, attributes: Attributes) => errorCounts.push({ value, attributes }),
    },
    productCounter: {
      add: (value: number, attributes: Attributes) => counterAdds.push({ value, attributes }),
    },
    measureHist: {
      record: (value: number, attributes: Attributes) => measureRecords.push({ value, attributes }),
    },
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
  return { client, logs, spans, errorCounts, counterAdds, measureRecords, event }
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

describe('session start shell, terminal, runtime and TTY', () => {
  const sessionKeys = [
    AttrShell,
    AttrTerminal,
    AttrStdoutIsTty,
    AttrRuntimeName,
    AttrRuntimeVersion,
  ]

  // Clears everything the detection reads, then sets `env`.
  function withEnv(env: Record<string, string>) {
    for (const name of Object.keys(process.env)) {
      if (
        /^(SHELL|TERM_PROGRAM|TMUX|STY|WT_SESSION|VTE_VERSION|PSModulePath|PROMPT|ComSpec)$|_WINDOW_ID$|^(ALACRITTY|KITTY|KONSOLE|XTERM|ITERM|WEZTERM|GHOSTTY)_/.test(
          name,
        )
      ) {
        vi.stubEnv(name, undefined as never)
      }
    }
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  }

  let restoreTty = () => {}

  afterEach(() => {
    restoreTty()
    restoreTty = () => {}
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('uses the exact wire names the server allowlist expects', () => {
    expect(AttrShell).toBe('cli.shell')
    expect(AttrTerminal).toBe('cli.terminal')
    expect(AttrStdoutIsTty).toBe('cli.stdout.is_tty')
    expect(AttrRuntimeName).toBe('cli.runtime.name')
    expect(AttrRuntimeVersion).toBe('cli.runtime.version')
  })

  it('sends all five at Tier.Basic+, on the session start only', async () => {
    withEnv({ SHELL: '/usr/bin/zsh', TERM_PROGRAM: 'WezTerm' })
    restoreTty = stubStdoutIsTty(true)
    for (const tier of [Tier.Basic, Tier.Full, Tier.OptIn]) {
      const { client, logs, event } = capturingClient(tier)
      client.recordSessionStart()
      client.recordCommandInvocation('testcli sub')
      await client.flush(500)

      const attrs = event(EventSessionStarted)?.attributes
      expect(attrs?.[AttrShell]).toBe('zsh')
      expect(attrs?.[AttrTerminal]).toBe('wezterm')
      expect(attrs?.[AttrStdoutIsTty]).toBe(true)
      expect(attrs?.[AttrRuntimeName]).toBe('node')
      expect(attrs?.[AttrRuntimeVersion]).toBe(process.versions.node)
      for (const log of logs.filter((l) => l.eventName !== EventSessionStarted)) {
        for (const key of sessionKeys) expect(log.attributes).not.toHaveProperty(key)
      }
    }
  })

  it('sends none of them at Tier.Anonymous', async () => {
    withEnv({ SHELL: '/usr/bin/zsh', TERM_PROGRAM: 'WezTerm' })
    restoreTty = stubStdoutIsTty(true)
    const { client, logs, event } = capturingClient(Tier.Anonymous)
    client.recordSessionStart()
    await client.flush(500)

    expect(event(EventSessionStarted)).toBeDefined()
    for (const log of logs) {
      for (const key of sessionKeys) expect(log.attributes).not.toHaveProperty(key)
    }
  })

  it('reports false for piped output', async () => {
    withEnv({ SHELL: '/bin/bash' })
    restoreTty = stubStdoutIsTty(undefined)
    const { client, event } = capturingClient(Tier.Basic)
    client.recordSessionStart()
    await client.flush(500)

    expect(event(EventSessionStarted)?.attributes[AttrStdoutIsTty]).toBe(false)
  })

  it('reports other and unknown instead of echoing the environment', async () => {
    withEnv({ SHELL: '/home/alice/bin/my-shell', TERM_PROGRAM: '$(whoami)' })
    const { client, event } = capturingClient(Tier.Basic)
    client.recordSessionStart()
    await client.flush(500)

    expect(event(EventSessionStarted)?.attributes[AttrShell]).toBe('other')
    expect(event(EventSessionStarted)?.attributes[AttrTerminal]).toBe('other')

    withEnv({})
    const second = capturingClient(Tier.Basic)
    second.client.recordSessionStart()
    await second.client.flush(500)

    expect(second.event(EventSessionStarted)?.attributes).not.toHaveProperty(AttrShell)
    expect(second.event(EventSessionStarted)?.attributes[AttrTerminal]).toBe('unknown')
  })

  it('reads the environment when recordSessionStart is called, not when the job runs', async () => {
    withEnv({ SHELL: '/bin/fish' })
    const { client, event } = capturingClient(Tier.Basic)
    client.recordSessionStart()
    vi.stubEnv('SHELL', '/bin/bash')
    await client.flush(500)

    expect(event(EventSessionStarted)?.attributes[AttrShell]).toBe('fish')
  })
})

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

describe('error reason', () => {
  it('is sent at Tier.Basic+ on the event and the cli.errors metric', async () => {
    for (const tier of [Tier.Basic, Tier.Full, Tier.OptIn]) {
      const { client, errorCounts, event } = capturingClient(tier)
      client.recordError('testcli sub', ErrorCategory.Auth, 'no-token')
      await client.flush(500)

      expect(AttrErrorReason).toBe('cli.error.reason')
      expect(event(EventErrorRaised)?.attributes[AttrErrorReason], String(tier)).toBe('no-token')
      expect(event(EventErrorRaised)?.attributes[AttrErrorType]).toBe('auth')
      expect(errorCounts).toHaveLength(1)
      expect(errorCounts[0]?.attributes[AttrErrorReason]).toBe('no-token')
    }
  })

  it('is not sent at Tier.Anonymous, where the category is not either', async () => {
    const { client, errorCounts, event } = capturingClient(Tier.Anonymous)
    client.recordError('testcli sub', ErrorCategory.Auth, 'no-token')
    await client.flush(500)

    expect(errorCounts).toHaveLength(1)
    expect(errorCounts[0]?.attributes).not.toHaveProperty(AttrErrorReason)
    expect(event(EventErrorRaised)).toBeUndefined()
  })

  it('is omitted when absent, and the error is recorded as before', async () => {
    const { client, errorCounts, event } = capturingClient(Tier.Basic)
    client.recordError('testcli sub', ErrorCategory.Network)
    await client.flush(500)

    expect(event(EventErrorRaised)?.attributes).not.toHaveProperty(AttrErrorReason)
    expect(errorCounts[0]?.attributes).not.toHaveProperty(AttrErrorReason)
  })

  it('drops a reason that is not a valid identifier, but still records the error', async () => {
    const invalid = [
      '',
      'No-Token',
      'no token',
      'failed to read config file',
      '-leading-dash',
      '.leading-dot',
      '_leading-underscore',
      'trailing-newline\n',
      '/etc/passwd',
      'caf\u00e9',
      'x'.repeat(65),
    ]
    for (const reason of invalid) {
      const { client, errorCounts, event } = capturingClient(Tier.Basic)
      client.recordError('testcli sub', ErrorCategory.Internal, reason)
      await client.flush(500)

      expect(event(EventErrorRaised)?.attributes, JSON.stringify(reason)).not.toHaveProperty(
        AttrErrorReason,
      )
      expect(event(EventErrorRaised)?.attributes[AttrErrorType]).toBe('internal')
      expect(errorCounts[0]?.attributes).not.toHaveProperty(AttrErrorReason)
    }
  })

  it('accepts the whole allowed character set up to 64 characters', async () => {
    for (const reason of ['a', '0', 'a.b_c-d', 'x'.repeat(64)]) {
      const { client, event } = capturingClient(Tier.Basic)
      client.recordError('testcli sub', ErrorCategory.Internal, reason)
      await client.flush(500)
      expect(event(EventErrorRaised)?.attributes[AttrErrorReason]).toBe(reason)
    }
  })

  it('is ignored if it is not a string', async () => {
    const { client, event } = capturingClient(Tier.Basic)
    client.recordError('testcli sub', ErrorCategory.Internal, 42 as unknown as string)
    await client.flush(500)
    expect(event(EventErrorRaised)?.attributes).not.toHaveProperty(AttrErrorReason)
  })
})

describe('recordCounter', () => {
  it('sends the name and label under the server attribute names, at every tier', async () => {
    for (const tier of [Tier.Anonymous, Tier.Basic, Tier.Full, Tier.OptIn]) {
      const { client, counterAdds } = capturingClient(tier)
      client.recordCounter('rules.generated', 3, { label: 'get' })
      client.recordCounter('scan.completed', 1)
      await client.flush(500)

      expect(AttrCounterName).toBe('cli.counter.name')
      expect(AttrCounterLabel).toBe('cli.counter.label')
      expect(MetricCounter).toBe('cli.counter')
      expect(counterAdds, String(tier)).toHaveLength(2)
      expect(counterAdds[0]?.value).toBe(3)
      expect(counterAdds[0]?.attributes[AttrCounterName]).toBe('rules.generated')
      expect(counterAdds[0]?.attributes[AttrCounterLabel]).toBe('get')
      expect(counterAdds[1]?.attributes[AttrCounterName]).toBe('scan.completed')
      expect(counterAdds[1]?.attributes).not.toHaveProperty(AttrCounterLabel)
    }
  })

  it('carries no identifiers at Tier.Anonymous', async () => {
    const { client, counterAdds } = capturingClient(Tier.Anonymous)
    client.recordSessionStart()
    client.recordCounter('scan.completed', 1)
    await client.flush(500)

    expect(Object.keys(counterAdds[0]?.attributes ?? {}).sort()).toEqual(
      ['cli.analytics.tier', AttrCounterName].sort(),
    )
    expect(client.stats().belowTierDropped).toBe(0)
  })

  it('drops an invalid name, not trimming or rewriting it', async () => {
    const invalid = [
      '',
      'Scan',
      'scan completed',
      '-scan',
      '.scan',
      '_scan',
      'scan/done',
      'https://example.com',
      '/home/user/project',
      'scan\n',
      'caf\u00e9',
      'x'.repeat(65),
    ]
    const { client, counterAdds } = capturingClient(Tier.Anonymous)
    for (const name of invalid) client.recordCounter(name, 1)
    client.recordCounter(42 as unknown as string, 1)
    client.recordCounter(undefined as unknown as string, 1)
    await client.flush(500)
    expect(counterAdds).toHaveLength(0)
  })

  it('drops the whole increment for an invalid label rather than sending it unlabeled', async () => {
    const { client, counterAdds } = capturingClient(Tier.Anonymous)
    for (const label of ['', 'Get', 'a b', '-x', 'user@example.com', 'x'.repeat(65)]) {
      client.recordCounter('rules.generated', 1, { label })
    }
    client.recordCounter('rules.generated', 1, { label: 7 as unknown as string })
    await client.flush(500)
    expect(counterAdds).toHaveLength(0)
  })

  it('accepts names and labels of exactly 64 characters', async () => {
    const { client, counterAdds } = capturingClient(Tier.Anonymous)
    client.recordCounter('a'.repeat(64), 1, { label: '9'.repeat(64) })
    client.recordCounter('a.b_c-d', 1, { label: '0' })
    await client.flush(500)
    expect(counterAdds).toHaveLength(2)
  })

  it('ignores a non-positive or non-integer n', async () => {
    const { client, counterAdds } = capturingClient(Tier.Anonymous)
    for (const n of [0, -1, -0, 0.5, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      client.recordCounter('scan.completed', n)
    }
    client.recordCounter('scan.completed', '3' as unknown as number)
    client.recordCounter('scan.completed', null as unknown as number)
    client.recordCounter('scan.completed', undefined as unknown as number)
    await client.flush(500)
    expect(counterAdds).toHaveLength(0)

    client.recordCounter('scan.completed', 1)
    client.recordCounter('scan.completed', Number.MAX_SAFE_INTEGER)
    await client.flush(500)
    expect(counterAdds.map((a) => a.value)).toEqual([1, Number.MAX_SAFE_INTEGER])
  })

  it('is a safe no-op on a disabled client', async () => {
    const client = createClient('key', 'cli', '1.0.0', { disabled: true })
    expect(() => {
      client.recordCounter('scan.completed', 1, { label: 'x' })
      client.recordCounter('Bad Name', -1)
    }).not.toThrow()
    await client.flush(100)
    expect(client.stats()).toEqual({
      queueOverflowDropped: 0,
      belowTierDropped: 0,
      recoveredErrors: 0,
    })
  })

  it('is a no-op after shutdown', async () => {
    const { client, counterAdds } = capturingClient(Tier.Anonymous)
    await client.shutdown(100)
    client.recordCounter('scan.completed', 1)
    expect(counterAdds).toHaveLength(0)
  })

  it('never throws into the host CLI, even if the exporter pipeline does', () => {
    const client = new Client({
      cliName: 'testcli',
      disabled: false,
      initError: null,
      tier: Tier.Anonymous,
      queueSize: 10,
      shutdownTimeoutMs: 100,
      productCounter: {
        add: () => {
          throw new Error('boom')
        },
      },
    } as unknown as ConstructorParameters<typeof Client>[0])
    expect(() => client.recordCounter('scan.completed', 1)).not.toThrow()
    expect(client.stats().recoveredErrors).toBe(1)
  })

  it('does not throw when options is null or malformed', () => {
    const { client } = capturingClient(Tier.Anonymous)
    expect(() => {
      client.recordCounter('scan.completed', 1, null as unknown as { label?: string })
    }).not.toThrow()
  })

  it('sums increments in memory, sending one data point per name and label', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
    const meterProvider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 })],
    })
    const client = new Client({
      cliName: 'testcli',
      disabled: false,
      initError: null,
      tier: Tier.Anonymous,
      queueSize: 10,
      shutdownTimeoutMs: 100,
      productCounter: meterProvider.getMeter('test').createCounter(MetricCounter, { unit: '1' }),
    } as unknown as ConstructorParameters<typeof Client>[0])

    // Far more calls than the queue holds: none may be dropped.
    for (let i = 0; i < 1000; i++) client.recordCounter('rules.generated', 1, { label: 'get' })
    client.recordCounter('rules.generated', 5, { label: 'post' })
    client.recordCounter('rules.generated', 2)
    client.recordCounter('rules.generated', 3, { label: 'get' })
    client.recordCounter('scan.completed', 4)

    await meterProvider.forceFlush()
    const exports = exporter.getMetrics()
    expect(exports).toHaveLength(1)
    const metrics = exports.flatMap((rm) => rm.scopeMetrics.flatMap((scope) => scope.metrics))
    expect(metrics).toHaveLength(1)
    expect(metrics[0]?.descriptor.name).toBe('cli.counter')
    const points = (metrics[0]?.dataPoints ?? []).map((p) => ({
      name: p.attributes[AttrCounterName],
      label: p.attributes[AttrCounterLabel],
      value: p.value,
    }))
    expect(points).toHaveLength(4)
    expect(points).toEqual(
      expect.arrayContaining([
        { name: 'rules.generated', label: 'get', value: 1003 },
        { name: 'rules.generated', label: 'post', value: 5 },
        { name: 'rules.generated', label: undefined, value: 2 },
        { name: 'scan.completed', label: undefined, value: 4 },
      ]),
    )
    expect(client.stats().queueOverflowDropped).toBe(0)
    await meterProvider.shutdown()
  })
})

describe('recordDuration', () => {
  it('sends the name and label under the server attribute names, at every tier', async () => {
    for (const tier of [Tier.Anonymous, Tier.Basic, Tier.Full, Tier.OptIn]) {
      const { client, measureRecords } = capturingClient(tier)
      client.recordDuration('rules.fetch', 120, { label: 'get' })
      client.recordDuration('scan.completed', 1.5)
      await client.flush(500)

      expect(AttrMeasureName).toBe('cli.measure.name')
      expect(AttrMeasureLabel).toBe('cli.measure.label')
      expect(MetricMeasure).toBe('cli.measure')
      expect(measureRecords, String(tier)).toHaveLength(2)
      expect(measureRecords[0]?.value).toBe(120)
      expect(measureRecords[0]?.attributes[AttrMeasureName]).toBe('rules.fetch')
      expect(measureRecords[0]?.attributes[AttrMeasureLabel]).toBe('get')
      expect(measureRecords[1]?.value).toBe(1.5)
      expect(measureRecords[1]?.attributes[AttrMeasureName]).toBe('scan.completed')
      expect(measureRecords[1]?.attributes).not.toHaveProperty(AttrMeasureLabel)
    }
  })

  it('carries no identifiers at Tier.Anonymous', async () => {
    const { client, measureRecords } = capturingClient(Tier.Anonymous)
    client.recordSessionStart()
    client.recordDuration('scan.completed', 10)
    await client.flush(500)

    expect(Object.keys(measureRecords[0]?.attributes ?? {}).sort()).toEqual(
      ['cli.analytics.tier', AttrMeasureName].sort(),
    )
    expect(client.stats().belowTierDropped).toBe(0)
  })

  it('drops an invalid name, not trimming or rewriting it', async () => {
    const invalid = [
      '',
      'Scan',
      'scan completed',
      '-scan',
      '.scan',
      '_scan',
      'scan/done',
      'https://example.com',
      '/home/user/project',
      'scan\n',
      'café',
      'x'.repeat(65),
    ]
    const { client, measureRecords } = capturingClient(Tier.Anonymous)
    for (const name of invalid) client.recordDuration(name, 10)
    client.recordDuration(42 as unknown as string, 10)
    client.recordDuration(undefined as unknown as string, 10)
    await client.flush(500)
    expect(measureRecords).toHaveLength(0)
  })

  it('drops the whole timing for an invalid label rather than sending it unlabeled', async () => {
    const { client, measureRecords } = capturingClient(Tier.Anonymous)
    for (const label of ['', 'Get', 'a b', '-x', 'user@example.com', 'x'.repeat(65)]) {
      client.recordDuration('rules.fetch', 10, { label })
    }
    client.recordDuration('rules.fetch', 10, { label: 7 as unknown as string })
    await client.flush(500)
    expect(measureRecords).toHaveLength(0)
  })

  it('accepts names and labels of exactly 64 characters', async () => {
    const { client, measureRecords } = capturingClient(Tier.Anonymous)
    client.recordDuration('a'.repeat(64), 10, { label: '9'.repeat(64) })
    client.recordDuration('a.b_c-d', 10, { label: '0' })
    await client.flush(500)
    expect(measureRecords).toHaveLength(2)
  })

  it('ignores a non-positive or non-finite duration', async () => {
    const { client, measureRecords } = capturingClient(Tier.Anonymous)
    for (const ms of [0, -1, -0, -0.5, NaN, Infinity, -Infinity]) {
      client.recordDuration('scan.completed', ms)
    }
    client.recordDuration('scan.completed', '3' as unknown as number)
    client.recordDuration('scan.completed', null as unknown as number)
    client.recordDuration('scan.completed', undefined as unknown as number)
    await client.flush(500)
    expect(measureRecords).toHaveLength(0)

    client.recordDuration('scan.completed', 0.25)
    client.recordDuration('scan.completed', 300_000)
    await client.flush(500)
    expect(measureRecords.map((r) => r.value)).toEqual([0.25, 300_000])
  })

  it('is a safe no-op on a disabled client', async () => {
    const client = createClient('key', 'cli', '1.0.0', { disabled: true })
    expect(() => {
      client.recordDuration('scan.completed', 10, { label: 'x' })
      client.recordDuration('Bad Name', -1)
    }).not.toThrow()
    await client.flush(100)
    expect(client.stats()).toEqual({
      queueOverflowDropped: 0,
      belowTierDropped: 0,
      recoveredErrors: 0,
    })
  })

  it('is a no-op after shutdown', async () => {
    const { client, measureRecords } = capturingClient(Tier.Anonymous)
    await client.shutdown(100)
    client.recordDuration('scan.completed', 10)
    expect(measureRecords).toHaveLength(0)
  })

  it('never throws into the host CLI, even if the exporter pipeline does', () => {
    const client = new Client({
      cliName: 'testcli',
      disabled: false,
      initError: null,
      tier: Tier.Anonymous,
      queueSize: 10,
      shutdownTimeoutMs: 100,
      measureHist: {
        record: () => {
          throw new Error('boom')
        },
      },
    } as unknown as ConstructorParameters<typeof Client>[0])
    expect(() => client.recordDuration('scan.completed', 10)).not.toThrow()
    expect(client.stats().recoveredErrors).toBe(1)
  })

  it('does not throw when options is null or malformed', () => {
    const { client } = capturingClient(Tier.Anonymous)
    expect(() => {
      client.recordDuration('scan.completed', 10, null as unknown as { label?: string })
    }).not.toThrow()
  })

  it('reaches the metric pipeline as a cli.measure histogram in ms with the Go buckets', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
    const meterProvider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 })],
    })
    const client = new Client({
      cliName: 'testcli',
      disabled: false,
      initError: null,
      tier: Tier.Anonymous,
      queueSize: 10,
      shutdownTimeoutMs: 100,
      measureHist: meterProvider.getMeter('test').createHistogram(MetricMeasure, {
        unit: 'ms',
        advice: { explicitBucketBoundaries: [...MEASURE_BUCKET_BOUNDARIES_MS] },
      }),
    } as unknown as ConstructorParameters<typeof Client>[0])

    expect(MEASURE_BUCKET_BOUNDARIES_MS).toEqual([
      1, 5, 10, 50, 100, 500, 1000, 5000, 10000, 60000, 300000,
    ])
    // Far more calls than the queue holds: none may be dropped.
    for (let i = 0; i < 1000; i++) client.recordDuration('rules.fetch', 7, { label: 'get' })
    client.recordDuration('rules.fetch', 200, { label: 'get' })
    client.recordDuration('rules.fetch', 3, { label: 'post' })
    client.recordDuration('scan.completed', 400_000)

    await meterProvider.forceFlush()
    const exports = exporter.getMetrics()
    expect(exports).toHaveLength(1)
    const metrics = exports.flatMap((rm) => rm.scopeMetrics.flatMap((scope) => scope.metrics))
    expect(metrics).toHaveLength(1)
    expect(metrics[0]?.descriptor.name).toBe('cli.measure')
    expect(metrics[0]?.descriptor.unit).toBe('ms')
    const points = metrics[0]?.dataPoints ?? []
    expect(points).toHaveLength(3)

    const point = (name: string, label?: string) =>
      points.find(
        (p) => p.attributes[AttrMeasureName] === name && p.attributes[AttrMeasureLabel] === label,
      )
    const get = point('rules.fetch', 'get')
    expect(get?.value).toMatchObject({ count: 1001, sum: 7 * 1000 + 200 })
    expect(get?.value).toMatchObject({
      buckets: {
        boundaries: [1, 5, 10, 50, 100, 500, 1000, 5000, 10000, 60000, 300000],
        counts: [0, 0, 1000, 0, 0, 1, 0, 0, 0, 0, 0, 0],
      },
    })
    expect(point('rules.fetch', 'post')?.value).toMatchObject({ count: 1, sum: 3 })
    expect(point('scan.completed')?.value).toMatchObject({ count: 1, sum: 400_000 })
    expect(client.stats().queueOverflowDropped).toBe(0)
    await meterProvider.shutdown()
  })
})

describe('session start config customization and auth state', () => {
  const sessionKeys = [AttrConfigCustomizedCount, AttrAuthState]

  async function sessionAttrs(tier: Tier, extra: Record<string, unknown>) {
    const { client, event } = capturingClient(tier, undefined, undefined, extra)
    client.recordSessionStart()
    await client.flush(500)
    return event(EventSessionStarted)?.attributes
  }

  it('uses the exact wire names and vocabulary the server allowlist expects', () => {
    expect(AttrConfigCustomizedCount).toBe('cli.config.customized_count')
    expect(AttrAuthState).toBe('cli.auth.state')
    expect(Object.values(AuthState).sort()).toEqual(['anonymous', 'authenticated', 'unknown'])
  })

  it('sends both at Tier.Basic+, on the session start only', async () => {
    for (const tier of [Tier.Basic, Tier.Full, Tier.OptIn]) {
      const { client, logs, event } = capturingClient(tier, undefined, undefined, {
        configCustomizedCount: 7,
        authState: AuthState.Authenticated,
      })
      client.recordSessionStart()
      client.recordCommandInvocation('testcli sub')
      await client.flush(500)

      const attrs = event(EventSessionStarted)?.attributes
      expect(attrs?.[AttrConfigCustomizedCount]).toBe(7)
      expect(attrs?.[AttrAuthState]).toBe('authenticated')
      for (const log of logs.filter((l) => l.eventName !== EventSessionStarted)) {
        for (const key of sessionKeys) expect(log.attributes).not.toHaveProperty(key)
      }
    }
  })

  it('sends neither at Tier.Anonymous, and never calls the callbacks', async () => {
    const count = vi.fn(() => 3)
    const auth = vi.fn(() => AuthState.Anonymous)
    const { client, logs, event } = capturingClient(Tier.Anonymous, undefined, undefined, {
      configCustomizedCount: count,
      authState: auth,
    })
    client.recordSessionStart()
    await client.flush(500)

    expect(event(EventSessionStarted)).toBeDefined()
    for (const log of logs) {
      for (const key of sessionKeys) expect(log.attributes).not.toHaveProperty(key)
    }
    expect(count).not.toHaveBeenCalled()
    expect(auth).not.toHaveBeenCalled()
  })

  it('omits both when the options are unset', async () => {
    const attrs = await sessionAttrs(Tier.Basic, {})
    for (const key of sessionKeys) expect(attrs).not.toHaveProperty(key)
  })

  it('evaluates callbacks once, when the session starts', async () => {
    let count = 2
    let auth: AuthState = AuthState.Unknown
    const countFn = vi.fn(() => count)
    const authFn = vi.fn(() => auth)
    const { client, event } = capturingClient(Tier.Basic, undefined, undefined, {
      configCustomizedCount: countFn,
      authState: authFn,
    })
    expect(countFn).not.toHaveBeenCalled()
    count = 5
    auth = AuthState.Anonymous
    client.recordSessionStart()
    client.recordSessionStart()
    await client.flush(500)

    expect(countFn).toHaveBeenCalledTimes(1)
    expect(authFn).toHaveBeenCalledTimes(1)
    expect(event(EventSessionStarted)?.attributes[AttrConfigCustomizedCount]).toBe(5)
    expect(event(EventSessionStarted)?.attributes[AttrAuthState]).toBe('anonymous')
  })

  it('accepts every auth state and zero customizations', async () => {
    for (const state of Object.values(AuthState)) {
      const attrs = await sessionAttrs(Tier.Basic, { authState: state, configCustomizedCount: 0 })
      expect(attrs?.[AttrAuthState]).toBe(state)
      expect(attrs?.[AttrConfigCustomizedCount]).toBe(0)
    }
  })

  it('swallows a throwing callback, omits the attribute and still starts the session', async () => {
    const boom = () => {
      throw new Error('could not read credentials for alice@example.com')
    }
    const { client, event } = capturingClient(Tier.Basic, undefined, undefined, {
      configCustomizedCount: boom,
      authState: boom,
    })
    expect(() => client.recordSessionStart()).not.toThrow()
    await client.flush(500)

    const attrs = event(EventSessionStarted)?.attributes
    expect(attrs).toBeDefined()
    for (const key of sessionKeys) expect(attrs).not.toHaveProperty(key)
    expect(client.stats().recoveredErrors).toBe(0)
  })

  it('keeps one fact when the other callback fails', async () => {
    const attrs = await sessionAttrs(Tier.Basic, {
      configCustomizedCount: () => {
        throw new Error('nope')
      },
      authState: () => AuthState.Authenticated,
    })
    expect(attrs).not.toHaveProperty(AttrConfigCustomizedCount)
    expect(attrs?.[AttrAuthState]).toBe('authenticated')
  })

  it('clamps and rounds the count into 0..MAX', async () => {
    const cases: Array<[number, number]> = [
      [-5, 0],
      [-0.5, 0],
      [3.9, 3],
      [MAX_CONFIG_CUSTOMIZED_COUNT, MAX_CONFIG_CUSTOMIZED_COUNT],
      [MAX_CONFIG_CUSTOMIZED_COUNT + 1, MAX_CONFIG_CUSTOMIZED_COUNT],
      [Number.MAX_SAFE_INTEGER, MAX_CONFIG_CUSTOMIZED_COUNT],
      [Infinity, -1],
    ]
    for (const [input, expected] of cases) {
      const attrs = await sessionAttrs(Tier.Basic, { configCustomizedCount: input })
      // Infinity is not a count at all: omitted rather than clamped.
      if (expected === -1) expect(attrs).not.toHaveProperty(AttrConfigCustomizedCount)
      else expect(attrs?.[AttrConfigCustomizedCount]).toBe(expected)
    }
  })

  it('omits a count that is not a finite number', async () => {
    for (const bad of [NaN, -Infinity, '12', null, {}, [3], true]) {
      for (const source of [bad, () => bad]) {
        const attrs = await sessionAttrs(Tier.Basic, { configCustomizedCount: source })
        expect(attrs).not.toHaveProperty(AttrConfigCustomizedCount)
      }
    }
  })

  it('omits an auth state outside the vocabulary instead of echoing it', async () => {
    for (const bad of ['alice@example.com', 'Authenticated', '', 'signed-in', 1, true, null, {}]) {
      for (const source of [bad, () => bad]) {
        const attrs = await sessionAttrs(Tier.Basic, { authState: source })
        expect(attrs).not.toHaveProperty(AttrAuthState)
      }
    }
  })

  it('is passed through createClient options', async () => {
    const client = createClient('key', 'testcli', '1.0.0', {
      defaultTier: Tier.Basic,
      installIdPath: '',
      configCustomizedCount: () => 4,
      authState: AuthState.Anonymous,
    })
    expect(client.initError).toBeNull()
    client.recordSessionStart()
    await client.shutdown(200)
  })
})
