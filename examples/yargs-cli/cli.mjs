#!/usr/bin/env node
// Minimal runnable example of @getargvio/yargs instrumentation.
//
// Try it with telemetry fully disabled (no network calls, safe to run
// anywhere):
//
//   ARGVIO_DISABLED=1 node cli.mjs greet world --loud
//   ARGVIO_DISABLED=1 node cli.mjs --help
//   ARGVIO_DISABLED=1 node cli.mjs boom; echo "exit code: $?"

import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { instrument } from '@getargvio/yargs'
import { ErrorCategory } from '@getargvio/argvio'

const y = yargs(hideBin(process.argv)).scriptName('yargs-cli-example')

y.command(
  'greet <name>',
  'greet someone',
  (builder) => builder.option('loud', { type: 'boolean', default: false }),
  (argv) => {
    const message = `Hello, ${argv.name}!`
    console.log(argv.loud ? message.toUpperCase() : message)
  },
)

y.command(
  'boom',
  'always fails, to demonstrate error capture',
  () => {},
  () => {
    throw new Error('simulated failure')
  },
)

function classify(err) {
  return err.message.includes('simulated') ? ErrorCategory.Internal : ErrorCategory.Unknown
}

const { client } = instrument(
  y,
  process.env.ARGVIO_API_KEY ?? '',
  'yargs-cli-example',
  '0.0.0',
  {},
  { classify },
)

client.recordSessionStart()

let exitCode = 0
try {
  await y.parseAsync()
} catch (err) {
  // A synchronously-thrown command handler error bypasses yargs' own
  // .fail() entirely (see docs/yargs-integration.md), so printing it
  // here — not inside instrumentYargs — is this CLI's own responsibility.
  console.error(err instanceof Error ? err.message : err)
  exitCode = 1
}

client.recordSessionEnd()
await client.shutdown(3000)
process.exit(exitCode)
