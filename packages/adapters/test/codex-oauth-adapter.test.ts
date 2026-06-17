import type { ChatRequest, ChatStreamEvent, HttpClient, HttpRequest } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { codexOAuthAdapter } from '../src/codex-oauth.js';

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

  it('POSTs a Responses-shaped body to the codex backend with cli-impersonation headers', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp(
      {
        status: 200,
        body: {
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
          usage: { input_tokens: 7, output_tokens: 3 },
        },
      },
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
    expect(headers.Accept).toBe('application/json');
    expect(headers['Content-Type']).toBe('application/json');

    // Responses-shaped body: store:false, input array, system -> instructions.
    expect(seen?.body).toMatchObject({
      store: false,
      stream: false,
      instructions: 'be terse',
    });
    expect(Array.isArray((seen?.body as { input?: unknown }).input)).toBe(true);

    expect(res.message.content).toEqual([{ kind: 'text', text: 'hello' }]);
    expect(res.stopReason).toBe('stop');
    expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it('omits Chatgpt-Account-Id when config has no chatgptAccountId', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: { output: [], usage: {} } }, (r) => {
      seen = r;
    });
    await codexOAuthAdapter.chat?.(ir, {
      providerType: 'codex-oauth',
      apiKey: 'oat-tok',
      http,
    });
    expect(seen?.headers?.['Chatgpt-Account-Id']).toBeUndefined();
  });

  it('forwards ctx.proxyUrl onto the http request', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: { output: [], usage: {} } }, (r) => {
      seen = r;
    });
    await codexOAuthAdapter.chat?.(ir, {
      providerType: 'codex-oauth',
      apiKey: 'oat-tok',
      proxyUrl: 'http://proxy.local:8080',
      http,
    });
    expect(seen?.proxyUrl).toBe('http://proxy.local:8080');
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
