// 批次5 slice6 — renderer tests for the five new legacy surfaces:
// GatewayResponse → Anthropic message / Gemini candidates / rerank /
// moderations / transcription wire shapes (all three dialect-authored chat
// output shapes recognized), StreamFrame → Anthropic typed SSE / Gemini
// alt=sse, and the per-dialect error envelopes.
import type { GatewayError, GatewayUsage, StreamFrame } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import {
  renderAnthropicMessageOf,
  renderAnthropicMessagesSse,
  sendAnthropicError,
} from '../src/gateway/anthropic-render.js';
import {
  renderGeminiResponseOf,
  renderGeminiSse,
  sendGeminiError,
} from '../src/gateway/gemini-render.js';
import {
  renderModerationsOf,
  renderRerankOf,
  renderTranscriptionOf,
} from '../src/gateway/openai-render.js';
import { fakeRes } from './gateway-fixtures.js';

const USAGE: GatewayUsage = {
  metrics: { input_tokens: 3, output_tokens: 2 },
  billingDims: {},
  estimated: false,
};

async function collect(frames: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const frame of frames) out += frame;
  return out;
}

async function* framesOf(...frames: StreamFrame[]): AsyncGenerator<StreamFrame> {
  await Promise.resolve();
  for (const frame of frames) yield frame;
}

// --- anthropic non-streaming ---------------------------------------------------------------

describe('renderAnthropicMessageOf — GatewayResponse.output → Anthropic message', () => {
  it('openai-dialect choices → text content + wire usage', () => {
    const out = renderAnthropicMessageOf(
      [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      USAGE,
      'model-x',
    );
    expect(out).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'model-x',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 2 },
    });
  });

  it('openai-dialect tool_calls → tool_use blocks + stop_reason tool_use', () => {
    const out = renderAnthropicMessageOf(
      [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'get', arguments: '{"a":1}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      USAGE,
      'model-x',
    );
    expect(out).toMatchObject({
      content: [{ type: 'tool_use', id: 'call_1', name: 'get', input: { a: 1 } }],
      stop_reason: 'tool_use',
    });
  });

  it('anthropic-dialect blocks pass through; gemini-dialect {text} maps MAX_TOKENS → max_tokens', () => {
    const blocks = renderAnthropicMessageOf(
      [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 't1', name: 'f', input: { x: 1 } },
      ],
      USAGE,
      'model-x',
    );
    expect(blocks).toMatchObject({
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 't1', name: 'f', input: { x: 1 } },
      ],
      stop_reason: 'tool_use',
    });

    const gemini = renderAnthropicMessageOf(
      { text: 'truncated', finishReason: 'MAX_TOKENS' },
      USAGE,
      'model-x',
    );
    expect(gemini).toMatchObject({
      content: [{ type: 'text', text: 'truncated' }],
      stop_reason: 'max_tokens',
    });
  });

  it('an unrecognized shape degrades to a JSON-stringified text message', () => {
    const out = renderAnthropicMessageOf({ weird: true }, undefined, 'model-x');
    expect(out).toMatchObject({
      content: [{ type: 'text', text: '{"weird":true}' }],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  });
});

// --- anthropic streaming ---------------------------------------------------------------------

