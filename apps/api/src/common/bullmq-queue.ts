import type { JobQueuePort } from '@actionow/engine';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

/** Queue names shared with the worker (mirror of `apps/worker/src/queues.ts`). */
export const JOB_EXEC_QUEUE = 'job-exec';

/**
 * Retry/backoff/retention for `job-exec` jobs. A transient throw retries with
 * exponential backoff; on EXHAUSTED attempts the worker's `failed` handler
 * terminal-fails the DB job (releases the hold). Completed jobs are dropped;
 * the last `removeOnFail` failures are kept for inspection (a lightweight DLQ).
 */
const JOB_EXEC_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2_000 },
  removeOnComplete: true,
  removeOnFail: 1_000,
};

/**
 * BullMQ-backed {@link JobQueuePort}. `enqueueExec` pushes a `job-exec` job
 * that the worker's processor drives via `JobRunner.process`. The Redis
 * connection and `Queue` are created lazily on first enqueue so the blocking
 * `/v1/run` path (which never enqueues) needs no running Redis — the e2e
 * exercises that path without standing up a queue.
 */
@Injectable()
export class BullmqJobQueue implements JobQueuePort, OnModuleDestroy {
  private queue: Queue | undefined;
  private connection: Redis | undefined;

  constructor(private readonly redisUrl: string) {}

  /** Close the lazily-opened queue + redis connection on app shutdown so a
   * stopped Redis (e.g. a Testcontainers teardown) does not leave the ioredis
   * client reconnecting. No-op when the async path never ran. */
  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  async enqueueExec(jobId: string): Promise<void> {
    await this.getQueue().add('exec', { jobId }, { jobId, ...JOB_EXEC_OPTS });
  }

  /**
   * Readiness check: prove the BullMQ broker (Redis) is reachable. Opens the
   * lazy queue + connection on first call (so a never-enqueued instance still
   * verifies the broker) and `waitUntilReady()` resolves only once the
   * connection is established — rejecting on a connection error. The caller
   * (`/readyz`) bounds this with a short timeout and treats a reject/timeout as
   * `down`. Never used on the hot path.
   */
  async ping(): Promise<void> {
    await this.getQueue().waitUntilReady();
  }

  private getQueue(): Queue {
    if (this.queue === undefined) {
      this.connection = new Redis(this.redisUrl, { maxRetriesPerRequest: null });
      this.queue = new Queue(JOB_EXEC_QUEUE, { connection: this.connection });
    }
    return this.queue;
  }

  async close(): Promise<void> {
    if (this.queue !== undefined) await this.queue.close();
    if (this.connection !== undefined) await this.connection.quit();
  }
}
