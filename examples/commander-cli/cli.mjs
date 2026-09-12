#!/usr/bin/env node
// Minimal runnable example of @getargvio/commander instrumentation.
//
// Try it with telemetry fully disabled (no network calls, safe to run
// anywhere):
//
//   ARGVIO_DISABLED=1 node cli.mjs greet world --loud
//   ARGVIO_DISABLED=1 node cli.mjs --help
//   ARGVIO_DISABLED=1 node cli.mjs boom; echo "exit code: $?"

import { Command } from 'commander'
import { instrument } from '@getargvio/commander'
import { ErrorCategory } from '@getargvio/argvio'

const program = new Command()
program.name('commander-cli-example').version('0.0.0')

program
  .command('greet <name>')
  .description('greet someone')
  .option('--loud', 'shout it', false)
  .action((name, opts) => {
    const message = `Hello, ${name}!`
    console.log(opts.loud ? message.toUpperCase() : message)
  })

program
  .command('boom')
  .description('always fails, to demonstrate error capture')
  .action(() => {
    throw new Error('simulated failure')
  })

function classify(err) {
  return err.message.includes('simulated') ? ErrorCategory.Internal : ErrorCategory.Unknown
}

const { client } = instrument(program, process.env.ARGVIO_API_KEY ?? '', '0.0.0', {}, { classify })

client.recordSessionStart()

let exitCode = 0
try {
  await program.parseAsync()
} catch (err) {
  // --help/--version already print their own output and are excluded
  // from recordError (see docs/commander-integration.md); a real action
  // error still needs this CLI's own top-level catch to print it.
  if (err?.code !== 'commander.helpDisplayed' && err?.code !== 'commander.version') {
    console.error(err instanceof Error ? err.message : err)
  }
  exitCode = err?.exitCode ?? 1
}

client.recordSessionEnd()
await client.shutdown(3000)
process.exit(exitCode)
