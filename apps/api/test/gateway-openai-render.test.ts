// 批次5 slice3 — OpenAI wire renderer unit tests: GatewayResponse →
// chat.completion (three dialect output shapes + fallback + usage breakdown),
// StreamFrame → chat.completion.chunk SSE ([DONE] terminal; error frame ends
// WITHOUT [DONE]), embeddings list, and the OpenAI error envelope + status map.
import type { GatewayError, GatewayResponse, GatewayUsage, StreamFrame } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import {
  openaiErrorTypeOf,
  renderChatCompletion,
  renderChatCompletionChunks,
  renderEmbeddingsList,
  sendOpenAIError,
} from '../src/gateway/openai-render.js';
import { fakeRes } from './gateway-fixtures.js';

const USAGE: GatewayUsage = {
  metrics: { input_tokens: 10, output_tokens: 5 },
  billingDims: {},
  estimated: false,
};

function chatResponse(output: unknown, usage: GatewayUsage = USAGE): GatewayResponse {
  return {
    operation: 'chat.completions',
    model: 'gpt-test',
    output,
    usage,
    servedBy: { offeringId: 'offering-1', channelId: 'channel-1' },
    warnings: [],
  };
}

async function collect(frames: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const frame of frames) out.push(frame);
  return out;
}

async function* streamOf(...frames: StreamFrame[]): AsyncGenerator<StreamFrame> {
  await Promise.resolve();
  yield* frames;
}

const dataOf = (frame: string): unknown =>
  JSON.parse(frame.replace(/^data: /, '').trim()) as unknown;

/** Bounds-checked frame accessor (negative = from the end), keeping tests assertion-free. */
function at(frames: string[], index: number): string {
  const frame = frames.at(index);
  if (frame === undefined) throw new Error(`no frame at ${String(index)}`);
  return frame;
}

