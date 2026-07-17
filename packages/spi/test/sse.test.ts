// Bounded SSE framer (§6-⑤ 流转码有界缓冲): legacy framing semantics (half
// frames, CRLF, multi-line data, heartbeats) + the hard byte ceilings the old
// parser lacked.
import { describe, expect, it } from 'vitest';

import type { BoundedSseItem } from '../src/index.js';
import { parseSseBounded } from '../src/index.js';
import { collect } from './stub.js';

function chunks(...parts: string[]): AsyncIterable<string> {
  // eslint-disable-next-line @typescript-eslint/require-await
  return (async function* () {
    for (const part of parts) yield part;
  })();
}

const event = (data: string, name?: string): BoundedSseItem =>
  name === undefined ? { kind: 'event', data } : { kind: 'event', event: name, data };

describe('framing semantics (aligned with the legacy parser)', () => {
  it('reassembles half frames split across chunks', async () => {
    const items = await collect(parseSseBounded(chunks('data: he', 'llo\n', '\n')));
    expect(items).toEqual([event('hello')]);
  });

  it('tolerates CRLF line endings', async () => {
    const items = await collect(parseSseBounded(chunks('data: a\r\n\r\ndata: b\r\n\r\n')));
    expect(items).toEqual([event('a'), event('b')]);
  });

  it("joins multi-line data with '\\n' and keeps the event field (last wins)", async () => {
    const items = await collect(
      parseSseBounded(chunks('event: first\nevent: delta\ndata: a\ndata: b\n\n')),
    );
    expect(items).toEqual([event('a\nb', 'delta')]);
  });

  it("ignores ':' comment/heartbeat lines", async () => {
    const items = await collect(parseSseBounded(chunks(': ping\n\n', ': ping\ndata: x\n\n')));
    expect(items).toEqual([event('x')]);
  });

  it('passes the [DONE] sentinel through verbatim', async () => {
    const items = await collect(parseSseBounded(chunks('data: [DONE]\n\n')));
    expect(items).toEqual([event('[DONE]')]);
  });

  it('flushes a trailing line without a final newline and an unterminated final frame', async () => {
    const items = await collect(parseSseBounded(chunks('data: tail')));
    expect(items).toEqual([event('tail')]);
  });
});

describe('byte ceilings', () => {
  it('an event accumulating past maxEventBytes yields ONE error item and terminates', async () => {
    let pulledPastOverflow = false;
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* source(): AsyncIterable<string> {
      yield `data: ${'a'.repeat(64)}\ndata: ${'b'.repeat(64)}\n`;
      pulledPastOverflow = true;
      yield 'data: more\n\n';
    }
    const items = await collect(parseSseBounded(source(), { maxEventBytes: 100 }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'error',
      error: { code: 'upstream_error', retryable: false, failover: false },
    });
    if (items[0]?.kind === 'error') {
      expect(items[0].error.message).toContain('bounded buffer overflow');
    }
    expect(pulledPastOverflow).toBe(false); // stopped consuming the upstream
  });

  it('an unterminated line past maxBufferedBytes yields ONE error item and terminates', async () => {
    let pulledPastOverflow = false;
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* source(): AsyncIterable<string> {
      yield 'data: ' + 'x'.repeat(200); // no newline, ever
      pulledPastOverflow = true;
      yield 'y'.repeat(200);
    }
    const items = await collect(parseSseBounded(source(), { maxBufferedBytes: 128 }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'error', error: { code: 'upstream_error' } });
    if (items[0]?.kind === 'error') {
      expect(items[0].error.message).toContain('bounded buffer overflow');
    }
    expect(pulledPastOverflow).toBe(false);
  });

  it('events under the ceilings flow normally around the defaults', async () => {
    const big = 'a'.repeat(1024);
    const items = await collect(parseSseBounded(chunks(`data: ${big}\n\n`, 'data: ok\n\n')));
    expect(items).toEqual([event(big), event('ok')]);
  });
});
