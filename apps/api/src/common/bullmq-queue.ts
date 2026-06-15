import type { JobQueuePort } from '@actionow/engine';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

/** Queue names shared with the worker (mirror of `apps/worker/src/queues.ts`). */
export const JOB_EXEC_QUEUE = 'job-exec';

/**
 * BullMQ-backed {@link JobQueuePort}. `enqueueExec` pushes a `job-exec` job
 * that the worker's processor drives via `JobRunner.process`. The Redis
 * connection and `Queue` are created lazily on first enqueue so the blocking
 * `/v1/run` path (which never enqueues) needs no running Redis — the e2e
 * exercises that path without standing up a queue.
 */
@Injectable()
export class BullmqJobQueue implements JobQueuePort {
  private queue: Queue | undefined;
  private connection: Redis | undefined;

  constructor(private readonly redisUrl: string) {}

  async enqueueExec(jobId: string): Promise<void> {
    await this.getQueue().add('exec', { jobId }, { jobId });
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
