# Consent model

This document describes the four-tier consent model from this package's
perspective: what each tier unlocks, how the tier for a session gets
resolved, and how to plug in your own storage for the user's choice.

> **Schema status:** the tier→field mapping below mirrors what this SDK
> was scaffolded against. It has not yet been checked line-by-line
> against the server-side allowlist file (`public`'s source of truth).
> Search this repo for `TODO(schema)` before relying on exact wire
> values in a production integration; the shape of the API (which
> function requires which tier) is stable regardless.

## The four tiers

```ts
export const Tier = {
  Anonymous: 0, // default
  Basic: 1,
  Full: 2,
  OptIn: 3,
} as const
```

Tiers are strictly ordered — each is a superset of the tier below it.
`tierAllows(tier, required)` is how the SDK (and you, if you want)
checks this: `tierAllows(Tier.Full, Tier.Basic) === true`,
`tierAllows(Tier.Basic, Tier.Full) === false`.

### Tier.Anonymous (default)

No persistent or cross-invocation identifiers, no command path, no flag
names. Every taxonomy method still emits _something_ at this tier — an
aggregate counter increment — so vendors get install/usage volume
numbers even from users who've never made a choice.

| Method                                  | What's emitted at Anonymous                                  |
| --------------------------------------- | ------------------------------------------------------------ |
| `recordSessionStart`/`recordSessionEnd` | `cli.sessions` counter increment only                        |
| `recordCommandInvocation`               | `cli.invocations` counter increment only                     |
| `recordExitCode`                        | exit code, no command path                                   |
| `recordLatency`                         | duration, no command path                                    |
| `recordHelpFlagUsage`                   | a bare "help was used" event, no command path                |
| `recordError`                           | **nothing** — dropped, counted in `stats().belowTierDropped` |

### Tier.Basic

Adds command path (e.g. `"mycli sub subsub"`) and flag _names_ (never
values — see below) to `recordCommandInvocation`, and adds the command
path attribute to `recordExitCode`, `recordLatency`, and
`recordHelpFlagUsage`.

### Tier.Full

Adds:

- A per-process session correlation ID (`AttrSessionId`) on
  `recordSessionStart`/`recordSessionEnd` — a random value generated
  once per `Client`, not a user or device identifier, and not persisted
  anywhere.
- `recordError` starts actually emitting: category (`ErrorCategory`,
  e.g. `ErrorCategory.Network`) plus command path. Never a message or
  stack trace — see Tier.OptIn.

### Tier.OptIn

Raw error detail: message and, optionally, stack trace. This is
**only** reachable through `client.optIn()`:

```ts
const scope = client.optIn()
if (scope) {
  scope.recordErrorDetail(commandPath, err)
  // or, to also attach a stack trace:
  scope.recordErrorDetailWithStack(commandPath, err, err.stack ?? '')
}
```

`optIn()` returns `undefined` at every other tier — there is no other
function anywhere in this package that accepts a raw error message or
stack trace. This is deliberate: it should be structurally impossible
for a `recordError` call site written against a lower tier to
accidentally leak detail, not just a runtime check.

## What's never captured, at any tier

**Flag values.** `recordCommandInvocation` only ever accepts flag
_names_ (`string[]`). There is no tier, no option, and no method
anywhere in this SDK that accepts flag values. Flag values are
arbitrary free-form input a user typed — potentially secrets, paths, or
anything else — and this package doesn't try to be clever about
scrubbing that. If you need to understand _how_ a flag was used,
capture that yourself via `recordError`'s category or your own
out-of-band logging, scoped to your own judgment about what's safe.

## How the tier gets resolved

`createClient` resolves one tier for the whole `Client` (and therefore
the whole process — CLI invocations are short-lived, so consent isn't
expected to change mid-command):

1. If a `ConsentProvider` was supplied via `options.consentProvider`,
   its `resolve()` is called once, synchronously. If it succeeds, that
   tier is used.
2. Otherwise (no provider, or the provider threw), the tier from
   `options.defaultTier` is used — `Tier.Anonymous` if that wasn't set
   either.

Once resolved, the tier is fixed for the `Client`'s lifetime. There is
no code path that re-escalates it later, including from inside
`record*` calls — every call re-checks the resolved tier against what
it's trying to emit and drops (never upgrades) on mismatch.

## `ConsentProvider`

```ts
interface ConsentProvider {
  resolve(): Tier
}
```

### Composing providers

`chainProviders(...providers)` tries each in order and uses the first
one that resolves without throwing — useful for "env override, then
stored file, then anonymous default":

```ts
const provider = chainProviders(
  new EnvConsentProvider(), // caps at Anonymous in CI
  new FileConsentProvider('mycli'), // the user's stored choice
  new StaticProvider(Tier.Anonymous), // fail-safe default
)
const client = createClient(apiKey, 'mycli', version, { consentProvider: provider })
```

### The reference file-based provider

`FileConsentProvider` stores the chosen tier as JSON
(`{"tier":"basic"}`) at a conventional per-CLI path — the standard
`$XDG_CONFIG_HOME`/`~/Library/Application Support`/`%APPDATA%`
convention, implemented here without a dependency. Namespacing under
your CLI's own name avoids collisions with other CLIs that also embed
this SDK.

Use it to both read and persist a user's choice, e.g. from a first-run
prompt:

```ts
const fp = new FileConsentProvider('mycli')
const tier = promptUserForTier() // your own UX
fp.store(tier)
```

A missing, unreadable, or malformed file throws (never crashes the
process), so always place `FileConsentProvider` inside `chainProviders`
with a fallback, or accept that `createClient` will fall back to
`options.defaultTier` on its own.

### `DO_NOT_TRACK` and CI

These are handled outside `ConsentProvider` entirely, in `createClient`
itself:

- `DO_NOT_TRACK` (see [do-not-track.dev](https://do-not-track.dev)),
  when set to a truthy value, forces the client into full disabled
  mode — zero network calls — the same as `options.disabled = true`.
  This is a standing, explicit opt-out signal a user or environment
  sets deliberately, so it's honored as "no telemetry," not "least
  telemetry."
- CI environments (detected via common CI provider env vars — see
  `isCI()`) are **not** disabled by default, but `EnvConsentProvider`
  caps the tier at `Tier.Anonymous` when placed in your provider chain.
  If you want CI fully silent instead, check `isCI()` yourself and pass
  `options.disabled = true`.

### Writing your own `ConsentProvider`

Anything that can synchronously produce a `Tier` works — reading a flag
your CLI already parses, checking an already-loaded config object, or a
synchronous local file read. Throw (don't return a sentinel) when you
can't determine a tier; `createClient` treats that as "defer to the
next provider in the chain, or the configured default."

## Why `resolve()` is synchronous

`createClient` in Node is a plain synchronous function — there is no
way to synchronously await a `Promise` on Node's single-threaded event
loop, and making `createClient` itself return a `Promise` would mean
every consumer's `main()` has to `await` client construction before
doing anything else, which most CLI frameworks don't expect this early.
So `ConsentProvider.resolve()` is synchronous and must stay fast and
local — never a network call. All the built-in providers in this
package (`StaticProvider`, `DisabledProvider`, `EnvConsentProvider`,
`FileConsentProvider`) satisfy that by construction.
