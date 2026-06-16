import { describe, expect, it } from 'vitest';

import { parseSse } from '../src/internal/sse.js';

/** Wrap an array of string chunks as an `AsyncIterable<string>`. */
function chunks(parts: string[]): AsyncIterable<string> {
  // eslint-disable-next-line @typescript-eslint/require-await
  return (async function* gen(): AsyncIterable<string> {
    for (const part of parts) {
      yield part;
    }
  })();
}

/** Drain a `parseSse` iterable into an array for assertions. */
async function collect(
  it: AsyncIterable<{ event?: string; data: string }>,
): Promise<{ event?: string; data: string }[]> {
  const out: { event?: string; data: string }[] = [];
  for await (const frame of it) {
    out.push(frame);
  }
  return out;
}

describe('parseSse', () => {
  it('parses a single data-only frame', async () => {
    const frames = await collect(parseSse(chunks(['data: hello\n\n'])));
    expect(frames).toEqual([{ data: 'hello' }]);
  });

  it('collects event: + data: fields into one frame', async () => {
    const frames = await collect(parseSse(chunks(['event: delta\ndata: hi\n\n'])));
    expect(frames).toEqual([{ event: 'delta', data: 'hi' }]);
  });

  it('parses multiple frames split on a blank line', async () => {
    const frames = await collect(parseSse(chunks(['data: one\n\ndata: two\n\ndata: three\n\n'])));
    expect(frames).toEqual([{ data: 'one' }, { data: 'two' }, { data: 'three' }]);
  });

  it('buffers a frame that spans multiple chunks (partial lines)', async () => {
    const frames = await collect(
      parseSse(chunks(['ev', 'ent: delta\nda', 'ta: hel', 'lo\n', '\n'])),
    );
    expect(frames).toEqual([{ event: 'delta', data: 'hello' }]);
  });

  it('concatenates multiple data: lines within one frame with newlines', async () => {
    const frames = await collect(parseSse(chunks(['data: a\ndata: b\n\n'])));
    expect(frames).toEqual([{ data: 'a\nb' }]);
  });

  it('ignores comment lines starting with a colon (heartbeats)', async () => {
    const frames = await collect(parseSse(chunks([': keep-alive ping\n\ndata: real\n\n'])));
    expect(frames).toEqual([{ data: 'real' }]);
  });

  it('strips only a single leading space after the field colon', async () => {
    const frames = await collect(parseSse(chunks(['data:  two-spaces\n\n'])));
    expect(frames).toEqual([{ data: ' two-spaces' }]);
  });

  it('handles a field with no value', async () => {
    const frames = await collect(parseSse(chunks(['data:\n\n'])));
    expect(frames).toEqual([{ data: '' }]);
  });

  it('carries the [DONE] sentinel through as data so callers can stop', async () => {
    const frames = await collect(parseSse(chunks(['data: {"x":1}\n\n', 'data: [DONE]\n\n'])));
    expect(frames).toEqual([{ data: '{"x":1}' }, { data: '[DONE]' }]);
  });

  it('flushes a trailing frame with no terminating blank line', async () => {
    const frames = await collect(parseSse(chunks(['data: last'])));
    expect(frames).toEqual([{ data: 'last' }]);
  });

  it('tolerates CRLF line endings', async () => {
    const frames = await collect(parseSse(chunks(['event: e\r\ndata: d\r\n\r\n'])));
    expect(frames).toEqual([{ event: 'e', data: 'd' }]);
  });

  it('emits nothing for an empty stream', async () => {
    const frames = await collect(parseSse(chunks([])));
    expect(frames).toEqual([]);
  });
});
