import { sql } from 'drizzle-orm';
import { bigint, check, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

import { tenant } from './identity.js';

export const account = pgTable(
  'account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    creditBalance: bigint('credit_balance', { mode: 'bigint' }).notNull().default(0n),
    creditHeld: bigint('credit_held', { mode: 'bigint' }).notNull().default(0n),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    balanceCheck: check('account_balance_ge_held', sql`${t.creditBalance} >= ${t.creditHeld}`),
  }),
);
