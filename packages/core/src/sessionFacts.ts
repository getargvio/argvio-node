/**
 * Vendor-supplied session facts for `cli.session.started`: how far the user's
 * configuration deviates from the defaults, and whether they are signed in to
 * the vendor's service. The SDK can't know either, so the vendor passes them
 * as client options, each as a value or a callback evaluated at session start.
 *
 * Both are narrowed to a single shape here (a bounded integer, a fixed enum)
 * so nothing else, such as a key name, a value or a username, can reach the
 * wire through them. Anything outside that shape is dropped, never coerced.
 */

/**
 * Whether the CLI user is signed in to the vendor's own service, as the
 * server's `cli.auth.state` enum defines it. Use these constants rather than
 * free strings.
 */
export const AuthState = {
  Authenticated: 'authenticated',
  Anonymous: 'anonymous',
  Unknown: 'unknown',
} as const

export type AuthState = (typeof AuthState)[keyof typeof AuthState]

const AUTH_STATE_VALUES: ReadonlySet<unknown> = new Set(Object.values(AuthState))

export function isValidAuthState(value: unknown): value is AuthState {
  return AUTH_STATE_VALUES.has(value)
}

/**
 * A value, or a callback returning it. A callback runs once, synchronously,
 * when the session starts, and only at a tier that sends the value. One that
 * throws, or returns something invalid, means the attribute is omitted.
 */
export type Lazy<T> = T | (() => T)

/**
 * The highest count reported. A larger one is sent as this, so a buggy
 * caller can't put an arbitrary number on the wire.
 */
export const MAX_CONFIG_CUSTOMIZED_COUNT = 1000

/**
 * Evaluates a {@link Lazy} option. A callback that throws yields `undefined`
 * so the host CLI never sees the failure.
 */
function evaluate<T>(source: Lazy<T> | undefined): unknown {
  if (source === undefined) return undefined
  try {
    return typeof source === 'function' ? (source as () => T)() : source
  } catch {
    return undefined
  }
}

/**
 * The number of configuration keys that differ from their defaults, as a
 * whole number between 0 and {@link MAX_CONFIG_CUSTOMIZED_COUNT}: fractions
 * are rounded down, and negatives and larger counts clamped. `undefined` when
 * unset, when the callback throws, or when the result isn't a finite number.
 */
export function resolveConfigCustomizedCount(source: Lazy<number> | undefined): number | undefined {
  const value = evaluate(source)
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(Math.max(Math.floor(value), 0), MAX_CONFIG_CUSTOMIZED_COUNT)
}

/**
 * The auth state, or `undefined` when unset, when the callback throws, or when
 * the result isn't one of {@link AuthState}.
 */
export function resolveAuthState(source: Lazy<AuthState> | undefined): AuthState | undefined {
  const value = evaluate(source)
  return isValidAuthState(value) ? value : undefined
}
