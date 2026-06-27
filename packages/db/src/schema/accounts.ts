import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { subject, tenant } from './identity.js';
import { limitPlan } from './limit.js';

export const account = pgTable(
  'account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    // mode:'bigint' kept (values are JS bigint, e.g. 100n); default expressed via sql`0`
    // because drizzle-kit 0.31.10 cannot JSON-serialize a literal bigint default (`0n`)
    // when diffing snapshots. Generated DDL is identical: `bigint DEFAULT 0 NOT NULL`.
    creditBalance: bigint('credit_balance', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    creditHeld: bigint('credit_held', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    // The tenant-level limit plan (额度套餐) — applies to every key of this tenant
    // (governance-limits). NULLABLE → no tenant-level limits.
    limitPlanId: uuid('limit_plan_id').references(() => limitPlan.id),
    // Per-account config bag (unified tenancy M-X). Holds e.g. `wallet_mode`
    // (decision #3: SHARED default vs HARD) for the tenant's subjects. Additive;
    // `{}` default = today's behavior.
    config: jsonb('config')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    check('account_balance_ge_held', sql`${t.creditBalance} >= ${t.creditHeld}`),
    // Mirror sub_account's full money invariants on the HIGHER-value tenant pool:
    // without these an unguarded releaseHold could drive a balance/held negative.
    check('account_balance_ge0', sql`${t.creditBalance} >= 0`),
    check('account_held_ge0', sql`${t.creditHeld} >= 0`),
    // Partial on deleted_at so a soft-deleted account frees its tenant slot (the
    // soft-delete-frees-the-name pattern); still serves as the tenant_id FK index.
    uniqueIndex('account_tenant_unique')
      .on(t.tenantId)
      .where(sql`deleted_at IS NULL`),
  ],
);

/**
 * A **per-subject sub-wallet** (unified tenancy G-E, HARD mode). An end-user
 * (`subject`) optionally has prepaid credits of their own, held/settled against
 * THIS row instead of the tenant pool. Mirrors `account`'s money invariants
 * exactly (balance ≥ held ≥ 0) so the same atomic no-oversell `UPDATE` applies.
 * Absence of a row = SHARED mode (the subject draws the tenant `account`).
 * The governance plan is NOT here — it lives on `subject.limit_plan_id` so a
 * SHARED subject can still have caps.
 */
export const subAccount = pgTable(
  'sub_account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subject.id),
    creditBalance: bigint('credit_balance', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    creditHeld: bigint('credit_held', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    // status allowed values: active | disabled
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('sub_account_tenant_subject_unique')
      .on(t.tenantId, t.subjectId)
      .where(sql`deleted_at IS NULL`),
    index('sub_account_subject_idx').on(t.subjectId),
    check('sub_account_balance_ge_held', sql`${t.creditBalance} >= ${t.creditHeld}`),
    check('sub_account_balance_ge0', sql`${t.creditBalance} >= 0`),
    check('sub_account_held_ge0', sql`${t.creditHeld} >= 0`),
    check('sub_account_status_allowed', sql`${t.status} IN ('active', 'disabled')`),
  ],
);
