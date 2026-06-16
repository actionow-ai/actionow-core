import type {
  AdapterContext,
  HttpRequest,
  HttpStreamResponse,
  StreamEvent,
  UnifiedError,
} from '@actionow/contracts';

import { AdapterError, httpStatusToUnified } from '../errors.js';

/**
 * Issue a streaming HTTP request via the context's `HttpClient.stream`,
 * throwing `internal_error` when the injected client does not support
 * streaming. (All production wiring uses `FetchHttpClient`, which implements
 * `stream`.) Calls the method directly on the client so `this` is preserved.
 */
export function openStream(
  ctx: AdapterContext,
  provider: string,
  req: HttpRequest,
): Promise<HttpStreamResponse> {
  const { http } = ctx;
  if (http.stream === undefined) {
    throw new AdapterError({
      code: 'internal_error',
      message: `${provider}: the configured HttpClient does not support streaming`,
      upstream: { provider },
      retryable: false,
    });
  }
  return http.stream(req);
}

/**
 * Build an `error` {@link StreamEvent} from a non-ok upstream stream status,
 * mapping it via {@link httpStatusToUnified}.
 */
export function streamErrorEvent(provider: string, status: number): StreamEvent {
  const error: UnifiedError = httpStatusToUnified(provider, status);
  return { kind: 'error', error };
}
