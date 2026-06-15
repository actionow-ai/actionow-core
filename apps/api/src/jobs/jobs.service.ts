import { type Database, failJob, getJob, type Job, listJobs } from '@actionow/db';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantContext } from '../auth/auth.service.js';
import { engineNotFound } from '../common/errors.js';
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

/** A cursor-paginated page of jobs. */
export interface JobsPage {
  jobs: JobView[];
  /** `created_at` ISO of the last row, to pass back as `cursor`; null at end. */
  next_cursor: string | null;
}

const MAX_LIMIT = 100;

/** Read/cancel a tenant's jobs. Tenant scoping is enforced on every read. */
@Injectable()
export class JobsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async get(jobId: string, ctx: TenantContext): Promise<JobView> {
    const job = await this.requireOwnedJob(jobId, ctx);
    return toJobView(job);
  }

  async list(ctx: TenantContext, cursor: string | undefined, limit: number): Promise<JobsPage> {
    const capped = Math.min(Math.max(1, limit), MAX_LIMIT);
    const rows = await listJobs(this.db, ctx.tenantId, cursor, capped);
    const last = rows.at(-1);
    return {
      jobs: rows.map(toJobView),
      next_cursor:
        rows.length === capped && last !== undefined ? last.createdAt.toISOString() : null,
    };
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
      holdAmount: job.quotedCredits ?? 0n,
      to: 'canceled',
      error: { code: 'job_failed', message: 'canceled by client', retryable: false },
    });
    const refreshed = await getJob(this.db, jobId);
    return toJobView(refreshed ?? job);
  }

  private async requireOwnedJob(jobId: string, ctx: TenantContext): Promise<Job> {
    const job = await getJob(this.db, jobId);
    if (job?.tenantId !== ctx.tenantId) {
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
