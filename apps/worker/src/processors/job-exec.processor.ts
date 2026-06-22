import { createFileObject, insertUsageLog, markFileReady } from '@actionow/db';
import {
  type InsertMediaUsageLogFn,
  JobRunner,
  persistMediaResult,
  type PersistMediaResultFn,
} from '@actionow/engine';

import { loadJobContext } from '../loaders.js';
import type { WorkerRuntime } from '../runtime.js';

/** The `job-exec` BullMQ job payload (mirrors the api's `BullmqJobQueue`). */
export interface JobExecData {
  jobId: string;
}

/**
 * The `job-exec` processor surface: `process` drives a job to terminal state;
 * `failExhausted` terminal-fails a job whose BullMQ retries are exhausted (called
 * from the Worker's `failed` handler) so the hold is released immediately instead
 * of waiting for the reaper.
 */
export interface JobExecProcessor {
  process: (data: JobExecData) => Promise<void>;
  failExhausted: (jobId: string, message: string) => Promise<void>;
}

/**
 * Build the `job-exec` processor: drive an async job to a terminal state via
 * the engine's {@link JobRunner} (queued→running→poll→settle/fail). Pure over
 * the injected {@link WorkerRuntime}, so a unit test calls the returned
 * function directly with a fake runtime and asserts the job settled.
 */
export function createJobExecProcessor(runtime: WorkerRuntime): JobExecProcessor {
  const persistMediaResultFn = buildPersistMediaResult(runtime);
  // P1 metering: every settled media job writes a usage_log row (margin visibility).
  const insertUsageLogFn: InsertMediaUsageLogFn = async (row) => {
    await insertUsageLog(runtime.db, row);
  };
  const runner = new JobRunner({
    db: runtime.db,
    adapters: runtime.adapters,
    loadContext: (job) => loadJobContext(runtime.db, job),
    resolveSecret: runtime.resolveSecret,
    http: runtime.http,
    proxyUrlEnv: runtime.env.UPSTREAM_PROXY_URL,
    traceUpstream: runtime.env.RELAY_TRACE === 'full',
    traceMaxBytes: runtime.env.RELAY_TRACE_MAX_BYTES,
    insertUsageLog: insertUsageLogFn,
    ...(persistMediaResultFn !== undefined ? { persistMediaResult: persistMediaResultFn } : {}),
  });

  return {
    process: (data: JobExecData): Promise<void> => runner.process(data.jobId),
    failExhausted: (jobId: string, message: string): Promise<void> =>
      runner.failExhausted(jobId, message),
  };
}

/**
 * The P1 canonical-result persistence closure: copy a {@link MediaResult}'s
 * assets to durable storage (`persistMediaResult`) and record ONE `ready`
 * `file_object` per persisted object — including media metadata (width/height/
 * duration). This is the SINGLE media `file_object` writer. Best-effort, like
 * {@link buildPersistMedia}: errors never fail the job. `undefined` when storage
 * is unconfigured (settle keeps the temp upstream URL).
 */
function buildPersistMediaResult(runtime: WorkerRuntime): PersistMediaResultFn | undefined {
  const { storage, publicBaseUrl, fetchBytes, putBytes } = runtime;
  if (storage === null || publicBaseUrl === undefined) return undefined;
  return async ({ tenantId, jobId, result }) => {
    const persisted = await persistMediaResult({
      storage,
      publicBaseUrl,
      tenantId,
      jobId,
      result,
      fetchBytes,
      putBytes,
    });
    for (const obj of persisted.objects) {
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
          ...(obj.width !== undefined ? { width: obj.width } : {}),
          ...(obj.height !== undefined ? { height: obj.height } : {}),
          ...(obj.duration !== undefined ? { duration: obj.duration } : {}),
        });
      } catch {
        // best-effort: the asset URL is already rewritten; a catalog row miss is non-fatal.
      }
    }
    return persisted;
  };
}
