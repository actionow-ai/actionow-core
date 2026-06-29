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
  // Build the runner per call so the async/media RELAY_TRACE toggle + byte cap are
  // resolved from the live dynamic settings (动态配置); a fake runtime without
  // `settings` falls back to env (today's behavior). JobRunner construction is cheap.
  const buildRunner = async (): Promise<JobRunner> => {
    const relayTrace = (await runtime.settings?.get('RELAY_TRACE')) ?? runtime.env.RELAY_TRACE;
    const traceMaxBytes =
      (await runtime.settings?.get('RELAY_TRACE_MAX_BYTES')) ?? runtime.env.RELAY_TRACE_MAX_BYTES;
    return new JobRunner({
      db: runtime.db,
      adapters: runtime.adapters,
      loadContext: (job) => loadJobContext(runtime.db, job),
      resolveSecret: runtime.resolveSecret,
      http: runtime.http,
      proxyUrlEnv: runtime.env.UPSTREAM_PROXY_URL,
      traceUpstream: relayTrace === 'full',
      traceMaxBytes,
      insertUsageLog: insertUsageLogFn,
      breaker: runtime.breaker,
      // Fire-and-forget SSE progress (`GET /v1/jobs/:id/stream`). A fake runtime
      // without a publisher → the runner's milestones no-op.
      ...(runtime.publishProgress !== undefined
        ? { publishProgress: runtime.publishProgress }
        : {}),
      ...(persistMediaResultFn !== undefined ? { persistMediaResult: persistMediaResultFn } : {}),
    });
  };

  return {
    process: async (data: JobExecData): Promise<void> => (await buildRunner()).process(data.jobId),
    failExhausted: async (jobId: string, message: string): Promise<void> =>
      (await buildRunner()).failExhausted(jobId, message),
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
