import { AdapterError, type ProviderAdapter } from '@actionow/adapters';
import type { ChatResponse, PollResult, SubmitResult, UnifiedError } from '@actionow/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The service calls these as imported module functions — stub them per test.
const getResource = vi.fn();
const listChannels = vi.fn();
const getPluginVersion = vi.fn();
vi.mock('@actionow/db', () => ({ getResource, listChannels, getPluginVersion }));

const { ModelTestService } = await import('../src/admin/model-test.service.js');

/** A code channel pointing at a generic provider (no plugin binding). */
const CHANNEL = {
  id: 'ch1',
  providerType: 'openai',
  model: null,
  endpoint: null,
  config: null,
  credentialRef: 'cred1',
  proxyRef: null,
  pluginId: null,
  pluginVersion: null,
};

/** Build the service with a single fake adapter resolved for every providerType. */
function makeService(adapter: Partial<ProviderAdapter>): InstanceType<typeof ModelTestService> {
  const full: ProviderAdapter = {
    providerType: 'fake',
    submit: vi.fn(),
    extractUsage: () => ({}),
    mapError: () => ({ code: 'internal_error', message: 'x', retryable: false }),
    ...adapter,
  };
  const adapters = { get: () => full } as never;
  const secrets = { resolve: vi.fn().mockResolvedValue('sk-test') } as never;
  const env = {} as never;
  const http = {} as never;
  return new ModelTestService({} as never, adapters, secrets, env, http);
}

