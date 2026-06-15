import { EngineError } from '@actionow/engine';

/** A non-retryable `unauthorized` engine error (mapped to HTTP 401). */
export function engineUnauthorized(message: string): EngineError {
  return new EngineError({ code: 'unauthorized', message, retryable: false });
}

/** A non-retryable `resource_not_found` engine error (mapped to HTTP 404). */
export function engineNotFound(message: string): EngineError {
  return new EngineError({ code: 'resource_not_found', message, retryable: false });
}

/** A non-retryable `invalid_input` engine error (mapped to HTTP 400). */
export function engineInvalidInput(message: string): EngineError {
  return new EngineError({ code: 'invalid_input', message, retryable: false });
}

/**
 * A retryable `rate_limited` engine error (mapped to HTTP 429). `retryAfterMs`
 * surfaces on the §4.7 envelope as `retry_after_ms` so the client can back off.
 */
export function engineRateLimited(message: string, retryAfterMs: number): EngineError {
  return new EngineError({ code: 'rate_limited', message, retryable: true, retryAfterMs });
}
