import { Tier } from './tier.js'
import type { ConsentProvider } from './consent.js'

export type Transport = 'http' | 'grpc'

/**
 * The hosted public ingest endpoint for OTLP/HTTP. Overridden by
 * `options.endpoint` for self-hosted/on-prem deployments.
 *
 * TODO(schema): confirm the production hostname; this is a placeholder.
 */
export const DEFAULT_ENDPOINT_HTTP = 'https://ingest.argvio.io:4318'

/** The hosted public ingest endpoint for OTLP/gRPC. Same TODO(schema) status as above. */
export const DEFAULT_ENDPOINT_GRPC = 'ingest.argvio.io:4317'

/**
 * The metadata/header key the API key is sent under.
 *
 * TODO(schema): confirm against the public server's actual auth
 * contract; placeholder pending that being pasted into this repo.
 */
export const DEFAULT_AUTH_HEADER = 'x-argvio-api-key'

export const DEFAULT_EXPORT_TIMEOUT_MS = 10_000
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000
export const DEFAULT_QUEUE_SIZE = 2048

/** Configures a {@link Client} constructed by `createClient`. */
export interface ClientOptions {
  /**
   * Overrides the OTLP collector endpoint. Defaults to the hosted
   * public endpoint appropriate for `transport`.
   */
  endpoint?: string
  /**
   * Selects the OTLP wire transport. Defaults to `'http'` so a CLI that
   * embeds it doesn't pull in a gRPC client stack by default. Pass
   * `'grpc'` if you need gRPC.
   */
  transport?: Transport
  /** Disables transport security. Only intended for local development against a self-hosted collector without TLS. */
  insecure?: boolean
  /** Overrides the header the API key is sent under. Rarely needed. */
  authHeader?: string
  /** The consent tier used when no `consentProvider` is supplied, or if it rejects/times out. Defaults to `Tier.Anonymous`. */
  defaultTier?: Tier
  /** Resolves the session's consent tier at construction time. If unset, `defaultTier` is used directly. */
  consentProvider?: ConsentProvider
  /**
   * Fully disables the client: `createClient` returns a Client that
   * performs zero network calls and whose `record*` methods are no-ops
   * with negligible overhead. Equivalent to setting `ARGVIO_DISABLED=1`,
   * and also engaged automatically when `DO_NOT_TRACK` requests it.
   */
  disabled?: boolean
  /** Bounds how long a single export attempt may take. */
  exportTimeoutMs?: number
  /** Bounds how long `flush`/`shutdown` may block waiting for in-flight data to be exported. */
  shutdownTimeoutMs?: number
  /** Bounds the number of pending records buffered before new records are dropped (counted, never blocking). */
  queueSize?: number
  /**
   * Additional static OTel resource attributes (e.g. a build channel or
   * distribution identifier). Not tier-gated and not part of the
   * taxonomy — use sparingly, for attributes that describe the CLI
   * build itself rather than any individual invocation.
   */
  resourceAttributes?: Record<string, string>
}

export interface ResolvedConfig {
  apiKey: string
  cliName: string
  cliVersion: string
  endpoint: string
  transport: Transport
  insecure: boolean
  authHeader: string
  defaultTier: Tier
  consentProvider: ConsentProvider | undefined
  disabled: boolean
  exportTimeoutMs: number
  shutdownTimeoutMs: number
  queueSize: number
  resourceAttributes: Record<string, string>
}

export function resolveConfig(
  apiKey: string,
  cliName: string,
  cliVersion: string,
  options: ClientOptions = {},
): ResolvedConfig {
  const transport = options.transport ?? 'http'
  return {
    apiKey,
    cliName,
    cliVersion,
    transport,
    endpoint:
      options.endpoint || (transport === 'grpc' ? DEFAULT_ENDPOINT_GRPC : DEFAULT_ENDPOINT_HTTP),
    insecure: options.insecure ?? false,
    authHeader: options.authHeader || DEFAULT_AUTH_HEADER,
    defaultTier: options.defaultTier ?? Tier.Anonymous,
    consentProvider: options.consentProvider,
    disabled: options.disabled ?? false,
    exportTimeoutMs:
      options.exportTimeoutMs && options.exportTimeoutMs > 0
        ? options.exportTimeoutMs
        : DEFAULT_EXPORT_TIMEOUT_MS,
    shutdownTimeoutMs:
      options.shutdownTimeoutMs && options.shutdownTimeoutMs > 0
        ? options.shutdownTimeoutMs
        : DEFAULT_SHUTDOWN_TIMEOUT_MS,
    queueSize: options.queueSize && options.queueSize > 0 ? options.queueSize : DEFAULT_QUEUE_SIZE,
    resourceAttributes: options.resourceAttributes ?? {},
  }
}
