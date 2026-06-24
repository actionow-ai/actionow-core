import { type DbOrTx, failJob, listExpiredHolds } from '@actionow/db';

export interface ReaperOptions {
  /** Jobs reaped per `reapExpiredHolds` call (default 100). */
  batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 100;

const EXPIRED_HOLD_ERROR = {
  code: 'job_failed',
  message: 'hold expired before completion',
  retryable: false,
} as const;

/**
 * Cancels orphan-hold jobs (review #12): jobs whose `hold_expires_at < now`
 * that are still `queued`/`running`. Each is `failJob(...,'canceled')`, which
 * atomically transitions the job and releases its hold. The transition guard
 * makes this idempotent against a late upstream callback racing the reaper —
 * whichever fires first wins, the other no-ops. Returns the count reaped.
 */
export class Reaper {
  private readonly batchSize: number;

  constructor(options: ReaperOptions = {}) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  async reapExpiredHolds(db: DbOrTx, now: Date): Promise<number> {
    const expired = await listExpiredHolds(db, now, this.batchSize);
    let reaped = 0;

    for (const hold of expired) {
      const { settled } = await failJob(db, {
        jobId: hold.jobId,
        accountId: hold.accountId,
        tenantId: hold.tenantId,
        subjectId: hold.subjectId,
        holdAmount: hold.holdAmount,
        to: 'canceled',
        error: EXPIRED_HOLD_ERROR,
        ...(hold.callbackUrl !== null
          ? {
              outbox: {
                url: hold.callbackUrl,
                payload: { job_id: hold.jobId, status: 'canceled', error: EXPIRED_HOLD_ERROR },
              },
            }
          : {}),
      });
      if (settled) reaped += 1;
    }

    return reaped;
  }
}