describe('renderAnthropicMessagesSse — StreamFrame → Anthropic typed SSE', () => {
  it('text deltas + done → message_start … content_block_delta … message_delta/message_stop', async () => {
    const wire = await collect(
      renderAnthropicMessagesSse(
        framesOf(
          { kind: 'delta', payload: 'hel' },
          { kind: 'delta', payload: 'lo' },
          { kind: 'done', usage: USAGE },
        ),
        'model-x',
      ),
    );
    expect(wire).toContain('event: message_start');
    expect(wire).toContain('"model":"model-x"');
    expect(wire).toContain('event: content_block_start');
    expect(wire).toContain('"text_delta","text":"hel"');
    expect(wire).toContain('"text_delta","text":"lo"');
    expect(wire).toContain('event: message_delta');
    expect(wire).toContain('"stop_reason":"end_turn"');
    expect(wire).toContain('"output_tokens":2');
    expect(wire).toContain('event: message_stop');
  });

  it('anthropic-dialect tool frames → tool_use block + input_json_delta + stop_reason tool_use', async () => {
    const wire = await collect(
      renderAnthropicMessagesSse(
        framesOf(
          { kind: 'delta', payload: { index: 0, toolUse: { id: 't1', name: 'f' } } },
          { kind: 'delta', payload: { index: 0, argumentsDelta: '{"x":1}' } },
          { kind: 'done', usage: USAGE },
        ),
        'model-x',
      ),
    );
    expect(wire).toContain('"type":"tool_use","id":"t1","name":"f"');
    expect(wire).toContain('"input_json_delta","partial_json":"{\\"x\\":1}"');
    expect(wire).toContain('"stop_reason":"tool_use"');
  });

  it('a mid-stream gateway error frame becomes the Anthropic error event and ends the stream', async () => {
    const wire = await collect(
      renderAnthropicMessagesSse(
        framesOf(
          { kind: 'delta', payload: 'hel' },
          {
            kind: 'error',
            error: {
              code: 'upstream_error',
              message: 'boom',
              retryable: false,
              failover: true,
            },
          },
        ),
        'model-x',
      ),
    );
    expect(wire).toContain('event: error');
    expect(wire).toContain('"type":"overloaded_error"');
    expect(wire).toContain('"message":"boom"');
    expect(wire).not.toContain('event: message_stop');
  });
});

// --- gemini ------------------------------------------------------------------------------------

describe('renderGeminiResponseOf / renderGeminiSse — GatewayResponse → Gemini wire', () => {
  it('openai-dialect choices → candidates + usageMetadata', () => {
    const out = renderGeminiResponseOf(
      [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      USAGE,
    );
    expect(out).toEqual({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'hello' }] },
          finishReason: 'STOP',
          index: 0,
          safetyRatings: [],
        },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    });
  });

  it('anthropic-dialect tool_use blocks → functionCall parts', () => {
    const out = renderGeminiResponseOf(
      [{ type: 'tool_use', id: 't1', name: 'f', input: { x: 1 } }],
      USAGE,
    ) as { candidates: { content: { parts: unknown[] } }[] };
    expect(out.candidates[0]?.content.parts).toEqual([
      { functionCall: { name: 'f', args: { x: 1 } } },
    ]);
  });

  it('SSE: text delta + gemini functionCall delta + done → candidate frames + finishReason', async () => {
    const wire = await collect(
      renderGeminiSse(
        framesOf(
          { kind: 'delta', payload: 'hel' },
          { kind: 'delta', payload: { functionCall: { name: 'f', args: { x: 1 } } } },
          { kind: 'done', usage: USAGE },
        ),
      ),
    );
    expect(wire).toContain('"parts":[{"text":"hel"}]');
    expect(wire).toContain('"functionCall":{"name":"f","args":{"x":1}}');
    expect(wire).toContain('"finishReason":"STOP"');
    expect(wire).toContain('"promptTokenCount":3');
    expect(wire).not.toContain('[DONE]');
  });
});

// --- rerank / moderations / transcription -------------------------------------------------------

describe('renderRerankOf — normalized output → Cohere/Jina wire', () => {
  it('renders results envelopes, camelCase scores and Cohere {text} documents', () => {
    const out = renderRerankOf(
      {
        results: [
          { index: 1, relevance_score: 0.9, document: 'b' },
          { index: 0, relevanceScore: 0.4, document: { text: 'a' } },
        ],
      },
      USAGE,
      'rr',
    );
    expect(out).toEqual({
      model: 'rr',
      results: [
        { index: 1, relevance_score: 0.9, document: 'b' },
        { index: 0, relevance_score: 0.4, document: 'a' },
      ],
      usage: { input_tokens: 3 },
    });
  });

  it('accepts a bare results array; degrades unrecognized items', () => {
    const out = renderRerankOf([{ index: 0, relevance_score: 1 }], undefined, 'rr') as {
      results: unknown[];
      usage: { input_tokens: number };
    };
    expect(out.results).toEqual([{ index: 0, relevance_score: 1 }]);
    expect(out.usage.input_tokens).toBe(0);
  });
});

