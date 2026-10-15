import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SpanStatusCode } from '@opentelemetry/api'
import type { Attributes } from '@opentelemetry/api'
import { describe, expect, it } from 'vitest'

import {
  AttrCommandName,
  AttrDurationMs,
  AttrErrorMessage,
  AttrErrorType,
  AttrExitCode,
  AttrFlagNames,
  AttrInstallId,
  AttrInstallMethod,
  AttrSessionId,
  Client,
  ErrorCategory,
  EventCommandCompleted,
  EventCommandInvoked,
  EventErrorRaised,
  EventHelpViewed,
  EventSessionStarted,
  Tier,
} from '../src/index.js'
import { commandName, loadOrCreateInstallId } from '../src/taxonomy.js'

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
