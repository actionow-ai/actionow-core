import { describe, expect, it } from 'vitest';

import { consumeSse, SSE_DONE, type SseFrame } from './sse.js';

/** Build a `Response`-like object whose `body` streams the given UTF-8 string in chunks. */
function streamOf(text: string, chunkSize = text.length): Pick<Response, 'body'> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
  return { body };
}

async function collect(source: Pick<Response, 'body'>): Promise<SseFrame[]> {
  const out: SseFrame[] = [];
  for await (const frame of consumeSse(source)) out.push(frame);
  return out;
}

describe('consumeSse', () => {
  it('parses bare `data:` frames (OpenAI dialect) and yields the [DONE] sentinel', async () => {
    const wire =
      'data: {"choices":[{"delta":{"content":"He"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n' +
      'data: [DONE]\n\n';

    const frames = await collect(streamOf(wire));

    expect(frames).toHaveLength(3);
    expect(frames[0]?.event).toBe('message'); // default event when no `event:` line
    expect(frames[0]?.data).toBe('{"choices":[{"delta":{"content":"He"}}]}');
    expect(frames[2]?.data).toBe(SSE_DONE); // sentinel surfaced, not swallowed
  });

  it('parses typed `event:`/`data:` frames (the /v1/run dialect)', async () => {
    const wire =
      'event: delta\ndata: {"text":"a"}\n\n' +
      'event: usage\ndata: {"tokens":3}\n\n' +
      'event: done\ndata: {"jobId":"job_1"}\n\n';

    const frames = await collect(streamOf(wire));

    expect(frames.map((f) => f.event)).toEqual(['delta', 'usage', 'done']);
    expect(frames[2]?.data).toBe('{"jobId":"job_1"}');
  });

  it('reassembles frames split across read() chunk boundaries', async () => {
    const wire = 'event: delta\ndata: {"text":"hello world"}\n\nevent: done\ndata: {}\n\n';

    // One byte at a time — every field, colon, and the `\n\n` separator straddle chunks.
    const frames = await collect(streamOf(wire, 1));

    expect(frames).toHaveLength(2);
    expect(frames[0]?.event).toBe('delta');
    expect(frames[0]?.data).toBe('{"text":"hello world"}');
    expect(frames[1]?.event).toBe('done');
  });

  it('joins multiple `data:` lines in one frame with a newline (per the SSE spec)', async () => {
    const wire = 'data: line one\ndata: line two\n\n';

    const frames = await collect(streamOf(wire));

    expect(frames).toHaveLength(1);
    expect(frames[0]?.data).toBe('line one\nline two');
  });

  it('strips exactly one leading space after the colon and captures id/retry', async () => {
    const wire = 'id: 42\nretry: 3000\nevent: ping\ndata:  two-leading-spaces\n\n';

    const frames = await collect(streamOf(wire));

    expect(frames[0]?.id).toBe('42');
    expect(frames[0]?.retry).toBe(3000);
    // Only ONE space is stripped, so a second space is preserved in the value.
    expect(frames[0]?.data).toBe(' two-leading-spaces');
  });

  it('ignores comment lines and tolerates CRLF separators', async () => {
    const wire = ': keep-alive ping\r\n\r\ndata: real\r\n\r\n';

    const frames = await collect(streamOf(wire));

    // The comment-only block yields nothing; only the real data frame survives.
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data).toBe('real');
  });

  it('flushes a final frame that is not terminated by a trailing blank line', async () => {
    const wire = 'data: a\n\ndata: trailing-no-blank-line';

    const frames = await collect(streamOf(wire));

    expect(frames.map((f) => f.data)).toEqual(['a', 'trailing-no-blank-line']);
  });

  it('throws when the response has no body', async () => {
    await expect(collect({ body: null })).rejects.toThrow(/body is null/);
  });
});