function chatResponse(text: string): ChatResponse {
  return {
    message: { role: 'assistant', content: text === '' ? [] : [{ kind: 'text', text }] },
    stopReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function adapterError(code: UnifiedError['code'], message = 'boom'): AdapterError {
  return new AdapterError({ code, message, retryable: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  getPluginVersion.mockReset();
});

describe('ModelTestService — chat probe', () => {
  beforeEach(() => {
    getResource.mockResolvedValue({ id: 'r1', modality: 'chat' });
    listChannels.mockResolvedValue([CHANNEL]);
  });

  it('passes BOTH legs on a non-empty completion and returns a text sample', async () => {
    const chat = vi.fn().mockResolvedValue(chatResponse('ok'));
    const svc = makeService({ chat });
    const res = await svc.test({ resourceId: 'r1', model: 'gpt-x' });

    expect(res.connectivity.ok).toBe(true);
    expect(res.functional.ok).toBe(true);
    expect(res.sample?.text).toBe('ok');
    expect(res.channelId).toBe('ch1');
    expect(res.modality).toBe('chat');
    // The candidate model name flows into the IR when the channel pins none.
    const ir = chat.mock.calls.at(0)?.[0] as { model: string } | undefined;
    expect(ir?.model).toBe('gpt-x');
  });

  it('passes connectivity but FAILS functional on an empty completion', async () => {
    const svc = makeService({ chat: vi.fn().mockResolvedValue(chatResponse('')) });
    const res = await svc.test({ resourceId: 'r1', model: 'gpt-x' });
    expect(res.connectivity.ok).toBe(true);
    expect(res.functional.ok).toBe(false);
  });

  it('FAILS connectivity (code unauthorized) when the adapter throws unauthorized', async () => {
    const svc = makeService({
      chat: vi.fn().mockRejectedValue(adapterError('unauthorized', 'bad key')),
    });
    const res = await svc.test({ resourceId: 'r1', model: 'gpt-x' });
    expect(res.connectivity.ok).toBe(false);
    expect(res.connectivity.code).toBe('unauthorized');
    expect(res.functional.ok).toBe(false);
  });

  it('PASSES connectivity but fails functional when the upstream errors (reached + authed)', async () => {
    const svc = makeService({ chat: vi.fn().mockRejectedValue(adapterError('content_filtered')) });
    const res = await svc.test({ resourceId: 'r1', model: 'gpt-x' });
    expect(res.connectivity.ok).toBe(true);
    expect(res.functional.ok).toBe(false);
    expect(res.functional.code).toBe('content_filtered');
  });

  it('FAILS connectivity on a raw transport error (egress failure, not an AdapterError)', async () => {
    const svc = makeService({ chat: vi.fn().mockRejectedValue(new Error('ECONNRESET')) });
    const res = await svc.test({ resourceId: 'r1', model: 'gpt-x' });
    expect(res.connectivity.ok).toBe(false);
    expect(res.connectivity.message).toContain('could not reach upstream');
  });

  it('aggregates a stream-only adapter (no chat, has streamChat)', async () => {
    async function* streamChat(): AsyncIterable<{ type: 'content_delta'; text: string }> {
      await Promise.resolve();
      yield { type: 'content_delta', text: 'co' };
      yield { type: 'content_delta', text: 'dex' };
    }
    const svc = makeService({ streamChat: streamChat as never });
    const res = await svc.test({ resourceId: 'r1', model: 'gpt-x' });
    expect(res.functional.ok).toBe(true);
    expect(res.sample?.text).toBe('codex');
  });

  it('fails BOTH legs when the provider supports neither chat nor streamChat', async () => {
    // The base fake adapter has no chat/streamChat → the "neither" case.
    const svc = makeService({});
    const res = await svc.test({ resourceId: 'r1', model: 'gpt-x' });
    expect(res.connectivity.ok).toBe(false);
    expect(res.functional.ok).toBe(false);
  });
});

describe('ModelTestService — media probe', () => {
  beforeEach(() => {
    getResource.mockResolvedValue({ id: 'r1', modality: 'image' });
    listChannels.mockResolvedValue([{ ...CHANNEL, providerType: 'async-media' }]);
  });

  const asyncHandle: SubmitResult = {
    kind: 'async',
    provider: 'async-media',
    upstreamJobId: 'job1',
  };

  it('passes BOTH legs when the async job completes with an asset', async () => {
    const succeeded: PollResult = {
      status: 'succeeded',
      mediaResult: {
        kind: 'media',
        assets: [
          { role: 'primary', modality: 'image', url: 'https://cdn/x.png', mime: 'image/png' },
        ],
        usage: {},
      },
    };
    const svc = makeService({
      submit: vi.fn().mockResolvedValue(asyncHandle),
      poll: vi.fn().mockResolvedValue(succeeded),
    });
    vi.useFakeTimers();
    const p = svc.test({ resourceId: 'r1', model: 'sd-x' });
    await vi.advanceTimersByTimeAsync(2500);
    const res = await p;
    vi.useRealTimers();

    expect(res.connectivity.ok).toBe(true);
    expect(res.functional.ok).toBe(true);
    expect(res.sample?.url).toBe('https://cdn/x.png');
  });

  it('passes connectivity but FAILS functional when the job fails', async () => {
    const failed: PollResult = {
      status: 'failed',
      error: { code: 'job_failed', message: 'nsfw', retryable: false },
    };
    const svc = makeService({
      submit: vi.fn().mockResolvedValue(asyncHandle),
      poll: vi.fn().mockResolvedValue(failed),
    });
    vi.useFakeTimers();
    const p = svc.test({ resourceId: 'r1', model: 'sd-x' });
    await vi.advanceTimersByTimeAsync(2500);
    const res = await p;
    vi.useRealTimers();

    expect(res.connectivity.ok).toBe(true);
    expect(res.functional.ok).toBe(false);
    expect(res.functional.code).toBe('job_failed');
  });

  it('FAILS connectivity when submit throws unauthorized', async () => {
    const svc = makeService({ submit: vi.fn().mockRejectedValue(adapterError('unauthorized')) });
    const res = await svc.test({ resourceId: 'r1', model: 'sd-x' });
    expect(res.connectivity.ok).toBe(false);
    expect(res.connectivity.code).toBe('unauthorized');
  });

  it('passes BOTH legs on a SYNC media result with an asset', async () => {
    const sync: SubmitResult = {
      kind: 'sync',
      output: {},
      usage: {},
      mediaResult: {
        kind: 'media',
        assets: [
          { role: 'primary', modality: 'image', url: 'https://cdn/y.png', mime: 'image/png' },
        ],
        usage: {},
      },
    };
    const svc = makeService({ submit: vi.fn().mockResolvedValue(sync) });
    const res = await svc.test({ resourceId: 'r1', model: 'sd-x' });
    expect(res.connectivity.ok).toBe(true);
    expect(res.functional.ok).toBe(true);
    expect(res.sample?.url).toBe('https://cdn/y.png');
  });
});

describe('ModelTestService — input validation', () => {
  it('throws not_found when the resource does not exist', async () => {
    getResource.mockResolvedValue(undefined);
    const svc = makeService({});
    await expect(svc.test({ resourceId: 'missing', model: 'm' })).rejects.toThrow();
  });

  it('throws invalid_input when the resource has no active channel', async () => {
    getResource.mockResolvedValue({ id: 'r1', modality: 'chat' });
    listChannels.mockResolvedValue([]);
    const svc = makeService({});
    await expect(svc.test({ resourceId: 'r1', model: 'm' })).rejects.toThrow();
  });
});
