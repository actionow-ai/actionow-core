import type { ConnectionOptions } from 'bullmq';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';

import {
  createArtifactReaperProcessor,
  createFileLifecycleReaperProcessor,
  createReconcileDailyProcessor,
  createRelayTraceReaperProcessor,
  createTaskEventsReaperProcessor,
  createTaskPollProcessor,
  createTaskReaperProcessor,
  createTaskWebhookProcessor,
  createTokenRefreshProcessor,
} from './processors/index.js';
import { QUEUE_NAMES } from './queues.js';
import type { WorkerRuntime } from './runtime.js';

/** Default cadence for the repeatable oauth token-refresh sweep (ms). */
export const TOKEN_REFRESH_SWEEP_MS = 60_000;
/** Default cadence for the repeatable relay-trace retention sweep (ms; hourly). */
export const RELAY_TRACE_SWEEP_MS = 3_600_000;
/** Default cadence for the repeatable file-lifecycle (TTL) sweep (ms; hourly). */
export const FILE_LIFECYCLE_SWEEP_MS = 3_600_000;
/** Default cadence for the §7.2 task lease-takeover poll sweep (ms). */
export const TASK_POLL_SWEEP_MS = 10_000;
/** Default cadence for the §3/§7.3 task orphan + hold-expiry sweep (ms). */
export const TASK_REAPER_SWEEP_MS = 30_000;
/** Default cadence for the §7.6 task webhook delivery sweep (ms). */
export const TASK_WEBHOOK_SWEEP_MS = 10_000;
/** Default cadence for the §9.3 task_events retention sweep (ms; hourly). */
export const TASK_EVENTS_SWEEP_MS = 3_600_000;
/** Default cadence for the §9.4 signed-track artifact lifecycle sweep (ms; hourly). */
export const ARTIFACT_SWEEP_MS = 3_600_000;
/** Default cadence for the §9.2 官方渠道 daily reconciliation sweep (ms; daily). */
export const RECONCILE_DAILY_SWEEP_MS = 86_400_000;

/** Tuning for {@link startWorkers}. */
export interface StartWorkersOptions {
  /** Repeatable token-refresh sweep cadence in ms (default {@link TOKEN_REFRESH_SWEEP_MS}). */
  tokenRefreshSweepMs?: number;
  /** Repeatable relay-trace retention sweep cadence in ms (default {@link RELAY_TRACE_SWEEP_MS}). */
  relayTraceSweepMs?: number;
  /** Repeatable file-lifecycle (TTL) sweep cadence in ms (default {@link FILE_LIFECYCLE_SWEEP_MS}). */
  fileLifecycleSweepMs?: number;
  /** §7.2 task lease-takeover poll sweep cadence in ms (default {@link TASK_POLL_SWEEP_MS}). */
  taskPollSweepMs?: number;
  /** §3/§7.3 task orphan + hold-expiry sweep cadence in ms (default {@link TASK_REAPER_SWEEP_MS}). */
  taskReaperSweepMs?: number;
  /** §7.6 task webhook delivery sweep cadence in ms (default {@link TASK_WEBHOOK_SWEEP_MS}). */
  taskWebhookSweepMs?: number;
  /** §9.3 task_events retention sweep cadence in ms (default {@link TASK_EVENTS_SWEEP_MS}). */
  taskEventsSweepMs?: number;
  /** §9.4 artifact lifecycle sweep cadence in ms (default {@link ARTIFACT_SWEEP_MS}). */
  artifactSweepMs?: number;
  /** §9.2 daily official-channel reconcile sweep cadence in ms (default {@link RECONCILE_DAILY_SWEEP_MS}). */
  reconcileDailySweepMs?: number;
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
 * Boot the worker's BullMQ Workers over the injected {@link WorkerRuntime} and
 * register the repeatable sweeps: the task-center sweeps `task-poll` /
 * `task-reaper` / `task-webhook` / `task-events-reaper` / `artifact-reaper` /
 * `reconcile-daily` plus the shared retention/oauth sweeps (`token-refresh`,
 * `relay-trace-reaper`, `file-lifecycle-reaper`). 批次6 D2: the old job-path
 * queues (`job-exec`, `webhook-outbox`, `hold-reaper`) are deleted with the
 * legacy execution world. Extracted from `main.ts` so the api's full-stack
 * e2e can stand up a real worker against a Testcontainers Redis.
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

  const tokenRefreshSweepMs = opts.tokenRefreshSweepMs ?? TOKEN_REFRESH_SWEEP_MS;
  const relayTraceSweepMs = opts.relayTraceSweepMs ?? RELAY_TRACE_SWEEP_MS;
  const fileLifecycleSweepMs = opts.fileLifecycleSweepMs ?? FILE_LIFECYCLE_SWEEP_MS;
  const taskPollSweepMs = opts.taskPollSweepMs ?? TASK_POLL_SWEEP_MS;
  const taskReaperSweepMs = opts.taskReaperSweepMs ?? TASK_REAPER_SWEEP_MS;
  const taskWebhookSweepMs = opts.taskWebhookSweepMs ?? TASK_WEBHOOK_SWEEP_MS;
  const taskEventsSweepMs = opts.taskEventsSweepMs ?? TASK_EVENTS_SWEEP_MS;
  const artifactSweepMs = opts.artifactSweepMs ?? ARTIFACT_SWEEP_MS;
  const reconcileDailySweepMs = opts.reconcileDailySweepMs ?? RECONCILE_DAILY_SWEEP_MS;

