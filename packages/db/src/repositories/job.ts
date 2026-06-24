import type { JobStatus } from '@actionow/contracts';
import type { InferInsertModel, InferSelectModel, SQL } from 'drizzle-orm';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { job } from '../schema/index.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
import type { DbOrTx } from './types.js';

/**
 * Read-path subject isolation (unified tenancy §4b): when a subject is in scope
 * (a subject-scoped api-key), restrict reads to that subject's own rows PLUS
 * tenant-shared rows (`subject_id IS NULL`, created by tenant-level keys). A
 * `null` subject (tenant-level caller) imposes no extra filter — the operator/
 * tenant key sees every row. Cross-subject rows are excluded → a GET on one 404s.
 */
function jobSubjectScope(subjectId: string | null): SQL | undefined {
  return subjectId === null ? undefined : or(eq(job.subjectId, subjectId), isNull(job.subjectId));
}

export type Job = InferSelectModel<typeof job>;

/**
 * Fields a caller supplies to `createJob`. `status`, `createdAt`, `updatedAt`
 * are DB-managed (status defaults to `queued` here), so they are omitted;
 * everything else is the frozen version/hold snapshot the caller passes at
 * creation time. `id` is optional — when omitted the DB mints a random uuid;
 * callers that must reference the id before insert (e.g. the idempotency claim
 * row) may supply their own.
 */
export type CreateJobInput = Omit<
  InferInsertModel<typeof job>,
  'id' | 'status' | 'createdAt' | 'updatedAt'
> & { id?: string };

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
 * Fetch a job by id scoped to a tenant (and, when given, a subject — §4b read
 * isolation). A subject-scoped caller that names another subject's job gets
 * `undefined` (→ 404).
 */
export async function getJobForTenant(
  db: DbOrTx,
  jobId: string,
  tenantId: string,
  subjectId: string | null = null,
): Promise<Job | undefined> {
  const rows = await db
    .select()
    .from(job)
    .where(and(eq(job.id, jobId), eq(job.tenantId, tenantId), jobSubjectScope(subjectId)))
    .limit(1);
  return rows[0];
}

/**
 * Record the upstream provider's job handle on a job so a later async callback
 * can correlate the payload back to the job (best-effort; not on the money
 * path). Returns `true` iff a row was updated.
 */
export async function setUpstreamHandle(
  db: DbOrTx,
  jobId: string,
  upstreamJobHandle: string,
): Promise<boolean> {
  const rows = await db
    .update(job)
    .set({ upstreamJobHandle, updatedAt: sql`now()` })
    .where(eq(job.id, jobId))
    .returning({ id: job.id });
  return rows.length === 1;
}

/** Fetch the job whose `upstream_job_handle` matches, or `undefined`. */
export async function getJobByUpstreamHandle(
  db: DbOrTx,
  upstreamJobHandle: string,
): Promise<Job | undefined> {
  const rows = await db
    .select()
    .from(job)
    .where(eq(job.upstreamJobHandle, upstreamJobHandle))
    .limit(1);
  return rows[0];
}

/**
 * List a tenant's jobs newest-first, keyset-paginated on `(created_at, id)`.
 * The `tenant_id` filter composes with the keyset.
 */
export async function listJobs(
  db: DbOrTx,
  tenantId: string,
  page: PageParams,
  subjectId: string | null = null,
): Promise<KeysetResult<Job>> {
  return keysetPage<Job>(db, {
    table: job,
    createdAtCol: job.createdAt,
    idCol: job.id,
    where: and(eq(job.tenantId, tenantId), jobSubjectScope(subjectId)),
    page,
  });
}
