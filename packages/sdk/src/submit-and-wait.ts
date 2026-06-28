import type { Client } from 'openapi-fetch';

import type { components, paths } from './generated/openapi.js';

type RunBody = components['schemas']['RunBody'];
type RunJobView = components['schemas']['RunJobView'];

/** The job statuses that end a poll loop (no further transitions). */
const TERMINAL_STATUSES = ['succeeded', 'failed', 'canceled'] as const;
type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/** True when a job status is terminal (`succeeded`/`failed`/`canceled`). */
export function isTerminalJobStatus(status: string): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** Tuning for {@link submitAndWait}'s poll loop. */
export interface SubmitAndWaitOptions {
  /** Delay between status polls, in ms (default 1000). */
  pollMs?: number;
  /** Hard cap on total wait (submit + polling), in ms (default 120000). Exceeding it throws. */
  timeoutMs?: number;
  /**
   * Abort signal — when it fires, the poll loop stops and the returned promise
   * rejects with the signal's reason (an `AbortError` by default).
   */
  signal?: AbortSignal;
}

/** Thrown by {@link submitAndWait} when `timeoutMs` elapses before the job is terminal. */
export class JobTimeoutError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly lastStatus: string,
    timeoutMs: number,
  ) {
    super(
      `job ${jobId} did not reach a terminal status within ${String(timeoutMs)}ms (last: ${lastStatus})`,
    );
    this.name = 'JobTimeoutError';
  }
}

/** Thrown by {@link submitAndWait} (and request helpers) when the API returns a non-2xx. */
export class ActionowApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** The uniform `ErrorView` envelope, when the body parsed as one. */
    public readonly body?: components['schemas']['ErrorView'],
  ) {
    super(message);
    this.name = 'ActionowApiError';
  }
}

const DEFAULT_POLL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 120_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Submit an async resource run and poll it to a terminal status — the canonical
 * async media flow (`POST /v1/run/:resourceId` → poll `GET /v1/jobs/:id`).
 *
 * Forces `exec_mode: 'async-poll'` so the submit returns a `queued` job to poll,
 * regardless of the resource's default. (For fire-and-forget delivery, register
 * a `callback_url` and verify it with `verifyWebhookSignature` instead of
 * polling — see the quickstart example.)
 *
 * Resolves with the terminal {@link RunJobView}; the caller inspects
 * `job.status` (`succeeded` carries `output`/`usage`/`cost`; `failed` carries
 * `error`). Rejects with {@link ActionowApiError} on a non-2xx from submit or
 * poll, {@link JobTimeoutError} on timeout, or the abort reason if `signal` fires.
 *
 * @example
 * const job = await submitAndWait(api, 'image-relay', {
 *   inputs: { prompt: 'a red bicycle' },
 *   end_user: subjectId, // attribute the spend to a specific end-user
 * });
 * if (job.status === 'succeeded') console.log(job.output);
 */
export async function submitAndWait(
  client: Client<paths>,
  resourceId: string,
  runReq: Omit<RunBody, 'exec_mode'>,
  options: SubmitAndWaitOptions = {},
): Promise<RunJobView> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  const submit = await client.POST('/v1/run/{resourceId}', {
    params: { path: { resourceId } },
    body: { ...runReq, exec_mode: 'async-poll' },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (submit.error !== undefined) {
    throw new ActionowApiError('run submit failed', submit.response.status, submit.error);
  }
  const jobId = submit.data.job_id;

  // A blocking-style resource may already be terminal at submit; only poll while pending.
  let lastStatus = submit.data.status;
  if (isTerminalJobStatus(lastStatus)) {
    return await fetchJob(client, jobId, options.signal);
  }

  for (;;) {
    if (Date.now() >= deadline) throw new JobTimeoutError(jobId, lastStatus, timeoutMs);
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), options.signal);

    const job = await fetchJob(client, jobId, options.signal);
    lastStatus = job.status;
    if (isTerminalJobStatus(job.status)) return job;
  }
}

/** Fetch a single job view, throwing {@link ActionowApiError} on a non-2xx. */
async function fetchJob(
  client: Client<paths>,
  jobId: string,
  signal?: AbortSignal,
): Promise<RunJobView> {
  const res = await client.GET('/v1/jobs/{id}', {
    params: { path: { id: jobId } },
    ...(signal === undefined ? {} : { signal }),
  });
  if (res.error !== undefined) {
    throw new ActionowApiError(`poll of job ${jobId} failed`, res.response.status, res.error);
  }
  return res.data;
}
