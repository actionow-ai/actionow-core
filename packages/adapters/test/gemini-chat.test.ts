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

  it('spreads top-level extra + gen extra, maps reasoning + responseSchema, never clobbering criticals', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp(
      {
        status: 200,
        body: {
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        },
      },
      (r) => {
        seen = r;
      },
    );
    const richIr: ChatRequest = {
      model: 'gemini-3-pro',
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
      params: {
        temperature: 0.4,
        reasoningBudgetTokens: 4096,
        responseFormat: 'json_schema',
        jsonSchema: { type: 'OBJECT' },
      },
      extra: {
        cachedContent: 'cachedContents/abc',
        // unknown gen sub-keys re-nested by the parser; merged into generationConfig.
        generationConfig: { frequencyPenalty: 0.2, topK: 40, candidateCount: 2 },
        // hostile keys MUST NOT win:
        contents: 'EVIL',
        systemInstruction: 'EVIL',
      },
    };
    await geminiAdapter.chat?.(richIr, {
      providerType: 'gemini',
      model: 'gemini-3-pro',
      apiKey: 'k',
      http,
    });
    const body = seen?.body as Record<string, unknown>;
    // Top-level extra rode through; criticals untouched.
    expect(body.cachedContent).toBe('cachedContents/abc');
    expect(Array.isArray(body.contents)).toBe(true);
    // generationConfig merges gen-extra + first-class + reasoning + responseSchema.
    expect(body.generationConfig).toEqual({
      frequencyPenalty: 0.2,
      topK: 40,
      candidateCount: 2,
      temperature: 0.4,
      responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT' },
      thinkingConfig: { thinkingBudget: 4096 },
    });
  });

  it('maps reasoningEffort to thinkingConfig.thinkingLevel when no budget is set', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp(
      {
        status: 200,
        body: {
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        },
      },
      (r) => {
        seen = r;
      },
    );
    await geminiAdapter.chat?.(
      {
        model: 'gemini-3-pro',
        messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
        params: { reasoningEffort: 'low' },
      },
      { providerType: 'gemini', model: 'gemini-3-pro', apiKey: 'k', http },
    );
    expect((seen?.body as { generationConfig: unknown }).generationConfig).toEqual({
      thinkingConfig: { thinkingLevel: 'low' },
    });
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

  it('assigns distinct IR indices to parallel functionCalls across frames', async () => {
    // Gemini streams each functionCall in its own SSE frame.
    // eslint-disable-next-line @typescript-eslint/require-await
    const lines = (async function* g(): AsyncIterable<string> {
      yield 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"fa","args":{"a":1}}}]}}]}\n\n';
      yield 'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"fb","args":{"b":2}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}\n\n';
    })();
    const http: HttpClient = {
      request: () => Promise.reject(new Error('unused')),
      stream: () => Promise.resolve({ status: 200, ok: true, lines }),
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
    const toolDeltas = events.filter((e) => e.type === 'tool_call_delta');
    // Two functionCalls in two frames must get DISTINCT indices (0, 1) — a
    // per-frame counter would emit index 0 twice and collapse them downstream.
    expect(toolDeltas).toEqual([
      { type: 'tool_call_delta', index: 0, id: 'fa', name: 'fa', argumentsDelta: '{"a":1}' },
      { type: 'tool_call_delta', index: 1, id: 'fb', name: 'fb', argumentsDelta: '{"b":2}' },
    ]);
  });
});
