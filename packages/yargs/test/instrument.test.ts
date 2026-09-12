import { describe, expect, it, vi } from 'vitest'
import yargs from 'yargs'

import { createClient, ErrorCategory, StaticProvider, Tier } from '@getargvio/argvio'

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
  it('records a successful invocation with flags, exit code 0, and latency', async () => {
    const client = makeClient()
    const recordInvocation = vi.spyOn(client, 'recordCommandInvocation')
    const recordExit = vi.spyOn(client, 'recordExitCode')
    const recordLatency = vi.spyOn(client, 'recordLatency')

    const y = instrumentYargs(buildY(), client)
    await y.parseAsync(['greet', 'world', '--loud'])

    expect(recordInvocation).toHaveBeenCalledWith('testcli greet', ['loud'])
    expect(recordExit).toHaveBeenCalledWith('testcli greet', 0)
    expect(recordLatency).toHaveBeenCalledWith('testcli greet', expect.any(Number))
  })

  it('records a synchronously-thrown handler error and rethrows it', async () => {
    const client = makeClient()
    const recordError = vi.spyOn(client, 'recordError')
    const recordExit = vi.spyOn(client, 'recordExitCode')

    const y = instrumentYargs(buildY(), client, {
      classify: () => ErrorCategory.Internal,
    })

    await expect(y.parseAsync(['boom'])).rejects.toThrow('kaboom')
    expect(recordError).toHaveBeenCalledWith('testcli boom', ErrorCategory.Internal)
    expect(recordExit).toHaveBeenCalledWith('testcli boom', 1)
  })

  it('records an asynchronously-rejected handler error and rethrows it', async () => {
    const client = makeClient()
    const recordError = vi.spyOn(client, 'recordError')
    const recordExit = vi.spyOn(client, 'recordExitCode')

    const y = instrumentYargs(buildY(), client, {
      classify: () => ErrorCategory.Network,
    })

    await expect(y.parseAsync(['boom-async'])).rejects.toThrow('kaboom-async')
    expect(recordError).toHaveBeenCalledWith('testcli boom-async', ErrorCategory.Network)
    expect(recordExit).toHaveBeenCalledWith('testcli boom-async', 1)
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