describe('renderChatCompletion — output shape dispatch', () => {
  it('openai-dialect output (choices array) passes through with indexes', () => {
    const body = renderChatCompletion(
      chatResponse([{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }]),
    );
    expect(body).toMatchObject({
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    expect(body.id).toMatch(/^chatcmpl-/);
  });

  it('anthropic-dialect output (content blocks) folds into one assistant message', () => {
    const body = renderChatCompletion(
      chatResponse([
        { type: 'text', text: 'thinking… ' },
        { type: 'text', text: 'done' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'sf' } },
      ]),
    );
    const choice = (body.choices as Record<string, unknown>[])[0];
    expect(choice).toMatchObject({
      index: 0,
      message: {
        role: 'assistant',
        content: 'thinking… done',
        tool_calls: [
          {
            id: 'toolu_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"sf"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    });
  });

  it('gemini-dialect output ({text, toolCalls, finishReason}) maps text + calls', () => {
    const body = renderChatCompletion(
      chatResponse({
        text: 'hi',
        toolCalls: [{ id: 'call_f', name: 'f', args: { a: 1 } }],
        finishReason: 'STOP',
      }),
    );
    const choice = (body.choices as Record<string, unknown>[])[0];
    expect(choice).toMatchObject({
      message: { content: 'hi', tool_calls: [{ id: 'call_f', type: 'function' }] },
      finish_reason: 'tool_calls',
    });
  });

  it('gemini MAX_TOKENS finish maps to length', () => {
    const body = renderChatCompletion(chatResponse({ text: 'cut', finishReason: 'MAX_TOKENS' }));
    expect((body.choices as Record<string, unknown>[])[0]).toMatchObject({
      finish_reason: 'length',
    });
  });

  it('an unrecognized output shape degrades to stringified text (never a throw)', () => {
    const body = renderChatCompletion(chatResponse({ weird: true }));
    const choice = (body.choices as Record<string, unknown>[])[0];
    expect(choice).toMatchObject({
      message: { role: 'assistant', content: '{"weird":true}' },
      finish_reason: 'stop',
    });
  });

  it('surfaces the usage breakdown only when metered', () => {
    const body = renderChatCompletion(
      chatResponse('ok', {
        metrics: { input_tokens: 4, output_tokens: 2, cached_input_tokens: 3, reasoning_tokens: 1 },
        billingDims: {},
        estimated: false,
      }),
    );
    expect(body.usage).toEqual({
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
      prompt_tokens_details: { cached_tokens: 3 },
      completion_tokens_details: { reasoning_tokens: 1 },
    });
  });
});

describe('renderChatCompletionChunks — SSE framing', () => {
  it('opens with a role delta, streams content, finishes stop + [DONE]', async () => {
    const frames = await collect(
      renderChatCompletionChunks(
        streamOf(
          { kind: 'delta', payload: 'hel' },
          { kind: 'delta', payload: 'lo' },
          { kind: 'done', usage: USAGE },
        ),
        'gpt-test',
      ),
    );
    expect(dataOf(at(frames, 0))).toMatchObject({
      object: 'chat.completion.chunk',
      model: 'gpt-test',
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    });
    expect(dataOf(at(frames, 1))).toMatchObject({ choices: [{ delta: { content: 'hel' } }] });
    expect(dataOf(at(frames, 2))).toMatchObject({ choices: [{ delta: { content: 'lo' } }] });
    expect(dataOf(at(frames, 3))).toMatchObject({
      choices: [{ delta: {}, finish_reason: 'stop' }],
    });
    // the trailing usage chunk carries EMPTY choices (include_usage wire shape)
    expect(dataOf(at(frames, 4))).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    expect(frames[5]).toBe('data: [DONE]\n\n');
    expect(frames).toHaveLength(6);
  });

  it('an error frame renders the OpenAI error and ends WITHOUT [DONE] (v0.0.9)', async () => {
    const frames = await collect(
      renderChatCompletionChunks(
        streamOf(
          { kind: 'delta', payload: 'par' },
          {
            kind: 'error',
            error: {
              code: 'upstream_error',
              message: 'boom',
              retryable: true,
              failover: true,
            },
          },
        ),
        'gpt-test',
      ),
    );
    const last = at(frames, -1);
    expect(dataOf(last)).toEqual({
      error: { message: 'boom', type: 'server_error', param: null, code: 'upstream_error' },
    });
    expect(frames.some((f) => f.includes('[DONE]'))).toBe(false);
  });

  it('openai tool_calls fragments pass through and flip finish_reason to tool_calls', async () => {
    const frames = await collect(
      renderChatCompletionChunks(
        streamOf(
          {
            kind: 'delta',
            payload: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'f', arguments: '' },
                },
              ],
            },
          },
          { kind: 'done' },
        ),
        'gpt-test',
      ),
    );
    expect(dataOf(at(frames, 1))).toMatchObject({
      choices: [{ delta: { tool_calls: [{ id: 'call_1' }] } }],
    });
    expect(dataOf(at(frames, 2))).toMatchObject({
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    });
  });

  it('anthropic toolUse start + argumentsDelta slices map to OpenAI fragments', async () => {
    const frames = await collect(
      renderChatCompletionChunks(
        streamOf(
          { kind: 'delta', payload: { index: 1, toolUse: { id: 'toolu_1', name: 'f' } } },
          { kind: 'delta', payload: { index: 1, argumentsDelta: '{"a":' } },
          { kind: 'done' },
        ),
        'gpt-test',
      ),
    );
    expect(dataOf(at(frames, 1))).toMatchObject({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 1, id: 'toolu_1', type: 'function', function: { name: 'f', arguments: '' } },
            ],
          },
        },
      ],
    });
    expect(dataOf(at(frames, 2))).toMatchObject({
      choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"a":' } }] } }],
    });
  });

  it('gemini whole functionCall chunks map with synthesized ids and rising indexes', async () => {
    const frames = await collect(
      renderChatCompletionChunks(
        streamOf(
          { kind: 'delta', payload: { functionCall: { name: 'f', args: { a: 1 } } } },
          { kind: 'delta', payload: { functionCall: { name: 'g', args: {} } } },
          { kind: 'done' },
        ),
        'gpt-test',
      ),
    );
    expect(dataOf(at(frames, 1))).toMatchObject({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'call_f', function: { name: 'f', arguments: '{"a":1}' } }],
          },
        },
      ],
    });
    expect(dataOf(at(frames, 2))).toMatchObject({
      choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_g' }] } }],
    });
  });

  it('a mid-stream usage frame is stashed and emitted once after the finish chunk', async () => {
    const frames = await collect(
      renderChatCompletionChunks(
        streamOf(
          { kind: 'delta', payload: 'x' },
          { kind: 'usage', usage: USAGE },
          { kind: 'done' },
        ),
        'gpt-test',
      ),
    );
    const usageFrames = frames.filter((f) => f.includes('"usage"'));
    expect(usageFrames).toHaveLength(1);
    expect(frames.at(-1)).toBe('data: [DONE]\n\n');
  });

  it('a stream ending without done still closes with finish + [DONE] (honest close)', async () => {
    const frames = await collect(
      renderChatCompletionChunks(streamOf({ kind: 'delta', payload: 'x' }), 'gpt-test'),
    );
    expect(dataOf(at(frames, -2))).toMatchObject({
      choices: [{ delta: {}, finish_reason: 'stop' }],
    });
    expect(frames.at(-1)).toBe('data: [DONE]\n\n');
  });
});

