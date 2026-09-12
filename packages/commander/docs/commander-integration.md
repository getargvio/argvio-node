# commander integration

`@getargvio/commander` wires automatic telemetry capture into a
[commander](https://github.com/tj/commander.js) command tree.

## The one-liner

```ts
import { Command } from 'commander'
import { instrument } from '@getargvio/commander'

const program = new Command()
program.name('mycli').version('1.4.0')
// ... add commands as usual ...

const { client } = instrument(program, process.env.MYCLI_ARGVIO_KEY ?? '', '1.4.0')

await program.parseAsync()
await client.shutdown(3000)
```

`instrument` builds a `Client` using `program.name()` (set via
`.name()`) and the `cliVersion` you pass, and calls `instrumentCommander`
to wire up capture. `ClientOptions` and `CommanderHookOptions` pass
through as the 4th/5th arguments if you need to configure either.

If you already construct your `Client` some other way, call
`instrumentCommander(program, client, hookOptions)` directly instead of
`instrument`.

## Why this isn't just `preAction`/`postAction`

This is worth understanding before you customize anything.

Commander's `postAction` hook does **not** run when an action handler
throws or its returned promise rejects — verified directly against
commander's source
(`Command.js`'s `_chainOrCall`/`_chainOrCallHooks` flow): the promise
chain that runs `preAction` → the action handler → `postAction` simply
short-circuits on rejection, skipping `postAction` entirely. A
`postAction`-only integration would silently miss every failing
command.

So `instrumentCommander` uses different extension points for different
concerns:

| Capture                    | Extension point                  | Fires when                                                    |
| -------------------------- | -------------------------------- | ------------------------------------------------------------- |
| Command path, option names | `program.hook('preAction', ...)` | Every resolved action command, reliably (unlike `postAction`) |
| Exit code, latency, errors | wrapping `program.parseAsync`    | The whole parse+dispatch settles, success or failure          |
| Help usage                 | wrapping `program.outputHelp`    | `--help`/`-h`, or an explicit `.help()` call                  |

### `exitOverride()` is required

`instrumentCommander` calls `program.exitOverride()`. Without it,
commander calls `process.exit()` itself on `--help`, `--version`, or a
command failure — before this package's wrapped `parseAsync` ever gets
a chance to run. After instrumenting, **your own code owns the real
process exit**: await `parseAsync()` and decide the exit code yourself
based on whether it resolved or rejected.

### `--help`/`--version` are not errors

With `exitOverride()` set, commander doesn't call `process.exit()` for
`--help`/`--version` — it throws a `CommanderError` with `exitCode: 0`
instead (verified against commander's own source). `instrumentCommander`
checks for exactly this shape (`err instanceof CommanderError &&
err.exitCode === 0`) and records exit code `0`, never `recordError`, for
those cases — only a `CommanderError` with a _nonzero_ `exitCode`, or a
plain thrown/rejected `Error` from your own action handler, counts as a
real failure.

### Option names, not values

`changedOptionNames` uses `Command#getOptionValueSource(key) === 'cli'`
to find options the user actually passed on the command line (as
opposed to defaults, env-sourced, or config-sourced values). It only
ever extracts option _names_, never values.

## Options

```ts
instrumentCommander(program, client, {
  classify: (err) => (err.message.includes('ECONNREFUSED') ? 'network' : 'unknown'),
  captureHelp: true,
  captureInvocation: true,
})
```

- **`classify(err)`** — maps a caught error to an `ErrorCategory`.
  Without it, every error is recorded as `ErrorCategory.Unknown` — this
  package deliberately doesn't try to guess a category from an error's
  message or type; only your own error handling knows which of your
  errors are user mistakes vs. network failures vs. internal bugs.
- **`captureHelp: false`** — skip the `outputHelp` wrapping, if you have
  your own help instrumentation you don't want touched.
- **`captureInvocation: false`** — skip the `preAction` hook, if you
  want to call `client.recordCommandInvocation` yourself.

## Worked example

```ts
import { Command } from 'commander'
import { instrument } from '@getargvio/commander'
import { ErrorCategory } from '@getargvio/argvio'

function classifyDeployError(err: Error) {
  return err.message.includes('invalid deploy configuration')
    ? ErrorCategory.Validation
    : ErrorCategory.Unknown
}

async function main() {
  const program = new Command()
  program.name('mycli')

  program
    .command('deploy')
    .option('--dry-run', 'simulate without applying')
    .action(async (opts) => {
      await runDeploy(opts)
    })

  program.command('status').action(async () => {
    await runStatus()
  })

  const { client } = instrument(
    program,
    process.env.MYCLI_ARGVIO_KEY ?? '',
    '2.0.0',
    {},
    {
      classify: classifyDeployError,
    },
  )

  client.recordSessionStart()

  let exitCode = 0
  try {
    await program.parseAsync()
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
(`recordCommandInvocation`'s option list will include `"dry-run"`) —
never its value.
