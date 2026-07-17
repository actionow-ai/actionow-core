// 批次5 slice6 (坍缩于批次6 D2) — tests for the five dialect faces:
// (1) GatewayChatV2Service dispatch over a mocked GatewayService for
// anthropic/gemini/rerank/moderations/transcriptions (sync/stream/replay/error,
// per-dialect error envelopes, the §9.4 transcriptions media input), and
// (2) the collapsed controllers delegate every request to the new gateway
// unconditionally (the gray-release branch died with the legacy relay world).
import { Buffer } from 'node:buffer';

import type { GatewayResponse, StreamFrame } from '@actionow/contracts';
import type { ExecuteResult } from '@actionow/engine';
import type { AppEnv } from '@actionow/infra';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { AnthropicChatController } from '../src/chat/anthropic.controller.js';
import { GeminiChatController } from '../src/chat/gemini.controller.js';
import { ModerationsController } from '../src/chat/moderations.controller.js';
import { RerankController } from '../src/chat/rerank.controller.js';
import { TranscriptionsController } from '../src/chat/transcriptions.controller.js';
import { GatewayChatV2Service } from '../src/gateway/chat-v2.service.js';
import type { GatewayService } from '../src/gateway/gateway.service.js';
import { AUTH, fakeReq, fakeRes, modelRow, taskRow } from './gateway-fixtures.js';

// --- fixtures -----------------------------------------------------------------------

const V2_MODEL = modelRow({
  name: 'model-x',
  modality: 'text',
  operations: [
    {
      operation: 'chat.completions',
      paradigms: ['sync', 'stream'],
      slow: false,
      params: [{ name: 'messages', type: 'json', billingRelevant: false, required: true }],
    },
    {
      operation: 'rerank',
      paradigms: ['sync'],
      slow: false,
      params: [
        { name: 'query', type: 'string', billingRelevant: false, required: true },
        {
          name: 'documents',
          type: 'string',
          billingRelevant: false,
          required: true,
          multiple: true,
        },
      ],
    },
    {
      operation: 'moderations',
      paradigms: ['sync'],
      slow: false,
      params: [{ name: 'input', type: 'json', billingRelevant: false, required: true }],
    },
    {
      operation: 'asr',
      paradigms: ['sync'],
      slow: false,
      params: [{ name: 'file', type: 'file', billingRelevant: false, required: true }],
    },
  ],
});

function syncResult(operation: GatewayResponse['operation'], output: unknown): ExecuteResult {
  const response: GatewayResponse = {
    operation,
    model: 'model-x',
    output,
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

function serviceWith(
  result?: ExecuteResult,
  env: AppEnv = {} as AppEnv,
): { service: GatewayChatV2Service; gateway: GatewayStub } {
  const gateway: GatewayStub = {
    modelAllowlist: vi.fn().mockResolvedValue([]),
    resolveVisibleModel: vi.fn().mockResolvedValue(V2_MODEL),
    execute: vi.fn().mockResolvedValue(result),
  };
  const service = new GatewayChatV2Service(env, gateway as unknown as GatewayService);
  return { service, gateway };
}

const ANTHROPIC_BODY = {
  model: 'model-x',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'hi' }],
};

const GEMINI_BODY = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };

const CHAT_OUTPUT = [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }];

// --- the v2 service: anthropic /v1/messages ------------------------------------------------

