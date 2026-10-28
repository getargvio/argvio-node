/** A command the user could have meant, from the CLI's own registered command set. */
export interface CommandCandidate {
  /** What the user would type: the command's name or one of its aliases. */
  token: string
  /** The dotted `cli.command.name` it resolves to, e.g. `deploy.push`. */
  name: string
}

/**
 * Typed text longer than this is never a typo of a command, and is not
 * compared at all, which also bounds the work done on arbitrary input.
 */
const MAX_TYPED_LENGTH = 64

/** The server's max_length for `cli.command.suggestion`, same as `cli.command.name`. */
export const MAX_COMMAND_SUGGESTION_LENGTH = 128

/**
 * Optimal string alignment distance between `a` and `b` (insertions,
 * deletions, substitutions and adjacent transpositions each cost 1), or
 * `max + 1` as soon as it is certain to exceed `max`.
 */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const cols = b.length + 1
  let prevPrev: number[] = []
  let prev = Array.from({ length: cols }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let rowMin = i
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let d = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, (prevPrev[j - 2] ?? 0) + 1)
      }
      row.push(d)
      if (d < rowMin) rowMin = d
    }
    if (rowMin > max) return max + 1
    prevPrev = prev
    prev = row
  }
  return prev[cols - 1] ?? max + 1
}

/**
 * Finds the command the user most likely meant by `typed`, which is
 * arbitrary user input: it may be a typo, but also a pasted token, a path or
 * a sentence. The result is always the `name` of one of `candidates`, taken
 * from the CLI's own command set, and never `typed` or any part of it.
 *
 * Returns `undefined` when no candidate is close enough: within an edit
 * distance of 2 (1 for a typed word of up to 3 characters, and always less
 * than its length), compared case-insensitively. A candidate is never chosen
 * because it contains, or is contained in, the input. The closest candidate
 * wins, the first one listed on a tie.
 *
 * Never throws.
 */
export function nearestCommand(
  typed: unknown,
  candidates: Iterable<CommandCandidate>,
): string | undefined {
  try {
    if (typeof typed !== 'string' || typed.length === 0 || typed.length > MAX_TYPED_LENGTH) {
      return undefined
    }
    const input = typed.toLowerCase()
    const max = Math.min(input.length <= 3 ? 1 : 2, input.length - 1)
    let best: string | undefined
    let bestDistance = max + 1
    for (const candidate of candidates) {
      if (
        typeof candidate.token !== 'string' ||
        typeof candidate.name !== 'string' ||
        candidate.name.length === 0 ||
        candidate.name.length > MAX_COMMAND_SUGGESTION_LENGTH
      ) {
        continue
      }
      const distance = editDistance(input, candidate.token.toLowerCase(), max)
      if (distance < bestDistance) {
        best = candidate.name
        bestDistance = distance
      }
    }
    return best
  } catch {
    return undefined
  }
}
