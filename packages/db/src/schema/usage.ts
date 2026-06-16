import { sql } from 'drizzle-orm';
import { bigint, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { tenant } from './identity.js';

/**
 * One row per relay call (§C.4 — the "日志" page). Lightweight and additive: it
 * does NOT replace the `ledger_txn` settle row, it records the operational
 * usage (model, token counts, charged `cost`, latency, terminal status) for the
 * console (per-tenant) and admin (global) views. `cost` is the final µcredit
 * charge mirrored from settle.
 */
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
    cost: bigint('cost', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    latencyMs: bigint('latency_ms', { mode: 'number' }),
    status: text('status').notNull(), // succeeded | failed | canceled
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('usage_log_tenant_idx').on(t.tenantId, t.createdAt),
    index('usage_log_model_idx').on(t.model),
  ],
);
