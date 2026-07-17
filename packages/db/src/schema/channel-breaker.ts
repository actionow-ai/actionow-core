import { sql } from 'drizzle-orm';
import { check, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Per-(channel, model) circuit-breaker state (弹性2.0). The runtime FSM:
 * closed (normal) → open (tripped, excluded from routing) → half_open (trial).
 * `model` is the resolved model name, or `'*'` for model-less resources.
 *
 * Supersedes the binary `channel_health` cooldown (still present after 0047;
 * dropped in the Task-2 follow-on migration once its repo/engine/admin consumers
 * are repointed): the FSM adds a controlled HalfOpen probe instead of snapping a
 * cooled channel back to full traffic. Persisted (not in-memory) so state is
 * consistent across replicas via the shared DB; the Redis window
 * (`packages/infra`) drives the trip decision.
 */
export const channelBreaker = pgTable(
  'channel_breaker',
  {
    // 批次6 D3: plain uuid — the FK to the deleted `upstream_channel` table is
    // dropped (D4: DROP CONSTRAINT channel_breaker_channel_id_upstream_channel_id_fk).
    channelId: uuid('channel_id').notNull(),
    /** Resolved model name, or `'*'` for model-less resources. */
    model: text('model').notNull(),
    state: text('state').notNull().default('closed'),
    /** When it entered Open. */
    openedAt: timestamp('opened_at', { withTimezone: true }),
    /** Open→HalfOpen eligibility time. */
    cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
    /** Recent consecutive trips → drives exp-backoff cooldown; reset on HalfOpen→Closed. */
    tripCount: integer('trip_count').notNull().default(0),
    /** Consecutive successes accumulated in HalfOpen. */
    halfOpenSuccesses: integer('half_open_successes').notNull().default(0),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    lastTransitionAt: timestamp('last_transition_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.model] }),
    check('channel_breaker_state_allowed', sql`${t.state} IN ('closed','open','half_open')`),
  ],
);
