// 批次6 D2 — the OpenAI media dialects re-homed onto the NEW supply gateway:
// MediaDialectService over a mocked GatewayService (the chat-v2 test 范式).
// Covers: images sync rendering (canonical MediaResult AND legacy flat
// image_url outputs), the audio binary answer (data: URL fetch), §3 自动升格
// (202 + Task), model-required, and the §5 replay dispositions.
import type { GatewayResponse } from '@actionow/contracts';
import type { ExecuteResult } from '@actionow/engine';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayService } from '../src/gateway/gateway.service.js';
import { MediaDialectService } from '../src/media-dialect/media-dialect.service.js';
import { fakeReq, fakeRes, modelRow, taskRow } from './gateway-fixtures.js';

const MEDIA_MODEL = modelRow({
  name: 'img-x',
  modality: 'image',
  operations: [
    {
      operation: 'images.generation',
      paradigms: ['sync', 'task'],
      slow: false,
      params: [
        { name: 'prompt', type: 'string', billingRelevant: false, required: true },
        { name: 'size', type: 'string', billingRelevant: true, required: false },
      ],
    },
    {
      operation: 'tts',
      paradigms: ['sync'],
      slow: false,
      params: [
        { name: 'prompt', type: 'string', billingRelevant: false, required: true },
        { name: 'voice', type: 'string', billingRelevant: false, required: false },
        { name: 'format', type: 'string', billingRelevant: false, required: false },
        { name: 'speed', type: 'float', billingRelevant: false, required: false },
      ],
    },
  ],
});

