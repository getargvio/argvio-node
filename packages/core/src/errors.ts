/**
 * Sentinel errors thrown/rejected internally. Never thrown across the
 * public API surface itself (every exported method swallows errors via
 * {@link safeRun}/{@link safeRunAsync} — see safety.ts) but used as
 * rejection reasons a {@link ConsentProvider} chain can inspect or a
 * vendor can `instanceof`-check if they care why resolution failed.
 */

export class ArgvioError extends Error {
  constructor(message: string) {
    super(`argvio: ${message}`)
    this.name = 'ArgvioError'
  }
}

export const errNoProviderResolved = new ArgvioError('no consent provider resolved a tier')
export const errNoConsentFile = new ArgvioError('no consent config file path resolved')
export const errUnknownTierValue = new ArgvioError('unknown tier value in consent config')
