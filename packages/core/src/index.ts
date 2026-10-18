export { Client, OptInScope, createClient } from './client.js'
export type { CommandResult } from './client.js'

export type { ClientOptions, Transport } from './options.js'
export {
  DEFAULT_ENDPOINT_HTTP,
  DEFAULT_ENDPOINT_GRPC,
  DEFAULT_AUTH_HEADER,
  DEFAULT_EXPORT_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_QUEUE_SIZE,
} from './options.js'

export {
  Tier,
  RESOURCE_ATTR_TIER,
  tierToString,
  parseTier,
  isValidTier,
  tierAllows,
  clampTier,
  ErrorCategory,
  isValidErrorCategory,
} from './tier.js'

export type { ConsentProvider } from './consent.js'
export { StaticProvider, DisabledProvider, chainProviders } from './consent.js'

export { isCI, isDoNotTrackRequested, detectCIProvider, EnvConsentProvider } from './consentEnv.js'

export type { FileConsentProviderOptions } from './consentFile.js'
export { FileConsentProvider } from './consentFile.js'

export type { Stats } from './safety.js'

export {
  AttrCommandName,
  AttrExitCode,
  AttrDurationMs,
  AttrFlagNames,
  AttrSessionId,
  AttrInstallId,
  AttrHelpFlag,
  AttrInstallMethod,
  AttrActivationFeature,
  AttrErrorType,
  AttrErrorMessage,
  AttrErrorStack,
  EventSessionStarted,
  EventCommandInvoked,
  EventCommandCompleted,
  EventFeatureActivated,
  EventHelpViewed,
  EventErrorRaised,
  SpanCommandPrefix,
  MetricCommandInvocations,
  MetricCommandDuration,
  MetricErrors,
} from './taxonomy.js'
export {
  ResourceAttrCLIVersion,
  ResourceAttrOS,
  ResourceAttrArch,
  ResourceAttrIsCI,
  ResourceAttrCIProvider,
} from './resource.js'
