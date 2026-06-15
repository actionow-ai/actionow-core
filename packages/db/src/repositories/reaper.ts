import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm';

import { account, job } from '../schema/index.js';
import type { DbOrTx } from './types.js';

/** A job whose hold has expired while still in-flight, ready to be reaped. */
export interface ExpiredHold {
  jobId: string;
  tenantId: string;
  /** The account whose hold must be released (resolved via the tenant). */
  accountId: string;
  /** The held amount to release on cancel. */
  holdAmount: bigint;
  /** The job's callback url, if any (for an optional cancel webhook). */
  callbackUrl: string | null;
}

/**
 * Select jobs whose `hold_expires_at < now` and are still in-flight
 * (`queued`/`running`), joined to the tenant's account so the reaper can
 * release the hold (review #12). `limit` bounds the batch.
 */
export async function listExpiredHolds(db: DbOrTx, now: Date, limit = 100): Promise<ExpiredHold[]> {
  const rows = await db
    .select({
      jobId: job.id,
      tenantId: job.tenantId,
      accountId: account.id,
      holdAmount: job.quotedCredits,
      callbackUrl: job.callbackUrl,
    })
    .from(job)
    .innerJoin(account, eq(account.tenantId, job.tenantId))
    .where(
      and(
        isNotNull(job.holdExpiresAt),
        lt(job.holdExpiresAt, now),
        inArray(job.status, ['queued', 'running']),
      ),
    )
    .limit(limit);

  return rows.map((r) => ({
    jobId: r.jobId,
    tenantId: r.tenantId,
    accountId: r.accountId,
    holdAmount: r.holdAmount ?? 0n,
    callbackUrl: r.callbackUrl,
  }));
}
