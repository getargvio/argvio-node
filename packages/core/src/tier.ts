/**
 * The consent tier a CLI user (or their organization) has granted for
 * telemetry collection. Gates both which `record*` calls are allowed to
 * emit which fields, and the value sent on the `cli.analytics.tier`
 * resource attribute, which the public ingest server re-validates and
 * enforces as a backstop.
 *
 * Tiers are strictly ordered: each tier is a superset of the fields
 * allowed at the tier below it. Compare with plain `<`/`<=`/`>=` — the
 * numeric values are significant, not just distinct enum tags.
 *
 * TODO(schema): the wire string values in {@link tierToString} are
 * provisional pending the server-side allowlist file being confirmed.
 * They MUST match the `public` server's semantic allowlist exactly, or
 * the server will reject/strip the resource attribute.
 */
export const Tier = {
  /** No persistent or cross-invocation identifiers; aggregate counts only. */
  Anonymous: 0,
  /** Adds command path, flag names (not values), exit code, and latency. */
  Basic: 1,
  /** Adds session correlation and classified (not raw) error signatures. */
  Full: 2,
  /**
   * The explicit opt-in tier: raw error detail (stack traces, messages)
   * and any other field the allowlist marks opt-in-only. Never the
   * default; a vendor or user must positively select it.
   */
  OptIn: 3,
} as const

export type Tier = (typeof Tier)[keyof typeof Tier]

/** The OTel resource attribute key the tier is reported under. */
export const RESOURCE_ATTR_TIER = 'cli.analytics.tier'

const TIER_STRINGS: Record<Tier, string> = {
  [Tier.Anonymous]: 'anonymous',
  [Tier.Basic]: 'basic',
  [Tier.Full]: 'full',
  [Tier.OptIn]: 'opt-in',
}

/** Returns the wire value sent on the `cli.analytics.tier` resource attribute. */
export function tierToString(tier: Tier): string {
  return TIER_STRINGS[tier] ?? 'unknown'
}

/**
 * Parses a wire tier string (as produced by {@link tierToString}) back
 * into a {@link Tier}. Returns `undefined` if `value` does not match a
 * known tier — callers should fail closed to `Tier.Anonymous` in that
 * case, never assume the highest tier.
 */
export function parseTier(value: string): Tier | undefined {
  switch (value) {
    case 'anonymous':
      return Tier.Anonymous
    case 'basic':
      return Tier.Basic
    case 'full':
      return Tier.Full
    case 'opt-in':
      return Tier.OptIn
    default:
      return undefined
  }
}

/** Reports whether `value` is a known {@link Tier}. */
export function isValidTier(value: number): value is Tier {
  return (
    value === Tier.Anonymous || value === Tier.Basic || value === Tier.Full || value === Tier.OptIn
  )
}

/**
 * Reports whether `tier` permits emitting a field scoped to `required`.
 * A session resolved to `Tier.Full`, for example, `tierAllows(Tier.Full,
 * Tier.Basic)` and `tierAllows(Tier.Full, Tier.Full)` but not
 * `tierAllows(Tier.Full, Tier.OptIn)`.
 */
export function tierAllows(tier: Tier, required: Tier): boolean {
  return tier >= required
}

/** Returns the lower of `tier` and `ceiling`. */
export function clampTier(tier: Tier, ceiling: Tier): Tier {
  return tier > ceiling ? ceiling : tier
}

/**
 * A coarse, vendor-assigned classification of an error — deliberately
 * not the error's message or type name, both of which can carry
 * arbitrary (and potentially sensitive) free-form text. This SDK does
 * not attempt to infer a category from an error value itself; the
 * vendor's own error handling already knows which of these applies.
 */
export const ErrorCategory = {
  Unknown: 'unknown',
  /** Bad input, invalid flags/args. */
  User: 'user',
  Validation: 'validation',
  Network: 'network',
  Auth: 'auth',
  Internal: 'internal',
  Timeout: 'timeout',
  Canceled: 'canceled',
} as const

export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory]

const ERROR_CATEGORY_VALUES: ReadonlySet<string> = new Set(Object.values(ErrorCategory))

export function isValidErrorCategory(value: string): value is ErrorCategory {
  return ERROR_CATEGORY_VALUES.has(value)
}
