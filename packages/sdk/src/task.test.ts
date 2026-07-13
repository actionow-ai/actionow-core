import { describe, expect, it, vi } from 'vitest';

import { createActionowClient } from './index.js';
import {
  isTerminalTaskStatus,
  operationIsSlow,
  submitTaskAndWait,
  TaskTimeoutError,
  waitForTask,
} from './task.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function taskBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task-1',
    object: 'task',
    type: 'video.generation',
    model: 'seedance-pro',
    status: 'running',
    progress: null,
    output: null,
    usage: null,
    error: null,
    served_by: { offering_id: 'off-1' },
    created: 1_752_000_000,
    started: null,
    finished: null,
    expires_at: null,
    ...over,
  };
}

const SYNC_BODY = {
  operation: 'images.generation',
  model: 'fast-image',
  output: { url: 'https://cdn.test/img.png' },
  usage: { metrics: { images: 1 }, billing_dims: {}, estimated: false },
  served_by: { offering_id: 'off-fast', channel_id: 'chan-1' },
  warnings: [],
};

describe('submitTaskAndWait (§5 dual shape)', () => {
  it('digests a 200 sync response without polling (fast model)', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(SYNC_BODY, 200)));
    const client = createActionowClient({ baseUrl: 'https://api.test', fetch: fetchMock });

    const result = await submitTaskAndWait(client, '/v1/tasks', {
      model: 'fast-image',
      type: 'images.generation',
      prompt: 'a red bicycle',
    });

    expect(result.kind).toBe('sync');
    if (result.kind === 'sync') {
      expect(result.response.output).toEqual({ url: 'https://cdn.test/img.png' });
      expect(result.response.served_by.offering_id).toBe('off-fast');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1); // no poll
  });

  it('digests a 202 + Task by polling GET /v1/tasks/:id to terminal (slow model 自动升格)', async () => {
    const answers = [
      jsonResponse(taskBody({ status: 'pending' }), 202),
      jsonResponse(taskBody({ status: 'running', progress: 50 })),
      jsonResponse(taskBody({ status: 'succeeded', output: { video: 'https://cdn.test/v.mp4' } })),
    ];
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(answers.shift() ?? jsonResponse(taskBody({ status: 'succeeded' }))),
    );
    const client = createActionowClient({ baseUrl: 'https://api.test', fetch: fetchMock });

    const result = await submitTaskAndWait(
      client,
      '/v1/videos/generations',
      { model: 'seedance-pro', prompt: 'a red bicycle' },
      { pollMs: 1 },
    );

    expect(result.kind).toBe('task');
    if (result.kind === 'task') {
      expect(result.task.status).toBe('succeeded');
      expect(result.task.output).toEqual({ video: 'https://cdn.test/v.mp4' });
    }
    // 1 submit + 2 polls
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const submitReq = fetchMock.mock.calls[0]?.[0] as Request;
    expect(new URL(submitReq.url).pathname).toBe('/v1/videos/generations');
    const pollReq = fetchMock.mock.calls[1]?.[0] as Request;
    expect(new URL(pollReq.url).pathname).toBe('/v1/tasks/task-1');
  });

  it('treats a 200 replay carrying a TERMINAL Task body as the task shape (§5 回放)', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse(taskBody({ status: 'succeeded', output: { ok: true } }), 200)),
    );
    const client = createActionowClient({ baseUrl: 'https://api.test', fetch: fetchMock });

    const result = await submitTaskAndWait(
      client,
      '/v1/tasks',
      { model: 'seedance-pro', type: 'video.generation', prompt: 'x' },
      { idempotencyKey: 'idem-1' },
    );

    expect(result.kind).toBe('task');
    if (result.kind === 'task') expect(result.task.status).toBe('succeeded');
    expect(fetchMock).toHaveBeenCalledTimes(1); // already terminal — no poll
    const req = fetchMock.mock.calls[0]?.[0] as Request;
    expect(req.headers.get('idempotency-key')).toBe('idem-1');
  });

  it('resolves (not throws) a failed terminal task — the §9.3 error rides the body', async () => {
    const answers = [
      jsonResponse(taskBody({ status: 'pending' }), 202),
      jsonResponse(
        taskBody({
          status: 'failed',
          error: { code: 'upstream_error', message: 'boom', retryable: false, failover: true },
        }),
      ),
    ];
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(answers.shift() ?? jsonResponse(taskBody({ status: 'failed' }))),
    );
    const client = createActionowClient({ baseUrl: 'https://api.test', fetch: fetchMock });

    const result = await submitTaskAndWait(
      client,
      '/v1/tasks',
      { model: 'seedance-pro', type: 'video.generation', prompt: 'x' },
      { pollMs: 1 },
    );
    expect(result.kind).toBe('task');
    if (result.kind === 'task') {
      expect(result.task.status).toBe('failed');
      expect(result.task.error?.code).toBe('upstream_error');
    }
  });

  it('throws ActionowApiError on a 409 Idempotency-Key conflict', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        jsonResponse(
          {
            error: {
              code: 'conflict',
              message: 'Idempotency-Key reused with a different body',
              retryable: false,
              failover: false,
            },
          },
          409,
        ),
      ),
    );
    const client = createActionowClient({ baseUrl: 'https://api.test', fetch: fetchMock });

    await expect(
      submitTaskAndWait(
        client,
        '/v1/tasks',
        { model: 'seedance-pro', type: 'video.generation', prompt: 'y' },
        { idempotencyKey: 'idem-1' },
      ),
    ).rejects.toMatchObject({ name: 'ActionowApiError', status: 409 });
  });

  it('sends the X-Actionow-Route-Tag pin when routeTag is set', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(SYNC_BODY, 200)));
    const client = createActionowClient({ baseUrl: 'https://api.test', fetch: fetchMock });

    await submitTaskAndWait(
      client,
      '/v1/tasks',
      { model: 'fast-image', type: 'images.generation', prompt: 'z' },
      { routeTag: 'vip' },
    );
    const req = fetchMock.mock.calls[0]?.[0] as Request;
    expect(req.headers.get('x-actionow-route-tag')).toBe('vip');
  });
});

describe('waitForTask', () => {
  it('throws TaskTimeoutError when the deadline passes before a terminal status', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse(taskBody({ status: 'running' }))),
    );
    const client = createActionowClient({ baseUrl: 'https://api.test', fetch: fetchMock });

    await expect(waitForTask(client, 'task-1', { pollMs: 1, timeoutMs: 5 })).rejects.toBeInstanceOf(
      TaskTimeoutError,
    );
  });
});

describe('helpers', () => {
  it('isTerminalTaskStatus covers the four terminal states incl. expired', () => {
    expect(isTerminalTaskStatus('succeeded')).toBe(true);
    expect(isTerminalTaskStatus('expired')).toBe(true);
    expect(isTerminalTaskStatus('running')).toBe(false);
  });

  it('operationIsSlow reads the discovery-face slow marker', () => {
    const model = {
      id: 'seedance-pro',
      object: 'model' as const,
      created: 0,
      owned_by: 'actionow',
      display_name: 'Seedance Pro',
      modality: 'video',
      status: 'active',
      capabilities: [],
      operations: [
        { operation: 'images.generation' as const, paradigms: [], slow: true, params: [] },
        { operation: 'video.generation' as const, paradigms: [], slow: false, params: [] },
      ],
    };
    expect(operationIsSlow(model, 'images.generation')).toBe(true);
    expect(operationIsSlow(model, 'video.generation')).toBe(false);
  });
});
