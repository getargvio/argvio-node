import { CommanderError } from 'commander'
import type { Command } from 'commander'

import type { Client, ClientOptions } from '@getargvio/argvio'
import { createClient, ErrorCategory, nearestCommand } from '@getargvio/argvio'
import type { CommandCandidate } from '@getargvio/argvio'
import type { ErrorCategory as ErrorCategoryType, ErrorClassification } from '@getargvio/argvio'

/** Configures {@link instrumentCommander}. */
export interface CommanderHookOptions {
  /**
   * Maps a caught error to an {@link ErrorCategoryType}, or to
   * `{ category, reason }` to also report a fixed-vocabulary reason (e.g.
   * `"no-token"`). The reason must be an identifier chosen in code
   * (`^[a-z0-9][a-z0-9._-]*$`, at most 64 bytes), never error text or user
   * input; one that doesn't match is dropped. Without `classify`, every
   * error is recorded as `ErrorCategory.Unknown` with no reason.
   */
  classify?: (err: Error) => ErrorCategoryType | ErrorClassification
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

/** The code commander gives the error it raises for a command that does not exist. */
const UNKNOWN_COMMAND_CODE = 'commander.unknownCommand'

/** The commands the user can see below `cmd`, hidden ones left out. */
function visibleSubcommands(cmd: Command): Command[] {
  const visible = new Set(cmd.createHelp().visibleCommands(cmd))
  return cmd.commands.filter((sub) => visible.has(sub))
}

/** The dotted `cli.command.name` of `cmd`: the path below the root, without the CLI's own name. */
function dottedName(cmd: Command): string {
  const names: string[] = []
  for (let current: Command | null = cmd; current?.parent; current = current.parent) {
    names.unshift(current.name())
  }
  return names.join('.')
}

/** Every visible command in the tree below `cmd`, as dotted names. */
function registeredCommandNames(cmd: Command, into: string[] = []): string[] {
  for (const sub of visibleSubcommands(cmd)) {
    into.push(dottedName(sub))
    registeredCommandNames(sub, into)
  }
  return into
}

/**
 * Finds the command commander gave up on: the deepest one that resolved a
 * subcommand from its arguments and then found no match for the next
 * operand. The operand itself is what the user typed, so it is only ever
 * used to look a command up, never recorded.
 */
function failedLookup(program: Command): { cmd: Command; typed: string } | undefined {
  let cmd = program
  for (;;) {
    const typed = cmd.args[0]
    if (typed === undefined) return undefined
    const next = cmd.commands.find((sub) => sub.name() === typed || sub.aliases().includes(typed))
    if (!next) return { cmd, typed }
    cmd = next
  }
}

/**
 * Reports an unknown command to the client with the nearest known command as
 * its only content. What the user typed goes into {@link nearestCommand},
 * which returns one of the registered command names or nothing, and is never
 * passed on. Never throws.
 */
function recordUnknownCommand(program: Command, client: Client): void {
  let suggestion: string | undefined
  let known: string[] = []
  try {
    known = registeredCommandNames(program)
    const failed = failedLookup(program)
    if (failed) {
      const prefix = dottedName(failed.cmd)
      const candidates: CommandCandidate[] = []
      for (const sub of visibleSubcommands(failed.cmd)) {
        const name = prefix ? `${prefix}.${sub.name()}` : sub.name()
        for (const token of [sub.name(), ...sub.aliases()]) candidates.push({ token, name })
      }
      suggestion = nearestCommand(failed.typed, candidates)
    }
  } catch {
    // no suggestion: the attempt is still reported
  }
  client.recordUnknownCommand(suggestion, known)
}

/**
 * Wires automatic telemetry capture into a commander command tree:
 *
 * - Command path + option names (see `Client.recordCommandInvocation`)
 *   are captured via `program.hook('preAction', ...)` — fires reliably
 *   for every resolved action command (verified against commander's own
 *   source: unlike `postAction`, `preAction` runs unconditionally before
 *   the action handler).
 * - The session start, and each completed command's exit code and
 *   latency (`Client.recordCommand`), are captured by wrapping `program.parseAsync`
 *   — `postAction` does **not** run when an action handler throws or its
 *   returned promise rejects, so this package does not rely on it at
 *   all, measuring whole-invocation latency instead.
 * - Errors are captured in that same `parseAsync` wrapper's `catch`,
 *   distinguishing a real failure from commander's own `--help`/
 *   `--version` control-flow exits (see {@link isControlFlowExit}).
 * - Help usage is captured by wrapping the public, chainable
 *   `outputHelp` method.
 * - A command that does not exist (commander's `commander.unknownCommand`
 *   error) is reported with `Client.recordUnknownCommand` instead of as a
 *   failed command: it carries only the nearest registered command, never
 *   what was typed. The error is rethrown unchanged.
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
  let lastFlagNames: string[] = []

  if (captureInvocation) {
    program.hook('preAction', (_thisCommand, actionCommand) => {
      lastCommandPath = commandPath(actionCommand)
      lastFlagNames = changedOptionNames(actionCommand)
      client.recordCommandInvocation(lastCommandPath, lastFlagNames)
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
    client.recordSessionStart()
    const recordCommand = (exitCode: number): void => {
      client.recordCommand({
        path: lastCommandPath,
        flagNames: lastFlagNames,
        startMs: start,
        durationMs: Date.now() - start,
        exitCode,
      })
    }
    try {
      const result = await originalParseAsync(...args)
      recordCommand(0)
      return result
    } catch (err) {
      // --help/--version aren't command runs, same as in the cobra integration.
      if (err instanceof CommanderError && err.code === UNKNOWN_COMMAND_CODE) {
        // A failed lookup is an attempt, not an invocation or an error.
        recordUnknownCommand(program, client)
      } else if (!isControlFlowExit(err)) {
        recordCommand(1)
        const error = err instanceof Error ? err : new Error(String(err))
        const classified = classify(error)
        const { category, reason } =
          typeof classified === 'string' ? { category: classified } : classified
        client.recordError(lastCommandPath, category, reason)
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
