import type { ChatRequest, ChatStreamEvent } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { createMockChat } from '../src/mock-chat.js';

const ir: ChatRequest = {
  model: 'mock',
  messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
};

async function drainChat(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('mock-chat adapter', () => {
  it('declares full chat capabilities', () => {
    const adapter = createMockChat();
    expect(adapter.providerType).toBe('mock-chat');
    expect(adapter.capabilities).toEqual({
      tools: true,
      vision: true,
      audio: true,
      json: true,
      stream: true,
    });
  });

  it('chat returns a deterministic IR response with camelCase usage', async () => {
    const adapter = createMockChat();
    const ctx = {
      providerType: 'mock-chat',
      http: { request: () => Promise.reject(new Error('no network in mock')) },
    };
    const res = await adapter.chat?.(ir, ctx);
    if (res === undefined) {
      throw new Error('mock-chat adapter has no chat()');
    }
    expect(res.message).toEqual({ role: 'assistant', content: [{ kind: 'text', text: 'hello' }] });
    expect(res.stopReason).toBe('stop');
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('streamChat yields message_start, content_delta x2, usage, stop, done', async () => {
    const adapter = createMockChat();
    const ctx = {
      providerType: 'mock-chat',
      http: { request: () => Promise.reject(new Error('no network in mock')) },
    };
    const stream = adapter.streamChat?.(ir, ctx);
    if (stream === undefined) {
      throw new Error('mock-chat adapter has no streamChat()');
    }
    const events = await drainChat(stream);
    expect(events).toEqual([
      { type: 'message_start' },
      { type: 'content_delta', text: 'hel' },
      { type: 'content_delta', text: 'lo' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'stop', stopReason: 'stop' },
      { type: 'done' },
    ]);
  });
});
