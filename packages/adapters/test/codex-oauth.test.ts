import type {
  AdapterContext,
  ChatRequest,
  ChatStreamEvent,
  HttpRequest,
  HttpResponse,
  HttpStreamResponse,
} from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import {
  codexOAuthAdapter,
  irToResponsesBody,
  parseResponsesResponse,
  parseResponsesSse,
} from '../src/codex-oauth.js';

const ir: ChatRequest = {
  model: 'gpt-5-codex',
  messages: [
    { role: 'system', content: [{ kind: 'text', text: 'be brief' }] },
    {
      role: 'user',
      content: [
        { kind: 'text', text: 'what is this' },
        { kind: 'image', source: 'base64', data: 'aGk=', mime: 'image/png' },
      ],
    },
    {
      role: 'assistant',
      content: [],
      toolCalls: [{ id: 'call_1', name: 'lookup', arguments: { q: 'x' } }],
    },
    { role: 'tool', content: [{ kind: 'text', text: 'result text' }], toolCallId: 'call_1' },
  ],
  tools: [{ name: 'lookup', description: 'find', parameters: { type: 'object' } }],
  params: { maxOutputTokens: 256, temperature: 0.5, topP: 0.9 },
};

describe('irToResponsesBody', () => {
  it('hoists system to instructions, keeps no system in input, and maps every item', () => {
    const body = irToResponsesBody(ir, { stream: false });

    // system text moves to top-level instructions (Responses rejects a system role).
    expect(body.instructions).toBe('be brief');

    const input = body.input;
    expect(Array.isArray(input)).toBe(true);
    // No item carries a system role.
    for (const item of input) {
      expect(item.role).not.toBe('system');
    }

    // user message: input_text + input_image (base64 wrapped as a data: URI).
    expect(input[0]).toEqual({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'what is this' },
        { type: 'input_image', image_url: 'data:image/png;base64,aGk=' },
      ],
    });

    // assistant toolCall -> a function_call item with stringified arguments.
    expect(input[1]).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'lookup',
      arguments: '{"q":"x"}',
    });

    // tool result -> function_call_output.
    expect(input[2]).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'result text',
    });

    // tools -> [{type:'function', name, description?, parameters}]
    expect(body.tools).toEqual([
      { type: 'function', name: 'lookup', description: 'find', parameters: { type: 'object' } },
    ]);

    // params + invariants.
    expect(body.store).toBe(false);
    expect(body.stream).toBe(false);
    // `max_output_tokens` is NEVER forwarded — the private codex backend rejects
    // it ("Unsupported parameter") even when the IR carries maxOutputTokens.
    expect('max_output_tokens' in body).toBe(false);
    expect(body.temperature).toBe(0.5);
    expect(body.top_p).toBe(0.9);
    expect(body.model).toBe('gpt-5-codex');
  });

  it('falls back to the default instructions when there is no system message and honors stream:true', () => {
    const body = irToResponsesBody(
      { model: 'm', messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }] },
      { stream: true },
    );
    // The codex backend rejects an absent/empty instructions, so we always send one.
    expect(body.instructions).toBe('You are a helpful assistant.');
    expect(body.stream).toBe(true);
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
    expect('tools' in body).toBe(false);
    expect('max_output_tokens' in body).toBe(false);
  });

  it('honors a model override from opts, else uses ir.model', () => {
    const base: ChatRequest = {
      model: 'm',
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
    };
    // An explicit override flows to the body's model.
    expect(irToResponsesBody(base, { stream: true, model: 'gpt-5.5' }).model).toBe('gpt-5.5');
    // Without the override the IR model is used.
    expect(irToResponsesBody(base, { stream: true }).model).toBe('m');
  });

  it('renders an assistant text part as output_text', () => {
    const body = irToResponsesBody(
      {
        model: 'm',
        messages: [{ role: 'assistant', content: [{ kind: 'text', text: 'prior' }] }],
      },
      { stream: false },
    );
    expect(body.input[0]).toEqual({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'prior' }],
    });
  });
});

