// `process.stdout.isTTY` is only defined when stdout is a terminal, so it can't
// be spied on. Defines it for a test and returns what restores it.
export function stubStdoutIsTty(value: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true, writable: true })
  return () => {
    if (original) Object.defineProperty(process.stdout, 'isTTY', original)
    else delete (process.stdout as { isTTY?: unknown }).isTTY
  }
}
