import { AdapterError } from '@actionow/adapters';
import type { UnifiedError, UnifiedErrorCode } from '@actionow/contracts';
import { DomainError } from '@actionow/domain';
import { EngineError } from '@actionow/engine';
import { ProtocolError } from '@actionow/llm-protocol';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';

/** The §4.7 error envelope returned to API clients. */
interface ErrorEnvelope {
  error: {
    code: UnifiedErrorCode;
    message: string;
    upstream?: { provider: string; rawCode?: string };
    retryable: boolean;
    retry_after_ms?: number;
  };
}

/**
 * Map a unified error code to its HTTP status (§4.7):
 *
 * | code                 | status |
 * |----------------------|--------|
 * | invalid_input        | 400    |
 * | unauthorized         | 401    |
 * | insufficient_credits | 402    |
 * | resource_not_found   | 404    |
 * | rate_limited         | 429    |
 * | upstream_error       | 502    |
 * | upstream_timeout     | 504    |
 * | content_filtered     | 422    |
 * | job_failed           | 500    |
 * | internal_error       | 500    |
 */
function statusForCode(code: UnifiedErrorCode): number {
  switch (code) {
    case 'invalid_input':
      return 400;
    case 'unauthorized':
      return 401;
    case 'insufficient_credits':
      return 402;
    case 'resource_not_found':
      return 404;
    case 'content_filtered':
      return 422;
    case 'rate_limited':
      return 429;
    case 'upstream_error':
      return 502;
    case 'upstream_timeout':
      return 504;
    case 'job_failed':
    case 'internal_error':
      return 500;
  }
}

function toEnvelope(unified: UnifiedError): ErrorEnvelope {
  const error: ErrorEnvelope['error'] = {
    code: unified.code,
    message: unified.message,
    retryable: unified.retryable,
  };
  if (unified.upstream !== undefined) error.upstream = unified.upstream;
  if (unified.retryAfterMs !== undefined) error.retry_after_ms = unified.retryAfterMs;
  return { error };
}

/**
 * Global filter mapping every error class on the run/jobs path to the unified
 * §4.7 envelope. `EngineError`/`AdapterError` carry a sanitized `unified`
 * payload; `DomainError` becomes `invalid_input`; a NestJS `HttpException`
 * (e.g. a route guard's 401) is mapped by its status; anything else is a
 * sanitized `internal_error` (the real cause is logged, never returned).
 *
 * No secret material ever reaches the envelope — the engine/adapter layers
 * guarantee `unified.message` is free of credentials and URLs.
 */
@Catch()
export class UnifiedErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(UnifiedErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const unified = this.toUnified(exception);
    const status = statusForCode(unified.code);

    if (status >= 500) {
      // Log the original cause for 5xx (which may carry detail we must not
      // surface). Never log secrets — the engine sanitizes before throwing.
      this.logger.error(`${unified.code}: ${unified.message}`);
    }

    res.status(status).json(toEnvelope(unified));
  }

  private toUnified(exception: unknown): UnifiedError {
    if (exception instanceof EngineError) return exception.unified;
    if (exception instanceof AdapterError) return exception.unified;
    if (exception instanceof ProtocolError) {
      // A request-normalization failure (e.g. a capability mismatch from the
      // chat relay's `normalizeRequest`) carries its own unified code (e.g.
      // `invalid_input`) → mapped to its real client status (400) by the same
      // `statusForCode` table, not the 500 a plain `Error` would yield.
      return { code: exception.code, message: exception.message, retryable: false };
    }
    if (exception instanceof DomainError) {
      return { code: 'invalid_input', message: exception.message, retryable: false };
    }
    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }
    return { code: 'internal_error', message: 'internal error', retryable: false };
  }

  private fromHttpException(exception: HttpException): UnifiedError {
    const status = exception.getStatus();
    const message = exception.message;
    switch (status) {
      case 400:
        return { code: 'invalid_input', message, retryable: false };
      case 401:
      case 403:
        return { code: 'unauthorized', message, retryable: false };
      case 404:
        return { code: 'resource_not_found', message, retryable: false };
      case 429:
        return { code: 'rate_limited', message, retryable: true };
      default:
        return { code: 'internal_error', message: 'internal error', retryable: false };
    }
  }
}
