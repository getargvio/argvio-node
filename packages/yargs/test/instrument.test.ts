import { describe, expect, it, vi } from 'vitest'
import yargs from 'yargs'

import { createClient, ErrorCategory, StaticProvider, Tier } from '@getargvio/argvio'
import type { Client } from '@getargvio/argvio'

import { instrument, instrumentYargs } from '../src/index.js'

const NOWHERE = 'http://127.0.0.1:1'

function makeClient(tier: Tier = Tier.Basic) {
  return createClient('key', 'testcli', '1.0.0', {
    endpoint: NOWHERE,
    consentProvider: new StaticProvider(tier),
    exportTimeoutMs: 50,
  })
}

function buildY() {
  return yargs()
    .scriptName('testcli')
    .command(
      'greet <name>',
      'greet someone',
      (b) => b.option('loud', { type: 'boolean' }),
      () => {
        // no-op handler
      },
    )
    .command(
      'boom',
      'always fails synchronously',
      () => {},
      () => {
        throw new Error('kaboom')
      },
    )
    .command(
      'boom-async',
      'always rejects asynchronously',
      () => {},
      async () => {
        throw new Error('kaboom-async')
      },
    )
}

describe('instrumentYargs', () => {
  it('records a successful invocation with flags, and the completed command', async () => {
    const client = makeClient()
    const recordInvocation = vi.spyOn(client, 'recordCommandInvocation')
    const recordCommand = vi.spyOn(client, 'recordCommand')

    const y = instrumentYargs(buildY(), client)
    await y.parseAsync(['greet', 'world', '--loud'])

    expect(recordInvocation).toHaveBeenCalledWith('testcli greet', ['loud'])
    expect(recordCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'testcli greet',
        exitCode: 0,
        durationMs: expect.any(Number),
      }),
    )
  })

  it('records a synchronously-thrown handler error and rethrows it', async () => {
    const client = makeClient()
    const recordError = vi.spyOn(client, 'recordError')
    const recordCommand = vi.spyOn(client, 'recordCommand')

    const y = instrumentYargs(buildY(), client, {
      classify: () => ErrorCategory.Internal,
    })

    await expect(y.parseAsync(['boom'])).rejects.toThrow('kaboom')
    expect(recordError).toHaveBeenCalledWith('testcli boom', ErrorCategory.Internal, undefined)
    expect(recordCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'testcli boom',
        exitCode: 1,
        durationMs: expect.any(Number),
      }),
    )
  })

  it('passes the reason when classify returns a category and a reason', async () => {
    const client = makeClient()
    const recordError = vi.spyOn(client, 'recordError')

    const instrumented = instrumentYargs(buildY(), client, {
      classify: () => ({ category: ErrorCategory.Auth, reason: 'no-token' }),
    })

    await expect(instrumented.parseAsync(['boom'])).rejects.toThrow('kaboom')
    expect(recordError).toHaveBeenCalledWith('testcli boom', ErrorCategory.Auth, 'no-token')
  })

  it('records an asynchronously-rejected handler error and rethrows it', async () => {
    const client = makeClient()
    const recordError = vi.spyOn(client, 'recordError')
    const recordCommand = vi.spyOn(client, 'recordCommand')

    const y = instrumentYargs(buildY(), client, {
      classify: () => ErrorCategory.Network,
    })

    await expect(y.parseAsync(['boom-async'])).rejects.toThrow('kaboom-async')
    expect(recordError).toHaveBeenCalledWith('testcli boom-async', ErrorCategory.Network, undefined)
    expect(recordCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'testcli boom-async',
        exitCode: 1,
        durationMs: expect.any(Number),
      }),
    )
  })

  it('only records the invocation once even if middleware runs multiple times', async () => {
    const client = makeClient()
    const recordInvocation = vi.spyOn(client, 'recordCommandInvocation')

    const y = instrumentYargs(buildY(), client)
    await y.parseAsync(['greet', 'world'])

    expect(recordInvocation).toHaveBeenCalledTimes(1)
  })

  it('captures help usage before yargs short-circuits (best-effort)', async () => {
    const client = makeClient()
    const recordHelp = vi.spyOn(client, 'recordHelpFlagUsage')

    const y = instrumentYargs(buildY(), client)
    await y.parseAsync(['--help'])

    expect(recordHelp).toHaveBeenCalled()
  })

  it('calls onFail instead of the default print-and-rethrow when provided', async () => {
    // .fail() only fires for validation errors and *rejected* async
    // handlers, never a synchronous handler throw (see src/index.ts) —
    // so this exercises the async-rejection path specifically.
    const client = makeClient()
    const onFail = vi.fn()

    const y = instrumentYargs(buildY(), client, { onFail })
    await y.parseAsync(['boom-async']).catch(() => {
      // onFail replaces the default print-and-rethrow, but the
      // underlying rejected handler promise still propagates
      // independently of what `.fail()` does — see src/index.ts.
    })

    expect(onFail).toHaveBeenCalled()
  })
})

