/**
 * Detects the shell, terminal emulator, runtime and TTY-ness of the process
 * for `cli.session.started`.
 *
 * The lookup tables below are the privacy control for this signal: whatever
 * the environment says, only a value from a small fixed vocabulary (or
 * `other` / `unknown`) is ever returned, never a raw environment string, a
 * path or a `TERM`. Keep every mapping here and nowhere else.
 *
 * Detection is local, read-only and synchronous: environment variables and
 * two `process` properties, no subprocess. Anything that can't be detected
 * is left out of the result.
 */

/** What can be detected; a field that couldn't be detected is absent. */
export interface DetectedEnvironment {
  /** One of {@link SHELLS}, or `other`. */
  shell?: string
  /** One of {@link TERMINALS}, `other` or `unknown`. */
  terminal?: string
  runtimeName?: string
  runtimeVersion?: string
  stdoutIsTty?: boolean
}

/** Reported when a marker is present but isn't in the vocabulary. */
export const OTHER = 'other'
/** Reported for the terminal when no marker is present at all. */
export const UNKNOWN = 'unknown'

/** The runtime name this SDK reports. */
export const RUNTIME_NAME = 'node'

/** The server's max_length for `cli.shell`, `cli.terminal` and `cli.runtime.*`. */
const MAX_VALUE_LENGTH = 32

/**
 * Executable basename (lowercase, no `.exe`) to reported shell. Lookups go
 * through a Map so a hostile value like `__proto__` can only miss.
 */
const SHELL_BY_BASENAME: ReadonlyMap<string, string> = new Map([
  ['bash', 'bash'],
  ['zsh', 'zsh'],
  ['fish', 'fish'],
  ['sh', 'sh'],
  ['dash', 'dash'],
  ['ksh', 'ksh'],
  ['tcsh', 'tcsh'],
  ['csh', 'csh'],
  ['nu', 'nushell'],
  ['elvish', 'elvish'],
  ['xonsh', 'xonsh'],
  ['pwsh', 'powershell'],
  ['powershell', 'powershell'],
  ['cmd', 'cmd'],
])

/** The shells this SDK can report, besides `other`. */
export const SHELLS: readonly string[] = [...new Set(SHELL_BY_BASENAME.values())]

/** `TERM_PROGRAM` value to reported terminal. Matched exactly, case-sensitive. */
const TERMINAL_BY_TERM_PROGRAM: ReadonlyMap<string, string> = new Map([
  ['Apple_Terminal', 'apple-terminal'],
  ['iTerm.app', 'iterm2'],
  ['vscode', 'vscode'],
  ['WezTerm', 'wezterm'],
  ['ghostty', 'ghostty'],
  ['Hyper', 'hyper'],
  ['WarpTerminal', 'warp'],
  ['zed', 'zed'],
  ['rio', 'rio'],
  ['tmux', 'tmux'],
])

/**
 * Terminal-specific variables, checked in this order before `TERM_PROGRAM`.
 * A variable counts when set to a non-empty value; the value is never read
 * any further.
 */
const TERMINAL_BY_MARKER: ReadonlyArray<readonly [string, string]> = [
  ['WT_SESSION', 'windows-terminal'],
  ['KITTY_WINDOW_ID', 'kitty'],
  ['WEZTERM_EXECUTABLE', 'wezterm'],
  ['GHOSTTY_RESOURCES_DIR', 'ghostty'],
  ['KONSOLE_VERSION', 'konsole'],
  ['ITERM_SESSION_ID', 'iterm2'],
  ['VTE_VERSION', 'vte'],
  ['XTERM_VERSION', 'xterm'],
]

/** Multiplexers wrap whichever terminal they run in, so they are checked last. */
const MULTIPLEXER_BY_MARKER: ReadonlyArray<readonly [string, string]> = [
  ['TMUX', 'tmux'],
  ['STY', 'screen'],
]