describe('renderEmbeddingsList', () => {
  const embedResponse = (output: unknown): GatewayResponse => ({
    operation: 'embeddings',
    model: 'embed-test',
    output,
    usage: { metrics: { input_tokens: 7 }, billingDims: {}, estimated: false },
    servedBy: { offeringId: 'offering-1', channelId: 'channel-1' },
    warnings: [],
  });

  it('passes the openai-dialect data[] through (index normalized)', () => {
    const body = renderEmbeddingsList(
      embedResponse([{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }]),
    );
    expect(body).toEqual({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
      model: 'embed-test',
      usage: { prompt_tokens: 7, total_tokens: 7 },
    });
  });

  it('wraps bare vectors (number[][]) into embedding entries', () => {
    const body = renderEmbeddingsList(embedResponse([[0.1], [0.2]]));
    expect(body.data).toEqual([
      { object: 'embedding', index: 0, embedding: [0.1] },
      { object: 'embedding', index: 1, embedding: [0.2] },
    ]);
  });
});

describe('sendOpenAIError — §9.3 taxonomy → OpenAI envelope', () => {
  const err = (code: GatewayError['code'], extra: Partial<GatewayError> = {}): GatewayError => ({
    code,
    message: 'boom',
    retryable: false,
    failover: false,
    ...extra,
  });

  const cases: [GatewayError['code'], number, string][] = [
    ['conflict', 409, 'invalid_request_error'],
    ['rate_limited', 429, 'rate_limit_error'],
    ['model_not_found', 404, 'invalid_request_error'],
    ['insufficient_credits', 402, 'insufficient_quota'],
    ['unsupported_parameter', 400, 'invalid_request_error'],
    ['unauthorized', 401, 'authentication_error'],
    ['upstream_timeout', 504, 'server_error'],
  ];
  for (const [code, status, type] of cases) {
    it(`${code} → ${String(status)} / type ${type}`, () => {
      const res = fakeRes();
      sendOpenAIError(res, err(code), 'req-1');
      expect(res.statusCode).toBe(status);
      expect(res.body).toEqual({ error: { message: 'boom', type, param: null, code } });
      expect(res.headers['x-request-id']).toBe('req-1');
    });
  }

  it('rate_limited carries Retry-After (ceil seconds)', () => {
    const res = fakeRes();
    sendOpenAIError(res, err('rate_limited', { retryAfterMs: 1200 }), 'req-1');
    expect(res.headers['retry-after']).toBe('2');
  });

  it('surfaces the offending param from error.details (§4 rule 4)', () => {
    const res = fakeRes();
    sendOpenAIError(res, err('unsupported_parameter', { details: { param: 'resolution' } }), 'r');
    expect((res.body as { error: { param: string } }).error.param).toBe('resolution');
  });

  it('openaiErrorTypeOf maps the remaining codes', () => {
    expect(openaiErrorTypeOf('forbidden')).toBe('permission_error');
    expect(openaiErrorTypeOf('content_filtered')).toBe('invalid_request_error');
    expect(openaiErrorTypeOf('internal_error')).toBe('server_error');
  });
});
