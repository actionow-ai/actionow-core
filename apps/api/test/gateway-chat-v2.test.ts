// 批次5 slice3 — 切换预案③ tests: (1) GatewayChatV2Service end-to-end over a
// mocked GatewayService (sync/stream/replay/task/error dispatch, OpenAI error
// envelope, pre-execute gates), (2) the old controllers' ENTRY flag branch
// (flag=true → new gateway; flag=false → the untouched legacy relay;
// per-tenant split).
import type { ChatResponse, GatewayResponse, StreamFrame } from '@actionow/contracts';
import type { Database } from '@actionow/db';
import type { ExecuteResult } from '@actionow/engine';
import type { AppEnv } from '@actionow/infra';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { AuthService } from '../src/auth/auth.service.js';
import type { ChatRelayService } from '../src/chat/chat-relay.service.js';
import type { EmbedRelayService } from '../src/chat/embed-relay.service.js';
import { EmbeddingsController } from '../src/chat/embeddings.controller.js';
import { OpenAIChatController } from '../src/chat/openai.controller.js';
import { GatewayChatV2Service } from '../src/gateway/chat-v2.service.js';
import type { GatewayService } from '../src/gateway/gateway.service.js';
import { AUTH, fakeReq, fakeRes, modelRow, taskRow } from './gateway-fixtures.js';

// --- fixtures -----------------------------------------------------------------------

const CHAT_MODEL = modelRow({
  name: 'gpt-test',
  modality: 'text',
  operations: [
    {
      operation: 'chat.completions',
      paradigms: ['sync', 'stream'],
      slow: false,
      params: [{ name: 'messages', type: 'json', billingRelevant: false, required: true }],
    },
    {
      operation: 'embeddings',
      paradigms: ['sync'],
      slow: false,
      params: [{ name: 'input', type: 'json', billingRelevant: false, required: true }],
    },
  ],
});

const CHAT_BODY = { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] };

function syncChatResult(): ExecuteResult {
  const response: GatewayResponse = {
    operation: 'chat.completions',
    model: 'gpt-test',
    output: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: { metrics: { input_tokens: 3, output_tokens: 2 }, billingDims: {}, estimated: false },
    servedBy: { offeringId: 'offering-1', channelId: 'channel-1', provider: 'openai' },
    warnings: [],
  };
  return { kind: 'sync', response, warnings: [] };
}

interface GatewayStub {
  modelAllowlist: ReturnType<typeof vi.fn>;
  resolveVisibleModel: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
}

function serviceWith(result?: ExecuteResult): {
  service: GatewayChatV2Service;
  gateway: GatewayStub;
} {
  const gateway: GatewayStub = {
    modelAllowlist: vi.fn().mockResolvedValue([]),
    resolveVisibleModel: vi.fn().mockResolvedValue(CHAT_MODEL),
    execute: vi.fn().mockResolvedValue(result),
  };
  const service = new GatewayChatV2Service(
    {} as Database,
    {} as AppEnv,
    gateway as unknown as GatewayService,
  );
  return { service, gateway };
}

// --- the v2 service ---------------------------------------------------------------------

