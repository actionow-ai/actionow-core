import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { subject, tenant } from './identity.js';

/**
 * A redemption code / 卡密 (§C.3). `code` is the PK (the claim key); a claim is
 * idempotent on it. `credit_amount` is the µcredit grant (operator enters human
 * credits at the admin boundary → µcredits). `status` is `unused` until claimed,
 * then `redeemed`. `redeemed_by_tenant` records who claimed it; `expires_at` is
 * optional. Codes are minted by the admin and claimed via the engine
 * `redeemCode` (which reuses the `topUp` ledger path).
 */
export const redemptionCode = pgTable(
  'redemption_code',
  {
    // NOTE: redemption_code.code stays `text` (immutable claim key) — intentional.
    code: text('code').primaryKey(),
    creditAmount: bigint('credit_amount', { mode: 'bigint' }).notNull(),
    // status allowed values: unused (insert default) | redeemed (claimRedemptionCode).
    // `expired` is a computed claim outcome, never a persisted status.
    status: text('status').notNull().default('unused'),
    redeemedByTenant: uuid('redeemed_by_tenant').references(() => tenant.id),
    // The subject (end-user) that redeemed this code (unified tenancy G-E); null → tenant-level.
    subjectId: uuid('subject_id').references(() => subject.id, { onDelete: 'set null' }),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('redemption_code_redeemed_by_tenant_idx').on(t.redeemedByTenant),
    index('redemption_code_subject_idx').on(t.subjectId),
    check('redemption_code_status_allowed', sql`${t.status} IN ('unused', 'redeemed')`),
  ],
);
