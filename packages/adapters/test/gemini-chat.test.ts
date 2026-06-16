import type { ChatRequest, ChatStreamEvent, HttpClient, HttpRequest } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { geminiAdapter } from '../src/gemini.js';

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
  model: 'gemini-1.5-pro',
  messages: [
    { role: 'system', content: [{ kind: 'text', text: 'be brief' }] },
    { role: 'user', content: [{ kind: 'text', text: 'hi' }] },
  ],
  tools: [{ name: 'f', parameters: { type: 'object' } }],
};

describe('geminiAdapter.chat', () => {
  it('declares chat capabilities', () => {
    expect(geminiAdapter.capabilities).toMatchObject({
      tools: true,
      vision: true,
      audio: true,
      json: true,
      stream: true,
    });
  });

  it('sends systemInstruction/contents/functionDeclarations and parses functionCall + usage', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp(
      {
        status: 200,
        body: {
          candidates: [
            {
              content: {
                parts: [{ text: 'sure' }, { functionCall: { name: 'f', args: { a: 1 } } }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
        },
      },
      (r) => {
        seen = r;
      },
    );
    const res = await geminiAdapter.chat?.(ir, {
      providerType: 'gemini',
      model: 'gemini-1.5-pro',
      apiKey: 'k',
      http,
    });
    if (res === undefined) {
      throw new Error('gemini adapter has no chat()');
    }
    expect(seen?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=k',
    );
    expect(seen?.body).toMatchObject({
      systemInstruction: { parts: [{ text: 'be brief' }] },
      tools: [{ functionDeclarations: [{ name: 'f' }] }],
    });
    expect(res.message.content).toEqual([{ kind: 'text', text: 'sure' }]);
    expect(res.message.toolCalls).toEqual([{ id: 'f', name: 'f', arguments: { a: 1 } }]);
    expect(res.stopReason).toBe('stop');
    expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });
});

async function drainChat(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('geminiAdapter.streamChat', () => {
  it('yields message_start, content_delta, usage, stop, done', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    const lines = (async function* g(): AsyncIterable<string> {
      yield 'data: {"candidates":[{"content":{"parts":[{"text":"hel"}]}}]}\n\n';
      yield 'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}\n\n';
    })();
    const http: HttpClient = {
      request: () => Promise.reject(new Error('unused')),
      stream: (r: HttpRequest) => {
        expect(r.url).toContain(':streamGenerateContent?alt=sse');
        return Promise.resolve({ status: 200, ok: true, lines });
      },
    };
    const stream = geminiAdapter.streamChat?.(ir, {
      providerType: 'gemini',
      model: 'gemini-1.5-pro',
      apiKey: 'k',
      http,
    });
    if (stream === undefined) {
      throw new Error('gemini adapter has no streamChat()');
    }
    const events = await drainChat(stream);
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_delta',
      'content_delta',
      'usage',
      'stop',
      'done',
    ]);
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toEqual({ type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } });
  });
});
