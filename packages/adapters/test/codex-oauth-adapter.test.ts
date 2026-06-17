import type { ChatRequest, ChatStreamEvent, HttpClient, HttpRequest } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { codexOAuthAdapter } from '../src/codex-oauth.js';
import { AdapterError } from '../src/errors.js';

const fakeHttp = (
  resp: { status: number; body: unknown },
  cap?: (r: HttpRequest) => void,
): HttpClient => ({
  request: (r: HttpRequest) => {
    cap?.(r);
    return Promise.resolve({
      status: resp.status,
      ok: resp.status < 400,
      body: resp.body,
      text: '',
    });
  },
});

/** Yield canned SSE frames as decoded chunks (mirrors FetchHttpClient.stream). */
function sseLines(frames: string[]): AsyncIterable<string> {
  // eslint-disable-next-line @typescript-eslint/require-await
  return (async function* g(): AsyncIterable<string> {
    for (const f of frames) yield f;
  })();
}

/**
 * A streaming HttpClient — `chat()` is stream-only now, so it reaches
 * `http.stream` (via the adapter's shared transport), never `request`.
 */
const streamingHttp = (
  status: number,
  frames: string[],
  cap?: (r: HttpRequest) => void,
): HttpClient => ({
  request: () => Promise.reject(new Error('codex chat() must stream, not buffer')),
  stream: (r: HttpRequest) => {
    cap?.(r);
    return Promise.resolve({ status, ok: status < 400, lines: sseLines(frames) });
  },
});

const ir: ChatRequest = {
  model: 'gpt-5-codex',
  messages: [
    { role: 'system', content: [{ kind: 'text', text: 'be terse' }] },
    { role: 'user', content: [{ kind: 'text', text: 'hi' }] },
  ],
  tools: [{ name: 'f', parameters: { type: 'object' } }],
};

