import type { ConnectionOptions, Job as BullJob } from 'bullmq';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';

import {
  createHoldReaperProcessor,
  createJobExecProcessor,
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

/** Tuning for {@link startWorkers}. */
export interface StartWorkersOptions {
  /** Repeatable webhook-outbox sweep cadence in ms (default {@link WEBHOOK_SWEEP_MS}). */
  webhookSweepMs?: number;
  /** Repeatable hold-reaper sweep cadence in ms (default {@link REAPER_SWEEP_MS}). */
  reaperSweepMs?: number;
  /** Repeatable token-refresh sweep cadence in ms (default {@link TOKEN_REFRESH_SWEEP_MS}). */
  tokenRefreshSweepMs?: number;
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

  const processJobExec = createJobExecProcessor(runtime);
  const processWebhookOutbox = createWebhookOutboxProcessor(runtime);
  const processHoldReaper = createHoldReaperProcessor(runtime);
  const processTokenRefresh = createTokenRefreshProcessor(runtime);

  // job-exec: one job per async run, payload { jobId }.
  const jobExecWorker = new Worker(
    'job-exec',
    (job: BullJob<JobExecData>) => processJobExec(job.data),
    { connection },
  );

  // webhook-outbox: a repeatable sweep that drains due outbox rows.
  const webhookWorker = new Worker('webhook-outbox', () => processWebhookOutbox(), { connection });

  // hold-reaper: a repeatable sweep that cancels expired in-flight holds.
  const reaperWorker = new Worker('hold-reaper', () => processHoldReaper(), { connection });

  // token-refresh: a repeatable sweep that refreshes near-expiry oauth sessions.
  const tokenRefreshWorker = new Worker('token-refresh', () => processTokenRefresh(), {
    connection,
  });

  jobExecWorker.on('ready', () => {
    console.log(`worker ready: ${QUEUE_NAMES.join(', ')}`);
  });

  const workers = [jobExecWorker, webhookWorker, reaperWorker, tokenRefreshWorker];
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
  const queues = [webhookQueue, reaperQueue, tokenRefreshQueue];
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
    },
  };
}
