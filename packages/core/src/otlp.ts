import { Metadata } from '@grpc/grpc-js'
import type { SpanExporter } from '@opentelemetry/sdk-trace-node'
import type { LogRecordExporter } from '@opentelemetry/sdk-logs'
import type { PushMetricExporter } from '@opentelemetry/sdk-metrics'

import { OTLPTraceExporter as OTLPTraceExporterHttp } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPTraceExporter as OTLPTraceExporterGrpc } from '@opentelemetry/exporter-trace-otlp-grpc'
import { OTLPMetricExporter as OTLPMetricExporterHttp } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPMetricExporter as OTLPMetricExporterGrpc } from '@opentelemetry/exporter-metrics-otlp-grpc'
import { OTLPLogExporter as OTLPLogExporterHttp } from '@opentelemetry/exporter-logs-otlp-http'
import { OTLPLogExporter as OTLPLogExporterGrpc } from '@opentelemetry/exporter-logs-otlp-grpc'

import type { ResolvedConfig } from './options.js'

export interface Exporters {
  trace: SpanExporter
  metric: PushMetricExporter
  log: LogRecordExporter
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * Ensures `endpoint` carries an explicit scheme, downgrading to `http://`
 * when `insecure` is set (used for local development against a
 * self-hosted collector without TLS).
 */
function withScheme(endpoint: string, insecure: boolean): string {
  if (!SCHEME_RE.test(endpoint)) {
    return `${insecure ? 'http' : 'https'}://${endpoint}`
  }
  return insecure ? endpoint.replace(/^https:\/\//i, 'http://') : endpoint
}

function grpcMetadata(cfg: ResolvedConfig): Metadata {
  const metadata = new Metadata()
  metadata.set(cfg.authHeader, cfg.apiKey)
  return metadata
}

function httpHeaders(cfg: ResolvedConfig): Record<string, string> {
  return { [cfg.authHeader]: cfg.apiKey }
}

/**
 * Builds the three signal-specific OTLP exporters for a single Client.
 * Each is independently constructed so a failure building one doesn't
 * necessarily prevent the others.
 */
export function buildExporters(cfg: ResolvedConfig): Exporters {
  if (cfg.transport === 'grpc') {
    const url = withScheme(cfg.endpoint, cfg.insecure)
    const metadata = grpcMetadata(cfg)
    return {
      trace: new OTLPTraceExporterGrpc({ url, metadata, timeoutMillis: cfg.exportTimeoutMs }),
      metric: new OTLPMetricExporterGrpc({ url, metadata, timeoutMillis: cfg.exportTimeoutMs }),
      log: new OTLPLogExporterGrpc({ url, metadata, timeoutMillis: cfg.exportTimeoutMs }),
    }
  }

  const base = withScheme(cfg.endpoint, cfg.insecure).replace(/\/+$/, '')
  const headers = httpHeaders(cfg)
  return {
    trace: new OTLPTraceExporterHttp({
      url: `${base}/v1/traces`,
      headers,
      timeoutMillis: cfg.exportTimeoutMs,
    }),
    metric: new OTLPMetricExporterHttp({
      url: `${base}/v1/metrics`,
      headers,
      timeoutMillis: cfg.exportTimeoutMs,
    }),
    log: new OTLPLogExporterHttp({
      url: `${base}/v1/logs`,
      headers,
      timeoutMillis: cfg.exportTimeoutMs,
    }),
  }
}
