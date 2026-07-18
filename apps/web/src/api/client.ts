import { config } from '@/config';

import { getSession, refreshSession } from './auth';

/** Cursor pagination envelope shared by every list endpoint. */
export interface PageOf<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
}

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    retry_after_ms?: number;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly requestId?: string;

  constructor(options: {
    status: number;
    code: string;
    message: string;
    retryable?: boolean;
    retryAfterMs?: number;
    requestId?: string;
  }) {
    super(options.message);
    this.name = 'ApiError';
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.requestId = options.requestId;
  }
}

export type QueryValue = string | number | boolean | null | undefined;

export interface ApiFetchOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  /**
   * Skip the automatic 401 → refresh → retry pass. Set internally by the retry
   * itself, and by callers that probe a plane the current session may not belong
   * to (e.g. a tenant-less platform admin hitting `/console/me`): there a 401 is
   * an expected plane mismatch, not an expiry, so refreshing is useless — and
   * with the current backend it would re-mint the admin session with the wrong
   * role. Genuine expiries on real calls still refresh eagerly.
   */
  skipRefresh?: boolean;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = `${config.apiBaseUrl}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function parseError(response: Response): Promise<ApiError> {
  let envelope: ErrorEnvelope | undefined;
  try {
    envelope = (await response.json()) as ErrorEnvelope;
  } catch {
    envelope = undefined;
  }
  return new ApiError({
    status: response.status,
    code: envelope?.error?.code ?? 'unknown',
    message: envelope?.error?.message ?? `HTTP ${String(response.status)}`,
    retryable: envelope?.error?.retryable,
    retryAfterMs: envelope?.error?.retry_after_ms,
    requestId: response.headers.get('x-request-id') ?? undefined,
  });
}

/**
 * Authenticated JSON fetch against the backend. Parses the unified error
 * envelope into ApiError; on 401 rotates the refresh token once (single-flight)
 * and retries the original request.
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { method = 'GET', body, query, signal, skipRefresh } = options;
  const headers: Record<string, string> = { accept: 'application/json' };
  const session = getSession();
  if (session) headers.authorization = `Bearer ${session.accessToken}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(buildUrl(path, query), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  // Eagerly refresh on any 401 (a lagging client clock must still recover), EXCEPT
  // where the caller opted out via skipRefresh — the plane-mismatch probes that
  // 401 by design and must not spend a refresh (see ApiFetchOptions.skipRefresh).
  if (response.status === 401 && !skipRefresh && session) {
    const renewed = await refreshSession();
    if (renewed) return apiFetch<T>(path, { ...options, skipRefresh: true });
  }
  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Map any thrown error to the `ApiErrorNotice` shape. */
export function toApiStateError(error: unknown): {
  status?: number;
  message: string;
  requestId?: string;
} {
  if (error instanceof ApiError) {
    return { status: error.status, message: error.message, requestId: error.requestId };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

/** Format a µcredit decimal string (1 credit = 1_000_000 µ) for display. */
export function formatMicroCredits(micro: string | number | null | undefined): string {
  if (micro === null || micro === undefined || micro === '') return '—';
  const value = typeof micro === 'number' ? BigInt(Math.trunc(micro)) : BigInt(micro);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 1_000_000n;
  const frac = abs % 1_000_000n;
  const wholeText = whole.toLocaleString('en-US');
  if (frac === 0n) return `${negative ? '-' : ''}${wholeText}`;
  const fracText = frac.toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${wholeText}.${fracText}`;
}
