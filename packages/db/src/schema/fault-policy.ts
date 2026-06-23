import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * A **fault-tolerance policy (调用容错策略)** — a named, reusable resilience
 * profile an operator binds to an upstream channel (`upstream_channel.fault_policy_id`).
 * Mirrors the named/reusable pattern of {@link routeGroup}. A channel with NO
 * policy (`fault_policy_id IS NULL`) keeps the engine defaults (a single attempt
 * per channel + client-wide timeouts), so the table is purely additive.
 *
 * Two top-level modes:
 * - `fast_fail = true` — surface the first error immediately (no SAME-channel
 *   retry); cross-channel failover (兜底链) still applies.
 * - `fast_fail = false` — retry the SAME channel up to `retry_count` times with
 *   `backoff_type`/`backoff_ms` spacing BEFORE the router cools it down + cascades
 *   to the next channel.
 *
 * Retry is gated by the trigger set: an error is retried when its HTTP status is
 * in `retry_codes` OR its message contains any substring in `retry_messages`
 * (e.g. add `404` — normally non-retryable — or match "Internal server error").
 * An empty trigger set falls back to the adapter's built-in retryable verdict.
 *
 * The four timeouts are injected per attempt (ms): `connect` (TCP/TLS — best
 * effort: enforced on curl egress, falls back to total on fetch), `ttft`
 * (time-to-first-token — maps to the stream idle/TTFB window), `total` (whole
 * request), `idle` (inter-chunk read idle for streams). Null → the client default.
 */
export const faultPolicy = pgTable(
  'fault_policy',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Surface the first error immediately (no same-channel retry). */
    fastFail: boolean('fast_fail').notNull().default(false),
    /** SAME-channel retry attempts after the first failure (0 = none). */
    retryCount: integer('retry_count').notNull().default(0),
    /** Backoff spacing between same-channel retries: fixed | exponential. */
    backoffType: text('backoff_type').notNull().default('fixed'),
    /** Base backoff interval in ms (exponential doubles it per attempt). */
    backoffMs: integer('backoff_ms').notNull().default(0),
    /** TCP/TLS connect timeout (ms); null → client default. Best-effort on fetch. */
    connectTimeoutMs: integer('connect_timeout_ms'),
    /** Time-to-first-token timeout (ms); null → client default. */
    ttftTimeoutMs: integer('ttft_timeout_ms'),
    /** Whole-request timeout (ms); null → client default. */
    totalTimeoutMs: integer('total_timeout_ms'),
    /** Inter-chunk read-idle timeout for streams (ms); null → client default. */
    idleTimeoutMs: integer('idle_timeout_ms'),
    /** HTTP status codes that TRIGGER a retry (e.g. [500,429,404]); null/[] → adapter default. */
    retryCodes: jsonb('retry_codes').$type<number[]>(),
    /** Error-message substrings that trigger a retry; null/[] → adapter default. */
    retryMessages: jsonb('retry_messages').$type<string[]>(),
    // status allowed values: active | disabled (create default + admin DTO)
    status: text('status').notNull().default('active'),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // PARTIAL unique index (mirrors route_group_name_idx): only LIVE rows reserve
    // their name; a soft-deleted policy frees its name for a fresh create.
    uniqueIndex('fault_policy_name_idx')
      .on(t.name)
      .where(sql`deleted_at IS NULL`),
    check('fault_policy_status_allowed', sql`${t.status} IN ('active', 'disabled')`),
    check('fault_policy_backoff_allowed', sql`${t.backoffType} IN ('fixed', 'exponential')`),
  ],
);
