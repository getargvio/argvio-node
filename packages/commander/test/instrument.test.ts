import { describe, expect, it, vi } from 'vitest'
import { Command, CommanderError } from 'commander'

import { createClient, ErrorCategory, StaticProvider, Tier } from '@getargvio/argvio'
import type { Client } from '@getargvio/argvio'

import { instrument, instrumentCommander } from '../src/index.js'

const NOWHERE = 'http://127.0.0.1:1'

function makeClient(tier: Tier = Tier.Basic) {
  return createClient('key', 'testcli', '1.0.0', {
    endpoint: NOWHERE,
    consentProvider: new StaticProvider(tier),
    exportTimeoutMs: 50,
  })
}

function buildProgram() {
  const program = new Command()
  program.name('testcli')

  program
    .command('greet')
    .option('--loud', 'shout it')
    .action(() => {
      // no-op
    })

  program.command('boom').action(() => {
    throw new Error('kaboom')
  })

  program.command('boom-async').action(async () => {
    throw new Error('kaboom-async')
  })

  return program
}

describe('instrumentCommander', () => {
  it('records a successful invocation with option names, and the completed command', async () => {
    const client = makeClient()
    const recordInvocation = vi.spyOn(client, 'recordCommandInvocation')
    const recordCommand = vi.spyOn(client, 'recordCommand')

    const program = instrumentCommander(buildProgram(), client)
    await program.parseAsync(['node', 'testcli', 'greet', '--loud'])

    expect(recordInvocation).toHaveBeenCalledWith('testcli greet', ['loud'])
    expect(recordCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'testcli greet',
        exitCode: 0,
        durationMs: expect.any(Number),
      }),
    )
  })

  it('records a synchronously-thrown action error and rethrows it', async () => {
    const client = makeClient()
    const recordError = vi.spyOn(client, 'recordError')
    const recordCommand = vi.spyOn(client, 'recordCommand')

    const program = instrumentCommander(buildProgram(), client, {
      classify: () => ErrorCategory.Internal,
    })

    await expect(program.parseAsync(['node', 'testcli', 'boom'])).rejects.toThrow('kaboom')
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

    const program = instrumentCommander(buildProgram(), client, {
      classify: () => ({ category: ErrorCategory.Auth, reason: 'no-token' }),
    })

    await expect(program.parseAsync(['node', 'testcli', 'boom'])).rejects.toThrow('kaboom')
    expect(recordError).toHaveBeenCalledWith('testcli boom', ErrorCategory.Auth, 'no-token')
  })

  it('records an asynchronously-rejected action error and rethrows it', async () => {
    const client = makeClient()
    const recordError = vi.spyOn(client, 'recordError')
    const recordCommand = vi.spyOn(client, 'recordCommand')

    const program = instrumentCommander(buildProgram(), client, {
      classify: () => ErrorCategory.Network,
    })

    await expect(program.parseAsync(['node', 'testcli', 'boom-async'])).rejects.toThrow(
      'kaboom-async',
    )
    expect(recordError).toHaveBeenCalledWith('testcli boom-async', ErrorCategory.Network, undefined)
    expect(recordCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'testcli boom-async',
        exitCode: 1,
        durationMs: expect.any(Number),
      }),
    )
  })

  it('treats --help as a control-flow exit, not an error, and records help usage', async () => {
    const client = makeClient()
    const recordError = vi.spyOn(client, 'recordError')
    const recordCommand = vi.spyOn(client, 'recordCommand')
    const recordHelp = vi.spyOn(client, 'recordHelpFlagUsage')
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const program = instrumentCommander(buildProgram(), client)
    await expect(program.parseAsync(['node', 'testcli', '--help'])).rejects.toThrow()

    expect(recordHelp).toHaveBeenCalled()
    expect(recordError).not.toHaveBeenCalled()
    expect(recordCommand).not.toHaveBeenCalled()

    vi.restoreAllMocks()
  })

  it('treats --version as a control-flow exit, not an error', async () => {
    const client = makeClient()
    const recordError = vi.spyOn(client, 'recordError')
    const recordCommand = vi.spyOn(client, 'recordCommand')
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const program = instrumentCommander(buildProgram().version('1.0.0'), client)
    await expect(program.parseAsync(['node', 'testcli', '--version'])).rejects.toThrow()

    expect(recordError).not.toHaveBeenCalled()
    expect(recordCommand).not.toHaveBeenCalled()

    vi.restoreAllMocks()
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

function buildNestedProgram() {
  const program = new Command()
  program.name('testcli')
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} })
  // Subcommands inherit this only if they are created after it, which is
  // why the integration's own exitOverride() can't reach ones defined before.
  program.exitOverride()

  program
    .command('status')
    .alias('st')
    .action(() => {})
  program.command('internal-debug', { hidden: true }).action(() => {})
  const deploy = program.command('deploy')
  deploy.command('push').action(() => {})
  deploy
    .command('rollback')
    .alias('undo')
    .action(() => {})
  return program
}