/** The terminals this SDK can report, besides `other` and `unknown`. */
export const TERMINALS: readonly string[] = [
  ...new Set([
    ...TERMINAL_BY_TERM_PROGRAM.values(),
    ...TERMINAL_BY_MARKER.map(([, terminal]) => terminal),
    ...MULTIPLEXER_BY_MARKER.map(([, terminal]) => terminal),
    'alacritty',
  ]),
]

type Env = Readonly<Record<string, string | undefined>>

function isSet(env: Env, name: string): boolean {
  const value = env[name]
  return typeof value === 'string' && value !== ''
}

/**
 * The last path segment of `path`, lowercased, without a leading `-` (login
 * shell marker) or a trailing `.exe`. Splits on both `/` and `\` so a
 * Windows path is handled on any platform.
 */
function executableBasename(path: string): string {
  const base = (path.split(/[\\/]/).pop() ?? '').toLowerCase()
  return base.replace(/^-/, '').replace(/\.exe$/, '')
}

/**
 * Maps the user's shell to the fixed vocabulary, or returns undefined when
 * there is nothing to go on.
 *
 * `$SHELL` is used when set (also under Git Bash or MSYS on Windows). Without
 * it on Windows: `PSModulePath` without `PROMPT` is PowerShell (cmd.exe sets
 * `PROMPT`, PowerShell does not, though both inherit `PSModulePath`), and a
 * bare `ComSpec` is cmd. Heuristics, not a guarantee.
 */
export function detectShell(env: Env, platform: string): string | undefined {
  const shell = env['SHELL']
  if (typeof shell === 'string' && shell !== '') {
    return SHELL_BY_BASENAME.get(executableBasename(shell)) ?? OTHER
  }
  if (platform !== 'win32') return undefined
  if (isSet(env, 'PSModulePath') && !isSet(env, 'PROMPT')) return 'powershell'
  if (isSet(env, 'ComSpec')) return 'cmd'
  return undefined
}

/**
 * Maps well-known environment markers to a terminal emulator from the fixed
 * vocabulary. `unknown` when no marker is present, `other` when a
 * `TERM_PROGRAM` is present but not in the vocabulary. Terminal-specific
 * markers win over `TERM_PROGRAM`, which wins over a multiplexer.
 */
export function detectTerminal(env: Env): string {
  for (const [name, terminal] of TERMINAL_BY_MARKER) {
    if (isSet(env, name)) return terminal
  }
  if (Object.keys(env).some((name) => name.startsWith('ALACRITTY_') && isSet(env, name))) {
    return 'alacritty'
  }
  const program = env['TERM_PROGRAM']
  if (typeof program === 'string' && program !== '') {
    return TERMINAL_BY_TERM_PROGRAM.get(program) ?? OTHER
  }
  for (const [name, terminal] of MULTIPLEXER_BY_MARKER) {
    if (isSet(env, name)) return terminal
  }
  return UNKNOWN
}

const NODE_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

/** The Node version if it looks like one and fits the server's limit. */
function readNodeVersion(): string | undefined {
  try {
    const version = process.versions.node
    return typeof version === 'string' &&
      version.length <= MAX_VALUE_LENGTH &&
      NODE_VERSION_PATTERN.test(version)
      ? version
      : undefined
  } catch {
    return undefined
  }
}

function readStdoutIsTty(): boolean | undefined {
  try {
    return process.stdout.isTTY === true
  } catch {
    return undefined
  }
}

/**
 * Detects the process's environment for `cli.session.started`. Never
 * throws; a fact that can't be detected is absent from the result.
 */
export function detectEnvironment(
  env: Env = process.env,
  platform: string = process.platform,
): DetectedEnvironment {
  const detected: DetectedEnvironment = {}
  try {
    const shell = detectShell(env, platform)
    if (shell !== undefined) detected.shell = shell
    detected.terminal = detectTerminal(env)
  } catch {
    // an exotic env object: report what we have
  }
  const version = readNodeVersion()
  if (version !== undefined) {
    detected.runtimeName = RUNTIME_NAME
    detected.runtimeVersion = version
  }
  const isTty = readStdoutIsTty()
  if (isTty !== undefined) detected.stdoutIsTty = isTty
  return detected
}