interface EmittedLog {
  eventName?: string
  body?: unknown
  attributes?: Record<string, unknown>
}

/** Replaces the client's log sink, so a test sees exactly what would go on the wire. */
function captureLogs(client: Client): EmittedLog[] {
  const logs: EmittedLog[] = []
  ;(client as unknown as { logger: { emit: (rec: EmittedLog) => void } }).logger = {
    emit: (rec) => logs.push(rec),
  }
  return logs
}

function buildNestedY(mode: 'strict' | 'recommend' | 'both' | 'none' = 'strict') {
  const y = yargs().scriptName('testcli')
  const configure = <T>(instance: T & ReturnType<typeof yargs>) => {
    if (mode === 'strict' || mode === 'both') instance.strictCommands()
    if (mode === 'recommend' || mode === 'both') instance.recommendCommands()
    return instance
  }
  return configure(y)
    .command(
      ['status', 'st'],
      'show status',
      () => {},
      () => {},
    )
    .command(
      'internal-debug',
      false,
      () => {},
      () => {},
    )
    .command(
      'deploy',
      'deploy things',
      (b) =>
        configure(b)
          .command(
            'push',
            'push it',
            () => {},
            () => {},
          )
          .command(
            ['rollback', 'undo'],
            'roll back',
            () => {},
            () => {},
          ),
      () => {},
    )
}

