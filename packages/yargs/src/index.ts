import type { Argv, Arguments } from 'yargs'

import type { Client, ClientOptions } from '@getargvio/argvio'
import { createClient, ErrorCategory } from '@getargvio/argvio'
import type { ErrorCategory as ErrorCategoryType } from '@getargvio/argvio'

const INVOCATION_MARKER = Symbol('argvio.recordedInvocation')

/** Configures {@link instrumentYargs}. */
export interface YargsHookOptions {
  /** Maps a caught error to an {@link ErrorCategoryType}. Without it, every error is recorded as `ErrorCategory.Unknown`. */
  classify?: (err: Error) => ErrorCategoryType
  /** Skip the best-effort help-flag capture (see docs/yargs-integration.md for why it's best-effort). */
  captureHelp?: boolean
  /** Skip the `middleware`-based command-invocation capture. */
  captureInvocation?: boolean
  /**
   * Called from inside the installed `.fail()` handler instead of this
   * package's default print-and-rethrow behavior. Use this if you
   * already have your own `.fail()` logic you want preserved —
   * `instrumentYargs` cannot chain with a pre-existing `.fail()` handler
   * the way it can with `middleware` (see docs/yargs-integration.md).
   * Error/exit-code recording itself always happens uniformly in the
   * wrapped `parseAsync`, regardless of whether `onFail` is set. Note
   * `.fail()` only fires for validation errors and *rejected* async
   * handlers — for the async-rejection case specifically, yargs invokes
   * `.fail()` purely as a side effect and swallows anything it throws,
   * so `onFail` cannot change whether the original rejection propagates.
   */
  onFail?: (msg: string, err: Error | undefined, yargsInstance: Argv) => void
  /** Flag tokens treated as a help request for the best-effort help capture. Defaults to `['--help', '-h']`. */
  helpFlags?: readonly string[]
}

function extractFlagNames(rawArgs: readonly string[]): string[] {
  const names = new Set<string>()
  for (const token of rawArgs) {
    if (!token.startsWith('-') || token === '-' || token === '--') continue
    const name = token.replace(/^--?/, '').split('=')[0]
    if (name) names.add(name)
  }
  return [...names]
}

function commandPathFrom(argv: Arguments): string {
  const script = typeof argv['$0'] === 'string' ? argv['$0'] : ''
  const segments = argv._.map((segment) => String(segment))
  return [script, ...segments].filter(Boolean).join(' ')
}

/**
 * Best-effort command path guess before parsing has happened (used for
 * help capture, which fires before yargs has resolved a command path
 * of its own). No CLI name prefix — the builder-side `Argv` has no
 * public getter for `scriptName`, only a setter.
 */
function guessCommandPathFromRawArgs(rawArgs: readonly string[]): string {
  const segments: string[] = []
  for (const token of rawArgs) {
    if (token.startsWith('-')) break
    segments.push(token)
  }
  return segments.join(' ')
}

type ParseFn = Argv['parseAsync']

/**
 * Wires automatic telemetry capture into a yargs instance:
 *
 * - Command path + flag names (see `Client.recordCommandInvocation`) are
 *   captured via global `middleware(fn, true)` — applied before
 *   validation, so it still runs even if validation later fails.
 * - Exit code, latency, and errors are captured by wrapping
 *   `parseAsync`/`parse` — the one place guaranteed to run exactly once
 *   per invocation, regardless of success or failure.
 * - Help usage is captured on a **best-effort** basis: yargs handles
 *   `--help`/`-h` internally before middleware, `.fail()`, or any
 *   command handler ever runs, so this package scans the raw args
 *   for help flags *before* calling the real parse.
 *
 * Calls `yargsInstance.exitProcess(false)`: with the default
 * `exitProcess(true)`, yargs calls `process.exit()` itself on failure or
 * `--help`, before this package's wrapped `parseAsync`/`.fail()` ever
 * get a chance to record anything. After instrumenting, your own code
 * must await `parseAsync()` and decide the real process exit itself —
 * see docs/yargs-integration.md.
 */
