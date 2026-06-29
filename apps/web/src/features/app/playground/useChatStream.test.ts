import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useChatStream } from './useChatStream';

/** A streamed 200 Response whose body yields the given raw SSE chunks, then closes. */
function streamResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** One OpenAI-style streaming delta frame. */
function delta(d: { content?: string; reasoning_content?: string }): string {
  return `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useChatStream', () => {
  it('assembles content + reasoning separately and maps the final usage', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        streamResponse([
          delta({ reasoning_content: 'think ' }),
          delta({ reasoning_content: 'more' }),
          delta({ content: 'Hello' }),
          delta({ content: ', world' }),
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 6, completion_tokens: 3 } })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useChatStream());
    const outcome = await result.current.run({
      key: 'ak_test',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(outcome.kind).toBe('done');
    if (outcome.kind !== 'done') return;
    expect(outcome.content).toBe('Hello, world');
    expect(outcome.reasoning).toBe('think more');
    expect(outcome.usage).toEqual({ input: 6, output: 3 });

    // The request opted into streaming usage + sent the bearer key.
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer ak_test');
  });

  it('decodes a non-2xx response as an error and flags a 401 as unauthorized', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'bad key' } }), {
        status: 401,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useChatStream());
    const outcome = await result.current.run({
      key: 'ak_revoked',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') return;
    expect(outcome.unauthorized).toBe(true);
    expect(outcome.message).toBe('bad key');
  });

  it('prepends a system turn when a system prompt is supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamResponse(['data: [DONE]\n\n']));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useChatStream());
    await result.current.run({
      key: 'ak_test',
      model: 'm',
      system: 'be terse',
      messages: [{ role: 'user', content: 'hi' }],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: { role: string; content: string }[];
    };
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be terse' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });
});
