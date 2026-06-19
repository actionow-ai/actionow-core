import { describe, expect, it } from 'vitest';

import {
  type ChatRequest,
  chatRequestSchema,
  type ChatResponse,
  type ChatStreamEvent,
  type ContentPart,
  type Message,
  type ToolCall,
  type ToolDef,
} from '../src/chat.js';

describe('chat IR schemas', () => {
  it('parses a minimal text request', () => {
    const req: ChatRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
    };
    expect(chatRequestSchema.parse(req)).toMatchObject({ model: 'gpt-4o' });
  });

  it('accepts tools, tool calls, and an image content part', () => {
    const tool: ToolDef = {
      name: 'get_weather',
      description: 'weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    };
    const call: ToolCall = { id: 'call_1', name: 'get_weather', arguments: { city: 'SF' } };
    const image: ContentPart = {
      kind: 'image',
      source: 'base64',
      data: 'aGVsbG8=',
      mime: 'image/png',
    };
    const messages: Message[] = [
      { role: 'system', content: [{ kind: 'text', text: 'be brief' }] },
      { role: 'user', content: [{ kind: 'text', text: 'weather?' }, image] },
      { role: 'assistant', content: [], toolCalls: [call] },
      { role: 'tool', content: [{ kind: 'text', text: '72F' }], toolCallId: 'call_1' },
    ];
    const req: ChatRequest = {
      model: 'gpt-4o',
      messages,
      tools: [tool],
      toolChoice: 'auto',
      params: { temperature: 0.2, maxOutputTokens: 256, responseFormat: 'json_object' },
    };
    expect(chatRequestSchema.parse(req).tools).toHaveLength(1);
  });

  it('rejects an unknown role', () => {
    const bad = { model: 'x', messages: [{ role: 'robot', content: [] }] };
    expect(chatRequestSchema.safeParse(bad).success).toBe(false);
  });

  it('types a response + stream events', () => {
    const res: ChatResponse = {
      message: { role: 'assistant', content: [{ kind: 'text', text: 'ok' }] },
      stopReason: 'stop',
      usage: { inputTokens: 3, outputTokens: 1 },
    };
    const events: ChatStreamEvent[] = [
      { type: 'message_start' },
      { type: 'content_delta', text: 'o' },
      { type: 'tool_call_delta', index: 0, id: 'c1', name: 'f', argumentsDelta: '{' },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } },
      { type: 'stop', stopReason: 'stop' },
      { type: 'done' },
      { type: 'error', error: { code: 'upstream_error', message: 'x', retryable: false } },
    ];
    expect(res.stopReason).toBe('stop');
    expect(events).toHaveLength(7);
  });
});
