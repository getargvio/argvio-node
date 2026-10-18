import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Attribute keys used on emitted signals. Exported so vendors and tests
 * can assert on them without relying on string literals staying in
 * sync.
 *
 * Every event, span, metric and attribute name in this file is taken from
 * the `public` server's allowlist (schema/allowlist/v1.yaml in
 * getargvio/argvio), which rejects anything else. Change them only
 * together with a server-side schema version.
 */
export const AttrCommandName = 'cli.command.name'
export const AttrExitCode = 'cli.command.exit_code'
export const AttrDurationMs = 'cli.command.duration_ms'
/** `Tier.Basic`+. */
export const AttrFlagNames = 'cli.flag.names'
/** `Tier.Basic`+. */
export const AttrSessionId = 'cli.session_id'
/** `Tier.Basic`+. */
export const AttrInstallId = 'cli.install_id'
export const AttrHelpFlag = 'cli.help.flag'
/** How the CLI was installed; supplied by the vendor via the `installMethod` option. */
export const AttrInstallMethod = 'cli.install.method'
/** `Tier.Basic`+. A fixed feature identifier supplied by the vendor. */
export const AttrActivationFeature = 'cli.activation.feature'
/** `Tier.Basic`+. */
export const AttrErrorType = 'cli.error.type'
/** `Tier.OptIn` only. */
export const AttrErrorMessage = 'cli.error.message'
/** `Tier.OptIn` only. */
export const AttrErrorStack = 'cli.error.stacktrace'

/** Log event names. */
export const EventSessionStarted = 'cli.session.started'
export const EventCommandInvoked = 'cli.command.invoked'
export const EventCommandCompleted = 'cli.command.completed'
export const EventFeatureActivated = 'cli.feature.activated'
export const EventHelpViewed = 'cli.help.viewed'
export const EventErrorRaised = 'cli.error.raised'

/**
 * Prefixes the name of the span `recordCommand` emits for each command
 * (e.g. `cli.command.deploy.push`). The server's command dashboards
 * (frequency, latency, error rate, exit codes) are built from these spans.
 */
export const SpanCommandPrefix = 'cli.command.'

/** Metric instrument names. */
export const MetricCommandInvocations = 'cli.command.invocations'
/** Unit: milliseconds. */
export const MetricCommandDuration = 'cli.command.duration'
export const MetricErrors = 'cli.errors'

/** The server's max_length for `cli.command.name`. */
const MAX_COMMAND_NAME_LENGTH = 128

/** The server's max_length for `cli.activation.feature`. */
export const MAX_ACTIVATION_FEATURE_LENGTH = 64

/**
 * Converts a command path as the CLI framework reports it
 * (`"mycli deploy push"`) into the dotted `cli.command.name` the server
 * expects (`"deploy.push"`). The CLI's own name is dropped, since every
 * record already carries it as `service.name`, except for the root command
 * itself, which keeps it so it still has a name.
 */
export function commandName(cliName: string, commandPath: string): string {
  let parts = commandPath.split(/\s+/).filter(Boolean)
  if (parts.length > 1 && parts[0] === cliName) parts = parts.slice(1)
  const name = parts.join('.') || cliName || 'root'
  return name.slice(0, MAX_COMMAND_NAME_LENGTH)
}

/** A random, non-persistent per-process session correlation ID. Not a user or device identifier. */
export function newSessionId(): string {
  try {
    return randomBytes(16).toString('hex')
  } catch {
    return ''
  }
}

const INSTALL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Returns the install ID stored at `path`, generating and persisting a new
 * random one on first use. Returns `''` whenever the ID can't be
 * persisted: an ID that changes on every run would count every invocation
 * as a new install, which is worse than no ID at all.
 */
export function loadOrCreateInstallId(path: string | undefined): string {
  if (!path) return ''
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (INSTALL_ID_PATTERN.test(existing)) return existing
  } catch {
    // missing or unreadable: create one below
  }
  try {
    const id = randomUUID()
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, `${id}\n`, { mode: 0o600 })
    return id
  } catch {
    return ''
  }
}
