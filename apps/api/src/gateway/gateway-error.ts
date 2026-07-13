// apps/api/src/gateway/gateway-error.ts
//
// model-supply-greenfield 批次4 slice3 — the §9.3 wire error rendering for the
// NEW gateway face: frozen GATEWAY_ERROR_CODES → HTTP status, the 统一信封
// (code/message/retryable/failover + upstream/details/request_id), the 429
// Retry-After header, and the §10 deprecation 预告 headers.
//
// Rendered IMPERATIVELY (res.status().json()) instead of thrown through the
// old-world UnifiedErrorFilter: the gateway taxonomy has members the old
// UnifiedErrorCode lacks (conflict → 409, model_not_found / task_not_found →
// 404, unsupported_parameter → 400), and the filter would flatten them. 双面
// 并存: the old envelope is untouched; this is the new face's own renderer.
import { randomUUID } from 'node:crypto';

import type { GatewayError, GatewayErrorCode } from '@actionow/contracts';
import type { DeprecationNotice } from '@actionow/engine';
import type { Request, Response } from 'express';

/** Frozen taxonomy → HTTP status (§9.3; §5 幂等 409; §10 下线 404). */
export function statusForGatewayError(code: GatewayErrorCode): number {
  switch (code) {
    case 'invalid_input':
    case 'unsupported_parameter':
      return 400;
    case 'unauthorized':
      return 401;
    case 'insufficient_credits':
      return 402;
    case 'forbidden':
      return 403;
    case 'model_not_found':
    case 'task_not_found':
      return 404;
    case 'conflict':
      return 409;
    case 'content_filtered':
      return 422;
    case 'rate_limited':
      return 429;
    case 'upstream_error':
      return 502;
    case 'upstream_timeout':
      return 504;
    case 'task_failed':
    case 'internal_error':
      return 500;
  }
}

/** The caller-supplied X-Request-Id when present, else a fresh uuid (§9.3 request_id). */
export function requestIdOf(req: Request | undefined): string {
  const raw = req?.headers['x-request-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return randomUUID();
}

/**
 * Write one gateway error to the wire: status from the taxonomy, the §9.3
 * envelope as body, `Retry-After` (seconds, ceil) on 429 when the error
 * carries a backoff hint.
 */
export function sendGatewayError(res: Response, error: GatewayError, requestId: string): void {
  const status = statusForGatewayError(error.code);
  if (status === 429 && error.retryAfterMs !== undefined) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
  }
  res.status(status).json({
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      failover: error.failover,
      ...(error.upstream !== undefined ? { upstream: error.upstream } : {}),
      ...(error.retryAfterMs !== undefined ? { retry_after_ms: error.retryAfterMs } : {}),
      ...(error.details !== undefined ? { details: error.details } : {}),
      request_id: requestId,
    },
  });
}

/**
 * §10 下线预告: a `deprecated` model still serves, but every response carries
 * the deprecation headers (the IETF `Deprecation` header + a named echo so
 * callers know WHICH model the notice concerns).
 */
export function applyDeprecationHeaders(
  res: Response,
  deprecation: DeprecationNotice | undefined,
): void {
  if (deprecation === undefined) return;
  res.setHeader('Deprecation', 'true');
  res.setHeader('X-Actionow-Model-Deprecated', deprecation.model);
}
