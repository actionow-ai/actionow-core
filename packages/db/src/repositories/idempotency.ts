import { and, eq } from 'drizzle-orm';

import { idempotencyKey } from '../schema/index.js';
import type { DbOrTx } from './types.js';

export interface ClaimResult {
  claimed: boolean;
  existingJobId?: string;
}

/**
 * Atomically claim `(tenantId, key)` for `jobId`.
 *
 * `INSERT … ON CONFLICT (tenant_id, key) DO NOTHING RETURNING job_id` — if a
 * row was inserted, this caller owns the key (`{claimed:true}`). Otherwise the
 * key was already claimed; we `SELECT` the original `job_id` and return
 * `{claimed:false, existingJobId}` so the caller can replay the existing job.
 */
export async function claimIdempotency(
  db: DbOrTx,
  tenantId: string,
  key: string,
  jobId: string,
): Promise<ClaimResult> {
  const inserted = await db
    .insert(idempotencyKey)
    .values({ tenantId, key, jobId })
    .onConflictDoNothing({ target: [idempotencyKey.tenantId, idempotencyKey.key] })
    .returning({ jobId: idempotencyKey.jobId });

  if (inserted.length === 1) return { claimed: true };

  const existing = await db
    .select({ jobId: idempotencyKey.jobId })
    .from(idempotencyKey)
    .where(and(eq(idempotencyKey.tenantId, tenantId), eq(idempotencyKey.key, key)))
    .limit(1);

  const row = existing[0];
  if (!row) {
    // The conflicting row vanished between INSERT and SELECT (e.g. a concurrent
    // delete). Surface it rather than silently returning a bad result.
    throw new Error(`claimIdempotency: conflict on (${tenantId}, ${key}) but no existing row`);
  }
  return { claimed: false, existingJobId: row.jobId };
}
