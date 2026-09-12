import type { Attributes, Counter, Histogram } from '@opentelemetry/api'
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
import { Tier, tierAllows, tierToString, isValidTier, RESOURCE_ATTR_TIER } from './tier.js'
import type { ErrorCategory } from './tier.js'
import { ErrorCategory as ErrorCategoryValues, isValidErrorCategory } from './tier.js'
import {
  AttrCommandFlags,
  AttrCommandPath,
  AttrErrorCategory,
  AttrErrorMessage,
  AttrErrorStack,
  AttrExitCode,
  AttrHelpUsed,
  AttrSessionId,
  MetricCommandDuration,
  newSessionId,
} from './taxonomy.js'
import type { Stats } from './safety.js'
import { ARGVIO_DEBUG, DroppedCounters, safeRun } from './safety.js'

/**
 * Identifies this SDK to the OTel SDKs it wraps (meter/logger name),
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

interface ClientParams {
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
  sessionsCounter?: Counter
  errorEventsCounter?: Counter
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

  private readonly tracerProvider: NodeTracerProvider | undefined
  private readonly meterProvider: MeterProvider | undefined
  private readonly loggerProvider: LoggerProvider | undefined
  private readonly logger: Logger | undefined
  private readonly latencyHist: Histogram | undefined
  private readonly invocationsCounter: Counter | undefined
  private readonly sessionsCounter: Counter | undefined
  private readonly errorEventsCounter: Counter | undefined

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
    this.sessionsCounter = params.sessionsCounter
    this.errorEventsCounter = params.errorEventsCounter
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
      this.logger?.emit({
        eventName: name,
        timestamp: Date.now(),
        severityNumber: severity,
        attributes: { ...this.tierAttr(), ...attributes },
      })
    })
  }

  /**
   * Lazily generates a session correlation ID at `Tier.Full`+. A random,
   * non-persistent identifier scoped to a single process invocation —
   * not a user or device identifier.
   */
  private ensureSessionId(): string {
    if (!tierAllows(this.tier, Tier.Full)) return ''
    if (this.sessionId === undefined) {
      this.sessionId = newSessionId()
    }
    return this.sessionId
  }

  /**
   * Records the start of a CLI process session. Call once, as early as
   * possible. At `Tier.Anonymous` this only increments an aggregate
   * session counter. At `Tier.Basic`+ it also emits a `cli.session_start`
   * event. At `Tier.Full`+ the event carries a per-process session
   * correlation ID.
   */
  recordSessionStart(): void {
    safeRun(() => {
      if (!this.enabled()) return
      this.queue.push(() => {
        this.sessionsCounter?.add(1, this.tierAttr())
      })
      if (!tierAllows(this.tier, Tier.Basic)) return
      const attrs: Attributes = {}
      const id = this.ensureSessionId()
      if (id) attrs[AttrSessionId] = id
      this.emitEvent('cli.session_start', SeverityNumber.INFO, attrs)
    }, this.counters)
  }

  /** Records the end of a CLI process session. Call once, symmetric with {@link recordSessionStart}. */
  recordSessionEnd(): void {
    safeRun(() => {
      if (!this.enabled() || !tierAllows(this.tier, Tier.Basic)) return
      const attrs: Attributes = {}
      const id = this.ensureSessionId()
      if (id) attrs[AttrSessionId] = id
      this.emitEvent('cli.session_end', SeverityNumber.INFO, attrs)
    }, this.counters)
  }

  /**
   * Records that a command began executing. `commandPath` should be the
   * full command path (e.g. `"mycli sub subsub"`), not just the leaf
   * command name. `flagNames` is the list of flag *names* the user set —
   * never flag values, which this SDK never accepts anywhere in the
   * taxonomy.
   *
   * At `Tier.Anonymous` this only increments an aggregate invocation
   * counter with no path/flag detail. At `Tier.Basic`+ the full command
   * path and flag names are included.
   */
  recordCommandInvocation(commandPath: string, flagNames: readonly string[] = []): void {
    safeRun(() => {
      if (!this.enabled()) return
      this.queue.push(() => {
        this.invocationsCounter?.add(1, this.tierAttr())
      })
      if (!tierAllows(this.tier, Tier.Basic)) return
      const attrs: Attributes = { [AttrCommandPath]: commandPath }
      if (flagNames.length > 0) attrs[AttrCommandFlags] = [...flagNames]
      this.emitEvent('cli.command_invocation', SeverityNumber.INFO, attrs)
    }, this.counters)
  }

  /**
   * Records the exit code a command finished with. Pass `""` for
   * `commandPath` if unknown (e.g. a single-command CLI). At
   * `Tier.Anonymous` the exit code is recorded without a command path.
   * At `Tier.Basic`+ the command path is included.
   */
  recordExitCode(commandPath: string, code: number): void {
    safeRun(() => {
      if (!this.gate(Tier.Anonymous)) return
      const attrs: Attributes = { [AttrExitCode]: code }
      if (tierAllows(this.tier, Tier.Basic) && commandPath) {
        attrs[AttrCommandPath] = commandPath
      }
      const severity = code !== 0 ? SeverityNumber.WARN : SeverityNumber.INFO
      this.emitEvent('cli.exit_code', severity, attrs)
    }, this.counters)
  }

  /**
   * Records how long a command took to execute, in milliseconds, on a
   * histogram (`cli.command.duration`). Available at every tier.
   */
  recordLatency(commandPath: string, durationMs: number): void {
    safeRun(() => {
      if (!this.gate(Tier.Anonymous)) return
      const attrs: Attributes = { ...this.tierAttr() }
      if (tierAllows(this.tier, Tier.Basic) && commandPath) {
        attrs[AttrCommandPath] = commandPath
      }
      this.queue.push(() => {
        this.latencyHist?.record(durationMs, attrs)
      })
    }, this.counters)
  }

  /** Records that a command's help output was requested (`-h`/`--help` or an explicit help command). */
  recordHelpFlagUsage(commandPath: string): void {
    safeRun(() => {
      if (!this.gate(Tier.Anonymous)) return
      const attrs: Attributes = { [AttrHelpUsed]: true }
      if (tierAllows(this.tier, Tier.Basic) && commandPath) {
        attrs[AttrCommandPath] = commandPath
      }
      this.emitEvent('cli.help_flag_used', SeverityNumber.INFO, attrs)
    }, this.counters)
  }

  /**
   * Records that a command failed with an error, classified by
   * `category` rather than its raw message or stack trace — this is
   * deliberately the only error-recording capability available below
   * `Tier.OptIn`. Raw error detail is only reachable via {@link optIn}.
   *
   * Requires `Tier.Full`+; at lower tiers this is a no-op (counted in
   * `stats().belowTierDropped`).
   */
  recordError(commandPath: string, category: ErrorCategory = ErrorCategoryValues.Unknown): void {
    safeRun(() => {
      if (!this.gate(Tier.Full)) return
      const cat = isValidErrorCategory(category) ? category : ErrorCategoryValues.Unknown
      const attrs: Attributes = { [AttrErrorCategory]: cat }
      if (commandPath) attrs[AttrCommandPath] = commandPath
      this.queue.push(() => {
        this.errorEventsCounter?.add(1, { ...this.tierAttr(), [AttrErrorCategory]: cat })
      })
      this.emitEvent('cli.error', SeverityNumber.ERROR, attrs)
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
      const attrs: Attributes = { [AttrErrorMessage]: err.message }
      if (commandPath) attrs[AttrCommandPath] = commandPath
      if (stack) attrs[AttrErrorStack] = stack
      this.emitEvent('cli.error_detail', SeverityNumber.ERROR, attrs)
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
    await withTimeout(
      Promise.all(
        [
          this.tracerProvider?.forceFlush(),
          this.meterProvider?.forceFlush(),
          this.loggerProvider?.forceFlush(),
        ].filter((p): p is Promise<void> => Boolean(p)),
      ).then(() => undefined),
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
    await withTimeout(
      Promise.all(
        [
          this.tracerProvider?.shutdown(),
          this.meterProvider?.shutdown(),
          this.loggerProvider?.shutdown(),
        ].filter((p): p is Promise<void> => Boolean(p)),
      ).then(() => undefined),
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
      invocationsCounter: meter.createCounter('cli.invocations', {
        description: 'Count of CLI command invocations.',
      }),
      sessionsCounter: meter.createCounter('cli.sessions', {
        description: 'Count of CLI process sessions.',
      }),
      errorEventsCounter: meter.createCounter('cli.errors', {
        description: 'Count of recorded CLI errors.',
      }),
    })
  } catch (err) {
    return disabledClient(toError(err))
  }
}
