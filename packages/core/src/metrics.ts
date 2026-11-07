import type {
  CounterHandle,
  DimValues,
  DurationHandle,
  MetricHandleOptions,
  ValueHandle,
} from './client.js'
import type { Client } from './client.js'
import { getDefaultClient } from './defaultClient.js'
import { startTimer, startTimerLate } from './timing.js'

/** A module-level timing: a {@link DurationHandle} plus timer helpers. */
export interface TimerHandle extends DurationHandle {
  /**
   * Starts a clock (`performance.now()`) and returns a function that records
   * the elapsed time with `values`. Only its first call records.
   */
  start(values?: DimValues): () => void
  /**
   * Like {@link start}, but the returned function takes the dimension values
   * when called, for values only known at the end.
   */
  startLate(): (values?: DimValues) => void
}

/**
 * Returns a function resolving the handle for the current default client:
 * made on first use, and again whenever the default client changes. Yields
 * undefined when there is no default client or anything throws.
 */
function lazyHandle<H>(make: (client: Client) => H): () => H | undefined {
  let bound: Client | undefined
  let handle: H | undefined
  return () => {
    try {
      const client = getDefaultClient()
      if (client === undefined) return undefined
      if (client !== bound) {
        handle = make(client)
        bound = client
      }
      return handle
    } catch {
      return undefined
    }
  }
}

/**
 * A vendor-defined counter declared at module level, bound lazily to the
 * default client. Same rules as {@link Client.counter}; does nothing when
 * there is no default client or telemetry is disabled. Never throws.
 *
 * ```ts
 * const vulns = counter('vulns.found', { dims: ['severity', 'check'] })
 * vulns.add(1, { severity: 'high', check: 'bola' })
 * ```
 */
export function counter(name: string, options: MetricHandleOptions = {}): CounterHandle {
  const resolve = lazyHandle((c) => c.counter(name, options))
  return {
    add: (n: number, values?: DimValues) => {
      try {
        resolve()?.add(n, values)
      } catch {
        // never throws
      }
    },
  }
}

/**
 * A vendor-defined timing declared at module level, bound lazily to the
 * default client. Same rules as {@link Client.duration}, including the
 * `start` and `startLate` helpers.
 *
 * ```ts
 * const scanTime = duration('scan.time', { dims: ['kind'] })
 * const stop = scanTime.start({ kind: 'openapi' })
 * try { await scan() } finally { stop() }
 * ```
 */
export function duration(name: string, options: MetricHandleOptions = {}): TimerHandle {
  const resolve = lazyHandle((c) => c.duration(name, options))
  const record = (ms: number, values?: DimValues) => {
    try {
      resolve()?.record(ms, values)
    } catch {
      // never throws
    }
  }
  return {
    record,
    start: (values?: DimValues) => startTimer(record, values),
    startLate: () => startTimerLate(record),
  }
}

/**
 * A vendor-defined per-run value declared at module level, bound lazily to
 * the default client. Same rules as {@link Client.value}: record zeros, and
 * `unit` must be `'1'`, `'By'` or `'%'`.
 *
 * ```ts
 * const ops = value('spec.operations')
 * ops.record(42)
 * ```
 */
export function value(name: string, options: MetricHandleOptions = {}): ValueHandle {
  const resolve = lazyHandle((c) => c.value(name, options))
  return {
    record: (v: number, values?: DimValues) => {
      try {
        resolve()?.record(v, values)
      } catch {
        // never throws
      }
    },
  }
}
