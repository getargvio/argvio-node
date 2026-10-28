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

| Method                                          | What's emitted at Anonymous                                      |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `recordSessionStart`/`recordSessionEnd`         | `cli.sessions` counter increment only                            |
| `recordCommandInvocation`                       | `cli.invocations` counter increment only                         |
| `recordExitCode`                                | exit code, no command path                                       |
| `recordLatency`                                 | duration, no command path                                        |
| `recordHelpFlagUsage`                           | a bare "help was used" event, no command path                    |
| `recordError`                                   | `cli.errors` counter increment by command; no category, no event |
| `recordFeatureActivated`                        | nothing                                                          |
| `recordCounter`                                 | `cli.counter` increment: name and optional label only            |
| `recordDuration`                                | `cli.measure` timing: name and optional label only               |
| `recordCommand` memory and CPU time             | nothing                                                          |
| `recordSessionStart` size, startup, environment | nothing                                                          |

### Tier.Basic

Adds command path (e.g. `"mycli sub subsub"`) and flag _names_ (never
values — see below) to `recordCommandInvocation`, and adds the command
path attribute to `recordExitCode`, `recordLatency`, and
`recordHelpFlagUsage`.

Also adds:

- A per-process session correlation ID (`AttrSessionId`) — a random value
  generated once per `Client`, not a user or device identifier, and not
  persisted anywhere — and a per-install ID (`AttrInstallId`), a random
  UUID persisted in the CLI's config directory. Both are attached to the
  session start, command invoked, command completed, feature activated and error
  events, so
  the server can follow one install across invocations.
- `recordFeatureActivated(feature, commandPath?)` starts emitting a
  `cli.feature.activated` event: the feature name, the command name if
  `commandPath` is given, and the session and install IDs. The feature name
  must be a fixed identifier you choose in code (e.g. `"export-csv"`),
  never user input such as a flag value, path or argument. It is truncated
  to 64 characters, and each feature is reported at most once per process;
  the server works out an install's first use itself.
- `recordCommand` adds two measures to the `cli.command.<name>` span:
  `cli.process.peak_rss_bytes` (peak resident memory, in bytes) and
  `cli.process.cpu_time_ms` (user plus system CPU time, in milliseconds).
  Both are read once, when the command completes, from
  `process.resourceUsage().maxRSS` and `process.cpuUsage()`. They are
  **process-wide and cumulative**, not per command: a CLI that runs one
  command per process gets that command's figures, but in a long-lived or
  multi-command process each report covers everything since the process
  started. If the platform can't provide a figure, or reports zero, it is
  omitted rather than sent. Nothing is sent at `Tier.Anonymous`.
