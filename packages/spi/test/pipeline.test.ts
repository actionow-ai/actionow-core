// Pipeline order invariant (①②③④⑤), the post-③ deep freeze, and the sync
// runner's error plumbing (§6).
import type { HttpRequest } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import type { SyncRunInput } from '../src/index.js';
import { runSync } from '../src/index.js';
import { BEARER_SECRET, CTX, fakeHttp, jsonResponse, stubDialect, usage } from './stub.js';

function baseInput(overrides: Partial<SyncRunInput> = {}): SyncRunInput {
  return {
    operation: 'chat.completions',
    upstreamModelName: 'stub-chat-1',
    params: { canonical: { size: '1080p' }, upstream: { resolution: '1080p' } },
    secret: BEARER_SECRET,
    ctx: CTX,
    ...overrides,
  };
}

describe('runSync aspect ordering', () => {
  it('invokes aspects strictly ① map → ② media → ③ credential → ④ transport → ⑤ normalize', async () => {
    const calls: string[] = [];
    const dialect = stubDialect({
      requestMapping: {
        map: (input) => {
          calls.push('map');
          return {
            method: 'POST',
            path: '/chat',
            bodyKind: 'json',
            body: { model: input.upstreamModelName },
          };
        },
      },
      mediaInjection: {
        deliveryForms: ['url'],
        inject: (draft, media) => {
          calls.push('media');
          return { ...draft, body: { ...(draft.body as object), image: media[0]?.url } };
        },
      },
      credentialInjection: {
        injectCredential: (draft) => {
          calls.push('credential');
          return { ...draft, headers: { ...(draft.headers ?? {}), authorization: 'Bearer x' } };
        },
      },
      responseNormalization: {
        normalize: (res) => {
          calls.push('normalize');
          return { ok: true, output: res.body, usage: usage() };
        },
        normalizeStreamFrame: () => [],
      },
    });
    const http = fakeHttp((req) => {
      calls.push('transport');
      return jsonResponse(200, { echo: req.url });
    });

    const result = await runSync(
      dialect,
      baseInput({ media: [{ param: 'image', form: 'url', url: 'https://cdn.test/a.png' }] }),
      { http },
    );

    expect(calls).toEqual(['map', 'media', 'credential', 'transport', 'normalize']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The relative path was resolved against ctx.baseUrl before ③/④.
      expect(result.output).toEqual({ echo: 'https://api.stub.test/v3/chat' });
      expect(result.servedRaw).toEqual({ echo: 'https://api.stub.test/v3/chat' });
    }
  });

  it('deep-freezes the draft after ③ — any later mutation throws TypeError', async () => {
    let sawFrozen = false;
    const dialect = stubDialect({
      requestMapping: {
        map: () => ({
          method: 'POST',
          path: '/chat',
          bodyKind: 'json',
          body: { nested: { a: 1 }, list: [1, 2] },
          headers: { 'x-a': '1' },
          query: { q: '1' },
        }),
      },
      transport: {
        request: (req) => {
          sawFrozen = true;
          expect(Object.isFrozen(req)).toBe(true);
          const headers = req.headers;
          const query = req.query;
          if (headers === undefined || query === undefined) {
            throw new Error('fixture guarantees headers + query');
          }
          expect(() => {
            headers['x-b'] = 'boom';
          }).toThrow(TypeError);
          expect(() => {
            query.q = '2';
          }).toThrow(TypeError);
          expect(() => {
            (req.body as { nested: { a: number } }).nested.a = 2;
          }).toThrow(TypeError);
          expect(() => {
            (req.body as { list: number[] }).list.push(3);
          }).toThrow(TypeError);
          expect(() => {
            (req as { path: string }).path = 'https://evil.test';
          }).toThrow(TypeError);
          return Promise.resolve({ status: 200, headers: {}, body: { ok: 1 } });
        },
        stream: () => {
          throw new Error('unused');
        },
      },
    });

    const result = await runSync(dialect, baseInput(), {
      http: fakeHttp(() => jsonResponse(200, {})),
    });
    expect(sawFrozen).toBe(true);
    expect(result.ok).toBe(true);
  });
});

