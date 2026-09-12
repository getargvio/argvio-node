# @getargvio/argvio

A Node.js SDK for emitting CLI usage telemetry to Argvio's ingest
server, built around a tiered consent model that this package enforces
on the client side. Works standalone for any CLI; see
[`@getargvio/yargs`](https://www.npmjs.com/package/@getargvio/yargs) and
[`@getargvio/commander`](https://www.npmjs.com/package/@getargvio/commander)
for drop-in framework integrations.

> **Status:** pre-v0.1.0. The taxonomy field list and exact wire values
> for `cli.analytics.tier` mirror what the server-side allowlist is
> expected to look like, but have not yet been checked against that
> file directly (see `TODO(schema)` comments in `tier.ts` and
> `taxonomy.ts`). Treat the public API shape as stable, the exact wire
> values as provisional until that's confirmed.

## Install

```sh
npm install @getargvio/argvio
```

Requires Node.js 22+.

## Quickstart

```ts
import { createClient } from '@getargvio/argvio'

const client = createClient(process.env.MYCLI_ARGVIO_KEY ?? '', 'mycli', '1.4.0')
// client is always safe to use, even if construction hit a problem —
// check client.initError if you want to log why it degraded.

client.recordSessionStart()
process.on('exit', () => client.recordSessionEnd())

const start = Date.now()
try {
  await runCommand()
  client.recordExitCode('mycli run', 0)
} catch (err) {
  client.recordExitCode('mycli run', 1)
  client.recordError('mycli run', 'internal')
} finally {
  client.recordLatency('mycli run', Date.now() - start)
  await client.shutdown(3000)
}
```

For yargs or commander, use the dedicated integration packages instead
of wiring this up by hand.

## Consent tiers

Every signal this SDK emits carries a `cli.analytics.tier` attribute
and is shaped by the tier the current session resolved to:

| Tier                  | Adds                                                           |
| --------------------- | -------------------------------------------------------------- |
| `Anonymous` (default) | aggregate invocation/session/exit counts only, no identifiers  |
| `Basic`               | command path, flag names, exit code w/ path, latency w/ path   |
| `Full`                | session correlation ID, classified error signatures            |
| `OptIn`               | raw error messages and stack traces, via `client.optIn()` only |

The SDK enforces this client-side — it is structurally difficult to
call a lower-tier method with a higher-tier field (e.g. `recordError`
has no parameter for a stack trace at all; that only exists on the
`OptInScope` returned by `client.optIn()`, which itself only returns
something usable at `Tier.OptIn`). Server-side allowlist stripping is a
backstop, not the primary mechanism. See [docs/consent.md](docs/consent.md)
for the full model.

## Disabling telemetry

```ts
const client = createClient(apiKey, 'mycli', '1.4.0', { disabled: true })
```

or set `ARGVIO_DISABLED=1`. Either produces a `Client` that performs
**zero network calls** and adds negligible overhead.

The `DO_NOT_TRACK` environment variable ([convention](https://do-not-track.dev))
is also honored automatically. Running in CI (common CI env vars
detected automatically via `isCI()`) does not disable telemetry by
default — pair `EnvConsentProvider` with `chainProviders` to cap CI runs
at `Tier.Anonymous` instead.

## Reliability

No exported method throws under any input (bad options, network
failure, malformed consent config, unreachable endpoint) — every one is
wrapped so a bug here degrades to a no-op instead of crashing the host
CLI. `flush`/`shutdown` are idempotent and bounded by a timeout you
control.

## Design notes

- **Default OTLP transport is HTTP, not gRPC** (`options.transport`
  defaults to `'http'`). This avoids pulling `@grpc/grpc-js` into every
  consumer's dependency tree by default; pass `transport: 'grpc'` if
  you need gRPC.
- **`ConsentProvider.resolve()` is synchronous**, not
  `async (...) => ...`. `createClient` is a synchronous factory (never
  returns a `Promise`), so consent resolution has to be synchronous and
  fast too — see [docs/consent.md](docs/consent.md#why-resolve-is-synchronous).
- **Options are a plain object** (`ClientOptions`) rather than a
  builder pattern — object literals and optional properties already
  cover the need.
- **`createClient` never throws** and returns `client.initError`
  instead.

## Documentation

- [docs/consent.md](docs/consent.md) — the tier model in depth
- [`@getargvio/yargs`](https://www.npmjs.com/package/@getargvio/yargs) — yargs integration
- [`@getargvio/commander`](https://www.npmjs.com/package/@getargvio/commander) — commander integration

## License

MIT — see [LICENSE](../../LICENSE).
