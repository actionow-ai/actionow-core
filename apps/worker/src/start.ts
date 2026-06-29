import type { ConnectionOptions, Job as BullJob } from 'bullmq';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';

import {
  createFileLifecycleReaperProcessor,
  createHoldReaperProcessor,
  createJobExecProcessor,
  createRelayTraceReaperProcessor,
  createTokenRefreshProcessor,
  createWebhookOutboxProcessor,
  type JobExecData,
} from './processors/index.js';
import { QUEUE_NAMES } from './queues.js';
import type { WorkerRuntime } from './runtime.js';

/** Default cadence for the repeatable webhook-outbox sweep (ms). */
export const WEBHOOK_SWEEP_MS = 10_000;
/** Default cadence for the repeatable hold-reaper sweep (ms). */
export const REAPER_SWEEP_MS = 30_000;
/** Default cadence for the repeatable oauth token-refresh sweep (ms). */
export const TOKEN_REFRESH_SWEEP_MS = 60_000;
/** Default cadence for the repeatable relay-trace retention sweep (ms; hourly). */
export const RELAY_TRACE_SWEEP_MS = 3_600_000;
/** Default cadence for the repeatable file-lifecycle (TTL) sweep (ms; hourly). */
export const FILE_LIFECYCLE_SWEEP_MS = 3_600_000;

/** Tuning for {@link startWorkers}. */
export interface StartWorkersOptions {
  /** Repeatable webhook-outbox sweep cadence in ms (default {@link WEBHOOK_SWEEP_MS}). */
  webhookSweepMs?: number;
  /** Repeatable hold-reaper sweep cadence in ms (default {@link REAPER_SWEEP_MS}). */
  reaperSweepMs?: number;
  /** Repeatable token-refresh sweep cadence in ms (default {@link TOKEN_REFRESH_SWEEP_MS}). */
  tokenRefreshSweepMs?: number;
  /** Repeatable relay-trace retention sweep cadence in ms (default {@link RELAY_TRACE_SWEEP_MS}). */
  relayTraceSweepMs?: number;
  /** Repeatable file-lifecycle (TTL) sweep cadence in ms (default {@link FILE_LIFECYCLE_SWEEP_MS}). */
  fileLifecycleSweepMs?: number;
  /**
   * BullMQ connection. When omitted a fresh ioredis client is created from
   * `runtime.env.REDIS_URL` and owned by the returned handle (closed on
   * `close()`); when supplied the caller owns its lifecycle.
   */
  connection?: ConnectionOptions;
}

/** A running set of workers; `close()` drains+closes them and any owned redis. */
export interface RunningWorkers {
  close: () => Promise<void>;
}

/**
 * Boot the worker's three BullMQ Workers (`job-exec`, `webhook-outbox`,
 * `hold-reaper`) over the injected {@link WorkerRuntime} and register the
 * repeatable webhook/reaper sweeps. Extracted from `main.ts` so the api's
 * full-stack e2e can stand up a real worker against a Testcontainers Redis.
 *
 * Returns a handle whose `close()` drains and closes every Worker + Queue and,
 * when this function owned the connection, quits the ioredis client — so the
 * process (or a test harness) exits with no leaked handles.
 */
