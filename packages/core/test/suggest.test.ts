import { describe, expect, it } from 'vitest'

import { nearestCommand } from '../src/index.js'
import type { CommandCandidate } from '../src/index.js'

const CANDIDATES: CommandCandidate[] = [
  { token: 'deploy', name: 'deploy' },
  { token: 'status', name: 'status' },
  { token: 'st', name: 'status' },
  { token: 'push', name: 'deploy.push' },
  { token: 'login', name: 'login' },
]

describe('nearestCommand', () => {
  it('suggests the closest registered command for a typo', () => {
    expect(nearestCommand('dploy', CANDIDATES)).toBe('deploy')
    expect(nearestCommand('stauts', CANDIDATES)).toBe('status') // transposition
    expect(nearestCommand('deplooy', CANDIDATES)).toBe('deploy')
    expect(nearestCommand('pussh', CANDIDATES)).toBe('deploy.push')
    expect(nearestCommand('lgin', CANDIDATES)).toBe('login')
  })

  it('is case-insensitive', () => {
    expect(nearestCommand('DEPLOY', CANDIDATES)).toBe('deploy')
    expect(nearestCommand('Stauts', CANDIDATES)).toBe('status')
  })

  it('returns the name an alias resolves to, not the alias', () => {
    expect(nearestCommand('sx', CANDIDATES)).toBe('status')
  })

  it('suggests nothing when no command is close', () => {
    expect(nearestCommand('banana', CANDIDATES)).toBeUndefined()
    expect(nearestCommand('delete', CANDIDATES)).toBeUndefined()
    expect(nearestCommand('deploy-to-production', CANDIDATES)).toBeUndefined()
  })

  it('never matches on a substring', () => {
    // contained in, or containing, a command, but far in edit distance
    expect(nearestCommand('log', [{ token: 'catalog', name: 'catalog' }])).toBeUndefined()
    expect(nearestCommand('mydeployment', CANDIDATES)).toBeUndefined()
    expect(nearestCommand('deploy --token abc', CANDIDATES)).toBeUndefined()
  })

  it('is strict for very short input', () => {
    expect(nearestCommand('x', [{ token: 'y', name: 'y' }])).toBeUndefined()
    expect(nearestCommand('ab', [{ token: 'cd', name: 'cd' }])).toBeUndefined()
    expect(nearestCommand('lz', [{ token: 'ls', name: 'ls' }])).toBe('ls')
  })

  it('prefers the closest, and the first listed on a tie', () => {
    const list = [
      { token: 'build', name: 'second' },
      { token: 'builder', name: 'third' },
      { token: 'buildd', name: 'first' },
    ]
    expect(nearestCommand('build', list)).toBe('second')
    expect(nearestCommand('buil', list)).toBe('second')
    expect(
      nearestCommand('bild', [
        { token: 'build', name: 'a' },
        { token: 'bold', name: 'b' },
      ]),
    ).toBe('a')
  })

  it('ignores input that is empty, not a string, or too long to be a typo', () => {
    expect(nearestCommand('', CANDIDATES)).toBeUndefined()
    expect(nearestCommand(undefined, CANDIDATES)).toBeUndefined()
    expect(nearestCommand(42, CANDIDATES)).toBeUndefined()
    expect(nearestCommand('d'.repeat(10_000), [{ token: 'd'.repeat(10_000), name: 'd' }])).toBe(
      undefined,
    )
  })

  it('only ever returns the name of a candidate, never the input', () => {
    const inputs = [
      'sk-live-4eC39HqLyjWDarjtT1zdp7dc',
      '/home/alice/.ssh/id_rsa',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'alice@example.com',
      'a'.repeat(200_000),
      'deploy ' + 'x'.repeat(100),
      'dploy',
      'stauts',
      '',
    ]
    const names = new Set(CANDIDATES.map((c) => c.name))
    for (const input of inputs) {
      const result = nearestCommand(input, CANDIDATES)
      if (result !== undefined) expect(names.has(result), input.slice(0, 20)).toBe(true)
    }
  })

  it('skips candidates with an unusable name or token', () => {
    const bad = [
      { token: 'deploy', name: '' },
      { token: 'deploy', name: 'n'.repeat(129) },
      { token: 7, name: 'x' },
    ] as unknown as CommandCandidate[]
    expect(nearestCommand('deploy', bad)).toBeUndefined()
  })

  it('does not throw on malformed candidates', () => {
    expect(nearestCommand('deploy', [null as unknown as CommandCandidate])).toBeUndefined()
    expect(nearestCommand('deploy', 5 as unknown as CommandCandidate[])).toBeUndefined()
  })
})
