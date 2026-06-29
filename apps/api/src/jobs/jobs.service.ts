import {
  type Database,
  failJob,
  getJob,
  getJobForTenant,
  type Job,
  listJobs,
  type PageParams,
} from '@actionow/db';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantContext } from '../auth/auth.service.js';
import { engineNotFound } from '../common/errors.js';
import { mapPageEnvelope, type PageEnvelope } from '../common/pagination.js';
import { DB } from '../common/tokens.js';

/** The JSON view of a job (bigint money fields serialized as decimal strings). */
export interface JobView {
  job_id: string;
  status: string;
  resource_id: string;
  exec_mode: string;
  inputs: unknown;
  output: unknown;
  usage: unknown;
  cost: { credits: string } | null;
  error: unknown;
  created_at: string;
  updated_at: string;
}

/** Read/cancel a tenant's jobs. Tenant scoping is enforced on every read. */
@Injectable()
export class JobsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async get(jobId: string, ctx: TenantContext): Promise<JobView> {
    const job = await this.requireOwnedJob(jobId, ctx);
    return toJobView(job);
  }

  /**
   * Like {@link get} but returns `undefined` (instead of throwing 404) when the
   * job is absent or not the caller's. Used by the SSE stream service for the
   * snapshot + DB-poll backstop reads, where a missing/foreign job is handled
   * inline rather than as an exception (the connect-time auth check still goes
   * through `get`, which throws before any byte is written).
   */
  async getOrNull(jobId: string, ctx: TenantContext): Promise<JobView | undefined> {
    const job = await getJobForTenant(this.db, jobId, ctx.tenantId, ctx.subjectId ?? null);
    return job === undefined ? undefined : toJobView(job);
  }

  async list(ctx: TenantContext, page: PageParams): Promise<PageEnvelope<JobView>> {
    const result = await listJobs(this.db, ctx.tenantId, page, ctx.subjectId ?? null);
    return mapPageEnvelope(result, (r) => r.id, toJobView);
  }

  /**
   * Cancel a queued job: `failJob` transitions `queued|running → canceled` and
   * releases the hold in one atomic transaction. Idempotent — a job that has
   * already left those states (succeeded/failed/canceled) yields the current
   * view unchanged (no error), since the transition guard simply no-ops.
   */
  async cancel(jobId: string, ctx: TenantContext): Promise<JobView> {
    const job = await this.requireOwnedJob(jobId, ctx);
    await failJob(this.db, {
      jobId: job.id,
      accountId: ctx.accountId,
      tenantId: ctx.tenantId,
      holdAmount: job.quotedCredits ?? 0n,
      to: 'canceled',
      error: { code: 'job_failed', message: 'canceled by client', retryable: false },
    });
    const refreshed = await getJob(this.db, jobId);
    return toJobView(refreshed ?? job);
  }

  private async requireOwnedJob(jobId: string, ctx: TenantContext): Promise<Job> {
    // §4b read isolation: a subject-scoped caller can only reach its own jobs
    // (plus tenant-shared NULL-subject jobs); another subject's job 404s.
    const job = await getJobForTenant(this.db, jobId, ctx.tenantId, ctx.subjectId ?? null);
    if (job === undefined) {
      throw engineNotFound(`job ${jobId} not found`);
    }
    return job;
  }
}

/** Map a `job` row to its JSON view (money as decimal strings, never floats). */
function toJobView(job: Job): JobView {
  return {
    job_id: job.id,
    status: job.status,
    resource_id: job.resourceId,
    exec_mode: job.execMode,
    inputs: job.inputs,
    output: job.output,
    usage: job.usage,
    cost: job.costCredits === null ? null : { credits: job.costCredits.toString() },
    error: job.error,
    created_at: job.createdAt.toISOString(),
    updated_at: job.updatedAt.toISOString(),
  };
}
