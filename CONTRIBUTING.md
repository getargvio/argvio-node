# Contributing to argvio-node

Thanks for considering a contribution. These SDKs are meant to be
embedded in many downstream CLI tools, so changes here have a wide
blast radius — please read this before opening a PR.

## Ground rules

- **No uncaught exceptions across the public API.** Every exported
  function/method must catch and degrade to a safe no-op rather than
  throw into (or leave a rejected promise dangling for) the host CLI.
  PRs that add a new exported function must include a test that proves
  it doesn't throw on bad/malformed input.
- **No new dependencies without justification.** Every dependency is a
  supply-chain and install-size cost imposed on every vendor. If your
  change needs a new package, say why in the PR description and why the
  standard library or an existing dependency (OTel, yargs, commander)
  doesn't already cover it.
- **The tier→field mapping is not yours to redefine.** The
  `cli.analytics.tier` allowlist mirrors a schema owned by the `public`
  server repo. If you need to add or change a taxonomy field, get the
  server-side schema change merged first, then update this repo to
  match — don't invent new fields or tiers here.
- **Non-blocking is a hard requirement.** Anything on the synchronous
  path of a `record*` call must be O(cheap) and must never perform
  network I/O synchronously.

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

Each package can also be worked on individually via
`npm run <script> -w packages/<name>`.

## Supported Node versions

CI builds against the two most recent Node.js LTS lines. Don't use
runtime features newer than the older of the two.

## Supported yargs/commander versions

CI tests `@getargvio/yargs` and `@getargvio/commander` against the
latest and previous-minor releases of their respective peer dependency.
Avoid depending on internal/undocumented APIs of either framework —
both integration packages already had to work around real gaps in what
each framework exposes publicly (see their `docs/*-integration.md`);
don't add a third workaround without documenting it the same way.

## Commit / PR style

- Keep PRs focused on one change, and to one package where possible.
- Explain _why_, not just _what_, in the PR description — especially for
  anything touching consent, tiering, or the async job queue in
  `packages/core/src/client.ts`.
- Add/update TSDoc on any exported symbol you touch — these packages'
  doc comments are a public API surface other companies depend on.

## Releases

Releases are managed by [release-please](https://github.com/googleapis/release-please)
in manifest mode — each package in `packages/*` is versioned and
published independently based on Conventional Commits. Don't hand-edit
`CHANGELOG.md` or `.release-please-manifest.json`; let the bot manage
them.
