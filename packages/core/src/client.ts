import { SpanStatusCode } from '@opentelemetry/api'
import type { Attributes, Counter, Histogram, Tracer } from '@opentelemetry/api'
import { SeverityNumber } from '@opentelemetry/api-logs'
import type { Logger } from '@opentelemetry/api-logs'
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node'

import type { ClientOptions } from './options.js'
import { resolveConfig } from './options.js'
import { buildExporters } from './otlp.js'
import { buildResource } from './resource.js'
import { isDoNotTrackRequested } from './consentEnv.js'
import { detectEnvironment } from './environment.js'
import type { AuthState, Lazy } from './sessionFacts.js'
import { resolveAuthState, resolveConfigCustomizedCount } from './sessionFacts.js'
import { Tier, tierAllows, tierToString, isValidTier, RESOURCE_ATTR_TIER } from './tier.js'
import type { ErrorCategory } from './tier.js'
import { ErrorCategory as ErrorCategoryValues, isValidErrorCategory } from './tier.js'
import {
  AttrActivationFeature,
  AttrAuthState,
  AttrCommandName,
  AttrConfigCustomizedCount,
  AttrCounterLabel,
  AttrCounterName,
  AttrDurationMs,
  AttrErrorMessage,
  AttrErrorReason,
  AttrErrorStack,
  AttrErrorType,
  AttrExitCode,
  AttrFlagNames,
  AttrHelpFlag,
  AttrInstallId,
  AttrInstallMethod,
  AttrMeasureLabel,
  AttrMeasureName,
  AttrPeakRssBytes,
  AttrRuntimeName,
  AttrRuntimeVersion,
  AttrShell,
  AttrStdoutIsTty,
  AttrTerminal,
  AttrCpuTimeMs,
  AttrBinarySizeBytes,
  AttrStartupDurationMs,
  AttrSessionId,
  EventCommandCompleted,
  EventCommandInvoked,
  EventErrorRaised,
  EventFeatureActivated,
  EventHelpViewed,
  EventSessionStarted,
  MetricCommandDuration,
  MetricCommandInvocations,
  MetricCounter,
  MetricErrors,
  MetricMeasure,
  MAX_ACTIVATION_FEATURE_LENGTH,
  MEASURE_BUCKET_BOUNDARIES_MS,
  SpanCommandPrefix,
  commandName,
  isValidIdentifier,
  loadOrCreateInstallId,
  newSessionId,
  readBinarySizeBytes,
  readProcessResourceUsage,
  readStartupDurationMs,
} from './taxonomy.js'
import type { Stats } from './safety.js'
import { ARGVIO_DEBUG, DroppedCounters, safeRun } from './safety.js'

/**
 * Identifies this SDK to the OTel SDKs it wraps (tracer/meter/logger name),
 * distinct from the CLI's own resource attributes.
 */
const INSTRUMENTATION_NAME = '@getargvio/argvio'

type Job = () => void | Promise<void>

/**
 * A small in-process bounded async queue: `push` never blocks the
 * caller, and drops (counted, never applying backpressure) when full.
 * Jobs run on subsequent ticks via `setImmediate`, off the caller's
 * synchronous call stack.
 */
class JobQueue {
  private readonly items: Job[] = []
  private draining = false

  constructor(
    private readonly maxSize: number,
    private readonly counters: DroppedCounters,
  ) {}

  push(job: Job): void {
    if (this.items.length >= this.maxSize) {
      this.counters.queueOverflow++
      return
    }
    this.items.push(job)
    this.scheduleDrain()
  }

  /**
   * Enqueues a control signal (e.g. a drain sentinel) bypassing the size
   * bound, so `waitForDrain` waits for genuine backlog instead of
   * silently racing ahead when the queue happens to be full.
   */
  private pushControl(job: Job): void {
    this.items.push(job)
    this.scheduleDrain()
  }

