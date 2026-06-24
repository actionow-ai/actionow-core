import type { InferSelectModel } from 'drizzle-orm';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { account, subAccount } from '../schema/index.js';
import { appendLedger } from './ledger.js';
import type { DbOrTx } from './types.js';

/** A per-subject sub-wallet row (HARD mode). */
export type SubAccountRow = InferSelectModel<typeof subAccount>;

/** Create a sub-wallet for a subject. Throws on the per-(tenant,subject) unique clash. */
export async function createSubAccount(
  db: DbOrTx,
  input: { tenantId: string; subjectId: string; creditBalance?: bigint },
): Promise<SubAccountRow> {
  const rows = await db
    .insert(subAccount)
    .values({
      tenantId: input.tenantId,
      subjectId: input.subjectId,
      ...(input.creditBalance !== undefined ? { creditBalance: input.creditBalance } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createSubAccount: insert returned no row');
  return row;
}

/** The live sub-wallet for `(tenant, subject)`, or `undefined` (→ SHARED mode). */
export async function getSubAccount(
  db: DbOrTx,
  tenantId: string,
  subjectId: string,
): Promise<SubAccountRow | undefined> {
  const rows = await db
    .select()
    .from(subAccount)
    .where(
      and(
        eq(subAccount.tenantId, tenantId),
        eq(subAccount.subjectId, subjectId),
        isNull(subAccount.deletedAt),
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * Atomically place a hold on an ACTIVE sub-wallet — the same single conditional
 * `UPDATE … WHERE credit_balance - credit_held >= amount AND status='active'`
 * as the tenant pool, so concurrent holds cannot oversell. `true` iff held.
 */
export async function holdSubAccount(
  db: DbOrTx,
  subAccountId: string,
  amount: bigint,
): Promise<boolean> {
  const rows = await db
    .update(subAccount)
    .set({ creditHeld: sql`${subAccount.creditHeld} + ${amount}`, updatedAt: new Date() })
    .where(
      and(
        eq(subAccount.id, subAccountId),
        eq(subAccount.status, 'active'),
        sql`${subAccount.creditBalance} - ${subAccount.creditHeld} >= ${amount}`,
      ),
    )
    .returning({ id: subAccount.id });
  return rows.length === 1;
}

/** Release a previously-placed hold on a sub-wallet (credit_held -= amount). */
export async function releaseSubAccountHold(
  db: DbOrTx,
  subAccountId: string,
  amount: bigint,
): Promise<void> {
  await db
    .update(subAccount)
    .set({ creditHeld: sql`${subAccount.creditHeld} - ${amount}`, updatedAt: new Date() })
    .where(eq(subAccount.id, subAccountId));
}

/**
 * Settle on a sub-wallet: release the hold AND debit the final cost in one
 * UPDATE (status-guarded), returning the post-update balance. Settle only
 * converts an already-held amount, so it cannot oversell. Throws when no active
 * row matched (the whole settle tx rolls back).
 */
export async function settleSubAccount(
  db: DbOrTx,
  subAccountId: string,
  holdAmount: bigint,
  finalCost: bigint,
): Promise<bigint> {
  const rows = await db
    .update(subAccount)
    .set({
      creditHeld: sql`${subAccount.creditHeld} - ${holdAmount}`,
      creditBalance: sql`${subAccount.creditBalance} - ${finalCost}`,
      updatedAt: new Date(),
    })
    .where(and(eq(subAccount.id, subAccountId), eq(subAccount.status, 'active')))
    .returning({ balanceAfter: subAccount.creditBalance });
  const row = rows[0];
  if (!row) throw new Error(`settleSubAccount: sub_account ${subAccountId} not found or disabled`);
  return row.balanceAfter;
}

/** Resolve a tenant's account id (for subject-attributed ledger rows). */
async function tenantAccountId(db: DbOrTx, tenantId: string): Promise<string> {
  const rows = await db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.tenantId, tenantId), isNull(account.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`no account for tenant ${tenantId}`);
  return row.id;
}

/**
 * Credit a sub-wallet + write a subject-attributed `topup` ledger row in one tx.
 * `balance_after` is the SUB-WALLET's post balance (the wallet that moved); the
 * ledger's `account_id` is the tenant account (the FK target). Returns the new
 * sub-wallet balance.
 */
export async function topupSubAccount(
  db: DbOrTx,
  tenantId: string,
  subjectId: string,
  amount: bigint,
): Promise<bigint> {
  const run = async (tx: DbOrTx): Promise<bigint> => {
    const sub = await getSubAccount(tx, tenantId, subjectId);
    if (sub === undefined)
      throw new Error(`topupSubAccount: no sub_account for subject ${subjectId}`);
    const accountId = await tenantAccountId(tx, tenantId);
    const rows = await tx
      .update(subAccount)
      .set({ creditBalance: sql`${subAccount.creditBalance} + ${amount}`, updatedAt: new Date() })
      .where(eq(subAccount.id, sub.id))
      .returning({ balanceAfter: subAccount.creditBalance });
    const balanceAfter = rows[0]?.balanceAfter ?? 0n;
    await appendLedger(tx, {
      tenantId,
      accountId,
      subjectId,
      type: 'topup',
      creditsDelta: amount,
      balanceAfter,
      jobId: null,
    });
    return balanceAfter;
  };
  return 'transaction' in db ? db.transaction((tx) => run(tx)) : run(db);
}

/** Direction of a {@link transferCredits} move. */
export type TransferDirection = 'to_subject' | 'to_tenant';

/**
 * Move credits between the tenant pool and a subject's sub-wallet (same tenant
 * only; immutable — a mistake is corrected by an opposite transfer). One tx:
 * atomic conditional debit of the source (no-oversell) + credit of the
 * destination + TWO ledger rows (`transfer_out`/`transfer_in`). Throws on
 * insufficient source balance (rolls back).
 */
export async function transferCredits(
  db: DbOrTx,
  input: { tenantId: string; subjectId: string; amount: bigint; direction: TransferDirection },
): Promise<void> {
  const { tenantId, subjectId, amount, direction } = input;
  const run = async (tx: DbOrTx): Promise<void> => {
    const sub = await getSubAccount(tx, tenantId, subjectId);
    if (sub === undefined)
      throw new Error(`transferCredits: no sub_account for subject ${subjectId}`);
    const accountId = await tenantAccountId(tx, tenantId);

    if (direction === 'to_subject') {
      const debited = await tx
        .update(account)
        .set({ creditBalance: sql`${account.creditBalance} - ${amount}` })
        .where(
          and(
            eq(account.id, accountId),
            sql`${account.creditBalance} - ${account.creditHeld} >= ${amount}`,
          ),
        )
        .returning({ balanceAfter: account.creditBalance });
      if (debited[0] === undefined) throw new Error('transferCredits: insufficient tenant balance');
      const credited = await tx
        .update(subAccount)
        .set({ creditBalance: sql`${subAccount.creditBalance} + ${amount}`, updatedAt: new Date() })
        .where(eq(subAccount.id, sub.id))
        .returning({ balanceAfter: subAccount.creditBalance });
      await appendLedger(tx, {
        tenantId,
        accountId,
        subjectId: null,
        type: 'transfer_out',
        creditsDelta: -amount,
        balanceAfter: debited[0].balanceAfter,
        jobId: null,
      });
      await appendLedger(tx, {
        tenantId,
        accountId,
        subjectId,
        type: 'transfer_in',
        creditsDelta: amount,
        balanceAfter: credited[0]?.balanceAfter ?? 0n,
        jobId: null,
      });
    } else {
      const debited = await tx
        .update(subAccount)
        .set({ creditBalance: sql`${subAccount.creditBalance} - ${amount}`, updatedAt: new Date() })
        .where(
          and(
            eq(subAccount.id, sub.id),
            sql`${subAccount.creditBalance} - ${subAccount.creditHeld} >= ${amount}`,
          ),
        )
        .returning({ balanceAfter: subAccount.creditBalance });
      if (debited[0] === undefined)
        throw new Error('transferCredits: insufficient sub-wallet balance');
      const credited = await tx
        .update(account)
        .set({ creditBalance: sql`${account.creditBalance} + ${amount}` })
        .where(eq(account.id, accountId))
        .returning({ balanceAfter: account.creditBalance });
      await appendLedger(tx, {
        tenantId,
        accountId,
        subjectId,
        type: 'transfer_out',
        creditsDelta: -amount,
        balanceAfter: debited[0].balanceAfter,
        jobId: null,
      });
      await appendLedger(tx, {
        tenantId,
        accountId,
        subjectId: null,
        type: 'transfer_in',
        creditsDelta: amount,
        balanceAfter: credited[0]?.balanceAfter ?? 0n,
        jobId: null,
      });
    }
  };
  return 'transaction' in db ? db.transaction((tx) => run(tx)) : run(db);
}
