import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
/** `Tier.Basic`+. Peak resident set size of the process, in bytes. */
export const AttrPeakRssBytes = 'cli.process.peak_rss_bytes'
/** `Tier.Basic`+. User plus system CPU time of the process, in milliseconds. */
export const AttrCpuTimeMs = 'cli.process.cpu_time_ms'
/**
 * `Tier.Basic`+. Size of the CLI's binary, in bytes. Only on
 * `cli.session.started`, and only for a Node single executable application.
 */
export const AttrBinarySizeBytes = 'cli.binary.size_bytes'
/**
 * `Tier.Basic`+. Time from process start to the point the command begins
 * running, in milliseconds. Only on `cli.session.started`.
 */
export const AttrStartupDurationMs = 'cli.startup.duration_ms'
/**
 * `Tier.Basic`+. The user's shell from a fixed vocabulary (`bash`, `zsh`,
 * `fish`, ...) or `other`, never a path. Only on `cli.session.started`.
 */
export const AttrShell = 'cli.shell'
/**
 * `Tier.Basic`+. The terminal emulator from a fixed vocabulary, `other` or
 * `unknown`, never a raw environment value. Only on `cli.session.started`.
 */
export const AttrTerminal = 'cli.terminal'
/**
 * `Tier.Basic`+. Whether stdout is a terminal (true) or piped or redirected
 * (false). Only on `cli.session.started`.
 */
export const AttrStdoutIsTty = 'cli.stdout.is_tty'
/** `Tier.Basic`+. The language runtime, `node`. Only on `cli.session.started`. */
export const AttrRuntimeName = 'cli.runtime.name'
/**
 * `Tier.Basic`+. The version of `cli.runtime.name` (`process.versions.node`).
 * Only on `cli.session.started`.
 */
export const AttrRuntimeVersion = 'cli.runtime.version'
/**
 * `Tier.Basic`+. How many configuration keys differ from their defaults,
 * supplied by the vendor via the `configCustomizedCount` option. A count
 * only, never key names or values. Only on `cli.session.started`.
 */
export const AttrConfigCustomizedCount = 'cli.config.customized_count'
/**
 * `Tier.Basic`+. Whether the user is signed in to the vendor's service
 * (`authenticated`, `anonymous` or `unknown`), supplied by the vendor via the
 * `authState` option. Only on `cli.session.started`.
 */
export const AttrAuthState = 'cli.auth.state'
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
/**
 * `Tier.Basic`+. A vendor-assigned reason from a fixed vocabulary, alongside
 * the error type. Never error text.
 */
export const AttrErrorReason = 'cli.error.reason'
/** `Tier.OptIn` only. */
export const AttrErrorMessage = 'cli.error.message'
/** `Tier.OptIn` only. */
export const AttrErrorStack = 'cli.error.stacktrace'

/**
 * Every tier. The name of a vendor-defined counter, a fixed identifier
 * chosen in code. Sent on `cli.counter`.
 */
export const AttrCounterName = 'cli.counter.name'
/**
 * Every tier. An optional fixed identifier that splits one counter into
 * series, chosen in code. Sent on `cli.counter`.
 */
export const AttrCounterLabel = 'cli.counter.label'

/**
 * Every tier. The name of a vendor-defined timing, a fixed identifier chosen
 * in code. Sent on `cli.measure`.
 */
export const AttrMeasureName = 'cli.measure.name'
/**
 * Every tier. An optional fixed identifier that splits one timing into
 * series, chosen in code. Sent on `cli.measure`.
 */
export const AttrMeasureLabel = 'cli.measure.label'

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
/** Unit: 1. A vendor-defined counter, see {@link Client.recordCounter}. */
export const MetricCounter = 'cli.counter'
/** Unit: milliseconds. A vendor-defined timing, see {@link Client.recordDuration}. */
export const MetricMeasure = 'cli.measure'

