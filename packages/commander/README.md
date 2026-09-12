# @getargvio/commander

Auto-instruments a [commander](https://github.com/tj/commander.js)
command tree with
[`@getargvio/argvio`](https://www.npmjs.com/package/@getargvio/argvio)
CLI usage telemetry.

## Install

```sh
npm install @getargvio/commander
```

`commander` is a peer dependency — bring your own (`>=12.0.0`).

## Usage

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

See [docs/commander-integration.md](docs/commander-integration.md) for
exactly what's captured automatically, the `exitOverride()` requirement,
and why `--help`/`--version` are treated as control flow rather than
errors.

## License

MIT — see [LICENSE](../../LICENSE).
