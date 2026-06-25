import type { UnifiedError, UnifiedErrorCode } from '@actionow/contracts';

/** Default human-readable message per unified error code. */
const DEFAULT_MESSAGES: Record<UnifiedErrorCode, string> = {
  invalid_input: 'invalid input',
  insufficient_credits: 'insufficient credits',
  resource_not_found: 'resource not found',
  rate_limited: 'rate limited',
  upstream_error: 'upstream error',
  upstream_timeout: 'upstream timeout',
  content_filtered: 'content filtered',
  job_failed: 'job failed',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  internal_error: 'internal error',
};

/**
 * Map an upstream HTTP status to a {@link UnifiedError}.
 *
 * | status  | code               | retryable |
 * |---------|--------------------|-----------|
 * | 400     | invalid_input      | false     |
 * | 401/403 | unauthorized       | false     |
 * | 404     | resource_not_found | false     |
 * | 408     | upstream_timeout   | true      |
 * | 429     | rate_limited       | true      |
 * | 5xx     | upstream_error     | true      |
 * | else    | upstream_error     | false     |
 */
export function httpStatusToUnified(
  provider: string,
  status: number,
  rawCode?: string,
): UnifiedError {
  let code: UnifiedErrorCode;
  let retryable: boolean;

  switch (status) {
    case 400:
      code = 'invalid_input';
      retryable = false;
      break;
    case 401:
    case 403:
      code = 'unauthorized';
      retryable = false;
      break;
    case 404:
      code = 'resource_not_found';
      retryable = false;
      break;
    case 408:
      code = 'upstream_timeout';
      retryable = true;
      break;
    case 429:
      code = 'rate_limited';
      retryable = true;
      break;
    default:
      code = 'upstream_error';
      retryable = status >= 500 && status <= 599;
      break;
  }

  const upstream = rawCode === undefined ? { provider } : { provider, rawCode };

  return { code, message: DEFAULT_MESSAGES[code], upstream, retryable };
}

/**
 * Error carrying a {@link UnifiedError}, so `submit` can
 * `throw new AdapterError(unified)` and routing can read `.unified.retryable`.
 */
export class AdapterError extends Error {
  readonly unified: UnifiedError;

  constructor(unified: UnifiedError) {
    super(unified.message);
    this.name = 'AdapterError';
    this.unified = unified;
  }
}