describe('parseResponsesResponse', () => {
  it('maps output text + function_call + usage into the IR', () => {
    const res = parseResponsesResponse({
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
        { type: 'function_call', call_id: 'call_9', name: 'lookup', arguments: '{"q":"y"}' },
      ],
      usage: { input_tokens: 11, output_tokens: 4 },
      status: 'completed',
    });

    expect(res.message.role).toBe('assistant');
    expect(res.message.content).toEqual([{ kind: 'text', text: 'hello' }]);
    expect(res.message.toolCalls).toEqual([
      { id: 'call_9', name: 'lookup', arguments: { q: 'y' } },
    ]);
    // a function_call present => tool_calls wins over a 'completed' status.
    expect(res.stopReason).toBe('tool_calls');
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 4 });
  });

  it("maps a plain completed reply to stopReason 'stop'", () => {
    const res = parseResponsesResponse({
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
      status: 'completed',
    });
    expect(res.stopReason).toBe('stop');
    expect(res.message.toolCalls).toBeUndefined();
  });

  it("maps incomplete_details.reason='max_output_tokens' to 'length'", () => {
    const res = parseResponsesResponse({
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'cut' }] },
      ],
      usage: { input_tokens: 2, output_tokens: 2 },
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    });
    expect(res.stopReason).toBe('length');
  });
});

function gen(frames: string[]): AsyncIterable<string> {
  // eslint-disable-next-line @typescript-eslint/require-await
  return (async function* g(): AsyncIterable<string> {
    for (const f of frames) yield f;
  })();
}

async function drain(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('parseResponsesSse', () => {
  it('maps created -> deltas -> completed into the IR event sequence', async () => {
    const lines = gen([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hel"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lo"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":2}}}\n\n',
    ]);
    const events = await drain(parseResponsesSse(lines));
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_delta',
      'content_delta',
      'usage',
      'stop',
      'done',
    ]);
    expect(events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect(events.find((e) => e.type === 'stop')).toEqual({ type: 'stop', stopReason: 'stop' });
  });

  it('maps a function_call slice to a tool_call_delta with id/name/index, then stop tool_calls', async () => {
    const lines = gen([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"item_0","call_id":"call_7","name":"lookup"}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"item_0","output_index":0,"delta":"{\\"q\\":"}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"item_0","output_index":0,"delta":"1}"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":6}}}\n\n',
    ]);
    const events = await drain(parseResponsesSse(lines));
    const toolDeltas = events.filter((e) => e.type === 'tool_call_delta');
    expect(toolDeltas).toEqual([
      { type: 'tool_call_delta', index: 0, id: 'call_7', name: 'lookup', argumentsDelta: '{"q":' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '1}' },
    ]);
    expect(events.find((e) => e.type === 'stop')).toEqual({
      type: 'stop',
      stopReason: 'tool_calls',
    });
  });

  it('assigns distinct indices to two parallel function_call items', async () => {
    const lines = gen([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"item_0","call_id":"call_a","name":"fa"}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"item_1","call_id":"call_b","name":"fb"}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"item_0","output_index":0,"delta":"{\\"a\\":1}"}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"item_1","output_index":1,"delta":"{\\"b\\":2}"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
    ]);
    const events = await drain(parseResponsesSse(lines));
    const toolDeltas = events.filter((e) => e.type === 'tool_call_delta');
    // The two items get DISTINCT indices keyed by item_id (not both 0).
    expect(toolDeltas).toEqual([
      { type: 'tool_call_delta', index: 0, id: 'call_a', name: 'fa', argumentsDelta: '{"a":1}' },
      { type: 'tool_call_delta', index: 1, id: 'call_b', name: 'fb', argumentsDelta: '{"b":2}' },
    ]);
  });

  it('maps response.failed to an error event', async () => {
    const lines = gen([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"boom"}}}\n\n',
    ]);
    const events = await drain(parseResponsesSse(lines));
    const err = events.find((e) => e.type === 'error');
    expect(err).toEqual({
      type: 'error',
      error: { code: 'upstream_error', message: 'boom', retryable: false },
    });
  });
});

/**
 * A mock HttpClient whose `stream(req)` returns an SSE `HttpStreamResponse`
 * shaped exactly like `FetchHttpClient.stream`: `{ status, ok, lines }` where
 * `lines` is an async iterable of decoded UTF-8 chunks (the adapter's
 * `streamChat` reads `res.lines` and frames them via `parseSse`). `request`
 * must never be called now that `chat()` streams.
 */
