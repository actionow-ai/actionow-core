import type { HttpClient } from './http.js';
import type { MediaResult } from './media-result.js';
import type { PluginManifest } from './provider-plugin.js';

export const EXEC_MODES = ['blocking', 'stream', 'async-poll', 'async-callback'] as const;
export type ExecMode = (typeof EXEC_MODES)[number];

export type UsageVector = Record<string, number>;

export const UNIFIED_ERROR_CODES = [
  'invalid_input',
  'insufficient_credits',
  'resource_not_found',
  'rate_limited',
  'upstream_error',
  'upstream_timeout',
  'content_filtered',
  'job_failed',
  'unauthorized',
  'internal_error',
] as const;
export type UnifiedErrorCode = (typeof UNIFIED_ERROR_CODES)[number];

export interface UnifiedError {
  code: UnifiedErrorCode;
  message: string;
  upstream?: { provider: string; rawCode?: string };
  retryable: boolean;
  retryAfterMs?: number;
}

export interface AdapterContext {
  providerType: string;
  model?: string;
  endpoint?: string;
  apiKey?: string; // resolved from vault by caller; never logged
  /** Optional per-channel egress proxy URL (resolved from the channel proxy_ref); never logged. */
  proxyUrl?: string;
  /**
   * Opaque per-channel protocol config consumed by the adapter (e.g. relay task
   * paths, signature header names); never logged.
   */
  config?: Record<string, unknown>;
  /**
   * Frozen plugin snapshot (manifest + handler JS) when this channel is served by
   * the generic plugin adapter (P2). The generic adapter runs the handler in the
   * QuickJS sandbox; `providerType` is `'plugin'` for these channels.
   */
  plugin?: { manifest: PluginManifest; handler: string };
  /**
   * Resolved credential map for the plugin signer (api_key / ak / sk / region …).
   * Consumed ONLY by the platform signer OUTSIDE the sandbox (D5/D7); never logged,
   * never passed into a handler.
   */
  credentials?: Record<string, string>;
  http: HttpClient;
}

export interface SubmitInput {
  resourceId: string;
  modality: string;
  inputs: Record<string, unknown>;
  execMode: ExecMode;
  ctx: AdapterContext;
}

/**
 * A provider-neutral description of one upstream model, returned by the optional
 * `ProviderAdapter.listModels` (the adapter discovers them from the provider's
 * official catalog endpoint). `id` is the upstream slug the relay sends in the
 * request body and stores as a `model` row `name`. `capabilities` is a feature
 * flag map (tools/vision/audio/json/stream) — a `Record<string, boolean>` rather
 * than the adapters-package `AdapterCapabilities`, since contracts may not import
 * the adapters package (the dependency runs the other way).
 */
export interface ProviderModel {
  id: string;
  displayName?: string;
  description?: string;
  contextWindow?: number;
  capabilities?: Record<string, boolean>;
}

export interface SyncResult {
  kind: 'sync';
  output: Record<string, unknown>;
  usage: UsageVector;
  /** Canonical media result when this is a media job (P1); the engine prefers it over `output`. */
  mediaResult?: MediaResult;
}
export interface UpstreamJobHandle {
  kind: 'async';
  provider: string;
  upstreamJobId: string;
  meta?: Record<string, unknown>;
}
export type SubmitResult = SyncResult | UpstreamJobHandle;

export type UpstreamStatus = 'running' | 'succeeded' | 'failed';
export interface PollResult {
  status: UpstreamStatus;
  output?: Record<string, unknown>;
  usage?: UsageVector;
  error?: UnifiedError;
  /** Canonical media result for a succeeded media job (P1). */
  mediaResult?: MediaResult;
}
export interface CallbackResult extends PollResult {
  upstreamJobId: string;
}

/**
 * A single event emitted by a streaming adapter (`ProviderAdapter.stream`) or by
 * the engine's settling stream.
 *
 * - `delta` carries an incremental `text` token.
 * - `usage` reports the normalized `{input_tokens, output_tokens}` once known.
 * - `done` marks the end of the stream and may repeat the final `usage`. The
 *   engine's terminal `done` also carries the settled `jobId` + `cost` (the
 *   `cost.credits` µcredit amount is a decimal string so JSON keeps full
 *   precision and never coerces money through a float).
 * - `error` carries a {@link UnifiedError}.
 */
export interface StreamEvent {
  kind: 'delta' | 'usage' | 'done' | 'error';
  /** Present on `kind: 'delta'` — an incremental text token. */
  text?: string;
  /** Present on `kind: 'usage' | 'done'` — normalized usage vector. */
  usage?: UsageVector;
  /** Present on the engine's terminal `kind: 'done'` — the settled job id. */
  jobId?: string;
  /** Present on the engine's terminal `kind: 'done'` — the settled cost. */
  cost?: { credits: string };
  /** Present on `kind: 'error'`. */
  error?: UnifiedError;
}
