import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import type { Tier } from './tier.js'
import { isValidTier, parseTier, tierToString } from './tier.js'
import type { ConsentProvider } from './consent.js'
import { errNoConsentFile, errUnknownTierValue } from './errors.js'

/**
 * Replicates Go's `os.UserConfigDir()` semantics without adding a
 * dependency: `$XDG_CONFIG_HOME` (or `~/.config`) on Linux/other,
 * `~/Library/Application Support` on macOS, `%APPDATA%` on Windows.
 */
function userConfigDir(): string | undefined {
  switch (process.platform) {
    case 'win32':
      return process.env['APPDATA']
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support')
    default:
      return process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config')
  }
}

function defaultConsentPath(cliName: string): string | undefined {
  const dir = userConfigDir()
  if (!dir) return undefined
  return join(dir, cliName || 'argvio', 'argvio-consent.json')
}

export interface FileConsentProviderOptions {
  /** Overrides the default config file location entirely. */
  path?: string
}

interface ConsentFileContents {
  tier?: string
}

/**
 * The reference {@link ConsentProvider} implementation: reads a small
 * JSON file at a conventional per-CLI config location, namespaced under
 * the vendor's own CLI name to avoid collisions between unrelated CLIs
 * that both embed this SDK.
 *
 * Reads/writes are synchronous (see {@link ConsentProvider}'s doc
 * comment for why) — a small local JSON file read is cheap enough that
 * this doesn't meaningfully block startup.
 *
 * Use `options.path` to override the location entirely (e.g. a vendor
 * that already has its own config file and wants to store the tier
 * alongside it under a different mechanism should implement their own
 * {@link ConsentProvider} instead).
 */
export class FileConsentProvider implements ConsentProvider {
  /** The resolved config file path (after defaults/overrides), primarily for diagnostics and tests. */
  readonly path: string | undefined

  constructor(cliName: string, options: FileConsentProviderOptions = {}) {
    this.path = options.path || defaultConsentPath(cliName)
  }

  /**
   * A missing file, unreadable file, or malformed contents all throw
   * synchronously, so callers should place `FileConsentProvider` inside
   * `chainProviders` with a sane fallback (e.g.
   * `new StaticProvider(Tier.Anonymous)`).
   */
  resolve(): Tier {
    if (!this.path) throw errNoConsentFile
    const data = readFileSync(this.path, 'utf8')
    const parsed = JSON.parse(data) as ConsentFileContents
    const tier = parseTier(parsed.tier ?? '')
    if (tier === undefined) throw errUnknownTierValue
    return tier
  }

  /**
   * Persists `tier` as the chosen consent tier, creating the parent
   * directory if needed. Intended for use by a vendor's first-run
   * consent prompt. Does not itself enforce any tier ceiling — it's the
   * vendor's own UX writing the user's explicit choice.
   */
  store(tier: Tier): void {
    if (!this.path) throw errNoConsentFile
    if (!isValidTier(tier)) throw errUnknownTierValue
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const contents: ConsentFileContents = { tier: tierToString(tier) }
    writeFileSync(this.path, JSON.stringify(contents), { mode: 0o600 })
  }
}