/**
 * Bucket boundaries, in milliseconds, of the `cli.measure` histogram. The
 * same as the Go SDK's, so a timing lands in the same buckets from either.
 */
export const MEASURE_BUCKET_BOUNDARIES_MS: readonly number[] = [
  1, 5, 10, 50, 100, 500, 1000, 5000, 10000, 60000, 300000,
]

/** The server's max_length for `cli.command.name`. */
const MAX_COMMAND_NAME_LENGTH = 128

/** The server's max_length for `cli.activation.feature`. */
export const MAX_ACTIVATION_FEATURE_LENGTH = 64

/**
 * The server's max_length for `cli.error.reason`, `cli.counter.name`,
 * `cli.counter.label`, `cli.measure.name` and `cli.measure.label`.
 */
const MAX_IDENTIFIER_LENGTH = 64

/**
 * The server's pattern for `cli.error.reason`, `cli.counter.name`,
 * `cli.counter.label`, `cli.measure.name` and `cli.measure.label`.
 */
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

/**
 * Reports whether `value` is acceptable as an error reason, or a counter or
 * measure name or label: the server's `^[a-z0-9][a-z0-9._-]*$` and at most 64
 * bytes (the pattern is ASCII only, so that is 64 characters). A value that
 * fails is dropped by the caller, never trimmed or rewritten into shape.
 */
export function isValidIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    IDENTIFIER_PATTERN.test(value)
  )
}

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

/**
 * Process-wide resource usage so far. Both figures are cumulative for the
 * whole process, not per command; a CLI normally runs one command per
 * process, so they describe that command.
 */
export interface ProcessResourceUsage {
  /** Peak resident set size, in bytes. */
  peakRssBytes?: number
  /** User plus system CPU time, in milliseconds. */
  cpuTimeMs?: number
}

/**
 * Reads the process's peak RSS and CPU time with two cheap synchronous
 * calls: no sampling, no timers. A measure the platform can't provide (the
 * call throws, or reports zero, negative or non-finite) is omitted rather
 * than reported as 0, which the server treats as "not reported" anyway.
 * Never throws.
 */
export function readProcessResourceUsage(): ProcessResourceUsage {
  const usage: ProcessResourceUsage = {}
  try {
    // maxRSS is in kilobytes.
    const rssBytes = Math.round(process.resourceUsage().maxRSS * 1024)
    if (Number.isFinite(rssBytes) && rssBytes > 0) usage.peakRssBytes = rssBytes
  } catch {
    // unsupported platform or OS error: omit
  }
  try {
    // user and system are in microseconds.
    const { user, system } = process.cpuUsage()
    const cpuMs = Math.round((user + system) / 1000)
    if (Number.isFinite(cpuMs) && cpuMs > 0) usage.cpuTimeMs = cpuMs
  } catch {
    // unsupported platform or OS error: omit
  }
  return usage
}

/**
 * Milliseconds since this process started, which is how long module
 * loading and framework setup took when read as the command begins
 * running. Returns undefined, never 0, if the platform can't provide it.
 * Never throws.
 */
export function readStartupDurationMs(): number | undefined {
  try {
    const ms = Math.round(process.uptime() * 1000)
    return Number.isFinite(ms) && ms > 0 ? ms : undefined
  } catch {
    return undefined
  }
}

/**
 * Size in bytes of the running binary, but only when this is a Node single
 * executable application (`node:sea` `isSea()`), where `process.execPath`
 * is the vendor's build. In any other case `process.execPath` is the
 * generic `node` binary, not the vendor's, so nothing is reported. At most
 * one `stat`. Returns undefined, never 0, on any failure. Never throws.
 */
export function readBinarySizeBytes(): number | undefined {
  try {
    const sea = process.getBuiltinModule?.('node:sea')
    if (!sea?.isSea()) return undefined
    const size = statSync(process.execPath).size
    return Number.isFinite(size) && size > 0 ? size : undefined
  } catch {
    return undefined
  }
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
