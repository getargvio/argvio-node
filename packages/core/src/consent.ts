import { Tier, isValidTier } from './tier.js'
import { errNoProviderResolved } from './errors.js'

/**
 * Resolves the consent tier that should be used for the current
 * process. Consulted once per {@link Client}, synchronously, at
 * construction time (cached for the process lifetime — consent is not
 * expected to change mid-invocation of a short-lived CLI command).
 *
 * `resolve` here is **synchronous**: Node's single-threaded event loop
 * has no way to synchronously await a Promise, and `createClient` must
 * return a fully
 * resolved, usable Client without an async round-trip (see the "why
 * createClient is synchronous" note in client.ts). Implementations must
 * therefore be fast and local only — env vars, an already-loaded config
 * object, a synchronous local file read — never network I/O. A provider
 * that throws is treated identically to `Tier.Anonymous` (fail closed).
 */
export interface ConsentProvider {
  resolve(): Tier
}

/**
 * A {@link ConsentProvider} that always resolves to a fixed tier. Useful
 * for tests, for vendors who resolve consent themselves before
 * constructing the Client, or as a fallback wrapped by
 * {@link chainProviders}.
 */
export class StaticProvider implements ConsentProvider {
  constructor(private readonly tier: Tier) {}

  resolve(): Tier {
    return isValidTier(this.tier) ? this.tier : Tier.Anonymous
  }
}

/**
 * A {@link ConsentProvider} that always resolves to `Tier.Anonymous`. It
 * exists as an explicit, self-documenting choice distinct from "a
 * provider that happens to return anonymous".
 */
export class DisabledProvider implements ConsentProvider {
  resolve(): Tier {
    return Tier.Anonymous
  }
}

/**
 * Returns a {@link ConsentProvider} that tries each provider in order
 * and returns the first successful (non-throwing) result. If all
 * providers throw, it throws {@link errNoProviderResolved} (the caller
 * treats that as `Tier.Anonymous`, same as any other thrown error). Lets
 * a vendor compose, e.g., "env override, then config file, then
 * anonymous default" without writing that logic themselves.
 */
export function chainProviders(
  ...providers: ReadonlyArray<ConsentProvider | null | undefined>
): ConsentProvider {
  return {
    resolve(): Tier {
      for (const provider of providers) {
        if (!provider) continue
        try {
          return provider.resolve()
        } catch {
          continue
        }
      }
      throw errNoProviderResolved
    },
  }
}
