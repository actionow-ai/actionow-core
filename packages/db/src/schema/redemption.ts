import { bigint, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { tenant } from './identity.js';

/**
 * A redemption code / 卡密 (§C.3). `code` is the PK (the claim key); a claim is
 * idempotent on it. `credit_amount` is the µcredit grant (operator enters human
 * credits at the admin boundary → µcredits). `status` is `unused` until claimed,
 * then `redeemed`. `redeemed_by_tenant` records who claimed it; `expires_at` is
 * optional. Codes are minted by the admin and claimed via the engine
 * `redeemCode` (which reuses the `topUp` ledger path).
 */
export const redemptionCode = pgTable('redemption_code', {
  code: text('code').primaryKey(),
  creditAmount: bigint('credit_amount', { mode: 'bigint' }).notNull(),
  status: text('status').notNull().default('unused'), // unused | redeemed
  redeemedByTenant: uuid('redeemed_by_tenant').references(() => tenant.id),
  redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
