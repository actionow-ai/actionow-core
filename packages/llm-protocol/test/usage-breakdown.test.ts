import type { ChatResponse, ChatStreamEvent, ChatUsage } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { renderAnthropicChat, renderAnthropicMessagesStream } from '../src/anthropic/index.js';
import { renderGeminiChat, renderGeminiGenerateContentStream } from '../src/gemini/index.js';
import { renderOpenAIChat, renderOpenAIChatStream } from '../src/openai/index.js';

// eslint-disable-next-line @typescript-eslint/require-await
async function* eventsOf(evs: ChatStreamEvent[]): AsyncIterable<ChatStreamEvent> {
  for (const e of evs) yield e;
}

/** Collect SSE frames, parse each `data:` JSON line into an object. */
async function dataObjects(it: AsyncIterable<string>): Promise<Record<string, unknown>[]> {
  let out = '';
  for await (const s of it) out += s;
  return out
    .split('\n\n')
    .flatMap((frame) => frame.split('\n'))
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
}

const baseResponse = (usage: ChatUsage): ChatResponse => ({
  message: { role: 'assistant', content: [{ kind: 'text', text: 'ok' }] },
  stopReason: 'stop',
  usage,
});

// --- OpenAI ----------------------------------------------------------------

describe('openai render usage breakdown', () => {
  it('emits prompt/completion details when the IR carries the breakdown', () => {
    const res = renderOpenAIChat(
      baseResponse({
        inputTokens: 100,
        outputTokens: 40,
        cachedInputTokens: 30,
        audioInputTokens: 10,
        reasoningTokens: 25,
        audioOutputTokens: 5,
      }),
      'gpt-4o',
    );
    expect(res.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      prompt_tokens_details: { cached_tokens: 30, audio_tokens: 10 },
      completion_tokens_details: { reasoning_tokens: 25, audio_tokens: 5 },
    });
  });

  it('omits details entirely when the IR has no breakdown (back-compat)', () => {
    const res = renderOpenAIChat(baseResponse({ inputTokens: 7, outputTokens: 3 }), 'gpt-4o');
    expect(res.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  });

  it('streaming usage chunk surfaces the breakdown when present', async () => {
    const objs = await dataObjects(
      renderOpenAIChatStream(
        eventsOf([
          { type: 'message_start' },
          { type: 'content_delta', text: 'x' },
          {
            type: 'usage',
            usage: { inputTokens: 100, outputTokens: 40, cachedInputTokens: 30, reasoningTokens: 25 },
          },
          { type: 'stop', stopReason: 'stop' },
          { type: 'done' },
        ]),
        'gpt-4o',
      ),
    );
    const usageChunk = objs.find((o) => 'usage' in o);
    expect(usageChunk?.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      prompt_tokens_details: { cached_tokens: 30 },
      completion_tokens_details: { reasoning_tokens: 25 },
    });
  });

  it('streaming usage chunk omits details when absent (back-compat)', async () => {
    const objs = await dataObjects(
      renderOpenAIChatStream(
        eventsOf([
          { type: 'message_start' },
          { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
          { type: 'stop', stopReason: 'stop' },
          { type: 'done' },
        ]),
        'gpt-4o',
      ),
    );
    const usageChunk = objs.find((o) => 'usage' in o);
    expect(usageChunk?.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  });
});

// --- Anthropic -------------------------------------------------------------

describe('anthropic render usage breakdown', () => {
  it('emits cache_read/cache_creation when the IR carries them', () => {
    const res = renderAnthropicChat(
      baseResponse({
        inputTokens: 80,
        outputTokens: 20,
        cachedInputTokens: 50,
        cacheCreationTokens: 12,
      }),
      'claude',
    );
    expect(res.usage).toEqual({
      input_tokens: 80,
      output_tokens: 20,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 12,
    });
  });

  it('omits cache fields when absent (back-compat)', () => {
    const res = renderAnthropicChat(baseResponse({ inputTokens: 4, outputTokens: 2 }), 'claude');
    expect(res.usage).toEqual({ input_tokens: 4, output_tokens: 2 });
  });

  it('streaming message_delta surfaces cache fields when present', async () => {
    const objs = await dataObjects(
      renderAnthropicMessagesStream(
        eventsOf([
          { type: 'message_start' },
          { type: 'content_delta', text: 'x' },
          {
            type: 'usage',
            usage: { inputTokens: 80, outputTokens: 20, cachedInputTokens: 50, cacheCreationTokens: 12 },
          },
          { type: 'stop', stopReason: 'stop' },
        ]),
        'claude',
      ),
    );
    const messageDelta = objs.find((o) => o.type === 'message_delta');
    expect(messageDelta?.usage).toEqual({
      output_tokens: 20,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 12,
    });
  });

  it('streaming message_delta omits cache fields when absent (back-compat)', async () => {
    const objs = await dataObjects(
      renderAnthropicMessagesStream(
        eventsOf([
          { type: 'message_start' },
          { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } },
          { type: 'stop', stopReason: 'stop' },
        ]),
        'claude',
      ),
    );
    const messageDelta = objs.find((o) => o.type === 'message_delta');
    expect(messageDelta?.usage).toEqual({ output_tokens: 2 });
  });
});

// --- Gemini ----------------------------------------------------------------

describe('gemini render usage breakdown', () => {
  it('emits thoughts/cachedContent when the IR carries them', () => {
    const res = renderGeminiChat(
      baseResponse({ inputTokens: 60, outputTokens: 18, reasoningTokens: 9, cachedInputTokens: 22 }),
    );
    expect(res.usageMetadata).toEqual({
      promptTokenCount: 60,
      candidatesTokenCount: 18,
      totalTokenCount: 78,
      thoughtsTokenCount: 9,
      cachedContentTokenCount: 22,
    });
  });

  it('omits thoughts/cachedContent when absent (back-compat)', () => {
    const res = renderGeminiChat(baseResponse({ inputTokens: 3, outputTokens: 1 }));
    expect(res.usageMetadata).toEqual({
      promptTokenCount: 3,
      candidatesTokenCount: 1,
      totalTokenCount: 4,
    });
  });

  it('streaming final chunk surfaces the breakdown when present', async () => {
    const objs = await dataObjects(
      renderGeminiGenerateContentStream(
        eventsOf([
          { type: 'content_delta', text: 'x' },
          {
            type: 'usage',
            usage: { inputTokens: 60, outputTokens: 18, reasoningTokens: 9, cachedInputTokens: 22 },
          },
          { type: 'stop', stopReason: 'stop' },
        ]),
      ),
    );
    const final = objs.find((o) => 'usageMetadata' in o);
    expect(final?.usageMetadata).toEqual({
      promptTokenCount: 60,
      candidatesTokenCount: 18,
      totalTokenCount: 78,
      thoughtsTokenCount: 9,
      cachedContentTokenCount: 22,
    });
  });
});
