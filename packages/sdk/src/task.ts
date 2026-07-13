// packages/sdk/src/task.ts
//
// The NEW task-paradigm helpers (model-supply greenfield §5): submit-and-wait
// over the task-create endpoints (`POST /v1/videos/generations`,
// `POST /v1/audio/music`, the generic `POST /v1/tasks`) which answer in TWO
// shapes the server decides ALONE (§3 自动升格 is pure server-side, no client
// opt-in):
//
//   200 → the sync result (a fast model on a sync-capable operation) — the
//         GatewayInvokeResponse body IS the output, nothing to poll;
//   202 → a Task (task paradigm, or a slow model auto-upgraded) — poll
//         `GET /v1/tasks/:id` to a terminal status.
//
// {@link submitTaskAndWait} digests both shapes behind one call. Clients that
// want to PRE-JUDGE the shape (e.g. to show a progress UI up front) can read
// the discovery face's `operations[].slow` marker (`GET /v1/gateway/models`,
// {@link operationIsSlow}) — but the 200/202 discrimination never depends on
// it.
import type { Client } from 'openapi-fetch';

import type { components, paths } from './generated/openapi.js';
import { ActionowApiError } from './submit-and-wait.js';

type Schemas = components['schemas'];
export type GatewayTaskView = Schemas['GatewayTaskView'];
export type GatewayInvokeResponse = Schemas['GatewayInvokeResponse'];
export type GatewayModelView = Schemas['GatewayModelList']['data'][number];

/** The task statuses that end a poll loop (§7.1 six-state machine, terminal four). */
export const TERMINAL_TASK_STATUSES = ['succeeded', 'failed', 'canceled', 'expired'] as const;
export type TerminalTaskStatus = (typeof TERMINAL_TASK_STATUSES)[number];

/** True when a gateway task status is terminal (`succeeded`/`failed`/`canceled`/`expired`). */
export function isTerminalTaskStatus(status: string): status is TerminalTaskStatus {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

/** The §5 task-paradigm create endpoints {@link submitTaskAndWait} accepts. */
export type TaskCreatePath = '/v1/videos/generations' | '/v1/audio/music' | '/v1/tasks';

/**
 * A create body: `model` addresses the model; `type` (only on `/v1/tasks`)
 * names the operation; every other key is a canonical parameter of the
 * model's contract (see `GET /v1/gateway/models` for the summary).
 */
export type TaskCreateBody = Record<string, unknown> & { model: string };

/** The two server-decided outcomes of one task-paradigm create (§3/§5). */
export type SubmitTaskResult =
  /** HTTP 200 — the fast/sync shape; `response.output` is the result. */
  | { kind: 'sync'; response: GatewayInvokeResponse }
  /** HTTP 202 → polled to terminal; inspect `task.status` / `task.output` / `task.error`. */
  | { kind: 'task'; task: GatewayTaskView };

/** Tuning for {@link submitTaskAndWait} / {@link waitForTask}. */
export interface SubmitTaskOptions {
  /** Delay between `GET /v1/tasks/:id` polls, in ms (default 2000). */
  pollMs?: number;
  /** Hard cap on total wait (submit + polling), in ms (default 600000 — media tasks run long). */
  timeoutMs?: number;
  /** Abort signal — stops the poll loop and rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Sent as `Idempotency-Key` (§5: same key + same body replays; different body ⇒ 409). */
  idempotencyKey?: string;
  /** Sent as `X-Actionow-Route-Tag` (§8 narrow-only supply pin). */
  routeTag?: string;
}

/** Thrown by {@link submitTaskAndWait}/{@link waitForTask} when `timeoutMs` elapses first. */
export class TaskTimeoutError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly lastStatus: string,
    timeoutMs: number,
  ) {
    super(
      `task ${taskId} did not reach a terminal status within ${String(timeoutMs)}ms (last: ${lastStatus})`,
    );
    this.name = 'TaskTimeoutError';
  }
}

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 600_000;

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
 * Submit one task-paradigm create and digest BOTH §5 response shapes:
 * a 200 returns immediately as `{kind:'sync'}`; a 202 + Task is polled
 * (`GET /v1/tasks/:id`) to a terminal status and returned as `{kind:'task'}`.
 *
 * A `failed`/`canceled`/`expired` terminal task RESOLVES (kind:'task' with
 * that status) rather than throwing — the task body carries the normalized
 * §9.3 error; only transport/HTTP failures throw {@link ActionowApiError}.
 *
 * @example
 * const result = await submitTaskAndWait(api, '/v1/videos/generations', {
 *   model: 'seedance-pro',
 *   prompt: 'a red bicycle riding itself',
 *   resolution: '1080p',
 * });
 * if (result.kind === 'sync') console.log(result.response.output);
 * else if (result.task.status === 'succeeded') console.log(result.task.output);
 * else console.error(result.task.error);
 */