describe('unknown commands', () => {
  async function attempt(
    args: string[],
    { tier = Tier.Basic, mode = 'strict' as Parameters<typeof buildNestedY>[0] } = {},
  ) {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const client = makeClient(tier)
      const logs = captureLogs(client)
      const recordCommand = vi.spyOn(client, 'recordCommand')
      const recordError = vi.spyOn(client, 'recordError')
      const recordInvocation = vi.spyOn(client, 'recordCommandInvocation')
      const y = instrumentYargs(buildNestedY(mode), client)
      const err = await y.parseAsync(args).then(
        () => undefined,
        (e: unknown) => e,
      )
      await client.flush(500)
      const unknown = logs.filter((l) => l.eventName === 'cli.command.unknown')
      return { err, logs, unknown, recordCommand, recordError, recordInvocation }
    } finally {
      stderr.mockRestore()
    }
  }

  it('reports the nearest top-level command and fails exactly as before', async () => {
    const { err, unknown, logs } = await attempt(['stauts'])

    expect((err as Error).message).toBe('Unknown command: stauts')
    expect(unknown).toHaveLength(1)
    expect(unknown[0]?.attributes).toMatchObject({ 'cli.command.suggestion': 'status' })
    expect(unknown[0]?.body).toBeUndefined()
    expect(logs.filter((l) => l.eventName !== 'cli.session.started')).toHaveLength(1)
  })

  it('suggests a nested command by its dotted name', async () => {
    const { unknown } = await attempt(['deploy', 'pussh'])
    expect(unknown).toHaveLength(1)
    expect(unknown[0]?.attributes).toMatchObject({ 'cli.command.suggestion': 'deploy.push' })
  })

  it('resolves an alias to the command name', async () => {
    const { unknown } = await attempt(['deploy', 'undoo'])
    expect(unknown[0]?.attributes).toMatchObject({ 'cli.command.suggestion': 'deploy.rollback' })
    const top = await attempt(['stt'])
    expect(top.unknown[0]?.attributes).toMatchObject({ 'cli.command.suggestion': 'status' })
  })

  it('detects the failure under recommendCommands(), with or without strictCommands()', async () => {
    for (const mode of ['recommend', 'both'] as const) {
      const { err, unknown } = await attempt(['stauts'], { mode })
      expect((err as Error).message, mode).toBe('Did you mean status?')
      expect(unknown, mode).toHaveLength(1)
      expect(unknown[0]?.attributes, mode).toMatchObject({ 'cli.command.suggestion': 'status' })
    }
  })

  it('does not count the attempt as a command or an error', async () => {
    const { recordCommand, recordError } = await attempt(['stauts'])
    expect(recordCommand).not.toHaveBeenCalled()
    expect(recordError).not.toHaveBeenCalled()
  })

  it('sends a bare attempt when no command is close', async () => {
    const { unknown } = await attempt(['frobnicate'])
    expect(unknown).toHaveLength(1)
    expect(unknown[0]?.attributes).not.toHaveProperty('cli.command.suggestion')
  })

  it('never suggests a hidden command', async () => {
    const { unknown } = await attempt(['internal-debu'])
    expect(unknown).toHaveLength(1)
    expect(unknown[0]?.attributes).not.toHaveProperty('cli.command.suggestion')
  })

  it('sends the attempt without the suggestion at Tier.Anonymous', async () => {
    const { unknown } = await attempt(['stauts'], { tier: Tier.Anonymous })
    expect(unknown).toHaveLength(1)
    expect(unknown[0]?.attributes).not.toHaveProperty('cli.command.suggestion')
  })

  it('reports once, and still calls onFail, when a custom fail handler is set', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const client = makeClient()
    const logs = captureLogs(client)
    const onFail = vi.fn((msg: string) => {
      throw new Error(msg)
    })
    const y = instrumentYargs(buildNestedY(), client, { onFail })
    await expect(y.parseAsync(['stauts'])).rejects.toThrow('Unknown command: stauts')
    await client.flush(500)
    stderr.mockRestore()

    expect(onFail).toHaveBeenCalledTimes(1)
    expect(logs.filter((l) => l.eventName === 'cli.command.unknown')).toHaveLength(1)
  })

  it('never lets the typed text into anything emitted, at any tier', async () => {
    const typed = [
      'sk-live-4eC39HqLyjWDarjtT1zdp7dc',
      '/home/alice/.ssh/id_rsa',
      'alice@example.com',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'status-' + 'x'.repeat(100_000),
      'stauts',
      'dploy',
    ]
    for (const mode of ['strict', 'recommend', 'both'] as const) {
      for (const tier of [Tier.Anonymous, Tier.Basic, Tier.Full, Tier.OptIn]) {
        for (const text of typed) {
          for (const args of [[text], ['deploy', text], [text, '--token', 'hunter2']]) {
            const { logs, unknown } = await attempt(args, { tier, mode })
            // recommendCommands() alone only fails when it has a close match to offer
            if (mode !== 'recommend') expect(unknown, text.slice(0, 20)).toHaveLength(1)
            const wire = JSON.stringify(logs)
            expect(wire).not.toContain(text)
            expect(wire).not.toContain('hunter2')
            const suggestion = unknown[0]?.attributes?.['cli.command.suggestion']
            if (suggestion !== undefined) {
              expect(['status', 'deploy', 'deploy.push', 'deploy.rollback']).toContain(suggestion)
            }
          }
        }
      }
    }
  })

  it('never turns a word that is not a command into part of a command name', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    for (const mode of ['strict', 'none'] as const) {
      const client = makeClient()
      const logs = captureLogs(client)
      const y = instrumentYargs(buildNestedY(mode), client)
      await y.parseAsync(['deploy', 'push', 'sk-live-4eC39HqLyjWDarjtT1zdp7dc']).catch(() => {})
      await client.flush(500)

      expect(JSON.stringify(logs), mode).not.toContain('sk-live')
    }
    stderr.mockRestore()
  })

  it('sends nothing without strictCommands() or recommendCommands(), where yargs does not fail', async () => {
    const { err, unknown } = await attempt(['stauts'], { mode: 'none' })
    expect(err).toBeUndefined()
    expect(unknown).toHaveLength(0)
  })

  it('does not report other validation failures', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const client = makeClient()
    const unknown = vi.spyOn(client, 'recordUnknownCommand')
    const recordError = vi.spyOn(client, 'recordError')
    const y = instrumentYargs(
      yargs()
        .scriptName('testcli')
        .command(
          'greet <name>',
          'greet',
          () => {},
          () => {},
        ),
      client,
    )
    await expect(y.parseAsync(['greet'])).rejects.toThrow()
    stderr.mockRestore()

    expect(unknown).not.toHaveBeenCalled()
    expect(recordError).toHaveBeenCalled()
  })
})

describe('instrument', () => {
  it('builds a client and wires up instrumentation in one call', async () => {
    const { client, yargs: y } = instrument(buildY(), 'key', 'testcli', '1.0.0', {
      endpoint: NOWHERE,
      consentProvider: new StaticProvider(Tier.Basic),
      exportTimeoutMs: 50,
    })
    const recordInvocation = vi.spyOn(client, 'recordCommandInvocation')

    await y.parseAsync(['greet', 'world'])

    expect(recordInvocation).toHaveBeenCalled()
    await client.shutdown(200)
  })
})
