// 批次4 slice3 — GatewayCreateController unit tests (mocked GatewayService):
// kind→HTTP dispatch (202+Task / 200 sync / §3 自动升格 / replay), the §5
// Idempotency-Key threading + 409 conflict, the §2.6 model allowlist, the
// §9.3 error-code mapping (429+Retry-After / 404 / 402 / 400) and the §10
// deprecation headers.
import type { GatewayError, ServedBy, StreamFrame } from '@actionow/contracts';
import type { ExecuteResult } from '@actionow/engine';
import { describe, expect, it, vi } from 'vitest';

import { GatewayCreateController } from '../src/gateway/create.controller.js';
import { fingerprintBody } from '../src/gateway/facade.js';
import type { GatewayService } from '../src/gateway/gateway.service.js';
import { AUTH, fakeReq, fakeRes, modelRow, taskRow } from './gateway-fixtures.js';

const SERVED: ServedBy = { offeringId: 'offering-1', channelId: 'channel-1' };

interface GatewayStub {
  modelAllowlist: ReturnType<typeof vi.fn>;
  resolveVisibleModel: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
}

function controllerWith(result?: ExecuteResult): {
  controller: GatewayCreateController;
  gateway: GatewayStub;
} {
  const gateway: GatewayStub = {
    modelAllowlist: vi.fn().mockResolvedValue([]),
    resolveVisibleModel: vi.fn().mockResolvedValue(modelRow()),
    execute: vi.fn().mockResolvedValue(result),
  };
  return {
    controller: new GatewayCreateController(gateway as unknown as GatewayService),
    gateway,
  };
}

function taskResult(
  overrides: Partial<Extract<ExecuteResult, { kind: 'task' }>> = {},
): ExecuteResult {
  return {
    kind: 'task',
    task: taskRow(),
    status: 202,
    servedBy: SERVED,
    warnings: [],
    ...overrides,
  };
}

function errorResult(error: Partial<GatewayError> & Pick<GatewayError, 'code'>): ExecuteResult {
  return {
    kind: 'error',
    error: { message: 'boom', retryable: false, failover: false, ...error },
    warnings: [],
  };
}

const BODY = { model: 'seedance-pro', prompt: 'a cat' };

