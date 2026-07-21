// Unit coverage for the Gemini dialect (BUG 2): the canonical IR / golden probe
// deliver OpenAI-shaped `messages` + `max_tokens` + sampling params, which
// gemini rejects (`Unknown name "messages"`). Aspect ① must reshape them into
// native generateContent form (contents / systemInstruction / generationConfig)
// WITHOUT leaking `messages`/`max_tokens`, and must leave an already-native body
// untouched. Also asserts the response mapping normalizes
// candidates[].content.parts[].text.
import { describe, expect, it } from 'vitest';

import type { DialectContext, RequestMappingInput, WireResponse } from '../src/aspects.js';
import { geminiDialect } from '../src/dialects/gemini.dialect.js';

const CTX: DialectContext = {
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  nowMs: 1_752_000_000_000,
};

function mapInput(
  upstream: Record<string, unknown>,
  overrides: Partial<RequestMappingInput> = {},
): RequestMappingInput {
  return {
    operation: 'chat.completions',
    upstreamModelName: 'gemini-1.5-pro',
    params: { canonical: {}, upstream },
    stream: false,
    ctx: CTX,
    ...overrides,
  };
}

describe('gemini dialect — request mapping (OpenAI IR → native)', () => {
  it('translates system + user messages + max_tokens into native shape and drops OpenAI keys', () => {
    const draft = geminiDialect.requestMapping.map(
      mapInput({
        messages: [
          { role: 'system', content: 'You are terse.' },
          { role: 'user', content: 'Reply with the single word: ok' },
        ],
        max_tokens: 32,
        temperature: 0.7,
        top_p: 0.95,
      }),
    );
    const body = draft.body as Record<string, unknown>;

    expect(body).toEqual({
      systemInstruction: { parts: [{ text: 'You are terse.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
      generationConfig: { maxOutputTokens: 32, temperature: 0.7, topP: 0.95 },
    });
    // The OpenAI-shaped keys MUST NOT leak onto the wire.
    expect(body.messages).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
  });

  it('maps the remaining known OpenAI wire params into generationConfig and drops the unmappable ones', () => {
    const draft = geminiDialect.requestMapping.map(
      mapInput({
        messages: [{ role: 'user', content: 'hi' }],
        max_completion_tokens: 100,
        frequency_penalty: 0.5,
        presence_penalty: 0.25,
        seed: 7,
        n: 2,
        // no clean gemini equivalent → must be DROPPED, never a top-level key:
        response_format: { type: 'json_object' },
        reasoning_effort: 'high',
        logprobs: true,
        top_logprobs: 5,
        logit_bias: { '1': 1 },
      }),
    );
    const body = draft.body as Record<string, unknown>;
    expect(body.generationConfig).toEqual({
      maxOutputTokens: 100,
      frequencyPenalty: 0.5,
      presencePenalty: 0.25,
      seed: 7,
      candidateCount: 2,
    });
    for (const k of [
      'max_completion_tokens',
      'frequency_penalty',
      'presence_penalty',
      'seed',
      'n',
      'response_format',
      'reasoning_effort',
      'logprobs',
      'top_logprobs',
      'logit_bias',
    ]) {
      expect(body[k]).toBeUndefined();
    }
  });

  it('maps assistant role → model and preserves multi-turn order', () => {
    const draft = geminiDialect.requestMapping.map(
      mapInput({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
          { role: 'user', content: 'bye' },
        ],
      }),
    );
    expect((draft.body as Record<string, unknown>).contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
      { role: 'user', parts: [{ text: 'bye' }] },
    ]);
  });

  it('maps stop → stopSequences and wraps a bare string', () => {
    const draft = geminiDialect.requestMapping.map(
      mapInput({ messages: [{ role: 'user', content: 'x' }], stop: 'STOP' }),
    );
    const gen = (draft.body as Record<string, unknown>).generationConfig as Record<string, unknown>;
    expect(gen.stopSequences).toEqual(['STOP']);
  });

  it('leaves an already-native body untouched (pre-shaped upstream is a no-op)', () => {
    const native = {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      systemInstruction: { parts: [{ text: 'You are a helpful assistant.' }] },
      generationConfig: { temperature: 0.7, maxOutputTokens: 256, topP: 0.95 },
    };
    const draft = geminiDialect.requestMapping.map(mapInput({ ...native }));
    expect(draft.body).toEqual(native);
  });

  it('keeps the path/verb/query on the stream path while reshaping the body', () => {
    const draft = geminiDialect.requestMapping.map(
      mapInput({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }, { stream: true }),
    );
    expect(draft.path).toBe('models/gemini-1.5-pro:streamGenerateContent');
    expect(draft.query).toEqual({ alt: 'sse' });
    const body = draft.body as Record<string, unknown>;
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
    expect(body.generationConfig).toEqual({ maxOutputTokens: 8 });
    expect(body.messages).toBeUndefined();
  });
});

describe('gemini dialect — response normalization', () => {
  it('joins candidates[].content.parts[].text into the normalized text + usage', () => {
    const res: WireResponse = {
      status: 200,
      headers: {},
      body: {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'Hello ' }, { text: 'there!' }] },
            finishReason: 'STOP',
            index: 0,
          },
        ],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 },
      },
    };
    const normalized = geminiDialect.responseNormalization.normalize(res, CTX);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) throw new Error('expected ok');
    expect((normalized.output as Record<string, unknown>).text).toBe('Hello there!');
    expect(normalized.usage.metrics).toEqual({ input_tokens: 12, output_tokens: 4 });
  });
});
