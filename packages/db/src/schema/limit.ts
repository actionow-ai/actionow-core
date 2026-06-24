import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * A **limit plan (额度套餐/档位)** — a reusable preset bundling a set of
 * {@link limitRule}s (spend budgets, usage quotas, throughput caps). Bound to an
 * API key (`api_key.limit_plan_id`) and/or a tenant (`account.limit_plan_id`);
 * a request's effective rules = the union of the key's plan + the tenant's plan,
 * AND-combined (governance-limits spec §1). Soft-deleted (mirrors `route_group`)
 * so a bound plan's history survives; a live `name` is unique.
 */
export const limitPlan = pgTable(
  'limit_plan',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description'),
    // status allowed values: active | disabled
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('limit_plan_name_idx')
      .on(t.name)
      .where(sql`deleted_at IS NULL`),
    check('limit_plan_status_allowed', sql`${t.status} IN ('active', 'disabled')`),
  ],
);

/**
 * One **limit rule** inside a {@link limitPlan}: a `dimension × period` cap.
 * - `dimension`: `spend` (µUSD) | `requests` | `tokens` | `rpm` | `concurrency`.
 * - `period`: `day` | `month` | `rolling_24h` | `rolling_30d` | `total` for the
 *   accumulating dimensions; `minute` for `rpm`; NULL for `concurrency`
 *   (instantaneous). The dimension↔period pairing is validated in the zod
 *   contract; the CHECK only constrains the allowed period vocabulary.
 * - `cap`: µUSD for `spend`, otherwise an integer count / RPM / max-in-flight.
 * - `model_scope`: when set, the rule applies only to requests naming that model.
 * - `alert_pct`: emit a {@link limitAlert} when usage crosses this % of `cap`.
 * - `enforce`: `hard` only in v1 (column reserved for a future `soft` option).
 */
export const limitRule = pgTable(
  'limit_rule',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id')
      .notNull()
      .references(() => limitPlan.id),
    dimension: text('dimension').notNull(),
    period: text('period'),
    cap: bigint('cap', { mode: 'bigint' }).notNull(),
    modelScope: text('model_scope'),
    alertPct: integer('alert_pct'),
    enforce: text('enforce').notNull().default('hard'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('limit_rule_plan_idx').on(t.planId),
    check(
      'limit_rule_dimension_allowed',
      sql`${t.dimension} IN ('spend', 'requests', 'tokens', 'rpm', 'concurrency')`,
    ),
    check(
      'limit_rule_period_allowed',
      sql`${t.period} IS NULL OR ${t.period} IN ('minute', 'day', 'month', 'rolling_24h', 'rolling_30d', 'total')`,
    ),
    check('limit_rule_cap_ge0', sql`${t.cap} >= 0`),
    check(
      'limit_rule_alert_pct_range',
      sql`${t.alertPct} IS NULL OR (${t.alertPct} >= 1 AND ${t.alertPct} <= 100)`,
    ),
  ],
);

/**
 * Durable materialized usage accumulator for the accumulating dimensions on the
 * calendar/total periods (`day`/`month`/`total`) — the fast read path that also
 * survives a Redis flush and is reconciled against the ledger. Rolling windows
 * are NOT materialized here (computed by a windowed aggregate at check time).
 * `period_key` encodes the bucket (`2026-06` month, `2026-06-24` day, `total`).
 */
export const limitUsage = pgTable(
  'limit_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // subject_type allowed values: key | tenant
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    dimension: text('dimension').notNull(),
    periodKey: text('period_key').notNull(),
    modelScope: text('model_scope').notNull().default(''),
    used: bigint('used', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    periodStart: timestamp('period_start', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('limit_usage_unique').on(
      t.subjectType,
      t.subjectId,
      t.dimension,
      t.periodKey,
      t.modelScope,
    ),
  ],
);

/**
 * A fired threshold crossing (`alert_pct`) for a {@link limitRule} in a period —
 * drives the operator alert list + the `limit.alert` webhook. Append-only; the
 * unique index makes it fire ONCE per `(subject, rule, period, pct)`.
 */
export const limitAlert = pgTable(
  'limit_alert',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    // Plain uuid (NOT an FK): alerts are append-only history and must survive a
    // plan-rule replace-all; dimension/period/used/cap/pct are denormalized here.
    ruleId: uuid('rule_id').notNull(),
    dimension: text('dimension').notNull(),
    periodKey: text('period_key').notNull(),
    used: bigint('used', { mode: 'bigint' }).notNull(),
    cap: bigint('cap', { mode: 'bigint' }).notNull(),
    pct: integer('pct').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('limit_alert_subject_idx').on(t.subjectType, t.subjectId),
    uniqueIndex('limit_alert_once_idx').on(
      t.subjectType,
      t.subjectId,
      t.ruleId,
      t.periodKey,
      t.pct,
    ),
  ],
);