function syncResult(operation: GatewayResponse['operation'], output: unknown): ExecuteResult {
  const response: GatewayResponse = {
    operation,
    model: 'img-x',
    output,
    usage: { metrics: { images: 1 }, billingDims: {}, estimated: false },
    servedBy: { offeringId: 'offering-1', channelId: 'channel-1', provider: 'huimeng' },
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
  service: MediaDialectService;
  gateway: GatewayStub;
} {
  const gateway: GatewayStub = {
    modelAllowlist: vi.fn().mockResolvedValue([]),
    resolveVisibleModel: vi.fn().mockResolvedValue(MEDIA_MODEL),
    execute: vi.fn().mockResolvedValue(result),
  };
  return {
    service: new MediaDialectService(gateway as unknown as GatewayService),
    gateway,
  };
}

describe('MediaDialectService — /v1/images/generations over the new gateway', () => {
  it('kind=sync with a canonical MediaResult output → {created, data:[{url}]}', async () => {
    const output = {
      kind: 'media',
      assets: [
        { role: 'primary', modality: 'image', url: 'https://cdn.test/i-0.png', mime: 'image/png' },
        { role: 'primary', modality: 'image', url: 'https://cdn.test/i-1.png', mime: 'image/png' },
      ],
    };
    const { service, gateway } = serviceWith(syncResult('images.generation', output));
    const res = fakeRes();
    const body = await service.images({ model: 'img-x', prompt: 'a cat' }, fakeReq(), res);
    expect(body).toMatchObject({
      data: [{ url: 'https://cdn.test/i-0.png' }, { url: 'https://cdn.test/i-1.png' }],
    });
    expect(res.headers['x-actionow-offering']).toBe('offering-1');
    expect(res.headers['x-actionow-channel']).toBe('huimeng');
    const request = gateway.execute.mock.calls[0]?.[0] as {
      operation: string;
      params: Record<string, unknown>;
    };
    expect(request.operation).toBe('images.generation');
    expect(request.params.prompt).toMatchObject({ value: 'a cat', isDefault: false });
  });

  it('kind=sync with a legacy flat image_url output renders identically', async () => {
    const { service } = serviceWith(
      syncResult('images.generation', { image_url: 'https://up.test/one.png', image_count: 1 }),
    );
    const body = await service.images({ model: 'img-x', prompt: 'a cat' }, fakeReq(), fakeRes());
    expect(body).toMatchObject({ data: [{ url: 'https://up.test/one.png' }] });
  });

  it('a sync output with NO image asset → upstream_error envelope', async () => {
    const { service } = serviceWith(syncResult('images.generation', { nothing: true }));
    const res = fakeRes();
    const body = await service.images({ model: 'img-x', prompt: 'a cat' }, fakeReq(), res);
    expect(body).toBeUndefined();
    expect(res.statusCode).toBe(502);
  });

  it('kind=task (§3 自动升格) → 202 + the Task view', async () => {
    const { service } = serviceWith({
      kind: 'task',
      task: taskRow({ id: 'task-9', status: 'pending' }),
      status: 202,
      servedBy: { offeringId: 'offering-1', channelId: 'channel-1' },
      warnings: [],
    });
    const res = fakeRes();
    const body = await service.images({ model: 'img-x', prompt: 'slow art' }, fakeReq(), res);
    expect(res.statusCode).toBe(202);
    expect(body).toMatchObject({ id: 'task-9', object: 'task' });
  });

  it("a missing 'model' answers a clean 400 (the gateway is model-addressed)", async () => {
    const { service, gateway } = serviceWith();
    const res = fakeRes();
    const body = await service.images({ prompt: 'a cat' }, fakeReq(), res);
    expect(body).toBeUndefined();
    expect(res.statusCode).toBe(400);
    expect(gateway.execute).not.toHaveBeenCalled();
  });

  it('kind=error routes the gateway error into the OpenAI envelope', async () => {
    const { service } = serviceWith({
      kind: 'error',
      error: {
        code: 'insufficient_credits',
        message: 'not enough',
        retryable: false,
        failover: false,
      },
      warnings: [],
    });
    const res = fakeRes();
    await service.images({ model: 'img-x', prompt: 'a cat' }, fakeReq(), res);
    expect(res.statusCode).toBe(402);
  });

  it('§5 replay: a terminal succeeded task re-renders its recorded output', async () => {
    const { service } = serviceWith({
      kind: 'replay',
      task: taskRow({
        status: 'succeeded',
        output: { kind: 'media', assets: [{ modality: 'image', url: 'https://cdn.test/r.png' }] },
      }),
      warnings: [],
    });
    const res = fakeRes();
    const body = await service.images({ model: 'img-x', prompt: 'a cat' }, fakeReq(), res);
    expect(body).toMatchObject({ data: [{ url: 'https://cdn.test/r.png' }] });
  });
});

describe('MediaDialectService — /v1/audio/speech over the new gateway', () => {
  it('kind=sync → fetches the audio asset and answers the RAW BYTES', async () => {
    const wav = Buffer.from('RIFFfake-audio');
    const dataUrl = `data:audio/wav;base64,${wav.toString('base64')}`;
    const output = { kind: 'media', assets: [{ modality: 'audio', url: dataUrl }] };
    const { service, gateway } = serviceWith(syncResult('tts', output));
    const res = fakeRes();
    await service.speech({ model: 'img-x', input: 'hello world' }, fakeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('audio/wav');
    const request = gateway.execute.mock.calls[0]?.[0] as {
      operation: string;
      params: Record<string, unknown>;
    };
    expect(request.operation).toBe('tts');
    // OpenAI wire `input` rides as the canonical `prompt` (legacy relay vocabulary).
    expect(request.params.prompt).toMatchObject({ value: 'hello world', isDefault: false });
  });

  it('a sync output with NO audio asset → upstream_error', async () => {
    const { service } = serviceWith(syncResult('tts', { kind: 'media', assets: [] }));
    const res = fakeRes();
    await service.speech({ model: 'img-x', input: 'hi' }, fakeReq(), res);
    expect(res.statusCode).toBe(502);
  });

  it('kind=task → 202 + Task JSON (no binary)', async () => {
    const { service } = serviceWith({
      kind: 'task',
      task: taskRow({ id: 'task-tts', status: 'pending' }),
      status: 202,
      servedBy: { offeringId: 'offering-1', channelId: 'channel-1' },
      warnings: [],
    });
    const res = fakeRes();
    await service.speech({ model: 'img-x', input: 'hi' }, fakeReq(), res);
    expect(res.statusCode).toBe(202);
  });
});
