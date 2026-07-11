// Aspect ⑥ + the task-path runners (§6-⑥): submit (handle / inline / business
// error / http error), query with the typed TaskUpdate envelope (unknown
// upstream states stay legal), cancel capability gating, and the
// verify-before-parse callback gate.
import type { HttpRequest, TaskStatus, TaskUpdate } from '@actionow/contracts';
import { taskUpdateSchema } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import type { Dialect, SyncRunInput, TaskLifecycleAspect, WireResponse } from '../src/index.js';
import { handleCallback, runTaskCancel, runTaskQuery, runTaskSubmit } from '../src/index.js';
import { BEARER_SECRET, CTX, fakeHttp, jsonResponse, stubDialect, usage } from './stub.js';

const STATUS_MAP: Record<string, TaskStatus> = {
  queued: 'pending',
  processing: 'running',
  done: 'succeeded',
  error: 'failed',
  canceled: 'canceled',
};

function toUpdate(body: { task_id: string; status: string; progress?: number }): TaskUpdate {
  return taskUpdateSchema.parse({
    upstreamTaskId: body.task_id,
    // Unknown upstream status → dialect's judgment: stay 'running', keep rawStatus (§6-⑥).
    status: STATUS_MAP[body.status] ?? 'running',
    rawStatus: body.status,
    ...(body.progress !== undefined ? { progress: body.progress } : {}),
    ...(STATUS_MAP[body.status] === 'succeeded'
      ? { output: { video_url: 'https://cdn.stub.test/v.mp4' }, usage: usage({ video_seconds: 5 }) }
      : {}),
  });
}

let parseCallbackCalls = 0;

const taskLifecycle: TaskLifecycleAspect = {
  buildSubmit: (input) => ({
    method: 'POST',
    path: '/tasks',
    bodyKind: 'json',
    body: { model: input.upstreamModelName, ...input.params.upstream },
  }),
  parseSubmitResponse: (res: WireResponse) => {
    const body = res.body as { code?: string; task_id?: string; result?: unknown };
    if (body.code === 'quota_exhausted') {
      return {
        error: {
          code: 'insufficient_credits',
          message: 'upstream quota exhausted',
          retryable: false,
          failover: true,
        },
      };
    }
    if (body.result !== undefined) {
      return { inline: { output: body.result, usage: usage({ images: 1 }) } };
    }
    return { upstreamTaskId: body.task_id ?? '' };
  },
  buildQuery: (upstreamTaskId) => ({
    method: 'GET',
    path: `/tasks/${upstreamTaskId}`,
    bodyKind: 'none',
  }),
  parseQueryResponse: (res) => toUpdate(res.body as { task_id: string; status: string }),
  verifyCallback: (raw) => raw.headers['x-callback-sig'] === 'valid',
  parseCallback: (raw) => {
    parseCallbackCalls += 1;
    return toUpdate(JSON.parse(raw.rawBody) as { task_id: string; status: string });
  },
};

function taskDialect(overrides: Partial<Dialect> = {}): Dialect {
  return stubDialect({
    operations: { 'video.generation': { fetchModes: ['submit_poll', 'submit_callback'] } },
    taskLifecycle,
    ...overrides,
  });
}

function submitInput(overrides: Partial<SyncRunInput> = {}): SyncRunInput {
  return {
    operation: 'video.generation',
    upstreamModelName: 'stub-video-1',
    params: { canonical: { duration: 5 }, upstream: { seconds: 5 } },
    secret: BEARER_SECRET,
    ctx: CTX,
    ...overrides,
  };
}

describe('runTaskSubmit', () => {
  it('2xx with a handle → kind task (the §7 correlation key), credential injected', async () => {
    let seen: HttpRequest | undefined;
    const result = await runTaskSubmit(taskDialect(), submitInput(), {
      http: fakeHttp((req) => {
        seen = req;
        return jsonResponse(200, { task_id: 'up-42' });
      }),
    });
    expect(result).toEqual({
      ok: true,
      kind: 'task',
      upstreamTaskId: 'up-42',
      servedRaw: { task_id: 'up-42' },
    });
    expect(seen?.url).toBe('https://api.stub.test/v3/tasks');
    expect(seen?.headers?.authorization).toBe('Bearer sk-stub'); // ③ ran on the task path
  });

  it('2xx completed synchronously → kind inline with output + usage', async () => {
    const result = await runTaskSubmit(taskDialect(), submitInput(), {
      http: fakeHttp(() => jsonResponse(200, { result: { url: 'https://x/i.png' } })),
    });
    expect(result).toMatchObject({
      ok: true,
      kind: 'inline',
      output: { url: 'https://x/i.png' },
      usage: { metrics: { images: 1 } },
    });
  });

  it('2xx-carried business rejection → the parse error variant propagates', async () => {
    const result = await runTaskSubmit(taskDialect(), submitInput(), {
      http: fakeHttp(() => jsonResponse(200, { code: 'quota_exhausted' })),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'insufficient_credits', failover: true },
    });
  });

  it('non-2xx → the dialect error table (429 → rate_limited), parse never runs', async () => {
    const result = await runTaskSubmit(taskDialect(), submitInput(), {
      http: fakeHttp(() => jsonResponse(429, { message: 'slow down' })),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'rate_limited', retryable: true, failover: true },
    });
  });

  it('injects media on the submit path when the dialect declares aspect ②', async () => {
    let sentBody: unknown;
    const dialect = taskDialect({
      mediaInjection: {
        deliveryForms: ['url'],
        inject: (draft, media) => ({
          ...draft,
          body: { ...(draft.body as object), image_url: media[0]?.url },
        }),
      },
    });
    await runTaskSubmit(
      dialect,
      submitInput({ media: [{ param: 'image', form: 'url', url: 'https://cdn.test/ref.png' }] }),
      {
        http: fakeHttp((req) => {
          sentBody = req.body;
          return jsonResponse(200, { task_id: 'up-1' });
        }),
      },
    );
    expect(sentBody).toMatchObject({ image_url: 'https://cdn.test/ref.png', seconds: 5 });
  });

  it('a dialect without taskLifecycle → internal_error', async () => {
    const result = await runTaskSubmit(stubDialect(), submitInput(), {
      http: fakeHttp(() => jsonResponse(200, {})),
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'internal_error' } });
  });
});

