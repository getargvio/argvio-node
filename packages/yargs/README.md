# @getargvio/yargs

Auto-instruments a [yargs](https://github.com/yargs/yargs) command tree
with [`@getargvio/argvio`](https://www.npmjs.com/package/@getargvio/argvio)
CLI usage telemetry.

## Install

```sh
npm install @getargvio/yargs
```

`yargs` is a peer dependency — bring your own (`>=17.0.0`).

## Usage

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

See [docs/yargs-integration.md](docs/yargs-integration.md) for exactly
what's captured automatically, the `exitProcess(false)` requirement,
and why `.fail()` behaves differently here than you might expect.

## License

MIT — see [LICENSE](../../LICENSE).
