import type { AppEnv, RateLimiter, RateLimitResult } from '@actionow/infra';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';

import { engineRateLimited } from '../common/errors.js';
import { ENV, RATE_LIMITER } from '../common/tokens.js';

/** Per-IP attempts/min on the auth endpoints when `AUTH_RATE_LIMIT_PER_MIN` is unset. */
const DEFAULT_AUTH_RATE_LIMIT_PER_MIN = 10;

/**
 * Max time to wait for the limiter before FAILING OPEN. A login throttle must
 * never lock everyone out when the rate-limit Redis is slow or unreachable
 * (self-deploy without Redis, a blip), so a slow/erroring `take` is treated as
 * "allow" rather than blocking auth. With a healthy limiter `take` is ~1ms.
 */
const LIMITER_TIMEOUT_MS = 200;

/**
 * Per-IP throttle for the UNAUTHENTICATED auth endpoints (`/auth/login`,
 * `/auth/register`, `/admin/auth/login`) — blunts credential stuffing /
 * brute-force on accounts that can mint API keys and spend prepaid credits. The
 * two-level {@link RateLimitGuard} cannot be reused here because it keys off the
 * authenticated `req.auth`, which does not exist pre-login; this guard keys off
 * the client IP instead.
 *
 * FAIL-OPEN by design: a limiter error OR a >`LIMITER_TIMEOUT_MS` stall allows
 * the request (logged), so a rate-limiter outage degrades to "no throttle"
 * rather than "no logins". Over-budget requests get a 429 with `retry_after_ms`.
 */
@Injectable()
export class LoginThrottleGuard implements CanActivate {
  private readonly logger = new Logger(LoginThrottleGuard.name);

  constructor(
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const ip = clientIp(req);
    const limit = this.env.AUTH_RATE_LIMIT_PER_MIN ?? DEFAULT_AUTH_RATE_LIMIT_PER_MIN;

    const result = await this.takeWithTimeout(`rl:login:${ip}`, limit);
    if (result === undefined) return true; // limiter slow/unreachable → fail open
    if (!result.allowed) {
      throw engineRateLimited('too many login attempts; slow down', result.retryAfterMs);
    }
    return true;
  }

  /** `limiter.take` bounded by {@link LIMITER_TIMEOUT_MS}; `undefined` → fail open. */
  private async takeWithTimeout(key: string, limit: number): Promise<RateLimitResult | undefined> {
    const take = this.limiter.take(key, limit);
    // Don't let a later rejection (e.g. after the timeout won) surface as an
    // unhandled rejection.
    take.catch(() => undefined);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        resolve(undefined);
      }, LIMITER_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([take, timeout]);
      if (result === undefined) {
        this.logger.warn('login throttle limiter slow/unreachable; allowing (fail-open)');
      }
      return result;
    } catch (err) {
      this.logger.warn(
        `login throttle limiter error; allowing (fail-open): ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/** The client IP for the throttle key (honors trust-proxy via req.ip). */
function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
