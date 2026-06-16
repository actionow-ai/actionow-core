import { config } from '../../config';
import { ApiError } from './errors';

export interface ClientDeps {
  getToken: () => string | null;
  onUnauthorized: () => void;
}

interface RequestInitLite {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
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
  async function request<T>(path: string, init: RequestInitLite = {}): Promise<T> {
    const token = deps.getToken();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

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
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return {
    get: <T>(path: string, query?: RequestInitLite['query']) => request<T>(path, { query }),
    post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
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
