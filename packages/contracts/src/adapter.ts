import type { HttpClient } from './http.js';

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
  http: HttpClient;
}

export interface SubmitInput {
  resourceId: string;
  modality: string;
  inputs: Record<string, unknown>;
  execMode: ExecMode;
  ctx: AdapterContext;
}

export interface SyncResult {
  kind: 'sync';
  output: Record<string, unknown>;
  usage: UsageVector;
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
