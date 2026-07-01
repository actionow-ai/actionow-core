import type { ChatRequest, ChatStreamEvent, HttpClient } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { anthropicAdapter } from '../src/anthropic.js';
import { geminiAdapter } from '../src/gemini.js';
import { openaiAdapter } from '../src/openai.js';

/**
 * P2-4 — `native_finish_reason` preservation (模型参数绑定 Phase 2). Each adapter
 * carries the upstream's RAW finish/stop reason onto the IR `ChatResponse` /
 * terminal `stop` stream event ALONGSIDE the normalized `stopReason`, so a
 * provider-only reason survives the enum flattening. NON-BREAKING invariant: when
 * the provider reports a standard reason, native == normalized; when the provider
 * reports none, `nativeFinishReason` is absent (byte-for-byte unchanged).
 */

/** A fake blocking HttpClient returning the given JSON body. */
const fakeHttp = (body: unknown): HttpClient => ({
  request: () => Promise.resolve({ status: 200, ok: true, body, text: JSON.stringify(body) }),
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

/** Pull the single terminal `stop` event out of a drained chat stream. */
function stopEventOf(events: ChatStreamEvent[]): Extract<ChatStreamEvent, { type: 'stop' }> {
  const ev = events.find((e) => e.type === 'stop');
  if (ev?.type !== 'stop') throw new Error('no stop event in stream');
  return ev;
}

// --- OpenAI --------------------------------------------------------------

describe('openai native_finish_reason', () => {
  it('blocking: preserves a non-standard finish_reason raw on the IR response', async () => {
    const http = fakeHttp({
      choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'content_filter' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const res = await openaiAdapter.chat?.(ir, {
      providerType: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk',
      http,
    });
    // Non-standard reason flattens to the `content_filter` enum AND survives raw.
    expect(res?.stopReason).toBe('content_filter');
    expect(res?.nativeFinishReason).toBe('content_filter');
  });

  it('blocking: a standard reason yields native == normalized (non-breaking)', async () => {
    const http = fakeHttp({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const res = await openaiAdapter.chat?.(ir, {
      providerType: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk',
      http,
    });
    expect(res?.stopReason).toBe('stop');
    expect(res?.nativeFinishReason).toBe('stop');
  });

  it('blocking: absent finish_reason → nativeFinishReason unset', async () => {
    const http = fakeHttp({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const res = await openaiAdapter.chat?.(ir, {
      providerType: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk',
      http,
    });
    expect(res?.stopReason).toBe('stop');
    expect(res?.nativeFinishReason).toBeUndefined();
  });

  it('streaming: preserves the raw finish reason on the terminal stop event', async () => {
    const http = fakeStreamHttp([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const stream = openaiAdapter.streamChat?.(ir, {
      providerType: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk',
      http,
    });
    if (stream === undefined) throw new Error('no streamChat');
    const stop = stopEventOf(await drainChat(stream));
    expect(stop.stopReason).toBe('length');
    expect(stop.nativeFinishReason).toBe('length');
  });
});

// --- Anthropic -----------------------------------------------------------

describe('anthropic native_finish_reason', () => {
  it('blocking: preserves the raw stop_reason', async () => {
    const http = fakeHttp({
      content: [{ type: 'text', text: 'x' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 2, output_tokens: 3 },
    });
    const res = await anthropicAdapter.chat?.(ir, {
      providerType: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      http,
    });
    // `max_tokens` normalizes to `length` but survives raw.
    expect(res?.stopReason).toBe('length');
    expect(res?.nativeFinishReason).toBe('max_tokens');
  });

  it('blocking: absent stop_reason → nativeFinishReason unset', async () => {
    const http = fakeHttp({
      content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const res = await anthropicAdapter.chat?.(ir, {
      providerType: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      http,
    });
    expect(res?.nativeFinishReason).toBeUndefined();
  });

  it('streaming: preserves the raw stop_reason on the terminal stop event', async () => {
    const http = fakeStreamHttp([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":2,"output_tokens":0}}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":3}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]);
    const stream = anthropicAdapter.streamChat?.(ir, {
      providerType: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      http,
    });
    if (stream === undefined) throw new Error('no streamChat');
    const stop = stopEventOf(await drainChat(stream));
    expect(stop.stopReason).toBe('length');
    expect(stop.nativeFinishReason).toBe('max_tokens');
  });
});

// --- Gemini --------------------------------------------------------------

describe('gemini native_finish_reason', () => {
  it('blocking: preserves a provider-only finishReason raw', async () => {
    const http = fakeHttp({
      candidates: [
        { content: { parts: [{ text: 'x' }] }, finishReason: 'MALFORMED_FUNCTION_CALL' },
      ],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    const res = await geminiAdapter.chat?.(ir, {
      providerType: 'gemini',
      model: 'gemini-3-pro',
      apiKey: 'k',
      http,
    });
    // `MALFORMED_FUNCTION_CALL` is a provider-only reason (flattens to `stop`) but
    // survives raw on `nativeFinishReason`.
    expect(res?.stopReason).toBe('stop');
    expect(res?.nativeFinishReason).toBe('MALFORMED_FUNCTION_CALL');
  });

  it('blocking: absent finishReason → nativeFinishReason unset', async () => {
    const http = fakeHttp({
      candidates: [{ content: { parts: [{ text: 'x' }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    const res = await geminiAdapter.chat?.(ir, {
      providerType: 'gemini',
      model: 'gemini-3-pro',
      apiKey: 'k',
      http,
    });
    expect(res?.nativeFinishReason).toBeUndefined();
  });

  it('streaming: preserves the raw finishReason on the terminal stop event', async () => {
    const http = fakeStreamHttp([
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]},"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}\n\n',
    ]);
    const stream = geminiAdapter.streamChat?.(ir, {
      providerType: 'gemini',
      model: 'gemini-3-pro',
      apiKey: 'k',
      http,
    });
    if (stream === undefined) throw new Error('no streamChat');
    const stop = stopEventOf(await drainChat(stream));
    expect(stop.stopReason).toBe('length');
    expect(stop.nativeFinishReason).toBe('MAX_TOKENS');
  });
});
