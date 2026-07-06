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

import { subject, tenant } from './identity.js';

/**
 * A redemption code / 卡密 (§C.3). `code` is the PK (the claim key). `credit_amount`
 * is the µcredit grant PER redemption (operator enters human credits at the admin
 * boundary → µcredits).
 *
 * MULTI-USE (mig 0067): a code may be redeemed up to `max_uses` times (default 1 =
 * the original single-use 卡密). `redeemed_count` counts successful claims;
 * `status` is `unused` while `redeemed_count < max_uses` and flips to `redeemed`
 * once exhausted. Each claim is recorded in {@link redemptionClaim} — one row per
 * (code, tenant) — which BOTH audits every grant AND enforces "one redemption per
 * tenant per code" (a tenant cannot consume a multi-use code more than once).
 * `redeemed_by_tenant`/`redeemed_at`/`subject_id` here record the MOST RECENT
 * claim (the per-claim history lives in `redemption_claim`); `expires_at` is
 * optional. Codes are minted by the admin and claimed via the engine `redeemCode`
 * (which reuses the `topUp` ledger path).
 */
export const redemptionCode = pgTable(
  'redemption_code',
  {
    // NOTE: redemption_code.code stays `text` (immutable claim key) — intentional.
    code: text('code').primaryKey(),
    creditAmount: bigint('credit_amount', { mode: 'bigint' }).notNull(),
    // How many times this code may be redeemed (1 = original single-use behavior).
    maxUses: integer('max_uses').notNull().default(1),
    // Successful claims so far (0..max_uses). Incremented atomically per claim.
    redeemedCount: integer('redeemed_count').notNull().default(0),
    // status allowed values: unused (claimable) | redeemed (exhausted: count>=max_uses).
    // `expired` is a computed claim outcome, never a persisted status.
    status: text('status').notNull().default('unused'),
    redeemedByTenant: uuid('redeemed_by_tenant').references(() => tenant.id),
    // The subject (end-user) of the MOST RECENT claim (unified tenancy G-E); null → tenant-level.
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
    check('redemption_code_max_uses_ge1', sql`${t.maxUses} >= 1`),
    check(
      'redemption_code_redeemed_count_valid',
      sql`${t.redeemedCount} >= 0 AND ${t.redeemedCount} <= ${t.maxUses}`,
    ),
  ],
);

/**
 * One successful redemption of a {@link redemptionCode} by a tenant (mig 0067).
 * The `unique(code, tenant_id)` is the DB backstop that stops a single tenant from
 * consuming more than one use of a multi-use code; the row also captures the
 * per-claim audit (which subject, how much, when) that the single summary columns
 * on `redemption_code` cannot hold once a code is redeemed by many tenants.
 */
export const redemptionClaim = pgTable(
  'redemption_claim',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code')
      .notNull()
      .references(() => redemptionCode.code),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    // The end-user that redeemed on this tenant's behalf; null → tenant-level.
    subjectId: uuid('subject_id').references(() => subject.id, { onDelete: 'set null' }),
    // The µcredit grant applied by this claim (snapshot of the code's amount).
    creditAmount: bigint('credit_amount', { mode: 'bigint' }).notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('redemption_claim_code_tenant_unique').on(t.code, t.tenantId),
    index('redemption_claim_code_idx').on(t.code),
    index('redemption_claim_tenant_idx').on(t.tenantId),
    index('redemption_claim_subject_idx').on(t.subjectId),
  ],
);