describe('GatewayCreateController — kind → HTTP dispatch', () => {
  it('POST /v1/videos/generations: kind=task → 202 + Task object', async () => {
    const { controller } = controllerWith(taskResult());
    const res = fakeRes();
    const body = await controller.createVideo({ ...BODY }, fakeReq(), res);
    expect(res.statusCode).toBe(202);
    expect(body).toMatchObject({
      id: 'task-1',
      object: 'task',
      type: 'video.generation',
      status: 'pending',
      model: 'seedance-pro',
    });
  });

  it('kind=sync (fast model) → 200 with the sync wire body', async () => {
    const { controller } = controllerWith({
      kind: 'sync',
      response: {
        operation: 'images.generation',
        model: 'seedance-pro',
        output: { url: 'https://x/y.png' },
        usage: { metrics: { images: 1 }, billingDims: { resolution: '720p' }, estimated: false },
        servedBy: SERVED,
        warnings: [],
      },
      warnings: [],
    });
    const res = fakeRes();
    const body = await controller.createTask(
      { model: 'seedance-pro', type: 'images.generation', prompt: 'a cat' },
      fakeReq(),
      res,
    );
    expect(res.statusCode).toBe(200); // untouched — @HttpCode(200) is the wire default
    expect(body).toMatchObject({
      operation: 'images.generation',
      output: { url: 'https://x/y.png' },
      usage: { billing_dims: { resolution: '720p' }, estimated: false },
      served_by: { offering_id: 'offering-1', channel_id: 'channel-1' },
    });
  });

  it('§3 自动升格: a slow images model answers kind=task → 202 (controller never re-judges)', async () => {
    const { controller, gateway } = controllerWith(
      taskResult({ task: taskRow({ operation: 'images.generation' }) }),
    );
    const res = fakeRes();
    const body = await controller.createTask(
      { model: 'seedance-pro', type: 'images.generation', prompt: 'a cat' },
      fakeReq(),
      res,
    );
    expect(res.statusCode).toBe(202);
    expect(body).toMatchObject({ object: 'task', type: 'images.generation' });
    // the operation reached the engine verbatim from body.type
    const request = gateway.execute.mock.calls[0]?.[0] as { operation: string };
    expect(request.operation).toBe('images.generation');
  });

  it('kind=task with a direct runner fires it and still answers 202', async () => {
    const run = vi.fn().mockResolvedValue(taskRow({ status: 'succeeded' }));
    const { controller } = controllerWith(taskResult({ run }));
    const res = fakeRes();
    await controller.createVideo({ ...BODY }, fakeReq(), res);
    expect(res.statusCode).toBe(202);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('kind=replay: 202 while live, 200 once terminal (§5 同键同体回放)', async () => {
    const live = controllerWith({
      kind: 'replay',
      task: taskRow({ status: 'running' }),
      warnings: [],
    });
    const resLive = fakeRes();
    await live.controller.createVideo({ ...BODY }, fakeReq(), resLive);
    expect(resLive.statusCode).toBe(202);

    const done = controllerWith({
      kind: 'replay',
      task: taskRow({ status: 'succeeded' }),
      warnings: [],
    });
    const resDone = fakeRes();
    const body = await done.controller.createVideo({ ...BODY }, fakeReq(), resDone);
    expect(resDone.statusCode).toBe(200);
    expect(body).toMatchObject({ status: 'succeeded' });
  });

  it('kind=stream → SSE frames written and stream closed', async () => {
    async function* frames(): AsyncGenerator<StreamFrame> {
      await Promise.resolve();
      yield { kind: 'delta', payload: 'hel' };
      yield { kind: 'done', usage: { metrics: {}, billingDims: {}, estimated: false } };
    }
    const { controller } = controllerWith({
      kind: 'stream',
      firstFrame: { kind: 'delta', payload: 'hel' },
      frames: frames(),
      servedBy: SERVED,
      warnings: [],
    });
    const res = fakeRes();
    const body = await controller.createVideo({ ...BODY }, fakeReq(), res);
    expect(body).toBeUndefined();
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.chunks.join('')).toContain('event: delta');
    expect(res.chunks.join('')).toContain('event: done');
    expect(res.writableEnded).toBe(true);
  });
});

describe('GatewayCreateController — §9.3 error mapping', () => {
  const cases: [GatewayError['code'], number][] = [
    ['conflict', 409],
    ['rate_limited', 429],
    ['model_not_found', 404],
    ['insufficient_credits', 402],
    ['unsupported_parameter', 400],
  ];
  for (const [code, status] of cases) {
    it(`${code} → ${String(status)}`, async () => {
      const { controller } = controllerWith(errorResult({ code }));
      const res = fakeRes();
      await controller.createVideo({ ...BODY }, fakeReq(), res);
      expect(res.statusCode).toBe(status);
      expect(res.body).toMatchObject({ error: { code, failover: false } });
      expect((res.body as { error: { request_id?: string } }).error.request_id).toBeTruthy();
    });
  }

  it('rate_limited carries Retry-After from retryAfterMs (ceil seconds)', async () => {
    const { controller } = controllerWith(
      errorResult({ code: 'rate_limited', retryAfterMs: 2500 }),
    );
    const res = fakeRes();
    await controller.createVideo({ ...BODY }, fakeReq(), res);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('3');
    expect(res.body).toMatchObject({ error: { retry_after_ms: 2500 } });
  });
});

describe('GatewayCreateController — pre-execute gates', () => {
  it('§2.6 key model-allowlist excludes the model → 404 model_not_found, engine never called', async () => {
    const { controller, gateway } = controllerWith();
    gateway.modelAllowlist.mockResolvedValue(['some-other-model']);
    const res = fakeRes();
    await controller.createVideo({ ...BODY }, fakeReq(), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: { code: 'model_not_found' } });
    expect(gateway.execute).not.toHaveBeenCalled();
  });

  it('unknown/invisible model → 404 model_not_found', async () => {
    const { controller, gateway } = controllerWith();
    gateway.resolveVisibleModel.mockResolvedValue(undefined);
    const res = fakeRes();
    await controller.createVideo({ ...BODY }, fakeReq(), res);
    expect(res.statusCode).toBe(404);
    expect(gateway.execute).not.toHaveBeenCalled();
  });

  it('operation not exposed by the model → 400 invalid_input', async () => {
    const { controller, gateway } = controllerWith();
    const res = fakeRes();
    await controller.createMusic({ ...BODY }, fakeReq(), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'invalid_input' } });
    expect(gateway.execute).not.toHaveBeenCalled();
  });

  it('facade rejection (missing required param) → 400, engine never called', async () => {
    const { controller, gateway } = controllerWith();
    const res = fakeRes();
    await controller.createVideo({ model: 'seedance-pro' }, fakeReq(), res);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { message: string } }).error.message).toContain("'prompt'");
    expect(gateway.execute).not.toHaveBeenCalled();
  });

  it('the dev x-tenant-id fallback (apiKeyId null) is rejected with 401', async () => {
    const { controller, gateway } = controllerWith();
    const res = fakeRes();
    await controller.createVideo({ ...BODY }, fakeReq({ auth: { ...AUTH, apiKeyId: null } }), res);
    expect(res.statusCode).toBe(401);
    expect(gateway.execute).not.toHaveBeenCalled();
  });
});

