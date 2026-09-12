import { Tier } from './tier.js'
import type { ConsentProvider } from './consent.js'
import { errNoProviderResolved } from './errors.js'

/**
 * Environment variables commonly set to a truthy value by CI systems.
 * Presence of any of these (with a non-empty, non-"false"/"0" value) is
 * treated as "running in CI".
 */
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
  'TF_BUILD', // Azure Pipelines
  'DRONE', // Drone CI
  'CODEBUILD_BUILD_ID',
  'BITBUCKET_BUILD_NUMBER',
] as const

/** Reports whether the current process appears to be running inside a CI system. */
export function isCI(): boolean {
  return CI_ENV_VARS.some((name) => {
    const value = process.env[name]
    return value !== undefined && value !== '' && value !== 'false' && value !== '0'
  })
}

/**
 * Reports whether the `DO_NOT_TRACK` environment variable
 * (https://do-not-track.dev) requests telemetry be disabled. Any value
 * other than unset, empty, "0", or "false" is treated as a request.
 */
export function isDoNotTrackRequested(): boolean {
  const value = process.env['DO_NOT_TRACK']
  if (value === undefined) return false
  return value !== '' && value !== '0' && value !== 'false'
}

/**
 * A {@link ConsentProvider} that caps the resolved tier at
 * `Tier.Anonymous` when the process appears to be running in a CI
 * environment. It resolves `Tier.Anonymous` in that case and rejects
 * otherwise, so it's meant to be placed ahead of other providers in a
 * {@link chainProviders} call — it "wins" only when CI is detected,
 * deferring to the next provider otherwise.
 *
 * Reasoning: CI runs are usually unattended, share no single human
 * user's stored consent preference, and can run at high volume (every
 * commit, every matrix leg). We still allow anonymous-tier telemetry
 * (e.g. install/build counts) by default rather than fully disabling,
 * because that data has real product value and carries no identifying
 * fields at `Tier.Anonymous` by construction. Vendors who want CI runs
 * fully silent can pass `disabled: true` or check `isCI()` themselves.
 *
 * `DO_NOT_TRACK` is handled separately (see {@link isDoNotTrackRequested})
 * and is enforced by the Client as a full disable, not a tier cap: it's
 * a standing, cross-tool opt-out signal a user or environment sets
 * deliberately, so it's honored as "no telemetry" rather than "least
 * telemetry".
 */
export class EnvConsentProvider implements ConsentProvider {
  resolve(): Tier {
    if (isCI()) return Tier.Anonymous
    throw errNoProviderResolved
  }
}