  private scheduleDrain(): void {
    if (this.draining) return
    this.draining = true
    setImmediate(() => {
      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    for (;;) {
      const job = this.items.shift()
      if (!job) break
      try {
        await job()
      } catch (err) {
        this.counters.recoveredErrors++
        if (ARGVIO_DEBUG) {
          const msg = err instanceof Error ? err.message : '(non-error thrown value)'
          process.stderr.write(`argvio: recovered internal error: ${msg}\n`)
        }
      }
    }
    this.draining = false
  }

  /** Resolves once every job enqueued before this call has finished executing, or `timeoutMs` elapses. */
  async waitForDrain(timeoutMs: number): Promise<void> {
    const done = new Promise<void>((resolve) => {
      this.pushControl(() => {
        resolve()
      })
    })
    await withTimeout(done, timeoutMs)
  }
}

async function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  try {
    await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** Options for {@link Client.recordCounter}. */
export interface CounterOptions {
  /**
   * Splits the counter into series (e.g. a tool or HTTP verb). A fixed
   * identifier chosen in code, subject to the same rules as the counter name.
   */
  label?: string
}

/** Options for {@link Client.recordDuration}. */
export interface DurationOptions {
  /**
   * Splits the timing into series (e.g. a tool or HTTP verb). A fixed
   * identifier chosen in code, subject to the same rules as the timing name.
   */
  label?: string
}

/** One completed command, for {@link Client.recordCommand}. */
export interface CommandResult {
  /** The full command path, as for {@link Client.recordCommandInvocation}. */
  path: string
  /** Names (never values) of the flags the user set. Only sent at `Tier.Basic`+. */
  flagNames?: readonly string[]
  /** When the command began, in epoch milliseconds. Defaults to `durationMs` before now. */
  startMs?: number
  /** How long the command ran, in milliseconds. */
  durationMs: number
  /** The command's exit code; non-zero counts as an error. */
  exitCode: number
}

interface ClientParams {
  cliName?: string
  installIdPath?: string | undefined
  installMethod?: string | undefined
  configCustomizedCount?: Lazy<number> | undefined
  authState?: Lazy<AuthState> | undefined
  tracer?: Tracer
  disabled: boolean
  initError: Error | null
  tier: Tier
  queueSize: number
  shutdownTimeoutMs: number
  tracerProvider?: NodeTracerProvider
  meterProvider?: MeterProvider
  loggerProvider?: LoggerProvider
  logger?: Logger
  latencyHist?: Histogram
  invocationsCounter?: Counter
  errorEventsCounter?: Counter
  productCounter?: Counter
  measureHist?: Histogram
}

/**
 * The entry point for emitting telemetry. Every method is safe to call
 * on a disabled Client (explicitly disabled, `DO_NOT_TRACK`/`ARGVIO_DISABLED`,
 * or degraded due to a construction error) — vendors never need to
 * check `disabled` before using a Client.
 *
 * Construct via {@link createClient}, never directly.
 */
export class Client {
  readonly tier: Tier
  readonly disabled: boolean
  /** Set if construction encountered a problem; the Client still degrades to a safe disabled no-op. */
  readonly initError: Error | null

  private readonly counters = new DroppedCounters()
  private readonly queue: JobQueue
  private readonly shutdownTimeoutMs: number
  private shuttingDown = false
  private shutdownStarted = false
  private sessionId: string | undefined
  private sessionStarted = false
  private readonly cliName: string
  private readonly installIdPath: string | undefined
  private readonly installMethod: string | undefined
  private readonly configCustomizedCount: Lazy<number> | undefined
  private readonly authState: Lazy<AuthState> | undefined
  private installId: string | undefined
  private readonly activatedFeatures = new Set<string>()
  private readonly tracer: Tracer | undefined

  private readonly tracerProvider: NodeTracerProvider | undefined
  private readonly meterProvider: MeterProvider | undefined
  private readonly loggerProvider: LoggerProvider | undefined
  private readonly logger: Logger | undefined
  private readonly latencyHist: Histogram | undefined
  private readonly invocationsCounter: Counter | undefined
  private readonly errorEventsCounter: Counter | undefined
  private readonly productCounter: Counter | undefined
  private readonly measureHist: Histogram | undefined

  /** @internal use {@link createClient} */
  constructor(params: ClientParams) {
    this.disabled = params.disabled
    this.initError = params.initError
    this.tier = params.tier
    this.shutdownTimeoutMs = params.shutdownTimeoutMs
    this.queue = new JobQueue(params.queueSize, this.counters)
    this.tracerProvider = params.tracerProvider
    this.meterProvider = params.meterProvider
    this.loggerProvider = params.loggerProvider
    this.logger = params.logger
    this.latencyHist = params.latencyHist
    this.invocationsCounter = params.invocationsCounter
    this.errorEventsCounter = params.errorEventsCounter
    this.productCounter = params.productCounter
    this.measureHist = params.measureHist
    this.cliName = params.cliName ?? ''
    this.installIdPath = params.installIdPath
    this.installMethod = params.installMethod
    this.configCustomizedCount = params.configCustomizedCount
    this.authState = params.authState
    this.tracer = params.tracer
  }

  private enabled(): boolean {
    return !this.disabled && !this.shuttingDown
  }

  /** A snapshot of in-process counters about dropped records. Never sent over the network. */
  stats(): Stats {
    return this.counters.snapshot()
  }

  private gate(required: Tier): boolean {
    if (!this.enabled()) return false
    if (!tierAllows(this.tier, required)) {
      this.counters.belowTierCeil++
      return false
    }
    return true
  }

  private tierAttr(): Attributes {
    return { [RESOURCE_ATTR_TIER]: tierToString(this.tier) }
  }

  private emitEvent(name: string, severity: SeverityNumber, attributes: Attributes = {}): void {
    this.queue.push(() => {
      this.emitEventNow(name, severity, attributes)
    })
  }

  private emitEventNow(name: string, severity: SeverityNumber, attributes: Attributes = {}): void {
    this.logger?.emit({
      eventName: name,
      timestamp: Date.now(),
      severityNumber: severity,
      attributes: { ...this.tierAttr(), ...attributes },
    })
  }

  private name(commandPath: string): string {
    return commandName(this.cliName, commandPath)
  }

  /**
   * Lazily generates a session correlation ID at `Tier.Basic`+. A random,
   * non-persistent identifier scoped to a single process invocation —
   * not a user or device identifier.
   */
  private ensureSessionId(): string {
    if (!tierAllows(this.tier, Tier.Basic)) return ''
    if (this.sessionId === undefined) {
      this.sessionId = newSessionId()
    }
    return this.sessionId
  }

  /**
   * The session and install ID attributes for a record, empty below
   * `Tier.Basic`. May read or create the install ID file, so call it from
   * inside a queued job rather than on the caller's stack.
   */
  private identityAttrs(sessionId: string): Attributes {
    const attrs: Attributes = {}
    if (sessionId) attrs[AttrSessionId] = sessionId
    if (tierAllows(this.tier, Tier.Basic)) {
      this.installId ??= loadOrCreateInstallId(this.installIdPath)
      if (this.installId) attrs[AttrInstallId] = this.installId
    }
    return attrs
  }

  /**
   * Records the start of a CLI process session, which is what the server
   * counts sessions, active installs and retention from. Call it as early
   * as possible (the yargs/commander integrations do it for you); only the
   * first call per Client emits anything.
   *
   * At `Tier.Anonymous` the event carries no identifiers. At `Tier.Basic`+
   * it also carries the per-process session ID and the install ID, a
   * random UUID persisted in the CLI's config directory the first time it
   * is needed — never derived from the user or machine.
   *
   * At `Tier.Basic`+ it also carries startup overhead
   * (`cli.startup.duration_ms`): the time from process start to this call,
   * so it covers module loading and framework setup. Call it just before
   * the command runs, as the integrations do. And when running as a Node
   * single executable application, it carries the binary's size
   * (`cli.binary.size_bytes`). Either is omitted if unavailable, never 0.
   *
   * Also at `Tier.Basic`+, read locally from the environment with no
   * subprocess: the shell (`cli.shell`) and terminal emulator
   * (`cli.terminal`), each mapped to a small fixed vocabulary rather than
   * sent raw; whether stdout is a TTY (`cli.stdout.is_tty`); and the runtime
   * (`cli.runtime.name`, `cli.runtime.version`). Anything that can't be
   * detected is omitted.
   *
   * Also at `Tier.Basic`+, the vendor-supplied `configCustomizedCount`
   * (`cli.config.customized_count`) and `authState` (`cli.auth.state`)
   * options, when set. A callback is evaluated here, once, and only at a tier
   * that sends it; one that throws or returns an invalid value omits the
   * attribute.
   */
  recordSessionStart(): void {
    safeRun(() => {
      if (!this.enabled() || this.sessionStarted) return
      this.sessionStarted = true
      const sessionId = this.ensureSessionId()
      const basic = tierAllows(this.tier, Tier.Basic)
      // Read now rather than in the queued job, which runs on a later tick.
      const startupMs = basic ? readStartupDurationMs() : undefined
      const environment = basic ? detectEnvironment() : undefined
      const configCustomizedCount = basic
        ? resolveConfigCustomizedCount(this.configCustomizedCount)
        : undefined
      const authState = basic ? resolveAuthState(this.authState) : undefined
      this.queue.push(() => {
        const attrs = this.identityAttrs(sessionId)
        if (startupMs !== undefined) attrs[AttrStartupDurationMs] = startupMs
        if (environment?.shell !== undefined) attrs[AttrShell] = environment.shell
        if (environment?.terminal !== undefined) attrs[AttrTerminal] = environment.terminal
        if (environment?.stdoutIsTty !== undefined) {
          attrs[AttrStdoutIsTty] = environment.stdoutIsTty
        }
        if (environment?.runtimeName !== undefined && environment.runtimeVersion !== undefined) {
          attrs[AttrRuntimeName] = environment.runtimeName
          attrs[AttrRuntimeVersion] = environment.runtimeVersion
        }
        if (configCustomizedCount !== undefined) {
          attrs[AttrConfigCustomizedCount] = configCustomizedCount
        }
        if (authState !== undefined) attrs[AttrAuthState] = authState
        if (basic) {
          const sizeBytes = readBinarySizeBytes()
          if (sizeBytes !== undefined) attrs[AttrBinarySizeBytes] = sizeBytes
        }
        if (this.installMethod) attrs[AttrInstallMethod] = this.installMethod
        this.emitEventNow(EventSessionStarted, SeverityNumber.INFO, attrs)
      })
    }, this.counters)
  }

  /**
   * Records that a command began executing. `commandPath` should be the
   * full command path (e.g. `"mycli sub subsub"`); it is reported as the
   * dotted command name (`"sub.subsub"`). `flagNames` is the list of flag
   * *names* the user set — never flag values, which this SDK never
   * accepts anywhere in the taxonomy.
   *
   * The command name is recorded at every tier; flag names and the
   * session ID at `Tier.Basic`+.
   */
  recordCommandInvocation(commandPath: string, flagNames: readonly string[] = []): void {
    safeRun(() => {
      if (!this.enabled()) return
      const attrs: Attributes = { [AttrCommandName]: this.name(commandPath) }
      if (tierAllows(this.tier, Tier.Basic) && flagNames.length > 0) {
        attrs[AttrFlagNames] = [...flagNames]
      }
      const sessionId = this.ensureSessionId()
      this.queue.push(() => {
        this.emitEventNow(EventCommandInvoked, SeverityNumber.INFO, {
          ...attrs,
          ...this.identityAttrs(sessionId),
        })
      })
    }, this.counters)
  }

  /**
   * Records a completed command: a `cli.command.<name>` span covering its
   * execution, plus the `cli.command.invocations` and
   * `cli.command.duration` metrics. This is what the server's command
   * frequency, latency, error-rate and exit-code dashboards are built
   * from, so call it once for every command that ran (the integrations
   * do). Available at every tier; flag names, peak memory and CPU time
   * only at `Tier.Basic`+.
   *
   * Peak memory (`cli.process.peak_rss_bytes`) and CPU time
   * (`cli.process.cpu_time_ms`) are read once from the process, so they are
   * process-wide and cumulative: right for a CLI that runs one command per
   * process, but in a long-lived or multi-command process each call
   * reports totals since the process started. A measure the platform can't
   * provide is omitted.
   */
  recordCommand(result: CommandResult): void {
    safeRun(() => {
      if (!this.enabled()) return
      const durationMs = Math.max(0, result.durationMs)
      const startMs = result.startMs ?? Date.now() - durationMs
      const name = this.name(result.path)
      const attrs: Attributes = {
        ...this.tierAttr(),
        [AttrCommandName]: name,
        [AttrExitCode]: result.exitCode,
      }
      const spanAttrs: Attributes = { ...attrs, [AttrDurationMs]: Math.round(durationMs) }
      if (tierAllows(this.tier, Tier.Basic) && result.flagNames && result.flagNames.length > 0) {
        spanAttrs[AttrFlagNames] = [...result.flagNames]
      }
      if (tierAllows(this.tier, Tier.Basic)) {
        // Read now, as the command completes, rather than in the queued job,
        // which runs on a later tick.
        const { peakRssBytes, cpuTimeMs } = readProcessResourceUsage()
        if (peakRssBytes !== undefined) spanAttrs[AttrPeakRssBytes] = peakRssBytes
        if (cpuTimeMs !== undefined) spanAttrs[AttrCpuTimeMs] = cpuTimeMs
      }
      const sessionId = this.ensureSessionId()
      this.queue.push(() => {
        const span = this.tracer?.startSpan(SpanCommandPrefix + name, {
          startTime: startMs,
          attributes: spanAttrs,
        })
        if (result.exitCode !== 0) span?.setStatus({ code: SpanStatusCode.ERROR })
        span?.end(startMs + durationMs)
        this.invocationsCounter?.add(1, attrs)
        this.latencyHist?.record(durationMs, attrs)

        // The completed event ties the outcome to the session and install,
        // which the span can't carry; the server's activation and friction
        // views are built from it.
        this.emitEventNow(EventCommandCompleted, SeverityNumber.INFO, {
          [AttrCommandName]: name,
          [AttrExitCode]: result.exitCode,
          [AttrDurationMs]: Math.round(durationMs),
          ...this.identityAttrs(sessionId),
        })
      })
    }, this.counters)
  }

  /**
   * Records that the user used one of the vendor's features, so the server
   * can tell which features an install has adopted and how soon after
   * installing. Emitted at `Tier.Basic`+ only; nothing is sent at
   * `Tier.Anonymous`. The event carries the feature name, the command name
   * when `commandPath` is given, and the session and install IDs.
   *
   * `feature` must be a fixed identifier chosen by the vendor in code
   * (e.g. `"export-csv"`), **never user input** such as a flag value, path
   * or argument. It is truncated to the server's 64 character limit.
   *
   * Each feature is reported at most once per process, however often this
   * is called, to keep volume down. The server derives "first use" per
   * install itself, so repeat reports within a run add nothing.
   */
  recordFeatureActivated(feature: string, commandPath?: string): void {
    safeRun(() => {
      if (!this.gate(Tier.Basic)) return
      const name = feature.slice(0, MAX_ACTIVATION_FEATURE_LENGTH)
      if (!name || this.activatedFeatures.has(name)) return
      this.activatedFeatures.add(name)
      const attrs: Attributes = { [AttrActivationFeature]: name }
      if (commandPath) attrs[AttrCommandName] = this.name(commandPath)
      const sessionId = this.ensureSessionId()
      this.queue.push(() => {
        this.emitEventNow(EventFeatureActivated, SeverityNumber.INFO, {
          ...attrs,
          ...this.identityAttrs(sessionId),
        })
      })
    }, this.counters)
  }

  /** Records that a command's help output was requested (`-h`/`--help` or an explicit help command). */
  recordHelpFlagUsage(commandPath: string): void {
    safeRun(() => {
      if (!this.gate(Tier.Anonymous)) return
      this.emitEvent(EventHelpViewed, SeverityNumber.INFO, {
        [AttrCommandName]: this.name(commandPath),
        [AttrHelpFlag]: 'help',
      })
    }, this.counters)
  }

  /**
   * Records that a command failed with an error, classified by
   * `category` rather than its raw message or stack trace — this is
   * deliberately the only error-recording capability available below
   * `Tier.OptIn`. Raw error detail is only reachable via {@link optIn}.
   *
   * At every tier this counts the error on the `cli.errors` metric by
   * command. At `Tier.Basic`+ the category is attached as the error type
   * and a `cli.error.raised` event is emitted too, tied to the session and
   * install.
   *
   * `reason` is an optional, finer classification from a fixed vocabulary
   * you define (e.g. `"no-token"`, `"invalid-url"`), sent at `Tier.Basic`+
   * as `cli.error.reason` on both of those. It must be an identifier chosen
   * in code, **never error text or user input**: this SDK does not scrub it.
   * It must match `^[a-z0-9][a-z0-9._-]*$` and be at most 64 bytes; one that
   * doesn't is dropped (the error is still recorded, without a reason).
   */
  recordError(
    commandPath: string,
    category: ErrorCategory = ErrorCategoryValues.Unknown,
    reason?: string,
  ): void {
    safeRun(() => {
      if (!this.enabled()) return
      const cat = isValidErrorCategory(category) ? category : ErrorCategoryValues.Unknown
      const basic = tierAllows(this.tier, Tier.Basic)
      const attrs: Attributes = { [AttrCommandName]: this.name(commandPath) }
      if (basic) {
        attrs[AttrErrorType] = cat
        if (isValidIdentifier(reason)) attrs[AttrErrorReason] = reason
      }
      const sessionId = this.ensureSessionId()
      this.queue.push(() => {
        this.errorEventsCounter?.add(1, { ...this.tierAttr(), ...attrs })
        if (basic) {
          this.emitEventNow(EventErrorRaised, SeverityNumber.ERROR, {
            ...attrs,
            ...this.identityAttrs(sessionId),
          })
        }
      })
    }, this.counters)
  }

  /**
   * Adds `n` to a vendor-defined counter, sent as the `cli.counter` metric
   * with the `cli.counter.name` and, if given, `cli.counter.label`
   * attributes. Increments are summed in memory: one data point per name
   * and label is sent at each export, however often this is called, so it
   * is cheap in a hot loop.
   *
   * **Counters are accepted at the anonymous tier.** They are sent at every
   * tier, including `Tier.Anonymous` and in CI, even when the user has made
   * no consent choice. Nothing identifies the user, but `name` and `label`
   * are strings you choose, so a mistake here puts text into anonymous
   * data. They must be fixed identifiers chosen in code, **never user
   * input, file paths, host names, URLs, tokens or anything derived from
   * them**. This SDK does not scrub them.
   *
   * `name` and `label` must match `^[a-z0-9][a-z0-9._-]*$` and be at most
   * 64 bytes. If either does not, nothing is recorded: the increment is
   * dropped, not trimmed or sent without its label. `n` must be a positive
   * integer; anything else is ignored. The server caps the number of
   * distinct names and labels per tenant and folds the rest into `other`.
   *
   * Never throws, and does nothing on a disabled Client.
   */
  recordCounter(name: string, n: number, options: CounterOptions = {}): void {
    safeRun(() => {
      if (!this.gate(Tier.Anonymous)) return
      if (!isValidIdentifier(name)) return
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) return
      const label = options?.label
      if (label !== undefined && !isValidIdentifier(label)) return
      const attrs: Attributes = { ...this.tierAttr(), [AttrCounterName]: name }
      if (label !== undefined) attrs[AttrCounterLabel] = label
      // Straight into the OTel counter, not the job queue: it sums per
      // attribute set in memory, so a hot loop neither allocates a record
      // per call nor overflows the queue.
      this.productCounter?.add(n, attrs)
    }, this.counters)
  }

  /**
   * Records how long something took, in milliseconds, for a vendor-defined
   * timing. It is sent as the `cli.measure` histogram with the
   * `cli.measure.name` and, if given, `cli.measure.label` attributes.
   * Values are aggregated in memory into fixed buckets (1, 5, 10, 50, 100,
   * 500, 1000, 5000, 10000, 60000 and 300000 ms): one data point per name
   * and label is sent at each export, however often this is called, so it
   * is cheap in a hot loop.
   *
   * **Timings are accepted at the anonymous tier.** They are sent at every
   * tier, including `Tier.Anonymous` and in CI, even when the user has made
   * no consent choice. Nothing identifies the user, but `name` and `label`
   * are strings you choose, so a mistake here puts text into anonymous
   * data. They must be fixed identifiers chosen in code, **never user
   * input, file paths, host names, URLs, tokens or anything derived from
   * them**. This SDK does not scrub them.
   *
   * `name` and `label` must match `^[a-z0-9][a-z0-9._-]*$` and be at most
   * 64 bytes. If either does not, nothing is recorded: the timing is
   * dropped, not trimmed or sent without its label. `ms` must be a finite
   * number greater than zero; anything else is ignored. The server caps the
   * number of distinct names and labels per tenant and folds the rest into
   * `other`.
   *
   * Never throws, and does nothing on a disabled Client.
   */
  recordDuration(name: string, ms: number, options: DurationOptions = {}): void {
    safeRun(() => {
      if (!this.gate(Tier.Anonymous)) return
      if (!isValidIdentifier(name)) return
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return
      const label = options?.label
      if (label !== undefined && !isValidIdentifier(label)) return
      const attrs: Attributes = { ...this.tierAttr(), [AttrMeasureName]: name }
      if (label !== undefined) attrs[AttrMeasureLabel] = label
      // Straight into the OTel histogram, not the job queue, for the same
      // reason as recordCounter: it aggregates per attribute set in memory.
      this.measureHist?.record(ms, attrs)
    }, this.counters)
  }

  /**
   * Returns an {@link OptInScope} if, and only if, this Client's resolved
   * consent tier is `Tier.OptIn`; otherwise returns `undefined`. There is
   * no other way to reach raw error detail (message, stack trace)
   * anywhere in this package — it's structurally impossible to pass that
   * data through {@link recordError}'s signature.
   */
  optIn(): OptInScope | undefined {
    if (this.enabled() && this.tier === Tier.OptIn) return new OptInScope(this)
    return undefined
  }

  /** @internal called only by {@link OptInScope}. */
  _recordErrorDetail(commandPath: string, err: Error, stack?: string): void {
    safeRun(() => {
      if (!this.gate(Tier.OptIn)) return
      const attrs: Attributes = {
        [AttrCommandName]: this.name(commandPath),
        [AttrErrorMessage]: err.message,
      }
      if (stack) attrs[AttrErrorStack] = stack
      this.emitEvent(EventErrorRaised, SeverityNumber.ERROR, attrs)
    }, this.counters)
  }

  /**
   * Blocks until all telemetry queued so far has been handed to the
   * exporters and an export attempt has completed, or `timeoutMs`
   * elapses, whichever comes first. Safe to call on a disabled Client
   * (a no-op).
   */
  async flush(timeoutMs: number = this.shutdownTimeoutMs): Promise<void> {
    if (!this.enabled()) return
    await this.queue.waitForDrain(timeoutMs)
    // allSettled: an unreachable collector must never make this reject.
    await withTimeout(
      Promise.allSettled([
        this.tracerProvider?.forceFlush(),
        this.meterProvider?.forceFlush(),
        this.loggerProvider?.forceFlush(),
      ]).then(() => undefined),
      timeoutMs,
    )
  }

  /**
   * Flushes any queued telemetry (best-effort, bounded by `timeoutMs`)
   * and releases all background resources. After `shutdown`, the Client
   * permanently behaves as a disabled no-op. Safe to call on a disabled
   * Client, and safe to call more than once.
   */
  async shutdown(timeoutMs: number = this.shutdownTimeoutMs): Promise<void> {
    if (this.disabled || this.shutdownStarted) return
    this.shutdownStarted = true
    this.shuttingDown = true

    await this.queue.waitForDrain(timeoutMs)
    // allSettled: an unreachable collector must never make this reject.
    await withTimeout(
      Promise.allSettled([
        this.tracerProvider?.shutdown(),
        this.meterProvider?.shutdown(),
        this.loggerProvider?.shutdown(),
      ]).then(() => undefined),
      timeoutMs,
    )
  }
}

/**
 * Exposes telemetry capabilities that require the user's explicit
 * `Tier.OptIn` consent, structurally separated from {@link Client} so
 * that raw error content (messages, stack traces) can never be passed
 * through a lower-tier code path by mistake or misuse.
 */
export class OptInScope {
  constructor(private readonly client: Client) {}

  /** Records an error's message at full fidelity. */
  recordErrorDetail(commandPath: string, err: Error): void {
    this.client._recordErrorDetail(commandPath, err)
  }

  /** Identical to {@link recordErrorDetail} but also attaches a raw stack trace. */
  recordErrorDetailWithStack(commandPath: string, err: Error, stack: string): void {
    this.client._recordErrorDetail(commandPath, err, stack)
  }
}

function resolveConsentTier(cfg: ReturnType<typeof resolveConfig>): Tier {
  if (!cfg.consentProvider) return cfg.defaultTier
  try {
    const tier = cfg.consentProvider.resolve()
    return isValidTier(tier) ? tier : cfg.defaultTier
  } catch {
    return cfg.defaultTier
  }
}

function disabledClient(initError: Error | null = null): Client {
  return new Client({
    disabled: true,
    initError,
    tier: Tier.Anonymous,
    queueSize: 0,
    shutdownTimeoutMs: 0,
  })
}

/**
 * Constructs a {@link Client}. `apiKey`, `cliName`, and `cliVersion` are
 * always required; everything else has a sane default and is set via
 * `options`.
 *
 * `createClient` is synchronous and **never throws**: if construction
 * encounters a problem (e.g. the exporter transport can't be built, or a
 * `ConsentProvider` throws), it returns a Client already degraded to a
 * disabled no-op, with `client.initError` describing why. Callers may
 * inspect `initError` but are not required to before using the returned
 * Client safely.
 *
 * `createClient` resolves consent through a synchronous
 * {@link ConsentProvider} — see that interface's doc comment for why
 * resolution has to be synchronous on Node's single-threaded event loop.
 */
export function createClient(
  apiKey: string,
  cliName: string,
  cliVersion: string,
  options: ClientOptions = {},
): Client {
  try {
    const cfg = resolveConfig(apiKey, cliName, cliVersion, options)

    if (cfg.disabled || process.env['ARGVIO_DISABLED'] === '1' || isDoNotTrackRequested()) {
      return disabledClient()
    }

    const tier = resolveConsentTier(cfg)
    const exporters = buildExporters(cfg)
    const resource = buildResource(cfg)

    const tracerProvider = new NodeTracerProvider({
      resource,
      spanProcessors: [
        new BatchSpanProcessor(exporters.trace, {
          maxQueueSize: cfg.queueSize,
          exportTimeoutMillis: cfg.exportTimeoutMs,
        }),
      ],
    })
    const meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: exporters.metric,
          exportTimeoutMillis: cfg.exportTimeoutMs,
        }),
      ],
    })
    const loggerProvider = new LoggerProvider({
      resource,
      processors: [
        new BatchLogRecordProcessor({
          exporter: exporters.log,
          maxQueueSize: cfg.queueSize,
          exportTimeoutMillis: cfg.exportTimeoutMs,
        }),
      ],
    })

    const meter = meterProvider.getMeter(INSTRUMENTATION_NAME)
    const logger = loggerProvider.getLogger(INSTRUMENTATION_NAME)

    return new Client({
      cliName,
      installIdPath: cfg.installIdPath,
      installMethod: cfg.installMethod,
      configCustomizedCount: cfg.configCustomizedCount,
      authState: cfg.authState,
      tracer: tracerProvider.getTracer(INSTRUMENTATION_NAME),
      disabled: false,
      initError: null,
      tier,
      queueSize: cfg.queueSize,
      shutdownTimeoutMs: cfg.shutdownTimeoutMs,
      tracerProvider,
      meterProvider,
      loggerProvider,
      logger,
      latencyHist: meter.createHistogram(MetricCommandDuration, {
        unit: 'ms',
        description: 'Duration of a CLI command invocation.',
      }),
      invocationsCounter: meter.createCounter(MetricCommandInvocations, {
        unit: '1',
        description: 'Count of completed CLI command invocations.',
      }),
      errorEventsCounter: meter.createCounter(MetricErrors, {
        unit: '1',
        description: 'Count of recorded CLI errors.',
      }),
      productCounter: meter.createCounter(MetricCounter, {
        unit: '1',
        description: 'Vendor-defined counters, by fixed name and optional label.',
      }),
      measureHist: meter.createHistogram(MetricMeasure, {
        unit: 'ms',
        description: 'Vendor-defined timings, by fixed name and optional label.',
        advice: { explicitBucketBoundaries: [...MEASURE_BUCKET_BOUNDARIES_MS] },
      }),
    })
  } catch (err) {
    return disabledClient(toError(err))
  }
}
