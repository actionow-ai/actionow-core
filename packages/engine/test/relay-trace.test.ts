import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  HttpStreamResponse,
} from '@actionow/contracts';
import type { InsertRelayTraceInput } from '@actionow/db';
import { describe, expect, it } from 'vitest';

import { TracingHttpClient } from '../src/relay-trace.js';

/** A stub inner HttpClient driven by per-test response/stream factories. */
function stubHttp(opts: {
  request?: (req: HttpRequest) => Promise<HttpResponse>;
  stream?: (req: HttpRequest) => Promise<HttpStreamResponse>;
}): HttpClient {
  const client: HttpClient = {
    request: opts.request ?? ((): Promise<HttpResponse> => Promise.reject(new Error('no request'))),
  };
  if (opts.stream !== undefined) client.stream = opts.stream;
  return client;
}

/** Collect every line of an async iterable into an array (consumer side). */
async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

/** Async generator that yields the given frames (an SSE inner stream). */
async function* frames(...xs: string[]): AsyncIterable<string> {
  for (const x of xs) {
    await Promise.resolve();
    yield x;
  }
}

const CTX = {
  tenantId: 'tnt-1',
  jobId: 'job-1',
  channelId: 'chan-1',
  providerType: 'codex-oauth',
} as const;

/** A trace context carrying a route tag (染色), exercising the routeTag column. */
const CTX_TAGGED = { ...CTX, routeTag: 'canary' } as const;

const MAX = 1_000_000;

describe('TracingHttpClient.request', () => {
  it('redacts secret headers, captures the full body + response, and leaks no token', async () => {
    const rows: InsertRelayTraceInput[] = [];
    const inner = stubHttp({
      request: (): Promise<HttpResponse> =>
        Promise.resolve({ status: 200, ok: true, body: { reply: 'ok' }, text: '{"reply":"ok"}' }),
    });
    const tracer = new TracingHttpClient(
      inner,
      (row) => {
        rows.push(row);
      },
      CTX,
      MAX,
    );

    const res = await tracer.request({
      method: 'POST',
      url: 'https://api.example.com/v1/chat',
      headers: { authorization: 'Bearer secret-xyz', 'content-type': 'application/json' },
      body: { hello: 'world' },
    });

    // The delegated response is returned unchanged.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reply: 'ok' });

    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error('no row');
    expect(row.method).toBe('POST');
    expect(row.url).toBe('https://api.example.com/v1/chat');
    expect(row.requestHeaders?.authorization).toBe('[redacted]');
    expect(row.requestHeaders?.['content-type']).toBe('application/json');
    expect(row.requestBody).toBe('{"hello":"world"}');
    expect(row.responseStatus).toBe(200);
    expect(row.responseBody).toBe('{"reply":"ok"}');
    expect(row.isStream).toBe(false);
    expect(typeof row.latencyMs).toBe('number');
    expect(row.tenantId).toBe('tnt-1');
    expect(row.jobId).toBe('job-1');
    expect(row.channelId).toBe('chan-1');
    expect(row.providerType).toBe('codex-oauth');

    // The real bearer token must appear NOWHERE in the serialized row.
    expect(JSON.stringify(row)).not.toContain('secret-xyz');
  });

  it('stamps the route tag (染色) onto the trace row when the ctx carries one', async () => {
    const rows: InsertRelayTraceInput[] = [];
    const inner = stubHttp({
      request: (): Promise<HttpResponse> =>
        Promise.resolve({ status: 200, ok: true, body: undefined, text: 'ok' }),
    });
    const tracer = new TracingHttpClient(
      inner,
      (row) => {
        rows.push(row);
      },
      CTX_TAGGED,
      MAX,
    );
    await tracer.request({ method: 'POST', url: 'https://x' });
    expect(rows[0]?.routeTag).toBe('canary');
  });

  it('leaves routeTag undefined on the trace row when the ctx has no tag', async () => {
    const rows: InsertRelayTraceInput[] = [];
    const inner = stubHttp({
      request: (): Promise<HttpResponse> =>
        Promise.resolve({ status: 200, ok: true, body: undefined, text: 'ok' }),
    });
    const tracer = new TracingHttpClient(
      inner,
      (row) => {
        rows.push(row);
      },
      CTX,
      MAX,
    );
    await tracer.request({ method: 'POST', url: 'https://x' });
    expect(rows[0]?.routeTag).toBeUndefined();
  });

  it('records an error row then rethrows when the inner request throws', async () => {
    const rows: InsertRelayTraceInput[] = [];
    const inner = stubHttp({
      request: (): Promise<HttpResponse> => Promise.reject(new Error('connect ECONNREFUSED')),
    });
    const tracer = new TracingHttpClient(
      inner,
      (row) => {
        rows.push(row);
      },
      CTX,
      MAX,
    );

    await expect(
      tracer.request({ method: 'GET', url: 'https://api.example.com/v1/models' }),
    ).rejects.toThrow('connect ECONNREFUSED');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.error).toContain('ECONNREFUSED');
  });

  it('redacts secret-looking url query params', async () => {
    const rows: InsertRelayTraceInput[] = [];
    const inner = stubHttp({
      request: (): Promise<HttpResponse> =>
        Promise.resolve({ status: 200, ok: true, body: undefined, text: '' }),
    });
    const tracer = new TracingHttpClient(
      inner,
      (row) => {
        rows.push(row);
      },
      CTX,
      MAX,
    );
    await tracer.request({
      method: 'GET',
      url: 'https://api.example.com/m?api_key=top-secret&q=hello&signature=abc',
    });
    const url = rows[0]?.url ?? '';
    expect(url).not.toContain('top-secret');
    expect(url).not.toContain('abc');
    expect(url).toContain('q=hello');
  });

  it('truncates a body over the cap and sets truncated', async () => {
    const rows: InsertRelayTraceInput[] = [];
    const big = 'x'.repeat(50);
    const inner = stubHttp({
      request: (): Promise<HttpResponse> =>
        Promise.resolve({ status: 200, ok: true, body: undefined, text: big }),
    });
    const tracer = new TracingHttpClient(
      inner,
      (row) => {
        rows.push(row);
      },
      CTX,
      10,
    );
    await tracer.request({ method: 'POST', url: 'https://x', body: { pad: big } });
    const row = rows[0];
    expect(row?.truncated).toBe(true);
    expect((row?.responseBody ?? '').length).toBeLessThanOrEqual(10);
    expect((row?.requestBody ?? '').length).toBeLessThanOrEqual(10);
  });

  it('still returns the response when the sink throws (best-effort)', async () => {
    const inner = stubHttp({
      request: (): Promise<HttpResponse> =>
        Promise.resolve({ status: 201, ok: true, body: undefined, text: 'done' }),
    });
    const tracer = new TracingHttpClient(
      inner,
      () => {
        throw new Error('sink exploded');
      },
      CTX,
      MAX,
    );
    const res = await tracer.request({ method: 'POST', url: 'https://x' });
    expect(res.status).toBe(201);
  });
});

