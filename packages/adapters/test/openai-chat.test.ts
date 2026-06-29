import type { ChatRequest, ChatStreamEvent, HttpClient, HttpRequest } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { openaiAdapter } from '../src/openai.js';

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
  model: 'gpt-4o',
  messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
  tools: [{ name: 'f', parameters: { type: 'object' } }],
};

describe('openaiAdapter.chat', () => {
  it('declares chat capabilities', () => {
    expect(openaiAdapter.capabilities).toMatchObject({ tools: true, vision: true, stream: true });
  });

  it('REJECTS an audio/file part instead of dumping the payload as text', async () => {
    // A fail-loud http: if the adapter ever reached the request (it must not),
    // the test would surface the wrong failure.
    const http = fakeHttp({ status: 200, body: {} });
    for (const kind of ['audio', 'file'] as const) {
      const partIr: ChatRequest = {
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: [{ kind, source: 'base64', data: 'BIG_BASE64', mime: 'x/y' }] },
        ],
      };
      await expect(
        openaiAdapter.chat?.(partIr, {
          providerType: 'openai',
          model: 'gpt-4o',
          apiKey: 'sk',
          http,
        }),
      ).rejects.toMatchObject({ unified: { code: 'invalid_input' } });
    }
  });

  it('posts an IR-derived body and parses tool_calls into the IR response', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp(
      {
        status: 200,
        body: {
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        },
      },
      (r) => {
        seen = r;
      },
    );
    const res = await openaiAdapter.chat?.(ir, {
      providerType: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk',
      http,
    });
    if (res === undefined) {
      throw new Error('openai adapter has no chat()');
    }
    expect(seen?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(seen?.body).toMatchObject({ tools: [{ type: 'function', function: { name: 'f' } }] });
    expect(res.message.toolCalls).toEqual([{ id: 'c1', name: 'f', arguments: { a: 1 } }]);
    expect(res.stopReason).toBe('tool_calls');
    expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it('spreads extra into the body, never overriding model/messages/tools, and maps reasoning_effort + json_schema', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp(
      {
        status: 200,
        body: {
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      },
      (r) => {
        seen = r;
      },
    );
    const richIr: ChatRequest = {
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
      tools: [{ name: 'f', parameters: { type: 'object' } }],
      params: {
        reasoningEffort: 'high',
        responseFormat: 'json_schema',
        jsonSchema: { type: 'object', properties: { x: { type: 'string' } } },
      },
      extra: {
        presence_penalty: 0.5,
        top_k: 40,
        parallel_tool_calls: false,
        // Hostile keys that MUST NOT override the first-class/critical fields:
        model: 'EVIL',
        messages: 'EVIL',
        tools: 'EVIL',
      },
    };
    await openaiAdapter.chat?.(richIr, {
      providerType: 'openai',
      model: 'gpt-5.5',
      apiKey: 'sk',
      http,
    });
    const body = seen?.body as Record<string, unknown>;
    // extra rode through…
    expect(body.presence_penalty).toBe(0.5);
    expect(body.top_k).toBe(40);
    expect(body.parallel_tool_calls).toBe(false);
    // …but never clobbered the critical fields.
    expect(body.model).toBe('gpt-5.5');
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.tools).toMatchObject([{ type: 'function', function: { name: 'f' } }]);
    // reasoning_effort + full json_schema body forwarded.
    expect(body.reasoning_effort).toBe('high');
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'response',
        schema: { type: 'object', properties: { x: { type: 'string' } } },
        strict: true,
      },
    });
  });

  it('renders a base64 image part as a data: URI image_url (not a raw payload)', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp(
      {
        status: 200,
        body: {
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      },
      (r) => {
        seen = r;
      },
    );
    const imageIr: ChatRequest = {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { kind: 'text', text: 'what is this' },
            { kind: 'image', source: 'base64', data: 'aGk=', mime: 'image/png' },
          ],
        },
      ],
    };
    const res = await openaiAdapter.chat?.(imageIr, {
      providerType: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk',
      http,
    });
    if (res === undefined) {
      throw new Error('openai adapter has no chat()');
    }
    // A raw base64 payload (`aGk=`) would be rejected by OpenAI — it must be a
    // `data:<mime>;base64,<payload>` data URI.
    expect(seen?.body).toMatchObject({
      messages: [
        {
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } },
          ],
        },
      ],
    });
  });
});

async function drainChat(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('openaiAdapter.streamChat', () => {
  it('yields message_start, content_delta, usage, stop, done', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    const lines = (async function* g(): AsyncIterable<string> {
      yield 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n';
      yield 'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n';
      yield 'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n';
      yield 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n';
      yield 'data: [DONE]\n\n';
    })();
    const http: HttpClient = {
      request: () => Promise.reject(new Error('unused')),
      stream: () => Promise.resolve({ status: 200, ok: true, lines }),
    };
    const stream = openaiAdapter.streamChat?.(ir, {
      providerType: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk',
      http,
    });
    if (stream === undefined) {
      throw new Error('openai adapter has no streamChat()');
    }
    const events = await drainChat(stream);
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_delta',
      'content_delta',
      'stop',
      'usage',
      'done',
    ]);
  });
});
