import type { components } from './generated/openapi.js';
import { consumeSse } from './sse.js';

/** The job-status view streamed over `GET /v1/jobs/:id/stream`. */
type JobView = components['schemas']['JobView'];

/**
 * The small progress event the worker publishes as an async/media job advances
 * (mirrors the engine's `JobProgressEvent`). Carried on interim `progress`
 * frames; terminal frames carry the full {@link JobView}. Hand-mirrored here so
 * the SDK has no runtime dependency on the engine package.
 */
export interface JobProgressEvent {
  status: string;
  phase?: string;
  poll?: number;
  progress?: number;
}

/** One yielded frame from {@link consumeJobStream}. */
export interface JobStreamFrame {
  /** `snapshot`/`progress` carry a JobView; `done`/`error` are terminal. */
  event: 'snapshot' | 'progress' | 'done' | 'error';
  /** A full JobView (snapshot/progress/done) or, for `error`, an error-ish payload. */
  data: JobView | Partial<JobView> | Record<string, unknown>;
}

/** Options for {@link consumeJobStream}. */
export interface ConsumeJobStreamOptions {
  /** API origin, e.g. `https://gateway.example.com`. */
  baseUrl: string;
  /** The job id to stream. */
  jobId: string;
  /** Bearer token (the data-plane API key). Omitted → no Authorization header. */
  token?: string;
  /** Override the global `fetch` (tests, custom agents). */
  fetch?: typeof fetch;
  /** An `AbortSignal` to cancel the stream early (closes the underlying request). */
  signal?: AbortSignal;
}

/**
 * Stream a job's progress from `GET /v1/jobs/:id/stream` as an async-iterator of
 * typed frames, terminating after the terminal `done` (succeeded) / `error`
 * (failed/canceled) frame. A thin wrapper over {@link consumeSse} (openapi-fetch
 * has no SSE support, so this is hand-written and does NOT touch the generated
 * client).
 *
 * @example
 * for await (const frame of consumeJobStream({ baseUrl, jobId, token })) {
 *   if (frame.event === 'done') { useResult(frame.data); break; }
 *   if (frame.event === 'error') throw new Error('job failed');
 *   // snapshot / progress: render frame.data.status
 * }
 */
export async function* consumeJobStream(
  opts: ConsumeJobStreamOptions,
): AsyncGenerator<JobStreamFrame, void, undefined> {
  const fetchImpl = opts.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  if (opts.token !== undefined) headers.Authorization = `Bearer ${opts.token}`;

  const url = `${opts.baseUrl}/v1/jobs/${encodeURIComponent(opts.jobId)}/stream`;
  const res = await fetchImpl(url, {
    method: 'GET',
    headers,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });

  for await (const frame of consumeSse(res)) {
    // Heartbeat comments (`:\n\n`) parse to an empty `message` frame — skip them.
    if (
      frame.event !== 'snapshot' &&
      frame.event !== 'progress' &&
      frame.event !== 'error' &&
      frame.event !== 'done'
    ) {
      continue;
    }
    const event = frame.event;
    let data: JobStreamFrame['data'] = {};
    if (frame.data !== '') {
      try {
        data = JSON.parse(frame.data) as JobStreamFrame['data'];
      } catch {
        data = {};
      }
    }
    yield { event, data };
    // Terminal frames close the stream.
    if (event === 'done' || event === 'error') return;
  }
}
