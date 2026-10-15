import { readFileSync } from 'node:fs'

import { resourceFromAttributes } from '@opentelemetry/resources'
import type { Resource } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'

import type { ResolvedConfig } from './options.js'
import { detectCIProvider } from './consentEnv.js'

/** Resource attribute keys describing the CLI build and host, promoted by the server into filterable columns. */
export const ResourceAttrCLIVersion = 'cli.version'
export const ResourceAttrOS = 'cli.os'
export const ResourceAttrArch = 'cli.arch'
export const ResourceAttrIsCI = 'cli.is_ci'
export const ResourceAttrCIProvider = 'cli.ci_provider'

/** Maps `process.platform` onto the server's `cli.os` enum. */
export function normalizeOS(platform: string): string {
  switch (platform) {
    case 'linux':
    case 'darwin':
      return platform
    case 'win32':
      return 'windows'
    default:
      return 'other'
  }
}

/** Maps `process.arch` onto the server's `cli.arch` enum. */
export function normalizeArch(arch: string): string {
  switch (arch) {
    case 'x64':
      return 'amd64'
    case 'arm64':
    case 'arm':
      return arch
    case 'ia32':
      return '386'
    default:
      return 'other'
  }
}

/** This package's own name, reported on `telemetry.sdk.name`. */
const SDK_NAME = '@getargvio/argvio'

/**
 * Returns this package's own version, read from its `package.json` at
 * runtime rather than hardcoded, so the reported value always matches
 * what a vendor actually installed.
 */
function sdkVersion(): string {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url)
    const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export function buildResource(cfg: ResolvedConfig): Resource {
  const ciProvider = detectCIProvider()
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: cfg.cliName,
    [ATTR_SERVICE_VERSION]: cfg.cliVersion,
    'telemetry.sdk.name': SDK_NAME,
    'telemetry.sdk.version': sdkVersion(),
    'telemetry.sdk.language': 'nodejs',
    [ResourceAttrCLIVersion]: cfg.cliVersion,
    [ResourceAttrOS]: normalizeOS(process.platform),
    [ResourceAttrArch]: normalizeArch(process.arch),
    [ResourceAttrIsCI]: ciProvider !== undefined,
    ...(ciProvider ? { [ResourceAttrCIProvider]: ciProvider } : {}),
    ...cfg.resourceAttributes,
  })
}