describe('TracingHttpClient.stream', () => {
  it('forwards every SSE frame unchanged AND captures the assembled stream', async () => {
    const rows: InsertRelayTraceInput[] = [];
    const sse = [
      'event: a\ndata: {"x":1}\n\n',
      'event: b\ndata: {"y":2}\n\n',
      'event: done\ndata: [DONE]\n\n',
    ];
    const inner = stubHttp({
      stream: (): Promise<HttpStreamResponse> =>
        Promise.resolve({ status: 200, ok: true, lines: frames(...sse) }),
    });
    const tracer = new TracingHttpClient(
      inner,
      (row) => {
        rows.push(row);
      },
      CTX,
      MAX,
    );

    const res = await tracer.stream({
      method: 'POST',
      url: 'https://api.example.com/v1/responses',
      headers: { authorization: 'Bearer stream-secret' },
      body: { stream: true },
    });
    expect(res.status).toBe(200);

    // The consumer receives every frame, byte-for-byte.
    const received = await collect(res.lines);
    expect(received).toEqual(sse);

    // The trace row is written in finally with the assembled raw SSE.
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error('no row');
    expect(row.isStream).toBe(true);
    expect(row.responseStatus).toBe(200);
    expect(row.responseBody).toBe(sse.join(''));
    expect(row.requestBody).toBe('{"stream":true}');
    expect(row.requestHeaders?.authorization).toBe('[redacted]');
    expect(JSON.stringify(row)).not.toContain('stream-secret');
  });

  it('stamps the route tag (染色) onto a stream trace row', async () => {
    const rows: InsertRelayTraceInput[] = [];
    const inner = stubHttp({
      stream: (): Promise<HttpStreamResponse> =>
        Promise.resolve({ status: 200, ok: true, lines: frames('a', 'b') }),
    });
    const tracer = new TracingHttpClient(
      inner,
      (row) => {
        rows.push(row);
      },
      CTX_TAGGED,
      MAX,
    );
    const res = await tracer.stream({ method: 'POST', url: 'https://x' });
    await collect(res.lines);
    expect(rows[0]?.routeTag).toBe('canary');
  });

  it('truncates the assembled stream at the cap and sets truncated', async () => {
    const rows: InsertRelayTraceInput[] = [];
    const inner = stubHttp({
      stream: (): Promise<HttpStreamResponse> =>
        Promise.resolve({
          status: 200,
          ok: true,
          lines: frames('aaaaa', 'bbbbb', 'ccccc'),
        }),
    });
    const tracer = new TracingHttpClient(
      inner,
      (row) => {
        rows.push(row);
      },
      CTX,
      7,
    );
    const res = await tracer.stream({ method: 'POST', url: 'https://x' });

    // Consumer STILL gets every frame unchanged even though capture is capped.
    const received = await collect(res.lines);
    expect(received).toEqual(['aaaaa', 'bbbbb', 'ccccc']);
    expect(rows[0]?.truncated).toBe(true);
    expect((rows[0]?.responseBody ?? '').length).toBeLessThanOrEqual(7);
  });

  it('records an error row and rethrows when the inner stream iteration throws', async () => {
    const rows: InsertRelayTraceInput[] = [];
    async function* boom(): AsyncIterable<string> {
      await Promise.resolve();
      yield 'first';
      throw new Error('mid-stream boom');
    }
    const inner = stubHttp({
      stream: (): Promise<HttpStreamResponse> =>
        Promise.resolve({ status: 200, ok: true, lines: boom() }),
    });
    const tracer = new TracingHttpClient(
      inner,
      (row) => {
        rows.push(row);
      },
      CTX,
      MAX,
    );
    const res = await tracer.stream({ method: 'POST', url: 'https://x' });

    await expect(collect(res.lines)).rejects.toThrow('mid-stream boom');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.error).toContain('mid-stream boom');
    // The frame that was forwarded before the throw is still captured.
    expect(rows[0]?.responseBody).toContain('first');
  });

  it('still streams when the sink throws (best-effort)', async () => {
    const inner = stubHttp({
      stream: (): Promise<HttpStreamResponse> =>
        Promise.resolve({ status: 200, ok: true, lines: frames('one', 'two') }),
    });
    const tracer = new TracingHttpClient(
      inner,
      () => {
        throw new Error('sink exploded');
      },
      CTX,
      MAX,
    );
    const res = await tracer.stream({ method: 'POST', url: 'https://x' });
    const received = await collect(res.lines);
    expect(received).toEqual(['one', 'two']);
  });
});