describe('runTaskQuery', () => {
  const probe = { upstreamTaskId: 'up-42', secret: BEARER_SECRET, ctx: CTX };

  it('⑥ buildQuery → ③ → ④ → parseQueryResponse: a typed, schema-valid TaskUpdate', async () => {
    let seen: HttpRequest | undefined;
    const result = await runTaskQuery(taskDialect(), probe, {
      http: fakeHttp((req) => {
        seen = req;
        return jsonResponse(200, { task_id: 'up-42', status: 'done' });
      }),
    });
    expect(seen?.url).toBe('https://api.stub.test/v3/tasks/up-42');
    expect(seen?.headers?.authorization).toBe('Bearer sk-stub');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(() => taskUpdateSchema.parse(result.update)).not.toThrow();
      expect(result.update).toMatchObject({
        upstreamTaskId: 'up-42',
        status: 'succeeded',
        rawStatus: 'done',
      });
    }
  });

  it('an UNKNOWN upstream status still yields a legal TaskUpdate.status + verbatim rawStatus', async () => {
    const result = await runTaskQuery(taskDialect(), probe, {
      http: fakeHttp(() => jsonResponse(200, { task_id: 'up-42', status: 'reticulating' })),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(() => taskUpdateSchema.parse(result.update)).not.toThrow();
      expect(result.update.status).toBe('running');
      expect(result.update.rawStatus).toBe('reticulating');
    }
  });

  it('non-2xx poll → error table (404 stays a typed gateway error)', async () => {
    const result = await runTaskQuery(taskDialect(), probe, {
      http: fakeHttp(() => jsonResponse(404, { message: 'no such task' })),
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'model_not_found' } });
  });
});

describe('runTaskCancel', () => {
  it('a dialect without cancel methods → internal_error (caller falls back to local-mark, §7.7)', async () => {
    const result = await runTaskCancel(
      taskDialect(),
      { upstreamTaskId: 'up-42', secret: BEARER_SECRET, ctx: CTX },
      { http: fakeHttp(() => jsonResponse(200, {})) },
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'internal_error' } });
    if (!result.ok) expect(result.error.message).toContain('does not support upstream cancel');
  });

  it('forwards cancel when the dialect implements it', async () => {
    const dialect = taskDialect({
      taskLifecycle: {
        ...taskLifecycle,
        buildCancel: (upstreamTaskId) => ({
          method: 'POST',
          path: `/tasks/${upstreamTaskId}/cancel`,
          bodyKind: 'none',
        }),
        parseCancelResponse: (res) => toUpdate(res.body as { task_id: string; status: string }),
      },
    });
    const result = await runTaskCancel(
      dialect,
      { upstreamTaskId: 'up-42', secret: BEARER_SECRET, ctx: CTX },
      { http: fakeHttp(() => jsonResponse(200, { task_id: 'up-42', status: 'canceled' })) },
    );
    expect(result).toMatchObject({ ok: true, update: { status: 'canceled' } });
  });
});

describe('handleCallback (inbound; no transport)', () => {
  const goodBody = JSON.stringify({ task_id: 'up-42', status: 'done' });

  it('verifyCallback false → unauthorized, parseCallback NEVER runs', () => {
    parseCallbackCalls = 0;
    const result = handleCallback(
      taskDialect(),
      { rawBody: goodBody, headers: { 'x-callback-sig': 'forged' } },
      BEARER_SECRET,
      CTX,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'unauthorized', retryable: false, failover: false },
    });
    expect(parseCallbackCalls).toBe(0);
  });

  it('verified → parseCallback yields a schema-valid TaskUpdate (unknown status stays legal)', () => {
    const ok = handleCallback(
      taskDialect(),
      { rawBody: goodBody, headers: { 'x-callback-sig': 'valid' } },
      BEARER_SECRET,
      CTX,
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(() => taskUpdateSchema.parse(ok.update)).not.toThrow();
      expect(ok.update).toMatchObject({ upstreamTaskId: 'up-42', status: 'succeeded' });
    }

    const weird = handleCallback(
      taskDialect(),
      {
        rawBody: JSON.stringify({ task_id: 'up-42', status: 'phase_9' }),
        headers: { 'x-callback-sig': 'valid' },
      },
      undefined, // secret may be absent (template-only verification)
      CTX,
    );
    expect(weird.ok).toBe(true);
    if (weird.ok) {
      expect(weird.update.status).toBe('running');
      expect(weird.update.rawStatus).toBe('phase_9');
    }
  });

  it('an unparseable verified body → invalid_input (typed, not a crash)', () => {
    const result = handleCallback(
      taskDialect(),
      { rawBody: 'not json at all', headers: { 'x-callback-sig': 'valid' } },
      BEARER_SECRET,
      CTX,
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  it('a dialect without taskLifecycle → internal_error', () => {
    const result = handleCallback(
      stubDialect(),
      { rawBody: goodBody, headers: { 'x-callback-sig': 'valid' } },
      BEARER_SECRET,
      CTX,
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'internal_error' } });
  });
});
