// Shared test fixtures: a reference error table, a minimal stub dialect, and
// fake HttpClients (no real network anywhere — the fakeHttp / hand-written
// async generator house convention).
import type {
  CredentialSecret,
  GatewayUsage,
  HttpClient,
  HttpRequest,
  HttpResponse,
} from '@actionow/contracts';
import { gatewayUsageSchema } from '@actionow/contracts';

import type { Dialect, DialectContext, ErrorTable } from '../src/index.js';
import { resolveError } from '../src/index.js';

/** A fully covered reference table (every STANDARD_ERROR_PROBES tier has an explicit row). */
export const TABLE: ErrorTable = {
  rows: [
    { match: { httpStatus: 400 }, code: 'invalid_input', retryable: false, failover: false },
    { match: { httpStatus: 401 }, code: 'unauthorized', retryable: false, failover: true },
    { match: { httpStatus: 403 }, code: 'forbidden', retryable: false, failover: true },
    { match: { httpStatus: 404 }, code: 'model_not_found', retryable: false, failover: true },
    { match: { httpStatus: 408 }, code: 'upstream_timeout', retryable: true, failover: true },
    { match: { httpStatus: 429 }, code: 'rate_limited', retryable: true, failover: true },
    { match: { httpStatus: [500, 599] }, code: 'upstream_error', retryable: true, failover: true },
    { match: { kind: 'timeout' }, code: 'upstream_timeout', retryable: true, failover: true },
    { match: { kind: 'network' }, code: 'upstream_error', retryable: true, failover: true },
  ],
  fallback: { code: 'upstream_error', retryable: false, failover: true },
};

export function usage(metrics: Record<string, number> = {}): GatewayUsage {
  return gatewayUsageSchema.parse({ metrics });
}

export const CTX: DialectContext = {
  baseUrl: 'https://api.stub.test/v3',
  nowMs: 1_752_000_000_000,
};

export const BEARER_SECRET: CredentialSecret = { scheme: 'bearer', api_key: 'sk-stub' };

/**
 * A minimal well-behaved dialect: POST /chat json body, bearer credential,
 * 2xx → ok (output = body), non-2xx → error table. Override members per test.
 */
export function stubDialect(overrides: Partial<Dialect> = {}): Dialect {
  return {
    ref: 'stub',
    version: '1.0.0',
    operations: { 'chat.completions': { fetchModes: ['direct', 'stream'] } },
    requestMapping: {
      map: (input) => ({
        method: 'POST',
        path: '/chat',
        bodyKind: 'json',
        body: { model: input.upstreamModelName, ...input.params.upstream },
        headers: {},
        query: {},
      }),
    },
    credentialInjection: {
      injectCredential: (draft, secret) => ({
        ...draft,
        headers: {
          ...(draft.headers ?? {}),
          authorization: `Bearer ${secret.scheme === 'bearer' ? secret.api_key : 'n/a'}`,
        },
      }),
    },
    responseNormalization: {
      normalize: (res) =>
        res.status >= 200 && res.status < 300
          ? { ok: true, output: res.body, usage: usage({ input_tokens: 1 }) }
          : {
              ok: false,
              error: resolveError(TABLE, {
                httpStatus: res.status,
                ...(res.text !== undefined ? { message: res.text } : {}),
              }),
            },
      normalizeStreamFrame: (rawFrame) =>
        rawFrame === '[DONE]'
          ? [{ kind: 'done', usage: usage({ output_tokens: 2 }) }]
          : [{ kind: 'delta', payload: rawFrame }],
    },
    errorTable: TABLE,
    ...overrides,
  };
}

/** Buffered fake HttpClient: hand the request to `handler`, no stream support. */
export function fakeHttp(
  handler: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>,
): HttpClient {
  return { request: async (req) => handler(req) };
}

export function jsonResponse(status: number, body: unknown): HttpResponse {
  return { status, ok: status >= 200 && status < 300, body, text: JSON.stringify(body) };
}

/** Streaming fake HttpClient: `stream()` yields the given chunks; `request()` is forbidden. */
export function fakeStreamHttp(status: number, chunks: string[]): HttpClient {
  return {
    request: () => {
      throw new Error('request() not expected on the stream path');
    },
    stream: () =>
      Promise.resolve({
        status,
        ok: status >= 200 && status < 300,
        // eslint-disable-next-line @typescript-eslint/require-await
        lines: (async function* () {
          for (const chunk of chunks) yield chunk;
        })(),
      }),
  };
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
