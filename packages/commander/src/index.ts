import { CommanderError } from 'commander'
import type { Command } from 'commander'

import type { Client, ClientOptions } from '@getargvio/argvio'
import { createClient, ErrorCategory } from '@getargvio/argvio'
import type { ErrorCategory as ErrorCategoryType } from '@getargvio/argvio'

/** Configures {@link instrumentCommander}. */
export interface CommanderHookOptions {
  /** Maps a caught error to an {@link ErrorCategoryType}. Without it, every error is recorded as `ErrorCategory.Unknown`. */
  classify?: (err: Error) => ErrorCategoryType
  /** Skip the `outputHelp` wrapping. */
  captureHelp?: boolean
  /** Skip the `preAction` hook-based command-invocation capture. */
  captureInvocation?: boolean
}

/** Names of options the user explicitly passed on the command line — never their values. */
function changedOptionNames(cmd: Command): string[] {
  const names: string[] = []
  for (const option of cmd.options) {
    const key = option.attributeName()
    if (cmd.getOptionValueSource(key) === 'cli') {
      names.push(option.long?.replace(/^--/, '') ?? option.short?.replace(/^-/, '') ?? key)
    }
  }
  return names
}

/** The full command path (e.g. `"mycli sub leaf"`), walking up to the root command. */
function commandPath(cmd: Command): string {
  const names: string[] = []
  for (let current: Command | null = cmd; current; current = current.parent) {
    names.unshift(current.name())
  }
  return names.join(' ')
}

/**
 * Reports whether `err` represents commander's own control flow (help
 * or version display via `--help`/`-h`/`--version`) rather than an
 * actual failure. `exitOverride()` makes both of those throw a
 * `CommanderError` with `exitCode: 0` instead of calling
 * `process.exit()` directly — this package must not record those as
 * errors or non-zero exit codes.
 */
function isControlFlowExit(err: unknown): err is CommanderError {
  return err instanceof CommanderError && err.exitCode === 0
}

/**
 * Wires automatic telemetry capture into a commander command tree:
 *
 * - Command path + option names (see `Client.recordCommandInvocation`)
 *   are captured via `program.hook('preAction', ...)` — fires reliably
 *   for every resolved action command (verified against commander's own
 *   source: unlike `postAction`, `preAction` runs unconditionally before
 *   the action handler).
 * - Exit code and latency are captured by wrapping `program.parseAsync`
 *   — `postAction` does **not** run when an action handler throws or its
 *   returned promise rejects, so this package does not rely on it at
 *   all, measuring whole-invocation latency instead.
 * - Errors are captured in that same `parseAsync` wrapper's `catch`,
 *   distinguishing a real failure from commander's own `--help`/
 *   `--version` control-flow exits (see {@link isControlFlowExit}).
 * - Help usage is captured by wrapping the public, chainable
 *   `outputHelp` method.
 *
 * Calls `program.exitOverride()`: without it, commander calls
 * `process.exit()` itself on `--help`, `--version`, or a command
 * failure, before this package's wrapped `parseAsync` ever gets a
 * chance to record anything. After instrumenting, your own code owns
 * the real process exit — see docs/commander-integration.md.
 */
export function instrumentCommander(
  program: Command,
  client: Client,
  options: CommanderHookOptions = {},
): Command {
  const classify = options.classify ?? (() => ErrorCategory.Unknown)
  const captureHelp = options.captureHelp ?? true
  const captureInvocation = options.captureInvocation ?? true

  program.exitOverride()

  let lastCommandPath = program.name()

  if (captureInvocation) {
    program.hook('preAction', (_thisCommand, actionCommand) => {
      lastCommandPath = commandPath(actionCommand)
      client.recordCommandInvocation(lastCommandPath, changedOptionNames(actionCommand))
    })
  }

  if (captureHelp) {
    const originalOutputHelp = program.outputHelp.bind(program)
    program.outputHelp = ((...args: Parameters<Command['outputHelp']>) => {
      client.recordHelpFlagUsage(lastCommandPath)
      return originalOutputHelp(...args)
    }) as Command['outputHelp']
  }

  const originalParseAsync = program.parseAsync.bind(program)
  program.parseAsync = (async (...args: Parameters<Command['parseAsync']>) => {
    const start = Date.now()
    try {
      const result = await originalParseAsync(...args)
      client.recordExitCode(lastCommandPath, 0)
      client.recordLatency(lastCommandPath, Date.now() - start)
      return result
    } catch (err) {
      client.recordLatency(lastCommandPath, Date.now() - start)
      if (isControlFlowExit(err)) {
        client.recordExitCode(lastCommandPath, 0)
      } else {
        client.recordExitCode(lastCommandPath, 1)
        const error = err instanceof Error ? err : new Error(String(err))
        client.recordError(lastCommandPath, classify(error))
      }
      throw err
    }
  }) as Command['parseAsync']

  return program
}

/**
 * Builds a `Client` (using `program.name()`/`program.version()`) and
 * calls {@link instrumentCommander} to wire up capture.
 *
 *     const { client } = instrument(program, apiKey, '1.4.0')
 *     await program.parseAsync()
 *     await client.shutdown()
 */
export function instrument(
  program: Command,
  apiKey: string,
  cliVersion: string,
  clientOptions: ClientOptions = {},
  hookOptions: CommanderHookOptions = {},
): { client: Client; program: Command } {
  const client = createClient(apiKey, program.name(), cliVersion, clientOptions)
  instrumentCommander(program, client, hookOptions)
  return { client, program }
}
