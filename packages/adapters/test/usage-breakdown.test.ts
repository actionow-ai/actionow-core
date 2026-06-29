import type { ChatRequest, ChatStreamEvent, HttpClient } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { anthropicAdapter } from '../src/anthropic.js';
import { geminiAdapter } from '../src/gemini.js';
import { openaiAdapter } from '../src/openai.js';

/** A fake blocking HttpClient returning the given JSON body. */
const fakeHttp = (body: unknown): HttpClient => ({
  request: () =>
    Promise.resolve({ status: 200, ok: true, body, text: JSON.stringify(body) }),
});

/** Yield pre-canned SSE frame strings as decoded chunks. */
// eslint-disable-next-line @typescript-eslint/require-await
async function* framesOf(frames: string[]): AsyncIterable<string> {
  for (const f of frames) yield f;
}

/** A fake streaming HttpClient yielding the given SSE frame strings. */
const fakeStreamHttp = (frames: string[]): HttpClient => ({
  request: () => Promise.reject(new Error('unused')),
  stream: () => Promise.resolve({ status: 200, ok: true, lines: framesOf(frames) }),
});

const ir: ChatRequest = {
  model: 'm',
  messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
};

async function drainChat(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

/** Pull the single IR `usage` event out of a drained chat stream. */
function usageEventOf(events: ChatStreamEvent[]): Extract<ChatStreamEvent, { type: 'usage' }> {
  const ev = events.find((e) => e.type === 'usage');
  if (ev === undefined || ev.type !== 'usage') throw new Error('no usage event in stream');
  return ev;
}

// --- OpenAI: reasoning + cached + audio (in/out) --------------------------

describe('openai usage breakdown', () => {
  const usageBlock = {
    prompt_tokens: 100,
    completion_tokens: 40,
    prompt_tokens_details: { cached_tokens: 30, audio_tokens: 10 },
    completion_tokens_details: { reasoning_tokens: 25, audio_tokens: 5 },
  };

  it('extractUsage parses the breakdown from a blocking usage block', () => {
    expect(openaiAdapter.extractUsage({ usage: usageBlock })).toEqual({
      input_tokens: 100,
      output_tokens: 40,
      cached_input_tokens: 30,
      audio_input_tokens: 10,
      reasoning_tokens: 25,
      audio_output_tokens: 5,
    });
  });

  it('omits breakdown keys when the upstream reports no details (back-compat)', () => {
    expect(
      openaiAdapter.extractUsage({ usage: { prompt_tokens: 7, completion_tokens: 3 } }),
    ).toEqual({ input_tokens: 7, output_tokens: 3 });
  });

  it('chat() carries the breakdown into the camelCase IR usage', async () => {
    const http = fakeHttp({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: usageBlock,
    });
    const res = await openaiAdapter.chat?.(ir, { providerType: 'openai', model: 'm', http });
    expect(res?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 30,
      audioInputTokens: 10,
      reasoningTokens: 25,
      audioOutputTokens: 5,
    });
  });

  it('streamChat() carries the breakdown on the trailing usage event', async () => {
    const http = fakeStreamHttp([
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
      `data: {"choices":[],"usage":${JSON.stringify(usageBlock)}}\n\n`,
      'data: [DONE]\n\n',
    ]);
    const stream = openaiAdapter.streamChat?.(ir, { providerType: 'openai', model: 'm', http });
    if (stream === undefined) throw new Error('no streamChat');
    const usage = usageEventOf(await drainChat(stream)).usage;
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 30,
      audioInputTokens: 10,
      reasoningTokens: 25,
      audioOutputTokens: 5,
    });
  });
});

// --- Anthropic: cache_read + cache_creation -------------------------------

describe('anthropic usage breakdown', () => {
  const usageBlock = {
    input_tokens: 80,
    output_tokens: 20,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 12,
  };

  it('extractUsage parses cache read/creation from a blocking usage block', () => {
    expect(anthropicAdapter.extractUsage({ usage: usageBlock })).toEqual({
      input_tokens: 80,
      output_tokens: 20,
      cached_input_tokens: 50,
      cache_creation_tokens: 12,
    });
  });

  it('omits cache keys when the upstream reports none (back-compat)', () => {
    expect(
      anthropicAdapter.extractUsage({ usage: { input_tokens: 4, output_tokens: 2 } }),
    ).toEqual({ input_tokens: 4, output_tokens: 2 });
  });

  it('chat() carries the cache breakdown into the IR usage', async () => {
    const http = fakeHttp({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: usageBlock,
    });
    const res = await anthropicAdapter.chat?.(ir, { providerType: 'anthropic', model: 'm', http });
    expect(res?.usage).toEqual({
      inputTokens: 80,
      outputTokens: 20,
      cachedInputTokens: 50,
      cacheCreationTokens: 12,
    });
  });

  it('streamChat() carries the cache breakdown (cache on message_start)', async () => {
    const http = fakeStreamHttp([
      `data: {"type":"message_start","message":{"usage":${JSON.stringify(usageBlock)}}}\n\n`,
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]);
    const stream = anthropicAdapter.streamChat?.(ir, {
      providerType: 'anthropic',
      model: 'm',
      http,
    });
    if (stream === undefined) throw new Error('no streamChat');
    const usage = usageEventOf(await drainChat(stream)).usage;
    expect(usage).toEqual({
      inputTokens: 80,
      outputTokens: 20,
      cachedInputTokens: 50,
      cacheCreationTokens: 12,
    });
  });
});

// --- Gemini: thoughts + cachedContent -------------------------------------

describe('gemini usage breakdown', () => {
  const usageMeta = {
    promptTokenCount: 60,
    candidatesTokenCount: 18,
    thoughtsTokenCount: 9,
    cachedContentTokenCount: 22,
  };

  it('extractUsage parses thoughts/cache from usageMetadata', () => {
    expect(geminiAdapter.extractUsage({ usageMetadata: usageMeta })).toEqual({
      input_tokens: 60,
      output_tokens: 18,
      reasoning_tokens: 9,
      cached_input_tokens: 22,
    });
  });

  it('omits breakdown keys when usageMetadata has none (back-compat)', () => {
    expect(
      geminiAdapter.extractUsage({
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
      }),
    ).toEqual({ input_tokens: 3, output_tokens: 1 });
  });

  it('chat() carries the thoughts/cache breakdown into the IR usage', async () => {
    const http = fakeHttp({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: usageMeta,
    });
    const res = await geminiAdapter.chat?.(ir, { providerType: 'gemini', model: 'm', http });
    expect(res?.usage).toEqual({
      inputTokens: 60,
      outputTokens: 18,
      reasoningTokens: 9,
      cachedInputTokens: 22,
    });
  });

  it('streamChat() carries the breakdown on the usage event', async () => {
    const http = fakeStreamHttp([
      'data: {"candidates":[{"content":{"parts":[{"text":"x"}]}}]}\n\n',
      `data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":${JSON.stringify(usageMeta)}}\n\n`,
    ]);
    const stream = geminiAdapter.streamChat?.(ir, { providerType: 'gemini', model: 'm', http });
    if (stream === undefined) throw new Error('no streamChat');
    const usage = usageEventOf(await drainChat(stream)).usage;
    expect(usage).toEqual({
      inputTokens: 60,
      outputTokens: 18,
      reasoningTokens: 9,
      cachedInputTokens: 22,
    });
  });
});