describe('runSync error plumbing', () => {
  it('media provided but no mediaInjection aspect → internal_error (never silently dropped)', async () => {
    const dialect = stubDialect(); // no mediaInjection
    const result = await runSync(
      dialect,
      baseInput({ media: [{ param: 'image', form: 'url', url: 'https://cdn.test/a.png' }] }),
      { http: fakeHttp(() => jsonResponse(200, {})) },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'internal_error', retryable: false, failover: false },
    });
    if (!result.ok) expect(result.error.message).toContain('mediaInjection');
  });

  it('relative path without ctx.baseUrl → internal_error', async () => {
    const dialect = stubDialect();
    const result = await runSync(
      dialect,
      baseInput({ ctx: { nowMs: CTX.nowMs } }), // no baseUrl
      { http: fakeHttp(() => jsonResponse(200, {})) },
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'internal_error' } });
    if (!result.ok) expect(result.error.message).toContain('baseUrl');
  });

  it('transport-level throw is classified via the error table (timeout vs network)', async () => {
    const dialect = stubDialect();
    const timeout = await runSync(dialect, baseInput(), {
      http: fakeHttp(() => {
        throw new Error('request timed out after 30000ms');
      }),
    });
    expect(timeout).toMatchObject({
      ok: false,
      error: { code: 'upstream_timeout', retryable: true, failover: true },
    });

    const network = await runSync(dialect, baseInput(), {
      http: fakeHttp(() => {
        throw new Error('connect ECONNREFUSED 1.2.3.4:443');
      }),
    });
    expect(network).toMatchObject({
      ok: false,
      error: { code: 'upstream_error', retryable: true, failover: true },
    });
  });

  it('⑤ normalize sees non-2xx exchanges and translates them (429 → rate_limited)', async () => {
    const dialect = stubDialect();
    const result = await runSync(dialect, baseInput(), {
      http: fakeHttp(() => jsonResponse(429, { error: { message: 'quota' } })),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'rate_limited', retryable: true, failover: true },
    });
  });

  it('default transport rejects verbs/bodies HttpClient cannot carry, as internal_error', async () => {
    const putDialect = stubDialect({
      requestMapping: {
        map: () => ({ method: 'PUT', path: '/chat', bodyKind: 'json', body: {} }),
      },
    });
    const put = await runSync(putDialect, baseInput(), {
      http: fakeHttp(() => jsonResponse(200, {})),
    });
    expect(put).toMatchObject({ ok: false, error: { code: 'internal_error' } });
    if (!put.ok) expect(put.error.message).toContain('custom TransportAspect');

    const formDialect = stubDialect({
      requestMapping: {
        map: () => ({ method: 'POST', path: '/chat', bodyKind: 'form', body: { a: '1' } }),
      },
    });
    const form = await runSync(formDialect, baseInput(), {
      http: fakeHttp(() => jsonResponse(200, {})),
    });
    expect(form).toMatchObject({ ok: false, error: { code: 'internal_error' } });
  });

  it('default transport fills content-type for json bodies and carries the budget + proxy', async () => {
    let seen: HttpRequest | undefined;
    const dialect = stubDialect();
    await runSync(dialect, baseInput(), {
      http: fakeHttp((req) => {
        seen = req;
        return jsonResponse(200, {});
      }),
      budget: { totalTimeoutMs: 60_000, ttftTimeoutMs: 5_000 },
      proxyUrl: 'http://proxy.test:8080',
    });
    expect(seen?.headers?.['content-type']).toBe('application/json');
    expect(seen?.timeoutMs).toBe(60_000);
    expect(seen?.firstChunkTimeoutMs).toBe(5_000);
    expect(seen?.proxyUrl).toBe('http://proxy.test:8080');
    expect(seen?.method).toBe('POST');
  });
});