describe('GatewayChatV2Service — chat completions over the new gateway', () => {
  it('kind=sync → 200 chat.completion with servedBy headers', async () => {
    const { service, gateway } = serviceWith(syncChatResult());
    const res = fakeRes();
    const body = await service.completions({ ...CHAT_BODY }, fakeReq(), res);
    expect(body).toMatchObject({
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    expect(res.headers['x-actionow-offering']).toBe('offering-1');
    expect(res.headers['x-actionow-channel']).toBe('openai');
    const request = gateway.execute.mock.calls[0]?.[0] as {
      operation: string;
      params: Record<string, unknown>;
    };
    expect(request.operation).toBe('chat.completions');
    expect(request.params.messages).toMatchObject({ isDefault: false });
    expect(gateway.execute.mock.calls[0]?.[1]).toMatchObject({ accountId: 'acct-1' });
  });

  it('kind=stream → OpenAI chunk SSE ending [DONE]', async () => {
    async function* frames(): AsyncGenerator<StreamFrame> {
      await Promise.resolve();
      yield { kind: 'delta', payload: 'hel' };
      yield {
        kind: 'done',
        usage: {
          metrics: { input_tokens: 1, output_tokens: 1 },
          billingDims: {},
          estimated: false,
        },
      };
    }
    const { service } = serviceWith({
      kind: 'stream',
      firstFrame: { kind: 'delta', payload: 'hel' },
      frames: frames(),
      servedBy: { offeringId: 'offering-1', channelId: 'channel-1' },
      warnings: [],
    });
    const res = fakeRes();
    const body = await service.completions({ ...CHAT_BODY, stream: true }, fakeReq(), res);
    expect(body).toBeUndefined();
    expect(res.headers['content-type']).toBe('text/event-stream');
    const wire = res.chunks.join('');
    expect(wire).toContain('"object":"chat.completion.chunk"');
    expect(wire).toContain('"content":"hel"');
    expect(wire).toContain('data: [DONE]');
    expect(res.writableEnded).toBe(true);
  });

  it('kind=error → the OpenAI error envelope (429 + Retry-After)', async () => {
    const { service } = serviceWith({
      kind: 'error',
      error: {
        code: 'rate_limited',
        message: 'slow down',
        retryable: true,
        failover: false,
        retryAfterMs: 3000,
      },
      warnings: [],
    });
    const res = fakeRes();
    await service.completions({ ...CHAT_BODY }, fakeReq(), res);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('3');
    expect(res.body).toMatchObject({
      error: { type: 'rate_limit_error', code: 'rate_limited' },
    });
  });

  it('§5 replay: succeeded re-renders the recorded output as chat.completion (200)', async () => {
    const { service } = serviceWith({
      kind: 'replay',
      task: taskRow({
        status: 'succeeded',
        operation: 'chat.completions',
        output: [{ message: { role: 'assistant', content: 'again' }, finish_reason: 'stop' }],
        usage: {
          metrics: { input_tokens: 1, output_tokens: 1 },
          billingDims: {},
          estimated: false,
        },
      }),
      warnings: [],
    });
    const res = fakeRes();
    const body = await service.completions({ ...CHAT_BODY }, fakeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({
      object: 'chat.completion',
      choices: [{ message: { content: 'again' } }],
    });
  });

  it('§5 replay: a still-live original answers 409 (no 202 vocabulary on a sync surface)', async () => {
    const { service } = serviceWith({
      kind: 'replay',
      task: taskRow({ status: 'running', operation: 'chat.completions' }),
      warnings: [],
    });
    const res = fakeRes();
    await service.completions({ ...CHAT_BODY }, fakeReq(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'conflict' } });
  });

  it('kind=task (§3 slow-marked auto-upgrade) → 202 + Task object', async () => {
    const { service } = serviceWith({
      kind: 'task',
      task: taskRow({ operation: 'chat.completions' }),
      status: 202,
      servedBy: { offeringId: 'offering-1', channelId: 'channel-1' },
      warnings: [],
    });
    const res = fakeRes();
    const body = await service.completions({ ...CHAT_BODY }, fakeReq(), res);
    expect(res.statusCode).toBe(202);
    expect(body).toMatchObject({ object: 'task', type: 'chat.completions' });
  });

  it('§2.6 allowlist exclusion → 404 model_not_found, engine never called', async () => {
    const { service, gateway } = serviceWith();
    gateway.modelAllowlist.mockResolvedValue(['other-model']);
    const res = fakeRes();
    await service.completions({ ...CHAT_BODY }, fakeReq(), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({
      error: { code: 'model_not_found', type: 'invalid_request_error' },
    });
    expect(gateway.execute).not.toHaveBeenCalled();
  });

  it('unknown/invisible model → 404; model without the operation → 400', async () => {
    const missing = serviceWith();
    missing.gateway.resolveVisibleModel.mockResolvedValue(undefined);
    const res404 = fakeRes();
    await missing.service.completions({ ...CHAT_BODY }, fakeReq(), res404);
    expect(res404.statusCode).toBe(404);

    const noOp = serviceWith();
    noOp.gateway.resolveVisibleModel.mockResolvedValue(
      modelRow({ name: 'gpt-test' }), // video-only operations
    );
    const res400 = fakeRes();
    await noOp.service.completions({ ...CHAT_BODY }, fakeReq(), res400);
    expect(res400.statusCode).toBe(400);
    expect(res400.body).toMatchObject({ error: { code: 'invalid_input' } });
  });

  it('facade rejection (missing messages) → 400, engine never called', async () => {
    const { service, gateway } = serviceWith();
    const res = fakeRes();
    await service.completions({ model: 'gpt-test' }, fakeReq(), res);
    expect(res.statusCode).toBe(400);
    expect(gateway.execute).not.toHaveBeenCalled();
  });

  it('the dev x-tenant-id fallback (apiKeyId null) is rejected with an OpenAI 401', async () => {
    const { service, gateway } = serviceWith();
    const res = fakeRes();
    await service.completions(
      { ...CHAT_BODY },
      fakeReq({ auth: { ...AUTH, apiKeyId: null } }),
      res,
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: { type: 'authentication_error' } });
    expect(gateway.execute).not.toHaveBeenCalled();
  });
});

describe('GatewayChatV2Service — embeddings over the new gateway', () => {
  it('kind=sync → the OpenAI list shape', async () => {
    const response: GatewayResponse = {
      operation: 'embeddings',
      model: 'gpt-test',
      output: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
      usage: { metrics: { input_tokens: 4 }, billingDims: {}, estimated: false },
      servedBy: { offeringId: 'offering-1', channelId: 'channel-1' },
      warnings: [],
    };
    const { service, gateway } = serviceWith({ kind: 'sync', response, warnings: [] });
    const res = fakeRes();
    const body = await service.embeddings({ model: 'gpt-test', input: 'hi' }, fakeReq(), res);
    expect(body).toEqual({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
      model: 'gpt-test',
      usage: { prompt_tokens: 4, total_tokens: 4 },
    });
    const request = gateway.execute.mock.calls[0]?.[0] as { operation: string };
    expect(request.operation).toBe('embeddings');
  });
});

// --- the controller entry branch (双面并存) ------------------------------------------------

interface V2Stub {
  isV2Tenant: ReturnType<typeof vi.fn>;
  completions: ReturnType<typeof vi.fn>;
  embeddings: ReturnType<typeof vi.fn>;
}

function v2Stub(flag: (tenantId: string) => boolean): V2Stub {
  return {
    isV2Tenant: vi.fn().mockImplementation((tenantId: string) => Promise.resolve(flag(tenantId))),
    completions: vi.fn().mockResolvedValue({ object: 'chat.completion', served: 'v2' }),
    embeddings: vi.fn().mockResolvedValue({ object: 'list', served: 'v2' }),
  };
}

const IR_RESPONSE: ChatResponse = {
  message: { role: 'assistant', content: [{ kind: 'text', text: 'old world' }] },
  stopReason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};

describe('OpenAIChatController — 预案③ entry flag branch', () => {
  function controllerWith(flag: (tenantId: string) => boolean): {
    controller: OpenAIChatController;
    relay: { chat: ReturnType<typeof vi.fn>; chatStream: ReturnType<typeof vi.fn> };
    v2: V2Stub;
  } {
    const relay = {
      chat: vi.fn().mockResolvedValue({
        response: IR_RESPONSE,
        servedBy: { providerType: 'openai' },
        servedModel: undefined,
      }),
      chatStream: vi.fn(),
    };
    const v2 = v2Stub(flag);
    const controller = new OpenAIChatController(
      relay as unknown as ChatRelayService,
      new AuthService(),
      v2 as unknown as GatewayChatV2Service,
    );
    return { controller, relay, v2 };
  }

  it('flag=true routes to the new gateway; the legacy relay is never touched', async () => {
    const { controller, relay, v2 } = controllerWith(() => true);
    const res = fakeRes();
    const body = await controller.completions({ ...CHAT_BODY }, fakeReq(), res);
    expect(v2.completions).toHaveBeenCalledTimes(1);
    expect(relay.chat).not.toHaveBeenCalled();
    expect(body).toMatchObject({ served: 'v2' });
  });

  it('flag=false rides the untouched legacy relay; the new gateway is never touched', async () => {
    const { controller, relay, v2 } = controllerWith(() => false);
    const res = fakeRes();
    const body = await controller.completions({ ...CHAT_BODY }, fakeReq(), res);
    expect(v2.completions).not.toHaveBeenCalled();
    expect(relay.chat).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ object: 'chat.completion' });
    expect(res.headers['x-actionow-channel']).toBe('openai');
  });

  it('splits PER TENANT (预案②: one flag, two worlds in the same process)', async () => {
    const { controller, relay, v2 } = controllerWith((tenantId) => tenantId === 'tenant-v2');
    await controller.completions(
      { ...CHAT_BODY },
      fakeReq({ auth: { ...AUTH, tenantId: 'tenant-v2' } }),
      fakeRes(),
    );
    expect(v2.completions).toHaveBeenCalledTimes(1);
    expect(relay.chat).not.toHaveBeenCalled();

    await controller.completions(
      { ...CHAT_BODY },
      fakeReq({ auth: { ...AUTH, tenantId: 'tenant-old' } }),
      fakeRes(),
    );
    expect(relay.chat).toHaveBeenCalledTimes(1);
    expect(v2.completions).toHaveBeenCalledTimes(1); // unchanged
  });
});