describe('GatewayChatV2Service — anthropic messages over the new gateway', () => {
  it('kind=sync → the Anthropic message JSON + servedBy headers + canonical request', async () => {
    const { service, gateway } = serviceWith(syncResult('chat.completions', CHAT_OUTPUT));
    const res = fakeRes();
    const body = await service.messages({ ...ANTHROPIC_BODY }, fakeReq(), res);
    expect(body).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'model-x',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 2 },
    });
    expect(res.headers['x-actionow-offering']).toBe('offering-1');
    const request = gateway.execute.mock.calls[0]?.[0] as {
      operation: string;
      params: Record<string, { value: unknown }>;
    };
    expect(request.operation).toBe('chat.completions');
    expect(request.params.messages?.value).toEqual([{ role: 'user', content: 'hi' }]);
    expect(request.params.max_tokens?.value).toBe(100);
  });

  it('kind=stream → Anthropic typed SSE (message_start … message_stop, no [DONE])', async () => {
    async function* frames(): AsyncGenerator<StreamFrame> {
      await Promise.resolve();
      yield { kind: 'delta', payload: 'hel' };
      yield {
        kind: 'done',
        usage: { metrics: { output_tokens: 1 }, billingDims: {}, estimated: false },
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
    const body = await service.messages({ ...ANTHROPIC_BODY, stream: true }, fakeReq(), res);
    expect(body).toBeUndefined();
    expect(res.headers['content-type']).toBe('text/event-stream');
    const wire = res.chunks.join('');
    expect(wire).toContain('event: message_start');
    expect(wire).toContain('"text_delta","text":"hel"');
    expect(wire).toContain('event: message_stop');
    expect(wire).not.toContain('[DONE]');
  });

  it('kind=error → the Anthropic error envelope (429 + Retry-After)', async () => {
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
    await service.messages({ ...ANTHROPIC_BODY }, fakeReq(), res);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('3');
    expect(res.body).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'slow down' },
    });
  });

  it('the dev x-tenant-id fallback is rejected with the Anthropic 401 envelope', async () => {
    const { service, gateway } = serviceWith();
    const res = fakeRes();
    await service.messages(
      { ...ANTHROPIC_BODY },
      fakeReq({ auth: { ...AUTH, apiKeyId: null } }),
      res,
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
    expect(gateway.execute).not.toHaveBeenCalled();
  });
});

// --- the v2 service: gemini generateContent -------------------------------------------------

describe('GatewayChatV2Service — gemini generateContent over the new gateway', () => {
  it('kind=sync → candidates + usageMetadata; the URL model feeds the request', async () => {
    const { service, gateway } = serviceWith(syncResult('chat.completions', CHAT_OUTPUT));
    const res = fakeRes();
    const body = await service.generateContent('model-x', { ...GEMINI_BODY }, fakeReq(), res);
    expect(body).toMatchObject({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'hello' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    });
    const request = gateway.execute.mock.calls[0]?.[0] as { model: string; options: unknown };
    expect(request.model).toBe('model-x');
    expect(request.options).toMatchObject({});
  });

  it('streamGenerateContent: kind=stream → alt=sse candidate frames (stream option forced)', async () => {
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
    const { service, gateway } = serviceWith({
      kind: 'stream',
      firstFrame: { kind: 'delta', payload: 'hel' },
      frames: frames(),
      servedBy: { offeringId: 'offering-1', channelId: 'channel-1' },
      warnings: [],
    });
    const res = fakeRes();
    await service.streamGenerateContent('model-x', { ...GEMINI_BODY }, fakeReq(), res);
    expect(res.headers['content-type']).toBe('text/event-stream');
    const wire = res.chunks.join('');
    expect(wire).toContain('"parts":[{"text":"hel"}]');
    expect(wire).toContain('"finishReason":"STOP"');
    const request = gateway.execute.mock.calls[0]?.[0] as { options: { stream?: boolean } };
    expect(request.options.stream).toBe(true);
  });

  it('streamGenerateContent: a sync answer on the stream endpoint is still written', async () => {
    const { service } = serviceWith(syncResult('chat.completions', CHAT_OUTPUT));
    const res = fakeRes();
    await service.streamGenerateContent('model-x', { ...GEMINI_BODY }, fakeReq(), res);
    expect(res.body).toMatchObject({ candidates: [{ finishReason: 'STOP' }] });
  });

  it('kind=error → the Google error envelope', async () => {
    const { service } = serviceWith({
      kind: 'error',
      error: { code: 'model_not_found', message: 'gone', retryable: false, failover: false },
      warnings: [],
    });
    const res = fakeRes();
    await service.generateContent('model-x', { ...GEMINI_BODY }, fakeReq(), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: { code: 404, message: 'gone', status: 'NOT_FOUND' } });
  });
});

// --- the v2 service: rerank / moderations ---------------------------------------------------

