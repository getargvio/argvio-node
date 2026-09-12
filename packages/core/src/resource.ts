import { readFileSync } from 'node:fs'

import { resourceFromAttributes } from '@opentelemetry/resources'
import type { Resource } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'

import type { ResolvedConfig } from './options.js'

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
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: cfg.cliName,
    [ATTR_SERVICE_VERSION]: cfg.cliVersion,
    'telemetry.sdk.name': SDK_NAME,
    'telemetry.sdk.version': sdkVersion(),
    'telemetry.sdk.language': 'nodejs',
    ...cfg.resourceAttributes,
  })
}
