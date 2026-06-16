import type { AdapterRegistry } from '@actionow/adapters';
import type { Database } from '@actionow/db';
import type { AppEnv } from '@actionow/infra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkerRuntime } from '../src/runtime.js';

/**
 * Light unit test for {@link startWorkers}: `bullmq` is mocked so no Redis is
 * required. We assert that booting binds exactly the three queue names
 * (`job-exec`, `webhook-outbox`, `hold-reaper`), registers the two repeatable
 * sweeps at the requested cadence, and that `close()` drains every Worker +
 * Queue. The real BullMQ/Redis path is covered by the api full-stack e2e.
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
};

afterEach(() => {
  workerNames.length = 0;
  vi.clearAllMocks();
});

describe('startWorkers', () => {
  it('binds the three queue names and registers both sweeps, then closes cleanly', async () => {
    const { startWorkers } = await import('../src/start.js');

    const handle = startWorkers(runtime, { webhookSweepMs: 250, reaperSweepMs: 500 });

    // Exactly the three processing queues are bound as Workers.
    expect(workerNames).toEqual(['job-exec', 'webhook-outbox', 'hold-reaper']);

    // Both repeatable sweeps were scheduled with the requested cadences.
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

    // close() drains all three Workers and both sweep Queues.
    await handle.close();
    expect(workerCloseSpy).toHaveBeenCalledTimes(3);
    expect(queueCloseSpy).toHaveBeenCalledTimes(2);
  });
});