describe('GatewayChatV2Service — rerank/moderations over the new gateway', () => {
  it('rerank kind=sync → the Cohere/Jina wire shape', async () => {
    const { service, gateway } = serviceWith(
      syncResult('rerank', { results: [{ index: 0, relevance_score: 0.9 }] }),
    );
    const res = fakeRes();
    const body = await service.rerank(
      { model: 'model-x', query: 'q', documents: ['a', 'b'] },
      fakeReq(),
      res,
    );
    expect(body).toEqual({
      model: 'model-x',
      results: [{ index: 0, relevance_score: 0.9 }],
      usage: { input_tokens: 3 },
    });
    const request = gateway.execute.mock.calls[0]?.[0] as { operation: string };
    expect(request.operation).toBe('rerank');
  });

  it('rerank §5 replay: succeeded re-renders the recorded output (200)', async () => {
    const { service } = serviceWith({
      kind: 'replay',
      task: taskRow({
        status: 'succeeded',
        operation: 'rerank',
        output: { results: [{ index: 0, relevance_score: 1 }] },
        usage: { metrics: { input_tokens: 2 }, billingDims: {}, estimated: false },
      }),
      warnings: [],
    });
    const res = fakeRes();
    const body = await service.rerank(
      { model: 'model-x', query: 'q', documents: ['a'] },
      fakeReq(),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({ results: [{ index: 0, relevance_score: 1 }] });
  });

  it('moderations kind=sync → the OpenAI moderations wire shape', async () => {
    const { service, gateway } = serviceWith(
      syncResult('moderations', {
        results: [{ flagged: true, categories: { hate: true }, category_scores: { hate: 0.9 } }],
      }),
    );
    const res = fakeRes();
    const body =
      (await service.moderations({ model: 'model-x', input: 'bad' }, fakeReq(), res)) ?? {};
    expect(body.id).toMatch(/^modr-/);
    expect(body.results).toEqual([
      { flagged: true, categories: { hate: true }, category_scores: { hate: 0.9 } },
    ]);
    const request = gateway.execute.mock.calls[0]?.[0] as { operation: string };
    expect(request.operation).toBe('moderations');
  });
});

// --- the v2 service: transcriptions (multipart → asr) ----------------------------------------

describe('GatewayChatV2Service — transcriptions over the new gateway', () => {
  const FILE = {
    buffer: Buffer.from('abc'),
    originalname: 'a.mp3',
    mimetype: 'audio/mpeg',
    size: 3,
  };

  it('kind=sync → json {text}; the audio rides mediaRefs (base64) + the file param', async () => {
    const { service, gateway } = serviceWith(syncResult('asr', { text: 'hello world' }));
    const res = fakeRes();
    const body = await service.transcriptions(FILE, { model: 'model-x' }, fakeReq(), res);
    expect(body).toEqual({ text: 'hello world' });
    const request = gateway.execute.mock.calls[0]?.[0] as {
      operation: string;
      params: Record<string, { value: unknown }>;
      mediaRefs: unknown[];
    };
    expect(request.operation).toBe('asr');
    const base64 = Buffer.from('abc').toString('base64');
    expect(request.params.file?.value).toBe(base64);
    expect(request.mediaRefs).toEqual([
      { param: 'file', source: 'base64', data: base64, mime: 'audio/mpeg' },
    ]);
  });

  it("response_format 'text' → the raw transcript string", async () => {
    const { service } = serviceWith(syncResult('asr', { text: 'hello world' }));
    const res = fakeRes();
    const body = await service.transcriptions(
      FILE,
      { model: 'model-x', response_format: 'text' },
      fakeReq(),
      res,
    );
    expect(body).toBe('hello world');
  });

  it('a missing file part answers 400 without touching the engine', async () => {
    const { service, gateway } = serviceWith();
    const res = fakeRes();
    await service.transcriptions(undefined, { model: 'model-x' }, fakeReq(), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'invalid_input' } });
    expect(gateway.execute).not.toHaveBeenCalled();
  });

  it('the operator STT_MAX_UPLOAD_BYTES ceiling answers 400 below the hard cap', async () => {
    const { service, gateway } = serviceWith(undefined, {
      STT_MAX_UPLOAD_BYTES: 2,
    } as AppEnv);
    const res = fakeRes();
    await service.transcriptions(FILE, { model: 'model-x' }, fakeReq(), res);
    expect(res.statusCode).toBe(400);
    expect(gateway.execute).not.toHaveBeenCalled();
  });
});

