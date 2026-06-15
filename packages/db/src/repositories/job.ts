import type { JobStatus } from '@actionow/contracts';
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';

import { job } from '../schema/index.js';
import type { DbOrTx } from './types.js';

export type Job = InferSelectModel<typeof job>;

/**
 * Fields a caller supplies to `createJob`. `id`, `status`, `createdAt`,
 * `updatedAt` are DB-managed (status defaults to `queued` here), so they are
 * omitted; everything else is the frozen version/hold snapshot the caller
 * passes at creation time.
 */
export type CreateJobInput = Omit<
  InferInsertModel<typeof job>,
  'id' | 'status' | 'createdAt' | 'updatedAt'
>;

/** Insert a `job` row in status `queued` with the supplied frozen snapshot. */
export async function createJob(db: DbOrTx, input: CreateJobInput): Promise<Job> {
  const rows = await db
    .insert(job)
    .values({ ...input, status: 'queued' })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createJob: insert returned no row');
  return row;
}

/**
 * Guarded status transition. `UPDATE job SET status=to, updated_at=now()
 * WHERE id=jobId AND status IN from RETURNING id` → `true` iff exactly one row
 * moved. This is the primary dedup guard for settle/fail (review #11): a
 * second attempt finds the job already terminal and matches no row.
 *
 * `extra` lets the caller set `output`/`usage`/`costCredits`/`error` in the
 * same atomic UPDATE that performs the transition.
 */
export async function transitionJob(
  db: DbOrTx,
  jobId: string,
  from: readonly JobStatus[],
  to: JobStatus,
  extra: Partial<Pick<Job, 'output' | 'usage' | 'costCredits' | 'error'>> = {},
): Promise<boolean> {
  const rows = await db
    .update(job)
    .set({ ...extra, status: to, updatedAt: sql`now()` })
    .where(and(eq(job.id, jobId), inArray(job.status, from as string[])))
    .returning({ id: job.id });
  return rows.length === 1;
}

/** Fetch a single job by id, or `undefined`. */
export async function getJob(db: DbOrTx, jobId: string): Promise<Job | undefined> {
  const rows = await db.select().from(job).where(eq(job.id, jobId)).limit(1);
  return rows[0];
}

/**
 * List a tenant's jobs newest-first. `cursor` is an exclusive upper bound on
 * `created_at` (ISO string) for keyset pagination; `limit` caps the page size.
 */
export async function listJobs(
  db: DbOrTx,
  tenantId: string,
  cursor?: string,
  limit = 50,
): Promise<Job[]> {
  const where =
    cursor === undefined
      ? eq(job.tenantId, tenantId)
      : and(eq(job.tenantId, tenantId), lt(job.createdAt, new Date(cursor)));
  return db.select().from(job).where(where).orderBy(desc(job.createdAt)).limit(limit);
}
