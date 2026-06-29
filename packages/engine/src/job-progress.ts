import type { JobStatus } from '@actionow/contracts';

/**
 * A small progress event published from the {@link JobRunner} as an async/media
 * job advances, consumed by the API's SSE endpoint (`GET /v1/jobs/:id/stream`)
 * over Redis pub/sub. It is a BEST-EFFORT optimization layer: pub/sub is
 * at-most-once, so the SSE service NEVER trusts it for correctness — a DB-poll
 * backstop guarantees the terminal event always arrives. The shape is kept
 * deliberately tiny (status + optional human phase / poll tick / progress
 * fraction); terminal events carry nothing extra (the SSE service re-reads the
 * authoritative {@link JobView} from the DB before emitting a terminal frame).
 */
export interface JobProgressEvent {
  /** The job's lifecycle status at the moment of the publish. */
  status: JobStatus;
  /** A coarse human-readable phase label (e.g. `submitted` / `polling`). */
  phase?: string;
  /** The poll-loop iteration index (running/polling milestones only). */
  poll?: number;
  /** An optional 0..1 progress fraction when the upstream reports one. */
  progress?: number;
}

/** The Redis pub/sub channel a job's progress events are published on. */
export function jobProgressChannel(jobId: string): string {
  return `job:progress:${jobId}`;
}

/**
 * Publish a {@link JobProgressEvent} via an injected `publish` sink. The engine
 * stays free of ioredis: the worker injects a real `(channel, payload) => void`
 * built over a dedicated publisher client; tests inject a recording fake (or
 * omit it for a no-op). The payload is the JSON-serialized event.
 */
export function publishJobProgress(
  publish: (channel: string, payload: string) => void,
  jobId: string,
  event: JobProgressEvent,
): void {
  publish(jobProgressChannel(jobId), JSON.stringify(event));
}