  const processTokenRefresh = createTokenRefreshProcessor(runtime);
  const processRelayTraceReaper = createRelayTraceReaperProcessor(runtime);
  const processFileLifecycleReaper = createFileLifecycleReaperProcessor(runtime);
  const processTaskPoll = createTaskPollProcessor(runtime);
  const processTaskReaper = createTaskReaperProcessor(runtime);
  const processTaskWebhook = createTaskWebhookProcessor(runtime);
  const processTaskEventsReaper = createTaskEventsReaperProcessor(runtime);
  const processArtifactReaper = createArtifactReaperProcessor(runtime);
  const processReconcileDaily = createReconcileDailyProcessor(runtime);

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

  // task-poll: the §7.2 lease-takeover sweep — claims expired-lease recoverable
  // tasks (submit_poll/submit_callback) and polls each to a terminal state.
  const taskPollWorker = new Worker('task-poll', () => processTaskPoll(), { connection });

  // task-reaper: §3 direct orphans + §7.3 hold-expiry backstop (fail, no charge).
  const taskReaperWorker = new Worker('task-reaper', () => processTaskReaper(), { connection });

  // task-webhook: drains due §7.6 webhook_deliveries (signed envelopes, fixed ladder).
  const taskWebhookWorker = new Worker('task-webhook', () => processTaskWebhook(), { connection });

  // task-events-reaper: §9.3 task_events retention sweep.
  const taskEventsReaperWorker = new Worker('task-events-reaper', () => processTaskEventsReaper(), {
    connection,
  });

  // artifact-reaper: §9.4 signed-track expiry (public 轨豁免清理 by construction).
  const artifactReaperWorker = new Worker('artifact-reaper', () => processArtifactReaper(), {
    connection,
  });

  // reconcile-daily: §9.2 官方渠道 daily reconciliation comparer (previous UTC day).
  const reconcileDailyWorker = new Worker('reconcile-daily', () => processReconcileDaily(), {
    connection,
  });

  taskPollWorker.on('ready', () => {
    console.log(`worker ready: ${QUEUE_NAMES.join(', ')}`);
  });

  const workers = [
    tokenRefreshWorker,
    relayTraceWorker,
    fileLifecycleWorker,
    taskPollWorker,
    taskReaperWorker,
    taskWebhookWorker,
    taskEventsReaperWorker,
    artifactReaperWorker,
    reconcileDailyWorker,
  ];
  for (const worker of workers) {
    worker.on('failed', (job, err) => {
      // Never log secrets — engine/adapter layers sanitize before throwing.
      console.error(`job failed on ${worker.name}: ${job?.id ?? '?'} ${err.message}`);
    });
  }

  // Register the repeatable sweeps. A fixed `jobId` dedupes the schedule across
  // restarts so it is not registered twice.
  const tokenRefreshQueue = new Queue('token-refresh', { connection });
  const relayTraceQueue = new Queue('relay-trace-reaper', { connection });
  const fileLifecycleQueue = new Queue('file-lifecycle-reaper', { connection });
  const taskPollQueue = new Queue('task-poll', { connection });
  const taskReaperQueue = new Queue('task-reaper', { connection });
  const taskWebhookQueue = new Queue('task-webhook', { connection });
  const taskEventsReaperQueue = new Queue('task-events-reaper', { connection });
  const artifactReaperQueue = new Queue('artifact-reaper', { connection });
  const reconcileDailyQueue = new Queue('reconcile-daily', { connection });
  const queues = [
    tokenRefreshQueue,
    relayTraceQueue,
    fileLifecycleQueue,
    taskPollQueue,
    taskReaperQueue,
    taskWebhookQueue,
    taskEventsReaperQueue,
    artifactReaperQueue,
    reconcileDailyQueue,
  ];
  const scheduled = Promise.all([
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
    taskPollQueue.add(
      'sweep',
      {},
      { repeat: { every: taskPollSweepMs }, jobId: 'task-poll-sweep' },
    ),
    taskReaperQueue.add(
      'sweep',
      {},
      { repeat: { every: taskReaperSweepMs }, jobId: 'task-reaper-sweep' },
    ),
    taskWebhookQueue.add(
      'sweep',
      {},
      { repeat: { every: taskWebhookSweepMs }, jobId: 'task-webhook-sweep' },
    ),
    taskEventsReaperQueue.add(
      'sweep',
      {},
      { repeat: { every: taskEventsSweepMs }, jobId: 'task-events-reaper-sweep' },
    ),
    artifactReaperQueue.add(
      'sweep',
      {},
      { repeat: { every: artifactSweepMs }, jobId: 'artifact-reaper-sweep' },
    ),
    reconcileDailyQueue.add(
      'sweep',
      {},
      { repeat: { every: reconcileDailySweepMs }, jobId: 'reconcile-daily-sweep' },
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
