import type { ChatRequest, ChatStreamEvent, HttpClient, HttpRequest } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { anthropicAdapter } from '../src/anthropic.js';

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
  model: 'claude-3-5-sonnet',
  messages: [
    { role: 'system', content: [{ kind: 'text', text: 'be brief' }] },
    { role: 'user', content: [{ kind: 'text', text: 'hi' }] },
  ],
  tools: [{ name: 'f', parameters: { type: 'object' } }],
};

describe('anthropicAdapter.chat', () => {
  it('declares chat capabilities', () => {
    expect(anthropicAdapter.capabilities).toMatchObject({
      tools: true,
      vision: true,
      json: false,
      stream: true,
    });
  });

  it('hoists system, sends tools with input_schema, parses content blocks + usage', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp(
      {
        status: 200,
        body: {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'text', text: 'sure' },
            { type: 'tool_use', id: 'tu1', name: 'f', input: { a: 1 } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 7, output_tokens: 3 },
        },
      },
      (r) => {
        seen = r;
      },
    );
    const res = await anthropicAdapter.chat?.(ir, {
      providerType: 'anthropic',
      model: 'claude-3-5-sonnet',
      apiKey: 'sk',
      http,
    });
    if (res === undefined) {
      throw new Error('anthropic adapter has no chat()');
    }
    expect(seen?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(seen?.body).toMatchObject({
      system: 'be brief',
      max_tokens: 1024,
      tools: [{ name: 'f', input_schema: { type: 'object' } }],
    });
    expect((seen?.body as { messages: unknown[] }).messages).toHaveLength(1);
    expect(res.message.content).toEqual([{ kind: 'text', text: 'sure' }]);
    expect(res.message.toolCalls).toEqual([{ id: 'tu1', name: 'f', arguments: { a: 1 } }]);
    expect(res.stopReason).toBe('tool_calls');
    expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });
});

async function drainChat(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('anthropicAdapter.streamChat', () => {
  it('yields message_start, content_delta, stop, usage, done from typed SSE', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    const lines = (async function* g(): AsyncIterable<string> {
      yield 'data: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}\n\n';
      yield 'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n';
      yield 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hel"}}\n\n';
      yield 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n';
      yield 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n';
      yield 'data: {"type":"message_stop"}\n\n';
    })();
    const http: HttpClient = {
      request: () => Promise.reject(new Error('unused')),
      stream: () => Promise.resolve({ status: 200, ok: true, lines }),
    };
    const stream = anthropicAdapter.streamChat?.(ir, {
      providerType: 'anthropic',
      model: 'claude-3-5-sonnet',
      apiKey: 'sk',
      http,
    });
    if (stream === undefined) {
      throw new Error('anthropic adapter has no streamChat()');
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
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toEqual({ type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } });
  });

  it('emits tool_call_delta from content_block_start + input_json_delta', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    const lines = (async function* g(): AsyncIterable<string> {
      yield 'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n';
      yield 'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu1","name":"f"}}\n\n';
      yield 'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}\n\n';
      yield 'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}\n\n';
      yield 'data: {"type":"message_stop"}\n\n';
    })();
    const http: HttpClient = {
      request: () => Promise.reject(new Error('unused')),
      stream: () => Promise.resolve({ status: 200, ok: true, lines }),
    };
    const stream = anthropicAdapter.streamChat?.(ir, {
      providerType: 'anthropic',
      model: 'claude-3-5-sonnet',
      apiKey: 'sk',
      http,
    });
    if (stream === undefined) {
      throw new Error('anthropic adapter has no streamChat()');
    }
    const events = await drainChat(stream);
    const toolDeltas = events.filter((e) => e.type === 'tool_call_delta');
    expect(toolDeltas).toEqual([
      { type: 'tool_call_delta', index: 0, id: 'tu1', name: 'f' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: '{"a":1}' },
    ]);
  });
});
