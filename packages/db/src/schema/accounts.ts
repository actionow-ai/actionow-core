import { sql } from 'drizzle-orm';
import { bigint, check, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { tenant } from './identity.js';
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    check('account_balance_ge_held', sql`${t.creditBalance} >= ${t.creditHeld}`),
    // account_tenant_unique also serves as the FK index on tenant_id
    uniqueIndex('account_tenant_unique').on(t.tenantId),
  ],
);
