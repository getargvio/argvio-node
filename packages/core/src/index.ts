export { Client, OptInScope, createClient } from './client.js'
export type { CommandResult, CounterOptions, DurationOptions } from './client.js'

export type { ClientOptions, Transport } from './options.js'
export { AuthState, isValidAuthState, MAX_CONFIG_CUSTOMIZED_COUNT } from './sessionFacts.js'
export type { Lazy } from './sessionFacts.js'
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
export type { ErrorClassification } from './tier.js'

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
  AttrPeakRssBytes,
  AttrShell,
  AttrTerminal,
  AttrStdoutIsTty,
  AttrRuntimeName,
  AttrRuntimeVersion,
  AttrCpuTimeMs,
  AttrBinarySizeBytes,
  AttrStartupDurationMs,
  AttrConfigCustomizedCount,
  AttrAuthState,
  AttrCommandSuggestion,
  AttrFlagNames,
  AttrSessionId,
  AttrInstallId,
  AttrHelpFlag,
  AttrInstallMethod,
  AttrActivationFeature,
  AttrErrorType,
  AttrErrorReason,
  AttrCounterName,
  AttrCounterLabel,
  AttrMeasureName,
  AttrMeasureLabel,
  AttrErrorMessage,
  AttrErrorStack,
  EventSessionStarted,
  EventCommandInvoked,
  EventCommandCompleted,
  EventFeatureActivated,
  EventHelpViewed,
  EventCommandUnknown,
  EventErrorRaised,
  SpanCommandPrefix,
  MetricCommandInvocations,
  MetricCommandDuration,
  MetricErrors,
  MetricCounter,
  MetricMeasure,
  MEASURE_BUCKET_BOUNDARIES_MS,
} from './taxonomy.js'
export { nearestCommand } from './suggest.js'
export type { CommandCandidate } from './suggest.js'
export {
  ResourceAttrCLIVersion,
  ResourceAttrOS,
  ResourceAttrArch,
  ResourceAttrIsCI,
  ResourceAttrCIProvider,
} from './resource.js'
