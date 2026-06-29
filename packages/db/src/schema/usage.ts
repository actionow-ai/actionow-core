import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { subject, tenant } from './identity.js';

/**
 * One row per relay call (§C.4 — the "日志" page). Lightweight and additive: it
 * does NOT replace the `ledger_txn` settle row, it records the operational
 * usage (model, token counts, charged `cost`, latency, terminal status) for the
 * console (per-tenant) and admin (global) views. `cost` is the final µcredit
 * charge mirrored from settle.
 */
// immutable: no updated_at (one append-only row per relay call)
export const usageLog = pgTable(
  'usage_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    model: text('model').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    /**
     * Response token-usage BREAKDOWN (additive; all default 0). These annotate
     * which portion of the totals fell into each bucket — `reasoning_tokens` and
     * `audio_output_tokens` are subsets of `output_tokens`; `cached_input_tokens`
     * and `audio_input_tokens` are subsets of `input_tokens`; `cache_creation_tokens`
     * (Anthropic cache writes) is reported alongside the input total. Captured for
     * correct cache/reasoning billing later — they do NOT change today's metering.
     */
    reasoningTokens: bigint('reasoning_tokens', { mode: 'number' }).notNull().default(0),
    cachedInputTokens: bigint('cached_input_tokens', { mode: 'number' }).notNull().default(0),
    cacheCreationTokens: bigint('cache_creation_tokens', { mode: 'number' }).notNull().default(0),
    audioInputTokens: bigint('audio_input_tokens', { mode: 'number' }).notNull().default(0),
    audioOutputTokens: bigint('audio_output_tokens', { mode: 'number' }).notNull().default(0),
    cost: bigint('cost', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /**
     * The SERVED upstream channel's ACTUAL cost for THIS call in µUSD (Track 5):
     * `roundHalfUp((in×ch.input_cost_per_1m + out×ch.output_cost_per_1m) / 1e6)`.
     * Margin = `cost − provider_cost`. Null when the served channel carried no
     * cost columns (unknown cost) or pre-Track-5. Does NOT affect the customer
     * charge (`cost`) — it is the operator's cost basis for margin analytics.
     */
    providerCost: bigint('provider_cost', { mode: 'bigint' }),
    latencyMs: bigint('latency_ms', { mode: 'number' }),
    // status allowed values: succeeded | failed | canceled (insertUsageLog)
    status: text('status').notNull(),
    // Best-effort correlation id (P1b), NOT an FK — usage_log is a high-volume log
    // and the served-channel id is captured loosely (same posture as relay_trace).
    channelId: uuid('channel_id'),
    /** That channel's provider/adapter type (P1b); null if unknown/pre-P1b. */
    providerType: text('provider_type'),
    // Best-effort correlation id (P1c), NOT an FK (see channelId); null when no key.
    apiKeyId: uuid('api_key_id'),
    /** The subject (end-user) this call is attributed to (unified tenancy G-B); null → tenant-level. */
    subjectId: uuid('subject_id').references(() => subject.id, { onDelete: 'set null' }),
    /** The per-request route tag (染色) the run was pinned to, when set; else null. */
    routeTag: text('route_tag'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('usage_log_tenant_idx').on(t.tenantId, t.createdAt),
    // Composite (col, created_at) so the governance rolling-window sums and the
    // model-health time aggregates use the index instead of scanning.
    index('usage_log_model_idx').on(t.model, t.createdAt),
    index('usage_log_subject_idx').on(t.subjectId, t.createdAt),
    index('usage_log_api_key_idx').on(t.apiKeyId, t.createdAt),
    check('usage_log_status_allowed', sql`${t.status} IN ('succeeded', 'failed', 'canceled')`),
  ],
);
