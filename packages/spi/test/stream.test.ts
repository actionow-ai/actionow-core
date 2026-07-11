// runStream (§6 ①②③④⑤ on the stream path): the 「首帧已达」 pre-commit point,
// frame replay, terminal-frame semantics, failed opens as REAL errors, and the
// bounded framer wired in.
import type { StreamFrame } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import type { SyncRunInput } from '../src/index.js';
import { runStream } from '../src/index.js';
import { BEARER_SECRET, collect, CTX, fakeStreamHttp, stubDialect, usage } from './stub.js';

function input(overrides: Partial<SyncRunInput> = {}): SyncRunInput {
  return {
    operation: 'chat.completions',
    upstreamModelName: 'stub-chat-1',
    params: { canonical: {}, upstream: {} },
    secret: BEARER_SECRET,
    ctx: CTX,
    ...overrides,
  };
}

describe('runStream', () => {
  it('firstFrame resolves the first normalized frame; frames REPLAY it then continue', async () => {
    const http = fakeStreamHttp(200, [
      'data: {"t":"a"}\n\n',
      'data: {"t":',
      '"b"}\n\n', // half frame across chunks, reassembled by the bounded framer
      ': heartbeat\n\n',
      'data: [DONE]\n\n',
    ]);
    const handle = runStream(stubDialect(), input(), { http });

    const first = await handle.firstFrame;
    expect(first).toEqual({ kind: 'delta', payload: '{"t":"a"}' });

    const frames = await collect(handle.frames);
    expect(frames[0]).toEqual(first); // replayed, not consumed away
    expect(frames).toEqual([
      { kind: 'delta', payload: '{"t":"a"}' },
      { kind: 'delta', payload: '{"t":"b"}' },
      { kind: 'done', usage: usage({ output_tokens: 2 }) },
    ]);
  });

  it('passes stream: true into aspect ① on the stream path', async () => {
    let sawStream: boolean | undefined;
    const dialect = stubDialect({
      requestMapping: {
        map: (mapInput) => {
          sawStream = mapInput.stream;
          return { method: 'POST', path: '/chat', bodyKind: 'json', body: {} };
        },
      },
    });
    const handle = runStream(dialect, input(), { http: fakeStreamHttp(200, ['data: x\n\n']) });
    await handle.firstFrame;
    expect(sawStream).toBe(true);
  });

  it('a non-2xx open drains the error body into ⑤ normalize → the FIRST frame is a real error (pre-commit never blesses it)', async () => {
    const http = fakeStreamHttp(429, ['{"error":{"message":"slow down"}}']);
    const handle = runStream(stubDialect(), input(), { http });
    const first = await handle.firstFrame;
    expect(first).toMatchObject({
      kind: 'error',
      error: { code: 'rate_limited', retryable: true, failover: true },
    });
    const frames = await collect(handle.frames);
    expect(frames).toEqual([first]); // single terminal frame, no [DONE]
  });

  it('a dialect protocol-violation verdict ({error}) terminates with ONE error frame', async () => {
    const dialect = stubDialect({
      responseNormalization: {
        normalize: () => ({ ok: true, output: null, usage: usage() }),
        normalizeStreamFrame: (rawFrame) =>
          rawFrame === 'poison'
            ? {
                error: {
                  code: 'upstream_error',
                  message: 'unparseable frame',
                  retryable: false,
                  failover: false,
                },
              }
            : [{ kind: 'delta', payload: rawFrame }],
      },
    });
    const http = fakeStreamHttp(200, ['data: fine\n\n', 'data: poison\n\n', 'data: never\n\n']);
    const frames = await collect(runStream(dialect, input(), { http }).frames);
    expect(frames.map((frame) => frame.kind)).toEqual(['delta', 'error']);
  });

  it('an empty 2xx stream synthesizes a terminal error frame (never a silent empty success)', async () => {
    const handle = runStream(stubDialect(), input(), { http: fakeStreamHttp(200, []) });
    const first = await handle.firstFrame;
    expect(first).toMatchObject({
      kind: 'error',
      error: { code: 'upstream_error', retryable: true, failover: true },
    });
    if (first.kind === 'error') {
      expect(first.error.message).toContain('before producing any frame');
    }
  });

  it('a framer byte-ceiling overflow surfaces as the terminal error frame', async () => {
    const giant = 'a'.repeat(1_100_000); // > 1 MiB default event ceiling
    const http = fakeStreamHttp(200, ['data: ok\n\n', `data: ${giant}\n\n`]);
    const frames = await collect(runStream(stubDialect(), input(), { http }).frames);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ kind: 'delta' });
    expect(frames[1]).toMatchObject({ kind: 'error', error: { code: 'upstream_error' } });
    const last = frames[1] as Extract<StreamFrame, { kind: 'error' }>;
    expect(last.error.message).toContain('bounded buffer overflow');
  });

  it('an HttpClient without stream() → internal_error frame (loud config error)', async () => {
    const handle = runStream(stubDialect(), input(), {
      http: {
        request: () => {
          throw new Error('unused');
        },
      },
    });
    const first = await handle.firstFrame;
    expect(first).toMatchObject({ kind: 'error', error: { code: 'internal_error' } });
  });
});