export function instrumentYargs(
  yargsInstance: Argv,
  client: Client,
  options: YargsHookOptions = {},
): Argv {
  const classify = options.classify ?? (() => ErrorCategory.Unknown)
  const captureHelp = options.captureHelp ?? true
  const captureInvocation = options.captureInvocation ?? true
  const helpFlags = options.helpFlags ?? ['--help', '-h']

  yargsInstance.exitProcess(false)

  let lastCommandPath = ''
  let rawArgs: readonly string[] = []

  if (captureInvocation) {
    yargsInstance.middleware((argv) => {
      const marker = argv as unknown as Record<symbol, boolean>
      if (marker[INVOCATION_MARKER]) return
      marker[INVOCATION_MARKER] = true

      lastCommandPath = commandPathFrom(argv)
      client.recordCommandInvocation(lastCommandPath, extractFlagNames(rawArgs))
    }, true)
  }

  // yargs only ever routes a failure through `.fail()` for validation
  // errors and *rejected* async handlers — a handler that throws
  // synchronously bypasses `.fail()` entirely and propagates straight
  // out of `parse()`/`parseAsync()`. So `.fail()` here does not itself
  // record anything (that would double-count the async-rejection case
  // and miss the synchronous-throw case); its only jobs are (a) letting
  // a vendor plug in `onFail`, and (b) — critically — converting a
  // validation failure into an actual thrown error. Without this, with
  // `exitProcess(false)`, yargs' default fail behavior swallows the
  // failure and `parseAsync()` would resolve as if nothing went wrong.
  // Error/exit-code/latency recording happens uniformly for every
  // failure mode in the `parseAsync` wrapper's `catch` below instead.
  yargsInstance.fail((msg, err, yi) => {
    if (options.onFail) {
      options.onFail(msg, err, yi)
      return
    }
    process.stderr.write(`${msg}\n`)
    throw err ?? new Error(msg)
  })

  const wrapParse = (original: ParseFn): ParseFn => {
    return function wrapped(this: Argv, ...args: Parameters<ParseFn>) {
      const maybeArgs = args[0]
      rawArgs = Array.isArray(maybeArgs) ? maybeArgs.map(String) : process.argv.slice(2)

      if (captureHelp && helpFlags.some((flag) => rawArgs.includes(flag))) {
        client.recordHelpFlagUsage(guessCommandPathFromRawArgs(rawArgs))
      }

      const start = Date.now()
      let resultPromise: Promise<unknown>
      try {
        // A command handler that throws synchronously (as opposed to
        // returning a rejected Promise) makes yargs' own `parse()`
        // throw synchronously too, bypassing `.fail()` entirely — this
        // try/catch normalizes that into a rejected promise so both
        // failure modes go through the same recording path below.
        resultPromise = (original as (...a: unknown[]) => Promise<unknown>).apply(this, args)
      } catch (err) {
        resultPromise = Promise.reject(err)
      }
      return resultPromise
        .then((result: unknown) => {
          client.recordExitCode(lastCommandPath, 0)
          client.recordLatency(lastCommandPath, Date.now() - start)
          return result
        })
        .catch((err: unknown) => {
          client.recordExitCode(lastCommandPath, 1)
          client.recordLatency(lastCommandPath, Date.now() - start)
          client.recordError(
            lastCommandPath,
            classify(err instanceof Error ? err : new Error(String(err))),
          )
          throw err
        })
    } as ParseFn
  }

  yargsInstance.parseAsync = wrapParse(yargsInstance.parseAsync.bind(yargsInstance))

  return yargsInstance
}

/**
 * Builds a `Client` (using `cliName`/`cliVersion` you provide — yargs
 * has no built-in fields to read them from) and calls
 * {@link instrumentYargs} to wire up capture.
 *
 *     const { client } = instrument(yargsInstance, apiKey, 'mycli', '1.4.0')
 *     const argv = await yargsInstance.parseAsync()
 *     await client.shutdown()
 */
export function instrument(
  yargsInstance: Argv,
  apiKey: string,
  cliName: string,
  cliVersion: string,
  clientOptions: ClientOptions = {},
  hookOptions: YargsHookOptions = {},
): { client: Client; yargs: Argv } {
  const client = createClient(apiKey, cliName, cliVersion, clientOptions)
  instrumentYargs(yargsInstance, client, hookOptions)
  return { client, yargs: yargsInstance }
}
