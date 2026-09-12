import { describe, expect, it, afterEach } from 'vitest'

import { Tier } from '../src/tier.js'
import { StaticProvider, DisabledProvider, chainProviders } from '../src/consent.js'
import { isCI, isDoNotTrackRequested, EnvConsentProvider } from '../src/consentEnv.js'

const CI_ENV_VARS = [
  'CI',
  'CONTINUOUS_INTEGRATION',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'JENKINS_URL',
  'BUILDKITE',
  'TEAMCITY_VERSION',
  'APPVEYOR',
  'TF_BUILD',
  'DRONE',
  'CODEBUILD_BUILD_ID',
  'BITBUCKET_BUILD_NUMBER',
]

function clearCiEnvVars(): void {
  for (const key of CI_ENV_VARS) delete process.env[key]
}

describe('StaticProvider', () => {
  it('always resolves to the configured tier', () => {
    expect(new StaticProvider(Tier.Full).resolve()).toBe(Tier.Full)
  })

  it('fails closed to Anonymous for an invalid tier', () => {
    // @ts-expect-error intentionally invalid for the test
    expect(new StaticProvider(99).resolve()).toBe(Tier.Anonymous)
  })
})

describe('DisabledProvider', () => {
  it('always resolves to Anonymous', () => {
    expect(new DisabledProvider().resolve()).toBe(Tier.Anonymous)
  })
})

describe('chainProviders', () => {
  it('uses the first provider that does not throw', () => {
    const provider = chainProviders(
      {
        resolve: () => {
          throw new Error('nope')
        },
      },
      new StaticProvider(Tier.Basic),
      new StaticProvider(Tier.OptIn),
    )
    expect(provider.resolve()).toBe(Tier.Basic)
  })

  it('skips null/undefined providers', () => {
    const provider = chainProviders(undefined, null, new StaticProvider(Tier.Full))
    expect(provider.resolve()).toBe(Tier.Full)
  })

  it('throws if every provider throws', () => {
    const provider = chainProviders(
      {
        resolve: () => {
          throw new Error('a')
        },
      },
      {
        resolve: () => {
          throw new Error('b')
        },
      },
    )
    expect(() => provider.resolve()).toThrow()
  })
})

describe('isCI / isDoNotTrackRequested', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('detects common CI env vars', () => {
    clearCiEnvVars()
    process.env['CI'] = 'true'
    expect(isCI()).toBe(true)
  })

  it('treats "false"/"0" as not-CI', () => {
    clearCiEnvVars()
    process.env['CI'] = 'false'
    expect(isCI()).toBe(false)
  })

  it('honors DO_NOT_TRACK truthy values', () => {
    process.env['DO_NOT_TRACK'] = '1'
    expect(isDoNotTrackRequested()).toBe(true)
    process.env['DO_NOT_TRACK'] = '0'
    expect(isDoNotTrackRequested()).toBe(false)
    delete process.env['DO_NOT_TRACK']
    expect(isDoNotTrackRequested()).toBe(false)
  })
})

describe('EnvConsentProvider', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('resolves Anonymous when CI is detected', () => {
    clearCiEnvVars()
    process.env['CI'] = 'true'
    expect(new EnvConsentProvider().resolve()).toBe(Tier.Anonymous)
  })

  it('throws (defers to the next provider) outside CI', () => {
    clearCiEnvVars()
    expect(() => new EnvConsentProvider().resolve()).toThrow()
  })
})
