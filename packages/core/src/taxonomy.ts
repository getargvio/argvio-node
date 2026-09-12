import { randomBytes } from 'node:crypto'

/**
 * Attribute keys used on emitted signals. Exported so vendors and tests
 * can assert on them without relying on string literals staying in
 * sync.
 *
 * TODO(schema): these keys are provisional and must be checked against
 * the authoritative server-side allowlist before v0.1.0 ships.
 */
export const AttrCommandPath = 'cli.command.path'
export const AttrCommandFlags = 'cli.command.flags'
export const AttrExitCode = 'cli.command.exit_code'
export const AttrHelpUsed = 'cli.command.help_used'
export const AttrSessionId = 'cli.session.id'
export const AttrErrorCategory = 'cli.error.category'
/** TierOptIn only. */
export const AttrErrorMessage = 'cli.error.message'
/** TierOptIn only. */
export const AttrErrorStack = 'cli.error.stack'

/** The name of the histogram instrument `recordLatency` records to (unit: milliseconds). */
export const MetricCommandDuration = 'cli.command.duration'

/** A random, non-persistent per-process session correlation ID. Not a user or device identifier. */
export function newSessionId(): string {
  try {
    return randomBytes(16).toString('hex')
  } catch {
    return ''
  }
}
