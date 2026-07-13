import type { AdapterRegistry } from '@actionow/adapters';
import type { Database } from '@actionow/db';
import type { AppEnv } from '@actionow/infra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkerRuntime } from '../src/runtime.js';

/**
 * Light unit test for {@link startWorkers}: `bullmq` is mocked so no Redis is
 * required. We assert that booting binds exactly the twelve queue names (the six
 * old-world ones — `job-exec`, `webhook-outbox`, `hold-reaper`,
 * `token-refresh`, `relay-trace-reaper`, `file-lifecycle-reaper` — plus the
 * 批次4 slice4 task-center sweeps `task-poll`, `task-reaper`, `task-webhook`,
 * `task-events-reaper`, the slice5 `artifact-reaper` and the 批次5 slice4
 * `reconcile-daily` comparer), registers the repeatable sweeps at the requested
 * cadence, and that `close()` drains every Worker + Queue. The real BullMQ/Redis
 * path is covered by the api full-stack e2e.
 */

const workerNames: string[] = [];
const workerCloseSpy = vi.fn(() => Promise.resolve());
const queueCloseSpy = vi.fn(() => Promise.resolve());
const queueAddSpy = vi.fn(() => Promise.resolve());

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation((name: string) => {
    workerNames.push(name);
    return { name, on: vi.fn(), close: workerCloseSpy };
  }),
  Queue: vi.fn().mockImplementation((name: string) => ({
    name,
    add: queueAddSpy,
    close: queueCloseSpy,
  })),
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({ quit: vi.fn(() => Promise.resolve()) })),
}));

const env = { REDIS_URL: 'redis://localhost:6379' } as AppEnv;
const runtime: WorkerRuntime = {
  env,
  db: {} as Database,
  adapters: { providerTypes: () => [], get: () => ({}) } as unknown as AdapterRegistry,
  http: { request: () => Promise.reject(new Error('no http')) },
  resolveSecret: () => Promise.resolve(undefined),
  storage: null,
  publicBaseUrl: undefined,
  fetchBytes: () => Promise.reject(new Error('no fetchBytes')),
  putBytes: () => Promise.reject(new Error('no putBytes')),
  breaker: {
    filterAvailable: (channels) => Promise.resolve([...channels]),
    onSuccess: () => Promise.resolve(),
    onFailure: () => Promise.resolve(),
    windowStats: () => Promise.resolve(null),
  },
};

afterEach(() => {
  workerNames.length = 0;
  vi.clearAllMocks();
});

describe('startWorkers', () => {
  it('binds the twelve queue names and registers all sweeps, then closes cleanly', async () => {
    const { startWorkers } = await import('../src/start.js');

    const handle = startWorkers(runtime, {
      webhookSweepMs: 250,
      reaperSweepMs: 500,
      tokenRefreshSweepMs: 750,
      relayTraceSweepMs: 900,
      fileLifecycleSweepMs: 1100,
      taskPollSweepMs: 1300,
      taskReaperSweepMs: 1500,
      taskWebhookSweepMs: 1700,
      taskEventsSweepMs: 1900,
      artifactSweepMs: 2100,
      reconcileDailySweepMs: 2300,
    });

    // Exactly the twelve processing queues are bound as Workers (six old-world
    // + the four 批次4 slice4 task-center sweeps + the slice5 artifact reaper
    // + the 批次5 slice4 daily reconcile comparer).
    expect(workerNames).toEqual([
      'job-exec',
      'webhook-outbox',
      'hold-reaper',
      'token-refresh',
      'relay-trace-reaper',
      'file-lifecycle-reaper',
      'task-poll',
      'task-reaper',
      'task-webhook',
      'task-events-reaper',
      'artifact-reaper',
      'reconcile-daily',
    ]);

    // All repeatable sweeps were scheduled with the requested cadences.
    await Promise.resolve();
    expect(queueAddSpy).toHaveBeenCalledWith(
      'sweep',
      {},
      { repeat: { every: 250 }, jobId: 'webhook-outbox-sweep' },
    );
    expect(queueAddSpy).toHaveBeenCalledWith(
      'sweep',
      {},
      { repeat: { every: 500 }, jobId: 'hold-reaper-sweep' },
    );
    expect(queueAddSpy).toHaveBeenCalledWith(
      'sweep',
      {},
      { repeat: { every: 750 }, jobId: 'token-refresh-sweep' },
    );
    expect(queueAddSpy).toHaveBeenCalledWith(
      'sweep',
      {},
      { repeat: { every: 900 }, jobId: 'relay-trace-reaper-sweep' },
    );
    expect(queueAddSpy).toHaveBeenCalledWith(
      'sweep',
      {},
      { repeat: { every: 1100 }, jobId: 'file-lifecycle-reaper-sweep' },
    );
    expect(queueAddSpy).toHaveBeenCalledWith(
      'sweep',
      {},
      { repeat: { every: 1300 }, jobId: 'task-poll-sweep' },
    );
    expect(queueAddSpy).toHaveBeenCalledWith(
      'sweep',
      {},
      { repeat: { every: 1500 }, jobId: 'task-reaper-sweep' },
    );
    expect(queueAddSpy).toHaveBeenCalledWith(
      'sweep',
      {},
      { repeat: { every: 1700 }, jobId: 'task-webhook-sweep' },
    );
    expect(queueAddSpy).toHaveBeenCalledWith(
      'sweep',
      {},
      { repeat: { every: 1900 }, jobId: 'task-events-reaper-sweep' },
    );
    expect(queueAddSpy).toHaveBeenCalledWith(
      'sweep',
      {},
      { repeat: { every: 2100 }, jobId: 'artifact-reaper-sweep' },
    );
    expect(queueAddSpy).toHaveBeenCalledWith(
      'sweep',
      {},
      { repeat: { every: 2300 }, jobId: 'reconcile-daily-sweep' },
    );

    // close() drains all twelve Workers and all eleven sweep Queues.
    await handle.close();
    expect(workerCloseSpy).toHaveBeenCalledTimes(12);
    expect(queueCloseSpy).toHaveBeenCalledTimes(11);
  });
});
