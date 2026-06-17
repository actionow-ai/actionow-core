import { createFileObject, markFileReady } from '@actionow/db';
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
    traceUpstream: runtime.env.RELAY_TRACE === 'full',
    traceMaxBytes: runtime.env.RELAY_TRACE_MAX_BYTES,
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
 *
 * After the copy, a `ready` `file_object` row is recorded per persisted object so
 * the tenant's media catalog tracks it (Task 11). The row creation is best-effort:
 * the output URL is already rewritten, so a catalog-row miss never fails the job.
 */
function buildPersistMedia(runtime: WorkerRuntime): PersistMediaFn | undefined {
  const { storage, publicBaseUrl, fetchBytes, putBytes } = runtime;
  if (storage === null || publicBaseUrl === undefined) return undefined;
  return async ({ tenantId, jobId, output }) => {
    const result = await persistMediaOutput({
      storage,
      publicBaseUrl,
      tenantId,
      jobId,
      output,
      fetchBytes,
      putBytes,
    });
    for (const obj of result.objects) {
      try {
        const file = await createFileObject(runtime.db, {
          tenantId,
          provider: storage.kind,
          bucket: runtime.env.STORAGE_BUCKET ?? '',
          key: obj.key,
        });
        await markFileReady(runtime.db, file.id, {
          ...(obj.size !== undefined ? { size: obj.size } : {}),
          ...(obj.contentType !== undefined ? { contentType: obj.contentType } : {}),
        });
      } catch {
        // best-effort: the output URL is already rewritten; a catalog row miss is non-fatal.
      }
    }
    return result;
  };
}
