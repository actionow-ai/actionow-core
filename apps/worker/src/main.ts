import 'reflect-metadata';

import type { Job as BullJob } from 'bullmq';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';

import {
  createHoldReaperProcessor,
  createJobExecProcessor,
  createWebhookOutboxProcessor,
  type JobExecData,
} from './processors/index.js';
import { QUEUE_NAMES } from './queues.js';
import { createWorkerRuntime } from './runtime.js';

/** Cadence for the repeatable webhook-outbox + hold-reaper sweeps. */
const WEBHOOK_SWEEP_MS = 10_000;
const REAPER_SWEEP_MS = 30_000;

async function bootstrap(): Promise<void> {
  const runtime = createWorkerRuntime();
  const connection = new Redis(runtime.env.REDIS_URL, { maxRetriesPerRequest: null });

  const processJobExec = createJobExecProcessor(runtime);
  const processWebhookOutbox = createWebhookOutboxProcessor(runtime);
  const processHoldReaper = createHoldReaperProcessor(runtime);

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

  // Register the repeatable sweeps. A fixed `jobId` dedupes the schedule across
  // restarts so it is not registered twice.
  const webhookQueue = new Queue('webhook-outbox', { connection });
  const reaperQueue = new Queue('hold-reaper', { connection });
  await webhookQueue.add(
    'sweep',
    {},
    { repeat: { every: WEBHOOK_SWEEP_MS }, jobId: 'webhook-outbox-sweep' },
  );
  await reaperQueue.add(
    'sweep',
    {},
    { repeat: { every: REAPER_SWEEP_MS }, jobId: 'hold-reaper-sweep' },
  );

  jobExecWorker.on('ready', () => {
    console.log(`worker ready: ${QUEUE_NAMES.join(', ')}`);
  });
  for (const worker of [jobExecWorker, webhookWorker, reaperWorker]) {
    worker.on('failed', (job, err) => {
      // Never log secrets — engine/adapter layers sanitize before throwing.
      console.error(`job failed on ${worker.name}: ${job?.id ?? '?'} ${err.message}`);
    });
  }
}

void bootstrap();
