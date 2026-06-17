import { config } from '../../config';
import { ApiError } from './errors';
import type { Page } from './types';

export interface ClientDeps {
  getToken: () => string | null;
  onUnauthorized: () => void;
}

/** The uniform list response envelope returned by every backend list route. */
export interface PageEnvelope<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
}

interface RequestInitLite {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Extra request headers merged after the default content-type/auth. */
  headers?: Record<string, string>;
}

function buildUrl(path: string, query?: RequestInitLite['query']): string {
  const url = config.apiBase + path;
  if (!query) return url;
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return qs ? `${url}?${qs}` : url;
}

export function createClient(deps: ClientDeps) {
  /** Issue a request and return the parsed body together with the response headers. */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T is the caller-asserted response body type for this typed-fetch helper.
  async function requestWithHeaders<T>(
    path: string,
    init: RequestInitLite = {},
  ): Promise<{ data: T; headers: Headers }> {
    const token = deps.getToken();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (init.headers) Object.assign(headers, init.headers);

    const res = await fetch(buildUrl(path, init.query), {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

    if (!res.ok) {
      const err = await toApiError(res);
      if (res.status === 401) deps.onUnauthorized();
      throw err;
    }
    if (res.status === 204) return { data: undefined as T, headers: res.headers };
    return { data: (await res.json()) as T, headers: res.headers };
  }

  async function request<T>(path: string, init: RequestInitLite = {}): Promise<T> {
    return (await requestWithHeaders<T>(path, init)).data;
  }

  return {
    get: <T>(path: string, query?: RequestInitLite['query']) => request<T>(path, { query }),
    /** Like `get`, but also exposes the response headers (e.g. `x-actionow-channel`). */
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T is the caller-asserted response body type.
    getWithHeaders: <T>(path: string, query?: RequestInitLite['query']) =>
      requestWithHeaders<T>(path, { query }),
    post: <T>(path: string, body?: unknown, opts?: { idempotencyKey?: string }) =>
      request<T>(path, {
        method: 'POST',
        body,
        headers: opts?.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : undefined,
      }),
    patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
    delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
    /** Fetch a list route and unwrap the `{data,next_cursor}` envelope into a `Page<T>`. */
    getPage: async <T>(path: string, query?: RequestInitLite['query']): Promise<Page<T>> => {
      const env = await request<PageEnvelope<T>>(path, { query });
      return { rows: env.data, nextCursor: env.next_cursor };
    },
  };
}

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string; retryable?: boolean; retry_after_ms?: number };
    };
    const e = body.error;
    if (e?.code) {
      return new ApiError(
        e.code,
        e.message ?? e.code,
        res.status,
        e.retryable ?? false,
        e.retry_after_ms,
      );
    }
  } catch {
    // fall through to a generic error
  }
  return new ApiError('internal_error', `HTTP ${String(res.status)}`, res.status, false);
}

export type ApiClient = ReturnType<typeof createClient>;
