import { and, eq, sql } from 'drizzle-orm';

import { account, ledgerTxn, subAccount } from '../schema/index.js';
import { getJob } from './job.js';
import { appendLedger } from './ledger.js';
import { getSubAccount } from './sub-account.js';
import type { DbOrTx } from './types.js';

export interface RefundJobInput {
  jobId: string;
  /** µcredits to refund; omitted → the full remaining refundable (settled − already refunded). */
  amount?: bigint;
}

export type RefundStatus = 'ok' | 'nothing_refundable' | 'not_settled' | 'job_not_found';

export interface RefundJobResult {
  status: RefundStatus;
  /** µcredits actually refunded (0 unless `status === 'ok'`). */
  refunded: bigint;
  /** Post-refund balance of the wallet that moved, or null when nothing moved. */
  balanceAfter: bigint | null;
}

/**
 * Refund a settled job's charge, crediting the SAME wallet the settle debited
 * (the subject sub-wallet in HARD mode, else the tenant pool) and writing a
 * positive `refund` ledger row.
 *
 * **Idempotent + race-safe.** One transaction that locks the target wallet row
 * `FOR UPDATE` BEFORE reading the already-refunded total, then caps the refund at
 * `settled − already_refunded`. So a repeated full refund — or two concurrent
 * refund calls for the same job — can never over-refund (the second sees the
 * first's row and finds nothing refundable). `amount` omitted → the full
 * remaining refundable; a too-large `amount` is capped to it.
 */
export async function refundJob(db: DbOrTx, p: RefundJobInput): Promise<RefundJobResult> {
  return db.transaction(async (tx) => {
    const job = await getJob(tx, p.jobId);
    if (job === undefined) return { status: 'job_not_found', refunded: 0n, balanceAfter: null };

    const settled = job.costCredits ?? 0n;
    if (job.accountId === null || job.status !== 'succeeded' || settled <= 0n) {
      return { status: 'not_settled', refunded: 0n, balanceAfter: null };
    }
    const sub =
      job.subjectId != null ? await getSubAccount(tx, job.tenantId, job.subjectId) : undefined;

    // Lock the target wallet row → serialize concurrent refunds for this job.
    if (sub !== undefined) {
      await tx
        .select({ id: subAccount.id })
        .from(subAccount)
        .where(eq(subAccount.id, sub.id))
        .for('update');
    } else {
      await tx
        .select({ id: account.id })
        .from(account)
        .where(eq(account.id, job.accountId))
        .for('update');
    }

    const [agg] = await tx
      .select({ s: sql<string>`coalesce(sum(${ledgerTxn.creditsDelta}), 0)` })
      .from(ledgerTxn)
      .where(and(eq(ledgerTxn.jobId, p.jobId), eq(ledgerTxn.type, 'refund')));
    const already = BigInt(agg?.s ?? '0');
    const refundable = settled - already;
    if (refundable <= 0n) return { status: 'nothing_refundable', refunded: 0n, balanceAfter: null };

    const amount = p.amount !== undefined && p.amount < refundable ? p.amount : refundable;
    if (amount <= 0n) return { status: 'nothing_refundable', refunded: 0n, balanceAfter: null };

    let balanceAfter: bigint;
    if (sub !== undefined) {
      const rows = await tx
        .update(subAccount)
        .set({ creditBalance: sql`${subAccount.creditBalance} + ${amount}`, updatedAt: new Date() })
        .where(eq(subAccount.id, sub.id))
        .returning({ balanceAfter: subAccount.creditBalance });
      balanceAfter = rows[0]?.balanceAfter ?? 0n;
    } else {
      const rows = await tx
        .update(account)
        .set({ creditBalance: sql`${account.creditBalance} + ${amount}` })
        .where(and(eq(account.id, job.accountId), eq(account.tenantId, job.tenantId)))
        .returning({ balanceAfter: account.creditBalance });
      const row = rows[0];
      if (!row) throw new Error(`refundJob: account ${job.accountId} not found`);
      balanceAfter = row.balanceAfter;
    }

    await appendLedger(tx, {
      tenantId: job.tenantId,
      accountId: job.accountId,
      subjectId: job.subjectId ?? null,
      type: 'refund',
      creditsDelta: amount,
      balanceAfter,
      jobId: p.jobId,
      resourceId: job.resourceId,
    });
    return { status: 'ok', refunded: amount, balanceAfter };
  });
}
