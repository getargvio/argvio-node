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