// --- the collapsed controllers (批次6 D2: always-new, 7/7) ----------------------------------

interface V2Stub {
  messages: ReturnType<typeof vi.fn>;
  generateContent: ReturnType<typeof vi.fn>;
  streamGenerateContent: ReturnType<typeof vi.fn>;
  rerank: ReturnType<typeof vi.fn>;
  moderations: ReturnType<typeof vi.fn>;
  transcriptions: ReturnType<typeof vi.fn>;
}

function v2Stub(): V2Stub {
  return {
    messages: vi.fn().mockResolvedValue({ type: 'message', served: 'v2' }),
    generateContent: vi.fn().mockResolvedValue({ candidates: [], served: 'v2' }),
    streamGenerateContent: vi.fn().mockResolvedValue(undefined),
    rerank: vi.fn().mockResolvedValue({ results: [], served: 'v2' }),
    moderations: vi.fn().mockResolvedValue({ results: [], served: 'v2' }),
    transcriptions: vi.fn().mockResolvedValue({ text: 'v2' }),
  };
}

describe('the five collapsed dialect controllers delegate to the new gateway', () => {
  it('anthropic /v1/messages → v2.messages', async () => {
    const v2 = v2Stub();
    const controller = new AnthropicChatController(v2 as unknown as GatewayChatV2Service);
    const body = await controller.messages({ ...ANTHROPIC_BODY }, fakeReq(), fakeRes());
    expect(v2.messages).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ served: 'v2' });
  });

  it('gemini generateContent + streamGenerateContent → v2', async () => {
    const v2 = v2Stub();
    const controller = new GeminiChatController(v2 as unknown as GatewayChatV2Service);
    const body = await controller.generateContent(
      'model-x',
      { ...GEMINI_BODY },
      fakeReq(),
      fakeRes(),
    );
    expect(v2.generateContent).toHaveBeenCalledWith(
      'model-x',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(body).toMatchObject({ served: 'v2' });

    await controller.streamGenerateContent('model-x', { ...GEMINI_BODY }, fakeReq(), fakeRes());
    expect(v2.streamGenerateContent).toHaveBeenCalledTimes(1);
  });

  it('rerank → v2.rerank (raw wire body)', async () => {
    const v2 = v2Stub();
    const controller = new RerankController(v2 as unknown as GatewayChatV2Service);
    const raw = { model: 'model-x', query: 'q', documents: ['a'] };
    const body = await controller.create(raw, fakeReq(), fakeRes());
    expect(v2.rerank).toHaveBeenCalledWith(raw, expect.anything(), expect.anything());
    expect(body).toMatchObject({ served: 'v2' });
  });

  it('moderations → v2.moderations (raw wire body)', async () => {
    const v2 = v2Stub();
    const controller = new ModerationsController(v2 as unknown as GatewayChatV2Service);
    const raw = { model: 'model-x', input: 'check me' };
    const body = await controller.create(raw, fakeReq(), fakeRes());
    expect(v2.moderations).toHaveBeenCalledWith(raw, expect.anything(), expect.anything());
    expect(body).toMatchObject({ served: 'v2' });
  });

  it('transcriptions → v2.transcriptions (multipart file + raw text fields)', async () => {
    const v2 = v2Stub();
    const controller = new TranscriptionsController(v2 as unknown as GatewayChatV2Service);
    const file = {
      buffer: Buffer.from('RIFFaudio'),
      originalname: 'a.wav',
      mimetype: 'audio/wav',
      size: 9,
    };
    const req = fakeReq();
    (req as Request & { body?: unknown }).body = { model: 'model-x' };
    const body = await controller.create(file, req, fakeRes());
    expect(v2.transcriptions).toHaveBeenCalledWith(
      file,
      { model: 'model-x' },
      req,
      expect.anything(),
    );
    expect(body).toMatchObject({ text: 'v2' });
  });
});
