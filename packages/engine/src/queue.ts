/**
 * Port the engine depends on to hand async jobs to a queue. The worker (Task 7)
 * provides the BullMQ-backed implementation; the engine core stays free of
 * BullMQ/ioredis so it can be unit-tested with an in-memory fake.
 */
export interface JobQueuePort {
  /** Enqueue an async job for the `JobRunner` to execute. */
  enqueueExec(jobId: string): Promise<void>;
}