function streamingHttp(frames: string[]): {
  http: AdapterContext['http'];
  seen: { req?: HttpRequest };
} {
  const seen: { req?: HttpRequest } = {};
  const http: AdapterContext['http'] = {
    request(): Promise<HttpResponse> {
      return Promise.reject(new Error('chat() must stream, not buffer'));
    },
    stream(req: HttpRequest): Promise<HttpStreamResponse> {
      seen.req = req;
      return Promise.resolve({
        status: 200,
        ok: true,
        lines: gen(frames),
      });
    },
  };
  return { http, seen };
}

/** `chat` is optional on ProviderAdapter; assert it exists for these tests. */
const chat = codexOAuthAdapter.chat?.bind(codexOAuthAdapter);
if (chat === undefined) {
  throw new Error('codex-oauth adapter has no chat()');
}

describe('codexOAuthAdapter.chat (stream-and-aggregate)', () => {
  it('streams, aggregates the deltas + usage + stop, and sends stream:true + SSE Accept', async () => {
    const { http, seen } = streamingHttp([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"codex relay"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" ok"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":11,"output_tokens":4}}}\n\n',
    ]);
    const ctx: AdapterContext = {
      providerType: 'codex-oauth',
      apiKey: 'tok',
      endpoint: 'https://fake.local/backend-api/codex',
      http,
    };

    const res = await chat(
      { model: 'm', messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }] },
      ctx,
    );

    expect(res.message.role).toBe('assistant');
    expect(res.message.content).toEqual([{ kind: 'text', text: 'codex relay ok' }]);
    expect(res.message.toolCalls).toBeUndefined();
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 4 });
    expect(res.stopReason).toBe('stop');

    // The POSTed request streamed: stream:true body + Accept: text/event-stream.
    expect(seen.req?.method).toBe('POST');
    expect(seen.req?.url).toBe('https://fake.local/backend-api/codex/responses');
    expect((seen.req?.body as { stream?: boolean }).stream).toBe(true);
    expect(seen.req?.headers?.Accept).toBe('text/event-stream');
  });

  it('aggregates a streamed function_call into toolCalls with parsed arguments', async () => {
    const { http } = streamingHttp([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"item_0","call_id":"call_7","name":"lookup"}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"item_0","output_index":0,"delta":"{\\"q\\":"}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"item_0","output_index":0,"delta":"1}"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":6}}}\n\n',
    ]);
    const ctx: AdapterContext = {
      providerType: 'codex-oauth',
      apiKey: 'tok',
      endpoint: 'https://fake.local/backend-api/codex',
      http,
    };

    const res = await chat(
      { model: 'm', messages: [{ role: 'user', content: [{ kind: 'text', text: 'go' }] }] },
      ctx,
    );

    expect(res.message.toolCalls).toEqual([{ id: 'call_7', name: 'lookup', arguments: { q: 1 } }]);
    expect(res.stopReason).toBe('tool_calls');
  });

  it('throws an AdapterError on a streamed error event', async () => {
    const { http } = streamingHttp([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"boom"}}}\n\n',
    ]);
    const ctx: AdapterContext = {
      providerType: 'codex-oauth',
      apiKey: 'tok',
      endpoint: 'https://fake.local/backend-api/codex',
      http,
    };

    await expect(
      chat(
        { model: 'm', messages: [{ role: 'user', content: [{ kind: 'text', text: 'x' }] }] },
        ctx,
      ),
    ).rejects.toThrow('boom');
  });

  it('threads ctx.model into the streamed request body', async () => {
    const { http, seen } = streamingHttp([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
    ]);
    const ctx: AdapterContext = {
      providerType: 'codex-oauth',
      model: 'gpt-5.5',
      apiKey: 'tok',
      endpoint: 'https://fake.local/backend-api/codex',
      http,
    };

    await chat(
      { model: 'ir-model', messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }] },
      ctx,
    );

    expect((seen.req?.body as { model?: string }).model).toBe('gpt-5.5');
  });
});
