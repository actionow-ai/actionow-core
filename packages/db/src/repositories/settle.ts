import type { JobStatus, UnifiedError, UsageVector } from '@actionow/contracts';
import { and, eq, sql } from 'drizzle-orm';

import { account, webhookOutbox } from '../schema/index.js';
import { transitionJob } from './job.js';
import { appendLedger } from './ledger.js';
import { getSubAccount, releaseSubAccountHold, settleSubAccount } from './sub-account.js';
import type { DbOrTx } from './types.js';

/** A webhook to enqueue transactionally alongside the settle (review #11). */
export interface OutboxInput {
  url: string;
  payload: unknown;
}

export interface SettleJobInput {
  jobId: string;
  accountId: string;
  tenantId: string;
  /** The subject (end-user) this settle is attributed to (unified tenancy G-B); null → tenant-level. */
  subjectId?: string | null;
  /** Amount currently held for this job; released as part of settle. */
  holdAmount: bigint;
  /** Final charged cost (already rounded to the integer µcredit). */
  finalCost: bigint;
  usage: unknown;
  output: unknown;
  /** Optional version-snapshot columns for the settle ledger row. */
  pricebookVersion?: number | null;
  modifiersApplied?: unknown;
  resourceId?: string | null;
  /** When present, a `webhook_outbox` row is written in the same transaction. */
  outbox?: OutboxInput;
}

/**
 * The single, idempotent settle (review #11). One transaction:
 *
 * 1. Guarded transition `queued|running → succeeded` (sets output/usage/cost).
 *    If no row moved (already terminal) → return `{settled:false}` — no
 *    double-charge, no second ledger row.
 * 2. Release the hold and debit the final cost in one UPDATE, reading the
 *    post-update balance via RETURNING.
 * 3. Insert the `settle` ledger row with `balanceAfter`.
 * 4. Optionally insert a `webhook_outbox` row (transactional outbox).
 *
 * The partial-unique `ledger_settle_per_job` index is the DB backstop; the
 * transition guard is the primary dedup.
 */
export async function settleJob(db: DbOrTx, p: SettleJobInput): Promise<{ settled: boolean }> {
  return db.transaction(async (tx) => {
    const moved = await transitionJob(tx, p.jobId, ['queued', 'running'], 'succeeded', {
      // output/usage are validated upstream; the job columns carry precise jsonb types.
      output: p.output as Record<string, unknown>,
      usage: p.usage as UsageVector,
      costCredits: p.finalCost,
    });
    if (!moved) return { settled: false };

    // Wallet branch (unified tenancy G-E): a subject with an active sub-wallet
    // settles against it (HARD); otherwise the tenant pool (SHARED / tenant-
    // level). `balanceAfter` is the post-balance of whichever wallet moved.
    const sub = p.subjectId != null ? await getSubAccount(tx, p.tenantId, p.subjectId) : undefined;
    let balanceAfter: bigint;
    if (sub !== undefined) {
      balanceAfter = await settleSubAccount(tx, sub.id, p.holdAmount, p.finalCost);
    } else {
      const rows = await tx
        .update(account)
        .set({
          creditHeld: sql`${account.creditHeld} - ${p.holdAmount}`,
          creditBalance: sql`${account.creditBalance} - ${p.finalCost}`,
        })
        // Scope the debit to (account, tenant) — defense-in-depth (P2-8). A
        // mismatch matches 0 rows → throws below → the whole settle rolls back.
        .where(and(eq(account.id, p.accountId), eq(account.tenantId, p.tenantId)))
        .returning({ balanceAfter: account.creditBalance });
      const row = rows[0];
      if (!row) throw new Error(`settleJob: account ${p.accountId} not found`);
      balanceAfter = row.balanceAfter;
    }

    await appendLedger(tx, {
      tenantId: p.tenantId,
      accountId: p.accountId,
      subjectId: p.subjectId ?? null,
      type: 'settle',
      creditsDelta: -p.finalCost,
      balanceAfter,
      jobId: p.jobId,
      resourceId: p.resourceId ?? null,
      pricebookVersion: p.pricebookVersion ?? null,
      modifiersApplied: p.modifiersApplied ?? null,
      usageVector: p.usage,
    });

    if (p.outbox) {
      await tx.insert(webhookOutbox).values({
        jobId: p.jobId,
        url: p.outbox.url,
        payload: p.outbox.payload,
      });
    }

    return { settled: true };
  });
}

export interface FailJobInput {
  jobId: string;
  accountId: string;
  tenantId: string;
  /** The subject the hold was placed for (unified tenancy G-E); null → tenant pool. */
  subjectId?: string | null;
  /** Amount to release (the hold), without charging the balance. */
  holdAmount: bigint;
  to: Extract<JobStatus, 'failed' | 'canceled'>;
  error?: unknown;
  outbox?: OutboxInput;
}

/**
 * Fail or cancel a job: guarded transition `queued|running → failed|canceled`,
 * then release the hold (default policy: no charge, no refund ledger row). If
 * the job is already terminal → `{settled:false}` (idempotent, e.g. a late
 * upstream callback racing the reaper).
 */
export async function failJob(db: DbOrTx, p: FailJobInput): Promise<{ settled: boolean }> {
  return db.transaction(async (tx) => {
    const moved = await transitionJob(tx, p.jobId, ['queued', 'running'], p.to, {
      error: (p.error ?? null) as UnifiedError | null,
    });
    if (!moved) return { settled: false };

    // Release the hold from whichever wallet it was placed on (unified tenancy
    // G-E): the subject's active sub-wallet (HARD) or the tenant pool (SHARED /
    // tenant-level).
    const sub = p.subjectId != null ? await getSubAccount(tx, p.tenantId, p.subjectId) : undefined;
    if (sub !== undefined) {
      await releaseSubAccountHold(tx, sub.id, p.holdAmount);
    } else {
      const rows = await tx
        .update(account)
        .set({ creditHeld: sql`${account.creditHeld} - ${p.holdAmount}` })
        // Scope the hold-release to (account, tenant) — defense-in-depth (P2-8),
        // mirroring settleJob. A mismatch matches 0 rows → throw → the whole
        // failJob (incl. the status transition) rolls back.
        .where(and(eq(account.id, p.accountId), eq(account.tenantId, p.tenantId)))
        .returning({ id: account.id });
      if (!rows[0]) throw new Error(`failJob: account ${p.accountId} not found`);
    }

    if (p.outbox) {
      await tx.insert(webhookOutbox).values({
        jobId: p.jobId,
        url: p.outbox.url,
        payload: p.outbox.payload,
      });
    }

    return { settled: true };
  });
}
