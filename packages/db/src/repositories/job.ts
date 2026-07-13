import type { InferSelectModel, SQL } from 'drizzle-orm';
import { and, eq, isNull, or } from 'drizzle-orm';

import { job } from '../schema/index.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
import type { DbOrTx } from './types.js';

/**
 * 批次6 D2 — READ-ONLY remnant of the legacy job world. The execution path
 * (createJob/transitionJob/settle/…) died with `/v1/run` + the job-runner; the
 * admin/console job LIST endpoints keep observing the historical rows until
 * the `job` table itself drops (D3/D4).
 */

/**
 * Read-path subject isolation (unified tenancy §4b): when a subject is in scope
 * (a subject-scoped api-key), restrict reads to that subject's own rows PLUS
 * tenant-shared rows (`subject_id IS NULL`, created by tenant-level keys). A
 * `null` subject (tenant-level caller) imposes no extra filter — the operator/
 * tenant key sees every row.
 */
function jobSubjectScope(subjectId: string | null): SQL | undefined {
  return subjectId === null ? undefined : or(eq(job.subjectId, subjectId), isNull(job.subjectId));
}

export type Job = InferSelectModel<typeof job>;

/** Fetch a single job by id, or `undefined` (admin refund + observation reads). */
export async function getJob(db: DbOrTx, jobId: string): Promise<Job | undefined> {
  const rows = await db.select().from(job).where(eq(job.id, jobId)).limit(1);
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
