import { describe, expect, it, vi } from 'vitest'
import { Command } from 'commander'

import { createClient, ErrorCategory, StaticProvider, Tier } from '@getargvio/argvio'

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
  it('records a successful invocation with option names, exit code 0, and latency', async () => {
    const client = makeClient()
    const recordInvocation = vi.spyOn(client, 'recordCommandInvocation')
    const recordExit = vi.spyOn(client, 'recordExitCode')
    const recordLatency = vi.spyOn(client, 'recordLatency')

    const program = instrumentCommander(buildProgram(), client)
    await program.parseAsync(['node', 'testcli', 'greet', '--loud'])

    expect(recordInvocation).toHaveBeenCalledWith('testcli greet', ['loud'])
    expect(recordExit).toHaveBeenCalledWith('testcli greet', 0)
    expect(recordLatency).toHaveBeenCalledWith('testcli greet', expect.any(Number))
  })

  it('records a synchronously-thrown action error and rethrows it', async () => {
    const client = makeClient()
    const recordError = vi.spyOn(client, 'recordError')
    const recordExit = vi.spyOn(client, 'recordExitCode')

    const program = instrumentCommander(buildProgram(), client, {
      classify: () => ErrorCategory.Internal,
    })

    await expect(program.parseAsync(['node', 'testcli', 'boom'])).rejects.toThrow('kaboom')
    expect(recordError).toHaveBeenCalledWith('testcli boom', ErrorCategory.Internal)
    expect(recordExit).toHaveBeenCalledWith('testcli boom', 1)
  })

  it('records an asynchronously-rejected action error and rethrows it', async () => {
    const client = makeClient()
    const recordError = vi.spyOn(client, 'recordError')
    const recordExit = vi.spyOn(client, 'recordExitCode')

    const program = instrumentCommander(buildProgram(), client, {
      classify: () => ErrorCategory.Network,
    })

    await expect(program.parseAsync(['node', 'testcli', 'boom-async'])).rejects.toThrow(
      'kaboom-async',
    )
    expect(recordError).toHaveBeenCalledWith('testcli boom-async', ErrorCategory.Network)
    expect(recordExit).toHaveBeenCalledWith('testcli boom-async', 1)
  })

  it('treats --help as a control-flow exit, not an error, and records help usage', async () => {
    const client = makeClient()
    const recordError = vi.spyOn(client, 'recordError')
    const recordExit = vi.spyOn(client, 'recordExitCode')
    const recordHelp = vi.spyOn(client, 'recordHelpFlagUsage')
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const program = instrumentCommander(buildProgram(), client)
    await expect(program.parseAsync(['node', 'testcli', '--help'])).rejects.toThrow()

    expect(recordHelp).toHaveBeenCalled()
    expect(recordError).not.toHaveBeenCalled()
    expect(recordExit).toHaveBeenCalledWith('testcli', 0)

    vi.restoreAllMocks()
  })

  it('treats --version as a control-flow exit, not an error', async () => {
    const client = makeClient()
    const recordError = vi.spyOn(client, 'recordError')
    const recordExit = vi.spyOn(client, 'recordExitCode')
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const program = instrumentCommander(buildProgram().version('1.0.0'), client)
    await expect(program.parseAsync(['node', 'testcli', '--version'])).rejects.toThrow()

    expect(recordError).not.toHaveBeenCalled()
    expect(recordExit).toHaveBeenCalledWith('testcli', 0)

    vi.restoreAllMocks()
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