- `recordSessionStart` adds two optional attributes to the
  `cli.session.started` event, once per process:
  - `cli.startup.duration_ms` (startup overhead, in milliseconds) is
    `process.uptime()` read when `recordSessionStart` is called. The
    yargs and commander integrations call it as parsing begins, just
    before the command runs, so it covers everything from process start
    until then: Node bootstrap, your module loading and framework setup.
    If you call `recordSessionStart` yourself, call it at that same point.
  - `cli.binary.size_bytes` (binary size, in bytes) is reported only when
    running as a [Node single executable application](https://nodejs.org/api/single-executable-applications.html)
    (`node:sea` `isSea()`), where `process.execPath` is your build; it is
    the size of that file, from one `stat` per process. Node has no single
    CLI binary otherwise (`process.execPath` would be the generic `node`),
    so the attribute is omitted. A Node that can't tell (before 22.3) also
    omits it.

  Either is omitted, never sent as zero, if it can't be read. Nothing is
  sent at `Tier.Anonymous`.

  `recordSessionStart` also adds the environment the CLI runs in, read once
  from environment variables and `process`, with no subprocess. The shell
  and terminal are the privacy-sensitive part: each is mapped to a small
  fixed vocabulary in `src/environment.ts`, so a raw environment string,
  a path or `TERM` is never sent. Anything that can't be detected is omitted.

  | Attribute             | Value                                                                                                                                                                                                                                                                                                                                                   |
  | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `cli.shell`           | Basename of `$SHELL`, one of `bash`, `zsh`, `fish`, `sh`, `dash`, `ksh`, `tcsh`, `csh`, `nushell`, `elvish`, `xonsh`, `powershell`, `cmd`, else `other`. Never the path. On Windows without `$SHELL`: `powershell` if `PSModulePath` is set and `PROMPT` isn't, else `cmd` if `ComSpec` is set. Omitted if neither.                                     |
  | `cli.terminal`        | From terminal-specific markers, then `TERM_PROGRAM`, then a multiplexer (`TMUX`, `STY`): `windows-terminal`, `kitty`, `wezterm`, `ghostty`, `konsole`, `iterm2`, `vte`, `xterm`, `alacritty`, `apple-terminal`, `vscode`, `hyper`, `warp`, `zed`, `rio`, `tmux`, `screen`. A `TERM_PROGRAM` outside the list is `other`; no marker at all is `unknown`. |
  | `cli.stdout.is_tty`   | `true` when `process.stdout.isTTY === true`, otherwise `false` (piped or redirected).                                                                                                                                                                                                                                                                   |
  | `cli.runtime.name`    | `node`.                                                                                                                                                                                                                                                                                                                                                 |
  | `cli.runtime.version` | `process.versions.node`, e.g. `22.12.0`. Sent together with the runtime name.                                                                                                                                                                                                                                                                           |

  All five are sent on `cli.session.started` only, at `Tier.Basic` and
  above, and never at `Tier.Anonymous`. Detection is best effort: a
  multiplexer or a stale variable inherited from a parent shell can make the
  terminal wrong, and the values are only ever aggregated by the server.

- `recordError` starts emitting a `cli.error.raised` event: category
  (`ErrorCategory`, e.g. `ErrorCategory.Network`) plus command path. Never
  a message or stack trace — see Tier.OptIn.
- `recordError(commandPath, category, reason)` also sends the optional
  `reason` as `cli.error.reason`, on that event and on the `cli.errors`
  metric. It is a fixed-vocabulary identifier you define in code (e.g.
  `"no-token"`, `"invalid-url"`), never error text or user input. It must
  match `^[a-z0-9][a-z0-9._-]*$` and be at most 64 bytes; a reason that
  doesn't is dropped (the error is still recorded without it), never
  trimmed or rewritten. The SDK does not scrub it. The server caps the
  number of distinct reasons per tenant and folds the rest into `other`.
  The `classify` option of `@getargvio/commander` and `@getargvio/yargs`
  may return `{ category, reason }` for this. Nothing is sent at
  `Tier.Anonymous`.

### Vendor counters, at every tier

`recordCounter(name, n, { label })` adds to a product counter of your own
(e.g. "rules generated, by HTTP verb"). It is sent as the `cli.counter`
metric with two attributes, `cli.counter.name` and, if given,
`cli.counter.label`, next to the command-independent resource attributes
every signal carries (CLI version, OS, architecture, CI). It carries no
session or install ID, and no command path.

> **Warning: counters are accepted at the anonymous tier.** `recordCounter`
> sends at every tier, including `Tier.Anonymous` and CI, with no consent
> choice made. Counter names and labels must be fixed identifiers chosen in
> code, **never user input, file paths, host names, URLs, tokens or anything
> derived from them**. The SDK does not scrub them.

| Tier        | What `recordCounter` sends                             |
| ----------- | ------------------------------------------------------ |
| `Anonymous` | `cli.counter`: `cli.counter.name`, `cli.counter.label` |
| `Basic`+    | the same; counters add nothing at a higher tier        |

- `name` and `label` must each match `^[a-z0-9][a-z0-9._-]*$` and be at
  most 64 bytes. An increment with an invalid name or label is dropped
  entirely, not trimmed and not sent without its label.
- `n` must be a positive integer; zero, negative, fractional and
  non-numeric values are ignored.
- Increments are summed in memory, so a hot loop is cheap: each export
  carries one data point per name and label.
- The server caps the number of distinct names and, per name, distinct
  labels for each tenant, and folds the rest into `other`. Fixed
  vocabularies stay well under the caps.
- A disabled client (`disabled`, `DO_NOT_TRACK`, `ARGVIO_DISABLED`)
  sends nothing, and `recordCounter` never throws.

### Vendor timings, at every tier

`recordDuration(name, ms, { label })` reports how long something took, in
milliseconds (e.g. "rules fetch time, by HTTP verb"). It is sent as the
`cli.measure` histogram with two attributes, `cli.measure.name` and, if
given, `cli.measure.label`, next to the same command-independent resource
attributes as counters. It carries no session or install ID, and no
command path.

> **Warning: timings are accepted at the anonymous tier.** `recordDuration`
> sends at every tier, including `Tier.Anonymous` and CI, with no consent
> choice made. Timing names and labels must be fixed identifiers chosen in
> code, **never user input, file paths, host names, URLs, tokens or anything
> derived from them**. The SDK does not scrub them.

| Tier        | What `recordDuration` sends                            |
| ----------- | ------------------------------------------------------ |
| `Anonymous` | `cli.measure`: `cli.measure.name`, `cli.measure.label` |
| `Basic`+    | the same; timings add nothing at a higher tier         |

- `name` and `label` must each match `^[a-z0-9][a-z0-9._-]*$` and be at
  most 64 bytes. A timing with an invalid name or label is dropped
  entirely, not trimmed and not sent without its label.
- `ms` must be a finite number greater than zero; zero, negative,
  non-finite and non-numeric values are ignored.
- Values are aggregated in memory into fixed buckets (1, 5, 10, 50, 100,
  500, 1000, 5000, 10000, 60000 and 300000 ms, the same as the Go SDK), so a
  hot loop is cheap: each export carries one data point per name and label.
- The server caps the number of distinct names and, per name, distinct
  labels for each tenant, and folds the rest into `other`.
- A disabled client sends nothing, and `recordDuration` never throws.

### Tier.Full

Reserved. The server allowlist permits some fields at this level, but this
SDK sends nothing here beyond Tier.Basic.

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