export function startWorkers(
  runtime: WorkerRuntime,
  opts: StartWorkersOptions = {},
): RunningWorkers {
  // When the caller supplies a connection it owns its lifecycle; otherwise we
  // create one from the runtime env and close it ourselves on `close()`.
  const ownsConnection = opts.connection === undefined;
  const connection: ConnectionOptions =
    opts.connection ?? new Redis(runtime.env.REDIS_URL, { maxRetriesPerRequest: null });

  const webhookSweepMs = opts.webhookSweepMs ?? WEBHOOK_SWEEP_MS;
  const reaperSweepMs = opts.reaperSweepMs ?? REAPER_SWEEP_MS;
  const tokenRefreshSweepMs = opts.tokenRefreshSweepMs ?? TOKEN_REFRESH_SWEEP_MS;
  const relayTraceSweepMs = opts.relayTraceSweepMs ?? RELAY_TRACE_SWEEP_MS;
  const fileLifecycleSweepMs = opts.fileLifecycleSweepMs ?? FILE_LIFECYCLE_SWEEP_MS;

  const jobExec = createJobExecProcessor(runtime);
  const processWebhookOutbox = createWebhookOutboxProcessor(runtime);
  const processHoldReaper = createHoldReaperProcessor(runtime);
  const processTokenRefresh = createTokenRefreshProcessor(runtime);
  const processRelayTraceReaper = createRelayTraceReaperProcessor(runtime);
  const processFileLifecycleReaper = createFileLifecycleReaperProcessor(runtime);

  // job-exec: one job per async run, payload { jobId }.
  const jobExecWorker = new Worker(
    'job-exec',
    (job: BullJob<JobExecData>) => jobExec.process(job.data),
    { connection },
  );

  // On EXHAUSTED retries (last attempt failed), terminal-fail the DB job so its
  // hold is released NOW rather than sitting `running` until the ~15-min reaper.
  // Earlier attempts (attemptsMade < attempts) are left for BullMQ to retry.
  jobExecWorker.on('failed', (job, err) => {
    if (job === undefined) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) return;
    void jobExec.failExhausted(job.data.jobId, err.message).catch((e: unknown) => {
      console.error(`failExhausted error for job ${job.id ?? '?'}: ${String(e)}`);
    });
  });

  // webhook-outbox: a repeatable sweep that drains due outbox rows.
  const webhookWorker = new Worker('webhook-outbox', () => processWebhookOutbox(), { connection });

  // hold-reaper: a repeatable sweep that cancels expired in-flight holds.
  const reaperWorker = new Worker('hold-reaper', () => processHoldReaper(), { connection });

  // token-refresh: a repeatable sweep that refreshes near-expiry oauth sessions.
  const tokenRefreshWorker = new Worker('token-refresh', () => processTokenRefresh(), {
    connection,
  });

  // relay-trace-reaper: a repeatable sweep that prunes relay_trace past its retention window.
  const relayTraceWorker = new Worker('relay-trace-reaper', () => processRelayTraceReaper(), {
    connection,
  });

  // file-lifecycle-reaper: a repeatable sweep that soft-deletes/bucket-deletes
  // file_object rows past each opt-in tenant's TTL window (no-op when none opt in).
  const fileLifecycleWorker = new Worker(
    'file-lifecycle-reaper',
    () => processFileLifecycleReaper(),
    { connection },
  );

  jobExecWorker.on('ready', () => {
    console.log(`worker ready: ${QUEUE_NAMES.join(', ')}`);
  });

  const workers = [
    jobExecWorker,
    webhookWorker,
    reaperWorker,
    tokenRefreshWorker,
    relayTraceWorker,
    fileLifecycleWorker,
  ];
  for (const worker of workers) {
    worker.on('failed', (job, err) => {
      // Never log secrets — engine/adapter layers sanitize before throwing.
      console.error(`job failed on ${worker.name}: ${job?.id ?? '?'} ${err.message}`);
    });
  }

  // Register the repeatable sweeps. A fixed `jobId` dedupes the schedule across
  // restarts so it is not registered twice.
  const webhookQueue = new Queue('webhook-outbox', { connection });
  const reaperQueue = new Queue('hold-reaper', { connection });
  const tokenRefreshQueue = new Queue('token-refresh', { connection });
  const relayTraceQueue = new Queue('relay-trace-reaper', { connection });
  const fileLifecycleQueue = new Queue('file-lifecycle-reaper', { connection });
  const queues = [
    webhookQueue,
    reaperQueue,
    tokenRefreshQueue,
    relayTraceQueue,
    fileLifecycleQueue,
  ];
  const scheduled = Promise.all([
    webhookQueue.add(
      'sweep',
      {},
      { repeat: { every: webhookSweepMs }, jobId: 'webhook-outbox-sweep' },
    ),
    reaperQueue.add('sweep', {}, { repeat: { every: reaperSweepMs }, jobId: 'hold-reaper-sweep' }),
    tokenRefreshQueue.add(
      'sweep',
      {},
      { repeat: { every: tokenRefreshSweepMs }, jobId: 'token-refresh-sweep' },
    ),
    relayTraceQueue.add(
      'sweep',
      {},
      { repeat: { every: relayTraceSweepMs }, jobId: 'relay-trace-reaper-sweep' },
    ),
    fileLifecycleQueue.add(
      'sweep',
      {},
      { repeat: { every: fileLifecycleSweepMs }, jobId: 'file-lifecycle-reaper-sweep' },
    ),
  ]);
  // Surface a scheduling failure rather than leaving it floating; a real boot
  // would crash, and the e2e awaits readiness via the first delivered job.
  void scheduled.catch((err: unknown) => {
    console.error(`failed to register repeatable sweeps: ${String(err)}`);
  });

  return {
    async close(): Promise<void> {
      // Wait for the sweep registration to settle so close() does not race an
      // in-flight `Queue.add`.
      await scheduled.catch(() => undefined);
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all(queues.map((q) => q.close()));
      if (ownsConnection && connection instanceof Redis) {
        await connection.quit();
      }
      // Quit the dedicated job-progress SSE publisher client the runtime owns
      // (createWorkerRuntime built it); a fake test runtime omits it → no-op.
      if (runtime.progressPublisher !== undefined) {
        await runtime.progressPublisher.quit();
      }
    },
  };
}
