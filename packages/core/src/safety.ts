/**
 * No bug inside this SDK should ever throw into the host CLI. `safeRun`
 * is a try/catch guard installed at the top of every exported Client
 * method.
 */

/** Prints recovered-error diagnostics to stderr. Off by default. */
export const ARGVIO_DEBUG = process.env['ARGVIO_DEBUG'] === '1'

/** A snapshot of in-process telemetry-about-telemetry: never sent over the network. */
export interface Stats {
  /** Records dropped because a batch queue was full rather than blocking the host CLI. */
  queueOverflowDropped: number
  /** Records/fields dropped because the resolved consent tier didn't permit them. */
  belowTierDropped: number
  /** Internal errors recovered from; should always be zero. */
  recoveredErrors: number
}

export class DroppedCounters {
  queueOverflow = 0
  belowTierCeil = 0
  recoveredErrors = 0

  snapshot(): Stats {
    return {
      queueOverflowDropped: this.queueOverflow,
      belowTierDropped: this.belowTierCeil,
      recoveredErrors: this.recoveredErrors,
    }
  }
}

function logRecovered(err: unknown): void {
  if (!ARGVIO_DEBUG) return
  const msg = err instanceof Error ? err.message : '(non-error thrown value)'
  process.stderr.write(`argvio: recovered internal error: ${msg}\n`)
}

/** Runs `fn`, guaranteeing no synchronous throw escapes. */
export function safeRun(fn: () => void, counters?: DroppedCounters): void {
  try {
    fn()
  } catch (err) {
    if (counters) counters.recoveredErrors++
    logRecovered(err)
  }
}
