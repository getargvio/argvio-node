# yargs integration

`@getargvio/yargs` wires automatic telemetry capture into a
[yargs](https://github.com/yargs/yargs) command tree. This document
covers what it captures automatically, what it deliberately doesn't,
and a worked example.

## The one-liner

```ts
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { instrument } from '@getargvio/yargs'

const y = yargs(hideBin(process.argv)).scriptName('mycli')
// ... add commands as usual ...

const { client } = instrument(y, process.env.MYCLI_ARGVIO_KEY ?? '', 'mycli', '1.4.0')

const argv = await y.parseAsync()
await client.shutdown(3000)
```

`instrument` builds a `Client` from the `apiKey`/`cliName`/`cliVersion`
you pass — yargs has no built-in fields to read them from
automatically — and calls `instrumentYargs` to wire up capture.
`ClientOptions` and `YargsHookOptions` pass through as the 5th/6th
arguments if you need to configure either.

If you already construct your `Client` some other way, call
`instrumentYargs(yargsInstance, client, hookOptions)` directly instead
of `instrument`.

## Why this instruments at the whole-invocation level

yargs has no public, reassignable list of individual command handlers
to wrap directly. So this package uses the extension points yargs
_does_ expose, at the whole-invocation level instead of per-command:

| Capture                    | Extension point                               | Fires when                                           |
| -------------------------- | --------------------------------------------- | ---------------------------------------------------- |
| Command path, flag names   | `middleware(fn, applyBeforeValidation: true)` | Command resolved and args parsed, before validation  |
| Exit code, latency, errors | wrapping `parseAsync()`                       | The whole parse+dispatch settles, success or failure |
| Help usage                 | best-effort raw-argv scan before parsing      | `--help`/`-h` present in the raw args                |

### `exitProcess(false)` is required

`instrumentYargs` calls `yargsInstance.exitProcess(false)`. With the
default `exitProcess(true)`, yargs calls `process.exit()` itself on
`--help` or a validation/handler failure — before this package's
wrapped `parseAsync()` or `.fail()` ever get a chance to run. After
instrumenting, **your own code owns the real process exit**: await
`parseAsync()` and call `process.exit()` yourself based on whether it
resolved or rejected, so you capture the _real_ OS exit code.

### `.fail()` is not what you'd expect

yargs only ever routes a failure through `.fail(fn)` for validation
errors and _rejected_ async command handlers — a handler that **throws
synchronously** bypasses `.fail()` entirely and propagates straight out
of `parse()`/`parseAsync()` as a synchronous throw. Verified against
yargs' own source (`command.js`'s `maybeAsyncResult` wrapping). So
`instrumentYargs` does not record anything inside `.fail()` itself
(that would double-count the async-rejection case and miss the
synchronous-throw case); instead, **all** error/exit-code/latency
recording happens uniformly in the wrapped `parseAsync`'s `catch`,
which normalizes both failure modes (a `try`/`catch` around the call
converts a synchronous throw into the same rejected-promise shape as an
async rejection). `.fail()`'s only remaining jobs are:

1. Converting a validation failure into an actual thrown error — without
   this, `exitProcess(false)` makes yargs' default fail behavior
   silently swallow the failure, and `parseAsync()` would resolve as if
   nothing went wrong.
2. Letting you plug in `onFail` for your own failure UX. Note that for
   the async-rejection case specifically, yargs calls `.fail()` purely
   as a side effect and swallows anything it throws — `onFail` cannot
   change whether the original rejection propagates in that case.

`instrumentYargs` cannot chain with a `.fail()` handler you already
installed, the way it can compose with `middleware` — yargs has no
getter for a previously registered fail function. If you have your own
`.fail()` logic, pass it as `onFail` instead of calling `.fail()`
yourself.

### Help capture is best-effort

yargs handles `--help`/`-h` internally before middleware, `.fail()`, or
any command handler ever runs. This
package scans the raw argument array for configured help flags
(`helpFlags`, defaulting to `['--help', '-h']`) _before_ calling the
real parse, and derives a best-effort command path by taking the
leading non-flag tokens. If you've renamed the help flag via
`.help('some-other-name')`, pass `helpFlags: ['--some-other-name']`.

### Flag names, not values

`extractFlagNames` only ever extracts flag _names_ from the raw argv
tokens (`--flag`, `--flag=value`, `-f` → `"flag"`/`"f"`) — never values.
Combined short flags (`-abc`) are captured as a single name rather than
three; this is a deliberate simplicity trade-off for a regex-based
best-effort extraction, not a security boundary being loosened (there
is still no code path anywhere in `@getargvio/argvio` that accepts flag
_values_).

## Options

```ts
instrumentYargs(yargsInstance, client, {
  classify: (err) => (err.message.includes('ECONNREFUSED') ? 'network' : 'unknown'),
  captureHelp: true,
  captureInvocation: true,
  helpFlags: ['--help', '-h'],
  onFail: (msg, err, yi) => {
    /* your own failure UX */
  },
})
```

## Worked example

```ts
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { instrument } from '@getargvio/yargs'
import { ErrorCategory } from '@getargvio/argvio'

function classifyDeployError(err: Error) {
  return err.message.includes('invalid deploy configuration')
    ? ErrorCategory.Validation
    : ErrorCategory.Unknown
}

async function main() {
  const y = yargs(hideBin(process.argv)).scriptName('mycli')

  y.command(
    'deploy',
    'deploy the app',
    (b) => b.option('dry-run', { type: 'boolean' }),
    async (argv) => {
      await runDeploy(argv)
    },
  )
  y.command(
    'status',
    'show status',
    () => {},
    async () => {
      await runStatus()
    },
  )

  const { client } = instrument(
    y,
    process.env.MYCLI_ARGVIO_KEY ?? '',
    'mycli',
    '2.0.0',
    {},
    { classify: classifyDeployError },
  )

  client.recordSessionStart()

  let exitCode = 0
  try {
    await y.parseAsync()
  } catch {
    exitCode = 1
  }

  client.recordSessionEnd()
  await client.shutdown(3000)
  process.exit(exitCode)
}

main()
```

`deploy`'s `--dry-run` flag, if set, is captured by name only
(`recordCommandInvocation`'s flag list will include `"dry-run"`) —
never its value.
