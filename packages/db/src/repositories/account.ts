import type { InferSelectModel } from 'drizzle-orm';
import { and, eq, sql } from 'drizzle-orm';

import { account } from '../schema/index.js';
import { appendLedger } from './ledger.js';
import { getSubAccount, holdSubAccount } from './sub-account.js';
import type { DbOrTx } from './types.js';

/**
 * Atomically place a hold of `amount` µcredits on `accountId`.
 *
 * Single conditional `UPDATE … WHERE credit_balance - credit_held >= amount
 * RETURNING id` — there is no read-then-write window, so concurrent callers
 * cannot oversell (review #10). Returns `true` iff exactly one row matched
 * (the hold was placed); `false` when available credit was insufficient.
 */
export async function holdCredits(
  db: DbOrTx,
  accountId: string,
  amount: bigint,
  tenantId?: string,
  subjectId?: string | null,
): Promise<boolean> {
  // Wallet branch (unified tenancy G-E): a subject with an active sub-wallet
  // holds against it (HARD); otherwise fall through to the tenant pool (SHARED /
  // tenant-level). Same atomic no-oversell guarantee either way.
  if (subjectId != null && tenantId !== undefined) {
    const sub = await getSubAccount(db, tenantId, subjectId);
    if (sub !== undefined) return holdSubAccount(db, sub.id, amount);
  }
  // Defense-in-depth (P2-8): when the caller knows the tenant, scope the UPDATE
  // to (account, tenant) so a mismatched pair touches ZERO rows (→ false →
  // insufficient_credits) rather than mutating another tenant's account. Today
  // accountId is always auth-derived, so this never changes correct behavior.
  const conditions = [
    eq(account.id, accountId),
    sql`${account.creditBalance} - ${account.creditHeld} >= ${amount}`,
  ];
  if (tenantId !== undefined) conditions.push(eq(account.tenantId, tenantId));

  const rows = await db
    .update(account)
    .set({ creditHeld: sql`${account.creditHeld} + ${amount}` })
    .where(and(...conditions))
    .returning({ id: account.id });

  return rows.length === 1;
}

/**
 * Release a previously-placed hold of `amount` µcredits (credit_held -= amount).
 * Used on settle, fail/cancel, and hold expiry. When `tenantId` is supplied the
 * UPDATE is scoped to (account, tenant) — defense-in-depth, never changes
 * correct behavior (P2-8).
 */
export async function releaseHold(
  db: DbOrTx,
  accountId: string,
  amount: bigint,
  tenantId?: string,
): Promise<void> {
  const conditions = [eq(account.id, accountId)];
  if (tenantId !== undefined) conditions.push(eq(account.tenantId, tenantId));
  await db
    .update(account)
    .set({ creditHeld: sql`${account.creditHeld} - ${amount}` })
    .where(and(...conditions));
}

/**
 * Credit `amount` µcredits to the account balance and write the matching
 * `topup` ledger row in a single transaction. `balanceAfter` is read from the
 * `RETURNING` of the same `UPDATE`, so the ledger always reflects the
 * post-update balance. Returns the new balance.
 */
export async function topUp(
  db: DbOrTx,
  accountId: string,
  tenantId: string,
  amount: bigint,
): Promise<bigint> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(account)
      .set({ creditBalance: sql`${account.creditBalance} + ${amount}` })
      // Scope the credit to (account, tenant) — defense-in-depth (P2-8).
      .where(and(eq(account.id, accountId), eq(account.tenantId, tenantId)))
      .returning({ balanceAfter: account.creditBalance });

    const row = rows[0];
    if (!row) throw new Error(`topUp: account ${accountId} not found`);

    await appendLedger(tx, {
      tenantId,
      accountId,
      type: 'topup',
      creditsDelta: amount,
      balanceAfter: row.balanceAfter,
      jobId: null,
    });

    return row.balanceAfter;
  });
}

/**
 * Set or clear a tenant account's opt-in file lifecycle / TTL (`config.file_ttl_days`).
 *
 * - `days` a POSITIVE number → merge `{file_ttl_days: days}` into the `config`
 *   jsonb (preserving other keys via `||`).
 * - `days` `null` → remove the `file_ttl_days` key (`config - 'file_ttl_days'`)
 *   so the tenant reverts to the platform default / retain-forever.
 *
 * Returns the updated account row, or `undefined` when no account exists for
 * `accountId` (caller maps to 404). Scoped by id only — there is exactly one live
 * account per tenant. (The `account` table has no `updated_at` column — the spec's
 * "Set updated_at" applies to tables that carry one; this one doesn't.)
 */
export async function setFileTtlDays(
  db: DbOrTx,
  accountId: string,
  days: number | null,
): Promise<InferSelectModel<typeof account> | undefined> {
  const configExpr =
    days === null
      ? sql`${account.config} - 'file_ttl_days'`
      : sql`${account.config} || ${JSON.stringify({ file_ttl_days: days })}::jsonb`;
  const rows = await db
    .update(account)
    .set({ config: configExpr })
    .where(eq(account.id, accountId))
    .returning();
  return rows[0];
}
