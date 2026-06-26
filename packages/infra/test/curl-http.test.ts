import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createHttpClient, CurlHttpClient, CurlTransportError } from '../src/curl-http.js';
import { FetchHttpClient } from '../src/http.js';

/**
 * These exercise the REAL `curl` binary (the egress used when `HTTP_EGRESS=curl`)
 * against local endpoints, so they assert the actual exit-code → unified-error
 * mapping rather than a mock of it. A closed loopback port deterministically
 * yields connection-refused (curl exit 7, `%{http_code}` 000).
 */

/** A loopback port nothing listens on → connection refused. */
const DEAD_URL = 'http://127.0.0.1:9';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => {
            resolve();
          });
        }),
    ),
  );
});

/** Start a throwaway HTTP server that answers every request with `status`/`body`. */
async function startServer(status: number, body: string): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}`;
}

describe('CurlHttpClient transport failures are retryable', () => {
  it('throws a CurlTransportError with a retryable unified error on connection refused', async () => {
    const client = new CurlHttpClient();

    const err = await client
      .request({ method: 'POST', url: DEAD_URL, body: { hi: 1 }, connectTimeoutMs: 1000 })
      .then(
        () => {
          throw new Error('expected request to reject');
        },
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(CurlTransportError);
    expect((err as CurlTransportError).unified).toMatchObject({
      code: 'upstream_error',
      retryable: true,
    });
  });

  it('the thrown error is NOT swallowed into a status-0 non-retryable response', async () => {
    const client = new CurlHttpClient();
    // The bug: a status-0 HttpResponse downstream maps to upstream_error
    // retryable=FALSE, silently disabling failover + the breaker. The fix throws
    // instead, so no such response is ever returned.
    await expect(
      client.request({ method: 'GET', url: DEAD_URL, connectTimeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(CurlTransportError);
  });

  it('a CurlTransportError would be deemed failover-retryable by the engine', () => {
    // Mirror engine `isFailoverRetryable`: an AdapterError/EngineError honors its
    // verdict, ANY OTHER thrown value defaults to retryable. A CurlTransportError
    // is neither subclass, so it lands on the default-true branch — AND its
    // `unified.retryable` is true, so the explicit verdict agrees too.
    const err = new CurlTransportError('boom', 7);
    expect(err).not.toBeInstanceOf(FetchHttpClient);
    expect(err.unified.retryable).toBe(true);
  });

  it('a genuine upstream HTTP 4xx stays a non-retryable response (not a transport error)', async () => {
    const url = await startServer(400, '{"error":{"message":"bad"}}');
    const client = new CurlHttpClient();

    const res = await client.request({ method: 'POST', url, body: { a: 1 } });

    // Real HTTP status surfaces unchanged → the adapter maps 400 → invalid_input
    // (non-retryable). The transport-failure path must NOT hijack genuine 4xx.
    expect(res.status).toBe(400);
    expect(res.ok).toBe(false);
    expect(res.body).toEqual({ error: { message: 'bad' } });
  });

  it('a successful 2xx response is returned with a parsed body', async () => {
    const url = await startServer(200, '{"hello":"world"}');
    const client = new CurlHttpClient();

    const res = await client.request({ method: 'GET', url });

    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.body).toEqual({ hello: 'world' });
  });

  it('stream() rejects with a retryable CurlTransportError on connection refused', async () => {
    const client = new CurlHttpClient();

    const err = await client
      .stream({ method: 'POST', url: DEAD_URL, body: { hi: 1 }, connectTimeoutMs: 1000 })
      .then(
        () => {
          throw new Error('expected stream to reject');
        },
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(CurlTransportError);
    expect((err as CurlTransportError).unified).toMatchObject({
      code: 'upstream_error',
      retryable: true,
    });
  });
});

describe('createHttpClient egress selection', () => {
  const original = process.env.HTTP_EGRESS;
  afterEach(() => {
    if (original === undefined) delete process.env.HTTP_EGRESS;
    else process.env.HTTP_EGRESS = original;
  });

  it('returns the CurlHttpClient when HTTP_EGRESS=curl', () => {
    process.env.HTTP_EGRESS = 'curl';
    expect(createHttpClient()).toBeInstanceOf(CurlHttpClient);
  });

  it('returns the FetchHttpClient otherwise', () => {
    delete process.env.HTTP_EGRESS;
    expect(createHttpClient()).toBeInstanceOf(FetchHttpClient);
  });
});
