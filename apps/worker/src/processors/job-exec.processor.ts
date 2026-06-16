import { JobRunner, type PersistMediaFn, persistMediaOutput } from '@actionow/engine';

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
  const persistMedia = buildPersistMedia(runtime);
  const runner = new JobRunner({
    db: runtime.db,
    adapters: runtime.adapters,
    loadContext: (job) => loadJobContext(runtime.db, job),
    resolveSecret: runtime.resolveSecret,
    http: runtime.http,
    proxyUrlEnv: runtime.env.UPSTREAM_PROXY_URL,
    ...(persistMedia !== undefined ? { persistMedia } : {}),
  });

  return (data: JobExecData): Promise<void> => runner.process(data.jobId);
}

/**
 * Build the best-effort media-persistence closure when both a storage provider
 * and a public base URL are configured; otherwise `undefined` (the settle path
 * keeps the temp upstream URL). The byte transfer runs over the runtime's
 * {@link WorkerRuntime.fetchBytes}/{@link WorkerRuntime.putBytes} (timeout-bounded
 * in prod; injectable in tests). `persistMediaOutput` swallows its own errors, so
 * a failed copy never fails the job (Task 8).
 */
function buildPersistMedia(runtime: WorkerRuntime): PersistMediaFn | undefined {
  const { storage, publicBaseUrl, fetchBytes, putBytes } = runtime;
  if (storage === null || publicBaseUrl === undefined) return undefined;
  return ({ tenantId, jobId, output }) =>
    persistMediaOutput({ storage, publicBaseUrl, tenantId, jobId, output, fetchBytes, putBytes });
}
