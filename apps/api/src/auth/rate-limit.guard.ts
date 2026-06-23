import { type Database, getModelRateLimit } from '@actionow/db';
import type { AppEnv, RateLimiter, RateLimitResult } from '@actionow/infra';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';

import { engineRateLimited, engineUnauthorized } from '../common/errors.js';
import { DB, ENV, RATE_LIMITER } from '../common/tokens.js';
import type { AuthedRequest } from './api-key.guard.js';

/** TTL (ms) for the per-model rate-limit cache — bounds the per-request model lookup. */
const MODEL_LIMIT_CACHE_TTL_MS = 30_000;

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
 * Exceeding any bucket throws a retryable `rate_limited` error, which the
 * {@link UnifiedErrorFilter} renders as 429 + `retry_after_ms`.
 *
 * A THIRD per-`(tenant, model)` bucket is consulted when the request body names
 * a `model` (chat + media) that carries a `rate_limit` (模型限流). The model's
 * limit is resolved with a small TTL cache so the hot path adds no per-request
 * query once warm; a model with no cap (the default) is cached as `null`.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  /** Per-model limit cache: model name → {limit, expiresAt}. */
  private readonly modelLimitCache = new Map<string, { limit: number | null; expiresAt: number }>();

  constructor(
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(ENV) private readonly env: AppEnv,
    @Inject(DB) private readonly db: Database,
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

    // Per-model cap (模型限流): only when the body names a model with a limit.
    const modelName = this.readModelName(req);
    if (modelName !== undefined) {
      const modelLimit = await this.resolveModelLimit(modelName);
      if (modelLimit !== null) {
        const modelResult = await this.limiter.take(
          `rl:model:${auth.tenantId}:${modelName}`,
          modelLimit,
        );
        this.assertAllowed(modelResult, `model '${modelName}' rate limit exceeded`);
      }
    }
    return true;
  }

  /** The `model` from the request body when it is a non-empty string, else undefined. */
  private readModelName(req: AuthedRequest): string | undefined {
    const body = req.body as { model?: unknown } | undefined;
    const model = body?.model;
    return typeof model === 'string' && model.length > 0 ? model : undefined;
  }

  /** Resolve a model's rate limit with a TTL cache (null = no cap). */
  private async resolveModelLimit(name: string): Promise<number | null> {
    const now = Date.now();
    const cached = this.modelLimitCache.get(name);
    if (cached !== undefined && cached.expiresAt > now) return cached.limit;
    const limit = await getModelRateLimit(this.db, name);
    this.modelLimitCache.set(name, { limit, expiresAt: now + MODEL_LIMIT_CACHE_TTL_MS });
    return limit;
  }

  /** Throw a 429 `rate_limited` (carrying `retry_after_ms`) when over budget. */
  private assertAllowed(result: RateLimitResult, message: string): void {
    if (!result.allowed) {
      throw engineRateLimited(message, result.retryAfterMs);
    }
  }
}
