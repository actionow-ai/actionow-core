import { JobRunner } from '@actionow/engine';

import { loadJobContext } from '../loaders.js';
import type { WorkerRuntime } from '../runtime.js';

/** The `job-exec` BullMQ job payload (mirrors the api's `BullmqJobQueue`). */
export interface JobExecData {
  jobId: string;
}

/**
 * Build the `job-exec` processor: drive an async job to a terminal state via
 * the engine's {@link JobRunner} (queued→running→poll→settle/fail). Pure over
 * the injected {@link WorkerRuntime}, so a unit test calls the returned
 * function directly with a fake runtime and asserts the job settled.
 */
export function createJobExecProcessor(
  runtime: WorkerRuntime,
): (data: JobExecData) => Promise<void> {
  const runner = new JobRunner({
    db: runtime.db,
    adapters: runtime.adapters,
    loadContext: (job) => loadJobContext(runtime.db, job),
    resolveSecret: runtime.resolveSecret,
    http: runtime.http,
    proxyUrlEnv: runtime.env.UPSTREAM_PROXY_URL,
  });

  return (data: JobExecData): Promise<void> => runner.process(data.jobId);
}
