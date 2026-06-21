import { createActionowClient } from '@actionow/sdk';

import { config } from '../../config';
import type { ClientDeps, PageEnvelope } from './client';
import { ApiError } from './errors';
import type { Page } from './types';

export type SdkClient = ReturnType<typeof createActionowClient>;

/**
 * Build the typed `openapi-fetch` SDK client with an auth middleware so the bearer
 * token is read PER REQUEST (matching the raw client's ref-based dynamic token —
 * the token may change after the client is memoized). The cross-cutting failure
 * behavior (ApiError-throwing, 401→logout, envelope→`Page` unwrap) lives in the
 * `unwrap`/`page` helpers below rather than middleware, so each resource method
 * keeps the typed `{ data, error, response }` result openapi-fetch returns.
 */
export function createSdkClient(deps: ClientDeps): SdkClient {
  const sdk = createActionowClient({ baseUrl: config.apiBase });
  sdk.use({
    onRequest({ request }) {
      const t = deps.getToken();
      if (t) request.headers.set('Authorization', `Bearer ${t}`);
      return request;
    },
  });
  return sdk;
}

/** Reconstruct the §4.7 `ApiError` from an openapi-fetch error body + status. */
function apiErrorFrom(body: unknown, status: number): ApiError {
  const e = (
    body as
      | {
          error?: { code?: string; message?: string; retryable?: boolean; retry_after_ms?: number };
        }
      | undefined
  )?.error;
  if (e?.code)
    return new ApiError(
      e.code,
      e.message ?? e.code,
      status,
      e.retryable ?? false,
      e.retry_after_ms,
    );
  return new ApiError('internal_error', `HTTP ${String(status)}`, status, false);
}

/** The `{ data, error, response }` result every openapi-fetch call returns. */
export interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/**
 * Throw `ApiError` on a failed openapi-fetch result (401 → `onUnauthorized`, i.e.
 * logout); otherwise return the typed `data`. 204/empty responses surface `data`
 * as `undefined`, which callers returning `Promise<void>` discard.
 */
export function unwrap<T>(r: FetchResult<T>, onUnauthorized: () => void): T {
  if (r.response.ok && r.error === undefined) return r.data as T;
  if (r.response.status === 401) onUnauthorized();
  throw apiErrorFrom(r.error, r.response.status);
}

/** Unwrap a list-envelope result into the frontend `Page<T>` shape. */
export function page<T>(r: FetchResult<PageEnvelope<T>>, onUnauthorized: () => void): Page<T> {
  const env = unwrap<PageEnvelope<T>>(r, onUnauthorized);
  return { rows: env.data, nextCursor: env.next_cursor };
}
