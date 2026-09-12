# argvio-node

Node.js SDKs for emitting CLI usage telemetry to Argvio's ingest
server, built around a client-enforced consent tier model.

> **Status:** pre-v0.1.0. See each package's README for its own status
> notes; the taxonomy and exact wire values are provisional pending
> confirmation against the server-side allowlist.

## Packages

This is an npm workspaces monorepo. Install only what you need:

| Package                                      | What it is                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`@getargvio/argvio`](packages/core)         | The core SDK: `Client`, the consent tier model, and the OTel wiring. Works standalone for any CLI. |
| [`@getargvio/yargs`](packages/yargs)         | Auto-instruments a [yargs](https://github.com/yargs/yargs) command tree.                           |
| [`@getargvio/commander`](packages/commander) | Auto-instruments a [commander](https://github.com/tj/commander.js) command tree.                   |

```sh
npm install @getargvio/argvio
# and one of:
npm install @getargvio/yargs
npm install @getargvio/commander
```

## Quickstart

```ts
// yargs
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { instrument } from '@getargvio/yargs'

const y = yargs(hideBin(process.argv)).scriptName('mycli')
// ... add commands ...
const { client } = instrument(y, process.env.MYCLI_ARGVIO_KEY ?? '', 'mycli', '1.4.0')
await y.parseAsync()
await client.shutdown(3000)
```

```ts
// commander
import { Command } from 'commander'
import { instrument } from '@getargvio/commander'

const program = new Command()
program.name('mycli').version('1.4.0')
// ... add commands ...
const { client } = instrument(program, process.env.MYCLI_ARGVIO_KEY ?? '', '1.4.0')
await program.parseAsync()
await client.shutdown(3000)
```

See each package's README/docs for the full picture — in particular,
both integrations require `exitOverride()`/`exitProcess(false)` so your
own code, not the CLI framework, decides the real process exit code.

## Consent tiers

Every signal carries a `cli.analytics.tier` attribute, enforced client-side:

| Tier                  | Adds                                                           |
| --------------------- | -------------------------------------------------------------- |
| `Anonymous` (default) | aggregate invocation/session/exit counts only, no identifiers  |
| `Basic`               | command path, flag names, exit code w/ path, latency w/ path   |
| `Full`                | session correlation ID, classified error signatures            |
| `OptIn`               | raw error messages and stack traces, via `client.optIn()` only |

See [`packages/core/docs/consent.md`](packages/core/docs/consent.md) for
the full model.

## Development

```sh
npm install
npm run build
npm run lint
npm run format:check
npm run typecheck
npm test
npm run bench
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for ground rules before opening a
PR — this SDK is meant to be embedded in other vendors' CLIs, so changes
here have a wide blast radius.

## License

MIT — see [LICENSE](LICENSE).