describe('renderModerationsOf — normalized output → OpenAI moderations wire', () => {
  it('renders flagged/categories/category_scores (camelCase categoryScores accepted)', () => {
    const out = renderModerationsOf(
      {
        results: [
          { flagged: true, categories: { hate: true }, categoryScores: { hate: 0.99 } },
          { flagged: false, categories: {}, category_scores: {} },
        ],
      },
      'mod',
    ) as { id: string; model: string; results: unknown[] };
    expect(out.id).toMatch(/^modr-/);
    expect(out.model).toBe('mod');
    expect(out.results).toEqual([
      { flagged: true, categories: { hate: true }, category_scores: { hate: 0.99 } },
      { flagged: false, categories: {}, category_scores: {} },
    ]);
  });
});

describe('renderTranscriptionOf — normalized output → the client response_format', () => {
  const OUTPUT = {
    text: 'hello world',
    language: 'en',
    duration: 1.5,
    segments: [{ id: 0, start: 0, end: 1.5, text: 'hello world' }],
  };

  it("'text' → the raw transcript string; default json → {text}", () => {
    expect(renderTranscriptionOf(OUTPUT, 'text')).toBe('hello world');
    expect(renderTranscriptionOf(OUTPUT, undefined)).toEqual({ text: 'hello world' });
    expect(renderTranscriptionOf(OUTPUT, 'json')).toEqual({ text: 'hello world' });
  });

  it("'verbose_json' → text + language/duration/segments", () => {
    expect(renderTranscriptionOf(OUTPUT, 'verbose_json')).toEqual(OUTPUT);
  });

  it('a bare string output is the transcript itself', () => {
    expect(renderTranscriptionOf('plain', 'json')).toEqual({ text: 'plain' });
    expect(renderTranscriptionOf('plain', 'text')).toBe('plain');
  });
});

// --- error envelopes ------------------------------------------------------------------------------

describe('sendAnthropicError / sendGeminiError — GatewayError → dialect envelopes', () => {
  const rateLimited: GatewayError = {
    code: 'rate_limited',
    message: 'slow down',
    retryable: true,
    failover: false,
    retryAfterMs: 3000,
  };

  it('anthropic: status from the taxonomy, Retry-After on 429, the typed envelope', () => {
    const res = fakeRes();
    sendAnthropicError(res, rateLimited, 'req-1');
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('3');
    expect(res.headers['request-id']).toBe('req-1');
    expect(res.body).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'slow down' },
    });
  });

  it('anthropic: insufficient_credits → 402 billing_error; model_not_found → 404 not_found_error', () => {
    const res402 = fakeRes();
    sendAnthropicError(
      res402,
      { code: 'insufficient_credits', message: 'broke', retryable: false, failover: false },
      'req-1',
    );
    expect(res402.statusCode).toBe(402);
    expect(res402.body).toMatchObject({ error: { type: 'billing_error' } });

    const res404 = fakeRes();
    sendAnthropicError(
      res404,
      { code: 'model_not_found', message: 'gone', retryable: false, failover: false },
      'req-1',
    );
    expect(res404.statusCode).toBe(404);
    expect(res404.body).toMatchObject({ error: { type: 'not_found_error' } });
  });

  it('gemini: the Google {error:{code,message,status}} envelope', () => {
    const res = fakeRes();
    sendGeminiError(
      res,
      { code: 'model_not_found', message: 'gone', retryable: false, failover: false },
      'req-1',
    );
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      error: { code: 404, message: 'gone', status: 'NOT_FOUND' },
    });

    const res429 = fakeRes();
    sendGeminiError(res429, rateLimited, 'req-1');
    expect(res429.statusCode).toBe(429);
    expect(res429.headers['retry-after']).toBe('3');
    expect(res429.body).toMatchObject({ error: { status: 'RESOURCE_EXHAUSTED' } });
  });
});