describe('EmbeddingsController — 预案③ entry flag branch', () => {
  function controllerWith(flag: boolean): {
    controller: EmbeddingsController;
    relay: { embed: ReturnType<typeof vi.fn> };
    v2: V2Stub;
  } {
    const relay = {
      embed: vi.fn().mockResolvedValue({
        result: { vectors: [[0.5]], usage: { inputTokens: 2 } },
        servedBy: { providerType: 'openai' },
      }),
    };
    const v2 = v2Stub(() => flag);
    const controller = new EmbeddingsController(
      relay as unknown as EmbedRelayService,
      new AuthService(),
      v2 as unknown as GatewayChatV2Service,
    );
    return { controller, relay, v2 };
  }

  const EMBED_IR = { model: 'embed-test', input: 'hi' };

  it('flag=true routes the RAW req.body to the new gateway', async () => {
    const { controller, relay, v2 } = controllerWith(true);
    const req = fakeReq();
    const raw = { model: 'embed-test', input: 'hi', encoding_format: 'float' };
    (req as Request & { body?: unknown }).body = raw;
    const body = await controller.create(EMBED_IR, req, fakeRes());
    expect(v2.embeddings).toHaveBeenCalledWith(raw, req, expect.anything());
    expect(relay.embed).not.toHaveBeenCalled();
    expect(body).toMatchObject({ served: 'v2' });
  });

  it('flag=false rides the untouched legacy embed relay', async () => {
    const { controller, relay, v2 } = controllerWith(false);
    const res = fakeRes();
    const body = await controller.create(EMBED_IR, fakeReq(), res);
    expect(v2.embeddings).not.toHaveBeenCalled();
    expect(relay.embed).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({
      object: 'list',
      usage: { prompt_tokens: 2, total_tokens: 2 },
    });
  });
});