describe('codexOAuthAdapter.chat', () => {
  it('declares chat capabilities', () => {
    expect(codexOAuthAdapter.capabilities).toEqual({
      tools: true,
      vision: true,
      audio: false,
      json: true,
      stream: true,
    });
  });

  it('rejects submit (chat-only relay)', async () => {
    await expect(
      codexOAuthAdapter.submit({
        resourceId: 'r',
        modality: 'chat',
        inputs: {},
        execMode: 'blocking',
        ctx: { providerType: 'codex-oauth', http: fakeHttp({ status: 200, body: {} }) },
      }),
    ).rejects.toThrow();
  });

  it('streams a Responses-shaped body to the codex backend with cli-impersonation headers', async () => {
    let seen: HttpRequest | undefined;
    // The codex backend is stream-only; chat() streams + aggregates the SSE reply.
    const http = streamingHttp(
      200,
      [
        'event: response.created\ndata: {"type":"response.created"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":7,"output_tokens":3}}}\n\n',
      ],
      (r) => {
        seen = r;
      },
    );
    const res = await codexOAuthAdapter.chat?.(ir, {
      providerType: 'codex-oauth',
      apiKey: 'oat-tok',
      config: { chatgptAccountId: 'acct_1' },
      http,
    });
    if (res === undefined) {
      throw new Error('codex-oauth adapter has no chat()');
    }

    expect(seen?.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(seen?.method).toBe('POST');
    const headers = seen?.headers ?? {};
    expect(headers.Authorization).toBe('Bearer oat-tok');
    expect(headers.Originator).toBe('codex_cli_rs');
    expect(headers['Chatgpt-Account-Id']).toBe('acct_1');
    expect(headers['OpenAI-Beta']).toBe('responses=experimental');
    expect(headers['User-Agent']).toContain('codex_cli_rs');
    expect(headers.version).toBe('0.125.0');
    // The codex backend is stream-only — chat() requests the SSE stream.
    expect(headers.Accept).toBe('text/event-stream');
    expect(headers['Content-Type']).toBe('application/json');

    // Responses-shaped body: store:false, stream:true, input array, system -> instructions.
    expect(seen?.body).toMatchObject({
      store: false,
      stream: true,
      instructions: 'be terse',
    });
    expect(Array.isArray((seen?.body as { input?: unknown }).input)).toBe(true);

    expect(res.message.content).toEqual([{ kind: 'text', text: 'hello' }]);
    expect(res.stopReason).toBe('stop');
    expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it('omits Chatgpt-Account-Id when config has no chatgptAccountId', async () => {
    let seen: HttpRequest | undefined;
    const http = streamingHttp(
      200,
      [
        'event: response.created\ndata: {"type":"response.created"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n',
      ],
      (r) => {
        seen = r;
      },
    );
    await codexOAuthAdapter.chat?.(ir, {
      providerType: 'codex-oauth',
      apiKey: 'oat-tok',
      http,
    });
    expect(seen?.headers?.['Chatgpt-Account-Id']).toBeUndefined();
  });

  it('forwards ctx.proxyUrl onto the http request', async () => {
    let seen: HttpRequest | undefined;
    const http = streamingHttp(
      200,
      [
        'event: response.created\ndata: {"type":"response.created"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n',
      ],
      (r) => {
        seen = r;
      },
    );
    await codexOAuthAdapter.chat?.(ir, {
      providerType: 'codex-oauth',
      apiKey: 'oat-tok',
      proxyUrl: 'http://proxy.local:8080',
      http,
    });
    expect(seen?.proxyUrl).toBe('http://proxy.local:8080');
  });
});

describe('codexOAuthAdapter.listModels', () => {
  /** The canned `GET /models` reply shape the codex backend returns. */
  const modelsBody = {
    models: [
      {
        slug: 'gpt-5.5',
        display_name: 'GPT-5.5',
        description: 'flagship',
        context_window: 272000,
        max_context_window: 272000,
        input_modalities: ['text', 'image'],
        supports_parallel_tool_calls: true,
        visibility: 'list',
        priority: 9,
      },
      {
        slug: 'gpt-5.4-mini',
        display_name: 'GPT-5.4 mini',
        input_modalities: ['text'],
        supports_parallel_tool_calls: false,
      },
    ],
  };

  it('GETs /models with the client_version + cli-impersonation headers and maps the reply', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: modelsBody }, (r) => {
      seen = r;
    });
    const models = await codexOAuthAdapter.listModels?.({
      providerType: 'codex-oauth',
      apiKey: 'oat-tok',
      config: { chatgptAccountId: 'acct_1' },
      http,
    });
    if (models === undefined) {
      throw new Error('codex-oauth adapter has no listModels()');
    }

    // GET the official catalog endpoint with the impersonated client version.
    expect(seen?.method).toBe('GET');
    expect(seen?.url).toBe('https://chatgpt.com/backend-api/codex/models?client_version=0.125.0');
    const headers = seen?.headers ?? {};
    expect(headers.Authorization).toBe('Bearer oat-tok');
    expect(headers.Originator).toBe('codex_cli_rs');
    expect(headers['Chatgpt-Account-Id']).toBe('acct_1');
    expect(headers['OpenAI-Beta']).toBe('responses=experimental');
    expect(String(headers['User-Agent'])).toContain('codex_cli_rs');
    expect(headers.version).toBe('0.125.0');
    expect(headers.Accept).toBe('application/json');

    // Mapped ProviderModel[]: id=slug, capabilities derived from modalities + parallel flag.
    expect(models).toEqual([
      {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: 'flagship',
        contextWindow: 272000,
        capabilities: { vision: true, tools: true, json: true, stream: true, audio: false },
      },
      {
        id: 'gpt-5.4-mini',
        displayName: 'GPT-5.4 mini',
        capabilities: { vision: false, tools: false, json: true, stream: true, audio: false },
      },
    ]);
  });

  it('hits ctx.endpoint/models when a per-channel endpoint is set (loopback sidecar)', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: { models: [] } }, (r) => {
      seen = r;
    });
    await codexOAuthAdapter.listModels?.({
      providerType: 'codex-oauth',
      apiKey: 'oat-tok',
      endpoint: 'http://127.0.0.1:8787/backend-api/codex',
      http,
    });
    expect(seen?.url).toBe('http://127.0.0.1:8787/backend-api/codex/models?client_version=0.125.0');
  });

  it('skips entries with no slug', async () => {
    const http = fakeHttp({
      status: 200,
      body: { models: [{ display_name: 'no slug' }, { slug: 'keep' }] },
    });
    const models = await codexOAuthAdapter.listModels?.({
      providerType: 'codex-oauth',
      apiKey: 'oat-tok',
      http,
    });
    expect(models?.map((m) => m.id)).toEqual(['keep']);
  });

  it('forwards ctx.proxyUrl onto the http request', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: { models: [] } }, (r) => {
      seen = r;
    });
    await codexOAuthAdapter.listModels?.({
      providerType: 'codex-oauth',
      apiKey: 'oat-tok',
      proxyUrl: 'http://proxy.local:8080',
      http,
    });
    expect(seen?.proxyUrl).toBe('http://proxy.local:8080');
  });

  it('throws an AdapterError on a non-ok status', async () => {
    const http = fakeHttp({ status: 401, body: { error: { code: 'unauthorized' } } });
    await expect(
      codexOAuthAdapter.listModels?.({
        providerType: 'codex-oauth',
        apiKey: 'bad',
        http,
      }),
    ).rejects.toThrow(AdapterError);
  });
});

async function drainChat(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('codexOAuthAdapter.streamChat', () => {
  it('consumes a Responses SSE sequence into IR events with text/event-stream Accept', async () => {
    let seen: HttpRequest | undefined;
    // eslint-disable-next-line @typescript-eslint/require-await
    const lines = (async function* g(): AsyncIterable<string> {
      yield 'event: response.created\ndata: {"type":"response.created"}\n\n';
      yield 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hel"}\n\n';
      yield 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lo"}\n\n';
      yield 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n';
    })();
    const http: HttpClient = {
      request: () => Promise.reject(new Error('unused')),
      stream: (r: HttpRequest) => {
        seen = r;
        return Promise.resolve({ status: 200, ok: true, lines });
      },
    };
    const stream = codexOAuthAdapter.streamChat?.(ir, {
      providerType: 'codex-oauth',
      apiKey: 'oat-tok',
      config: { chatgptAccountId: 'acct_1' },
      proxyUrl: 'http://proxy.local:8080',
      http,
    });
    if (stream === undefined) {
      throw new Error('codex-oauth adapter has no streamChat()');
    }
    const events = await drainChat(stream);

    expect(seen?.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(seen?.headers?.Accept).toBe('text/event-stream');
    expect(seen?.headers?.Authorization).toBe('Bearer oat-tok');
    expect(seen?.headers?.['Chatgpt-Account-Id']).toBe('acct_1');
    expect(seen?.proxyUrl).toBe('http://proxy.local:8080');
    expect((seen?.body as { stream?: unknown }).stream).toBe(true);

    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_delta',
      'content_delta',
      'usage',
      'stop',
      'done',
    ]);
  });
});