describe('unknown commands', () => {
  async function attempt(args: string[], tier: Tier = Tier.Basic) {
    const client = makeClient(tier)
    const logs = captureLogs(client)
    const recordCommand = vi.spyOn(client, 'recordCommand')
    const recordError = vi.spyOn(client, 'recordError')
    const recordInvocation = vi.spyOn(client, 'recordCommandInvocation')
    const program = instrumentCommander(buildNestedProgram(), client)
    const err = await program.parseAsync(['node', 'testcli', ...args]).then(
      () => undefined,
      (e: unknown) => e,
    )
    await client.flush(500)
    const unknown = logs.filter((l) => l.eventName === 'cli.command.unknown')
    return { err, logs, unknown, recordCommand, recordError, recordInvocation }
  }

  it('reports the nearest top-level command and fails exactly as before', async () => {
    const { err, unknown, logs } = await attempt(['stauts'])

    expect(err).toBeInstanceOf(CommanderError)
    expect(err).toMatchObject({
      code: 'commander.unknownCommand',
      exitCode: 1,
      message: "error: unknown command 'stauts'\n(Did you mean status?)",
    })
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

  it('resolves an alias to the command name, and finds a typo of an alias', async () => {
    const viaAlias = await attempt(['deploy', 'undoo'])
    expect(viaAlias.unknown[0]?.attributes).toMatchObject({
      'cli.command.suggestion': 'deploy.rollback',
    })
  })

  it('does not count the attempt as a command or an error', async () => {
    const { recordCommand, recordError, recordInvocation } = await attempt(['stauts'])
    expect(recordCommand).not.toHaveBeenCalled()
    expect(recordError).not.toHaveBeenCalled()
    expect(recordInvocation).not.toHaveBeenCalled()
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
    const { unknown } = await attempt(['stauts'], Tier.Anonymous)
    expect(unknown).toHaveLength(1)
    expect(unknown[0]?.attributes).not.toHaveProperty('cli.command.suggestion')
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
    for (const tier of [Tier.Anonymous, Tier.Basic, Tier.Full, Tier.OptIn]) {
      for (const text of typed) {
        for (const args of [[text], ['deploy', text], [text, '--token', 'hunter2']]) {
          const { logs, unknown } = await attempt(args, tier)
          expect(unknown, text.slice(0, 20)).toHaveLength(1)
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
  })

  it('still records a real failure as a command and an error', async () => {
    const client = makeClient()
    const recordError = vi.spyOn(client, 'recordError')
    const unknown = vi.spyOn(client, 'recordUnknownCommand')
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const program = instrumentCommander(buildProgram(), client)
    await expect(program.parseAsync(['node', 'testcli', 'greet', '--nope'])).rejects.toThrow()
    stderr.mockRestore()
    expect(recordError).toHaveBeenCalled()
    expect(unknown).not.toHaveBeenCalled()
  })
})

describe('instrument', () => {
  it('builds a client and wires up instrumentation in one call', async () => {
    const { client, program } = instrument(buildProgram(), 'key', '1.0.0', {
      endpoint: NOWHERE,
      consentProvider: new StaticProvider(Tier.Basic),
      exportTimeoutMs: 50,
    })
    const recordInvocation = vi.spyOn(client, 'recordCommandInvocation')

    await program.parseAsync(['node', 'testcli', 'greet'])

    expect(recordInvocation).toHaveBeenCalled()
    await client.shutdown(200)
  })
})
