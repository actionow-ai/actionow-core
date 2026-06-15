import { and, eq, sql } from 'drizzle-orm';

import { account } from '../schema/index.js';
import { appendLedger } from './ledger.js';
import type { DbOrTx } from './types.js';

/**
 * Atomically place a hold of `amount` µcredits on `accountId`.
 *
 * Single conditional `UPDATE … WHERE credit_balance - credit_held >= amount
 * RETURNING id` — there is no read-then-write window, so concurrent callers
 * cannot oversell (review #10). Returns `true` iff exactly one row matched
 * (the hold was placed); `false` when available credit was insufficient.
 */
export async function holdCredits(db: DbOrTx, accountId: string, amount: bigint): Promise<boolean> {
  const rows = await db
    .update(account)
    .set({ creditHeld: sql`${account.creditHeld} + ${amount}` })
    .where(
      and(
        eq(account.id, accountId),
        sql`${account.creditBalance} - ${account.creditHeld} >= ${amount}`,
      ),
    )
    .returning({ id: account.id });

  return rows.length === 1;
}

/**
 * Release a previously-placed hold of `amount` µcredits (credit_held -= amount).
 * Used on settle, fail/cancel, and hold expiry.
 */
export async function releaseHold(db: DbOrTx, accountId: string, amount: bigint): Promise<void> {
  await db
    .update(account)
    .set({ creditHeld: sql`${account.creditHeld} - ${amount}` })
    .where(eq(account.id, accountId));
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
      .where(eq(account.id, accountId))
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
