import type { AppEnv, RateLimiter, RateLimitResult } from '@actionow/infra';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';

import { engineRateLimited, engineUnauthorized } from '../common/errors.js';
import { ENV, RATE_LIMITER } from '../common/tokens.js';
import type { AuthedRequest } from './api-key.guard.js';

/**
 * Two-level per-minute rate limit for `/v1/run` (§8). Runs AFTER
 * {@link ApiKeyGuard} (declared second in `@UseGuards`) so it can read the
 * authenticated tenant + the key's optional `rateLimit` off `req.auth`.
 *
 * Two fixed-window buckets are consulted per request:
 *  1. per-tenant — a coarse account-wide cap (`RATE_LIMIT_TENANT_PER_MIN`).
 *  2. per-(tenant, resource) — the key's `rateLimit`, else the configured
 *     `RATE_LIMIT_RESOURCE_PER_MIN` default.
 *
 * Exceeding either bucket throws a retryable `rate_limited` error, which the
 * {@link UnifiedErrorFilter} renders as 429 + `retry_after_ms`.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const auth = req.auth;
    if (auth === undefined) {
      // The ApiKeyGuard must have run first; if not, fail closed.
      throw engineUnauthorized('request is not authenticated');
    }

    const resourceId = (req.params as Record<string, string | undefined>).resourceId ?? '_';
    const tenantLimit = this.env.RATE_LIMIT_TENANT_PER_MIN;
    const resourceLimit = auth.rateLimit ?? this.env.RATE_LIMIT_RESOURCE_PER_MIN;

    // Consult both buckets, then block on the first that is over budget. Both
    // counters are incremented either way (a request hits both windows).
    const [tenantResult, resourceResult] = await Promise.all([
      this.limiter.take(`rl:tenant:${auth.tenantId}`, tenantLimit),
      this.limiter.take(`rl:resource:${auth.tenantId}:${resourceId}`, resourceLimit),
    ]);

    this.assertAllowed(tenantResult, 'tenant rate limit exceeded');
    this.assertAllowed(resourceResult, 'resource rate limit exceeded');
    return true;
  }

  /** Throw a 429 `rate_limited` (carrying `retry_after_ms`) when over budget. */
  private assertAllowed(result: RateLimitResult, message: string): void {
    if (!result.allowed) {
      throw engineRateLimited(message, result.retryAfterMs);
    }
  }
}