describe('GatewayCreateController — §5 idempotency + §10 deprecation', () => {
  it('threads Idempotency-Key + body fingerprint into the IR', async () => {
    const { controller, gateway } = controllerWith(taskResult());
    const res = fakeRes();
    const body = { ...BODY };
    await controller.createVideo(body, fakeReq({ headers: { 'idempotency-key': 'idem-9' } }), res);
    const request = gateway.execute.mock.calls[0]?.[0] as {
      idempotency?: { key: string; bodyFingerprint: string };
    };
    expect(request.idempotency?.key).toBe('idem-9');
    expect(request.idempotency?.bodyFingerprint).toBe(fingerprintBody(body));
  });

  it('conflict from the engine (same key, different body) → 409', async () => {
    const { controller } = controllerWith(errorResult({ code: 'conflict' }));
    const res = fakeRes();
    await controller.createVideo(
      { ...BODY },
      fakeReq({ headers: { 'idempotency-key': 'idem-9' } }),
      res,
    );
    expect(res.statusCode).toBe(409);
  });

  it('a deprecated model stamps the §10 headers on the 202', async () => {
    const { controller } = controllerWith(
      taskResult({ deprecation: { model: 'seedance-pro', status: 'deprecated' } }),
    );
    const res = fakeRes();
    await controller.createVideo({ ...BODY }, fakeReq(), res);
    expect(res.statusCode).toBe(202);
    expect(res.headers.deprecation).toBe('true');
    expect(res.headers['x-actionow-model-deprecated']).toBe('seedance-pro');
  });

  it('passes accountId/keyRpm/routeGroup into the execute options', async () => {
    const { controller, gateway } = controllerWith(taskResult());
    const res = fakeRes();
    await controller.createVideo(
      { ...BODY },
      fakeReq({ auth: { ...AUTH, rateLimit: 60, routeGroupId: 'rg-1' } }),
      res,
    );
    expect(gateway.execute.mock.calls[0]?.[1]).toMatchObject({
      accountId: 'acct-1',
      keyRpm: 60,
      routeGroupId: 'rg-1',
    });
  });

  it('批次6 P5: the auth limit-plan bindings ride execute(opts.limits)', async () => {
    const { controller, gateway } = controllerWith(taskResult());
    const res = fakeRes();
    await controller.createVideo(
      { ...BODY },
      fakeReq({
        auth: {
          ...AUTH,
          limitPlanId: 'plan-key',
          tenantLimitPlanId: 'plan-tenant',
          subjectLimitPlanId: 'plan-subject',
        },
      }),
      res,
    );
    expect(gateway.execute.mock.calls[0]?.[1]).toMatchObject({
      limits: {
        keyLimitPlanId: 'plan-key',
        tenantLimitPlanId: 'plan-tenant',
        subjectLimitPlanId: 'plan-subject',
      },
    });
  });
});
