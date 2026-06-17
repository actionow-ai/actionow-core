import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * One row per upstream provider call captured at the `HttpClient` choke point
 * (the engine's `TracingHttpClient`). This is a full request/response AUDIT
 * TRACE of the raw wire payloads sent to upstreams (codex/openai/anthropic/
 * gemini/media), gated behind the `RELAY_TRACE` flag.
 *
 * Storage is deliberately Postgres-only (no object-storage offloading): the
 * full bodies — INCLUDING raw streaming SSE bytes — live in `request_body` /
 * `response_body`. Three safety valves keep this honest:
 *  - secrets in `request_headers` are redacted (`[redacted]`); a real bearer
 *    token is never stored;
 *  - secret-looking query params in `url` are redacted;
 *  - bodies are truncated at `RELAY_TRACE_MAX_BYTES` with `truncated=true`.
 *
 * The correlation columns (`tenant_id`/`job_id`/`channel_id`) are plain
 * nullable uuids, NOT foreign keys: trace writes are best-effort and must never
 * fail (or be rolled back) by a referential-integrity check on a transient id.
 */
export const relayTrace = pgTable('relay_trace', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** The calling tenant (best-effort; nullable, no FK). */
  tenantId: uuid('tenant_id'),
  /** The run/job this upstream call belongs to (best-effort; nullable, no FK). */
  jobId: uuid('job_id'),
  /** The upstream_channel that served this call (best-effort; nullable, no FK). */
  channelId: uuid('channel_id'),
  /** The serving channel's provider/adapter type (e.g. `codex-oauth`). */
  providerType: text('provider_type'),
  method: text('method').notNull(),
  /** The request URL with secret-looking query-param VALUES redacted. */
  url: text('url').notNull(),
  /** The request headers as sent, with secret header VALUES redacted. */
  requestHeaders: jsonb('request_headers').$type<Record<string, string>>(),
  /** The serialized request body, truncated at the byte cap. */
  requestBody: text('request_body'),
  responseStatus: integer('response_status'),
  /**
   * The full response body, truncated at the byte cap. For a stream this is the
   * assembled raw SSE bytes (every yielded line joined) — the user opted into
   * capturing the raw streaming wire.
   */
  responseBody: text('response_body'),
  isStream: boolean('is_stream').notNull().default(false),
  latencyMs: bigint('latency_ms', { mode: 'number' }),
  /** The error string when the underlying request/stream threw; else null. */
  error: text('error'),
  /** True when either body was clipped at the byte cap. */
  truncated: boolean('truncated').notNull().default(false),
});
