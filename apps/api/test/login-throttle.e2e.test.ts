import { FakeRateLimitRedis, RedisRateLimiter } from '@actionow/infra';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DB, ENV, RATE_LIMITER } from '../src/common/tokens.js';
import { UnifiedErrorFilter } from '../src/common/unified-error.filter.js';

/**
 * P1-6 login throttle: the per-IP {@link LoginThrottleGuard} on the
 * unauthenticated auth endpoints returns 429 once `AUTH_RATE_LIMIT_PER_MIN` is
 * exceeded from one IP. Network-free: a fast in-memory fake limiter (deterministic
 * counting) backs the throttle, DB is inert (the requests use a malformed body so
 * the throttle decision happens before any handler/DB work), and the low limit
 * lets the test trip it in a few requests.
 */

const AUTH_LIMIT = 3;

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue({
      NODE_ENV: 'test',
      CREDIT_RATE: 1000,
      DATABASE_URL: 'postgresql://localhost/none',
      REDIS_URL: 'redis://localhost:6379',
      API_PORT: 3000,
      LOG_LEVEL: 'info',
      ADMIN_JWT_SECRET: 'throttle-test-secret',
      AUTH_RATE_LIMIT_PER_MIN: AUTH_LIMIT,
    })
    .overrideProvider(DB)
    .useValue({})
    .overrideProvider(RATE_LIMITER)
    .useValue(new RedisRateLimiter(new FakeRateLimitRedis()))
    .compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new UnifiedErrorFilter());
  await app.init();
});

afterAll(async () => {
  await app.close();
});

describe('POST /auth/login per-IP throttle', () => {
  it('allows up to the limit, then 429 rate_limited', async () => {
    // Malformed body → the handler would 400, but the throttle guard runs first.
    const send = (): request.Test =>
      request(app.getHttpServer()).post('/auth/login').send({ email: 'x@example.com' });

    // The first AUTH_LIMIT attempts pass the throttle (and 400 on the bad body).
    for (let i = 0; i < AUTH_LIMIT; i += 1) {
      const res = await send();
      expect(res.status).toBe(400);
    }

    // The next attempt is over budget → 429 rate_limited (handler never runs).
    const blocked = await send();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
  });
});