export async function submitTaskAndWait(
  client: Client<paths>,
  path: TaskCreatePath,
  body: TaskCreateBody,
  options: SubmitTaskOptions = {},
): Promise<SubmitTaskResult> {
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const headers: Record<string, string> = {};
  if (options.idempotencyKey !== undefined) headers['Idempotency-Key'] = options.idempotencyKey;
  if (options.routeTag !== undefined) headers['X-Actionow-Route-Tag'] = options.routeTag;

  // The three create paths share one wire discipline (200|202|error envelope);
  // openapi-fetch cannot narrow a UNION of literal paths, so the call is made
  // through the widest one and the response is discriminated by HTTP status.
  const submit = await client.POST(path as '/v1/tasks', {
    body: body as never,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (submit.error !== undefined) {
    throw new ActionowApiError(
      `task submit failed (${path})`,
      submit.response.status,
      submit.error,
    );
  }

  // Discriminate on the BODY shape, not the status alone: a Task body always
  // carries `object: 'task'` (202 live task, but ALSO a 200 idempotent replay
  // of an already-terminal task — §5 同键同体回放); everything else is the
  // sync GatewayInvokeResponse.
  const shaped = submit.data as { object?: string };
  if (shaped.object !== 'task') {
    return { kind: 'sync', response: submit.data as GatewayInvokeResponse };
  }

  // The task shape (incl. server-side 自动升格): poll to terminal.
  const task = submit.data as GatewayTaskView;
  if (isTerminalTaskStatus(task.status)) return { kind: 'task', task };
  const terminal = await waitForTask(client, task.id, {
    ...options,
    timeoutMs: Math.max(0, deadline - Date.now()),
  });
  return { kind: 'task', task: terminal };
}

/**
 * Poll one task (`GET /v1/tasks/:id`) until terminal. Resolves with the
 * terminal {@link GatewayTaskView}; rejects with {@link ActionowApiError} on a
 * non-2xx poll, {@link TaskTimeoutError} on timeout, or the abort reason.
 */
export async function waitForTask(
  client: Client<paths>,
  taskId: string,
  options: SubmitTaskOptions = {},
): Promise<GatewayTaskView> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'unknown';

  for (;;) {
    const res = await client.GET('/v1/tasks/{id}', {
      params: { path: { id: taskId } },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (res.error !== undefined) {
      throw new ActionowApiError(`poll of task ${taskId} failed`, res.response.status, res.error);
    }
    const task = res.data;
    lastStatus = task.status;
    if (isTerminalTaskStatus(task.status)) return task;
    if (Date.now() >= deadline) throw new TaskTimeoutError(taskId, lastStatus, timeoutMs);
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), options.signal);
  }
}

/**
 * Discovery-face pre-judgment (§5): is `operation` on this model marked
 * `slow` (⇒ its sync endpoints will auto-upgrade to 202 + Task)? Purely a UX
 * hint — {@link submitTaskAndWait} discriminates on the actual HTTP status.
 */
export function operationIsSlow(model: GatewayModelView, operation: string): boolean {
  return model.operations.some((op) => op.operation === operation && op.slow);
}
