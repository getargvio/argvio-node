import type { DimValues } from './client.js'

type Record = (ms: number, values?: DimValues) => void

/**
 * Starts a clock; the returned function records the elapsed milliseconds
 * with `values`, once. Later calls do nothing.
 */
export function startTimer(record: Record, values?: DimValues): () => void {
  const begin = performance.now()
  let done = false
  return () => {
    if (done) return
    done = true
    record(performance.now() - begin, values)
  }
}

/**
 * Starts a clock; the returned function takes the dimension values, known
 * only at the end, and records the elapsed milliseconds once.
 */
export function startTimerLate(record: Record): (values?: DimValues) => void {
  const begin = performance.now()
  let done = false
  return (values?: DimValues) => {
    if (done) return
    done = true
    record(performance.now() - begin, values)
  }
}
