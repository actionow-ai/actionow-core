import { and, eq, isNull, sql } from 'drizzle-orm';

import { idempotencyKey } from '../schema/index.js';
import type { DbOrTx } from './types.js';

export interface ClaimResult {
  claimed: boolean;
  existingJobId?: string;
}

/**
 * Atomically claim an idempotency key for `jobId`, scoped to a subject when one
 * is given (unified tenancy G-B).
 *
 * `INSERT … ON CONFLICT (…) DO NOTHING RETURNING job_id` — if a row was inserted,
 * this caller owns the key (`{claimed:true}`). Otherwise the key was already
 * claimed; we `SELECT` the original `job_id` and return `{claimed:false,
 * existingJobId}` so the caller can replay the existing job.
 *
 * The unique constraint is split by `subject_id` (partial indexes): a NULL
 * subject claims `(tenant_id, key)` (today's exact behavior); a subject-scoped
 * claim is independent at `(tenant_id, subject_id, key)`. The `ON CONFLICT`
 * target must therefore carry the matching partial-index predicate.
 */
export async function claimIdempotency(
  db: DbOrTx,
  tenantId: string,
  key: string,
  jobId: string,
  subjectId: string | null = null,
): Promise<ClaimResult> {
  const inserted = await db
    .insert(idempotencyKey)
    .values({ tenantId, key, jobId, subjectId })
    .onConflictDoNothing(
      subjectId === null
        ? { target: [idempotencyKey.tenantId, idempotencyKey.key], where: sql`subject_id IS NULL` }
        : {
            target: [idempotencyKey.tenantId, idempotencyKey.subjectId, idempotencyKey.key],
            where: sql`subject_id IS NOT NULL`,
          },
    )
    .returning({ jobId: idempotencyKey.jobId });

  if (inserted.length === 1) return { claimed: true };

  const existing = await db
    .select({ jobId: idempotencyKey.jobId })
    .from(idempotencyKey)
    .where(
      subjectId === null
        ? and(
            eq(idempotencyKey.tenantId, tenantId),
            eq(idempotencyKey.key, key),
            isNull(idempotencyKey.subjectId),
          )
        : and(
            eq(idempotencyKey.tenantId, tenantId),
            eq(idempotencyKey.key, key),
            eq(idempotencyKey.subjectId, subjectId),
          ),
    )
    .limit(1);

  const row = existing[0];
  if (!row) {
    // The conflicting row vanished between INSERT and SELECT (e.g. a concurrent
    // delete). Surface it rather than silently returning a bad result.
    throw new Error(`claimIdempotency: conflict on (${tenantId}, ${key}) but no existing row`);
  }
  return { claimed: false, existingJobId: row.jobId };
}
