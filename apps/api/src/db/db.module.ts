import { createDefaultRegistry } from '@actionow/adapters';
import type { Database } from '@actionow/db';
import { createDb } from '@actionow/db';
import type { BreakerStore } from '@actionow/engine';
import type { AppEnv, ConcurrencyLimiter, RateLimiter } from '@actionow/infra';
import { createRedis, loadEnv, RedisConcurrencyLimiter, RedisRateLimiter } from '@actionow/infra';
import type { Provider } from '@nestjs/common';
import { Global, Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { AuditService } from '../audit/audit.service.js';
import { API_KEY_REPO, defaultApiKeyRepo } from '../auth/api-key.guard.js';
import { buildBreakerStore } from '../common/breaker-store.js';
import { SecretResolver } from '../common/secret-resolver.js';
import { ADAPTERS, BREAKER, CONCURRENCY_LIMITER, DB, ENV, RATE_LIMITER } from '../common/tokens.js';

const envProvider: Provider = {
  provide: ENV,
  useFactory: (): AppEnv => loadEnv(),
};

const dbProvider: Provider = {
  provide: DB,
  inject: [ENV],
  useFactory: (env: AppEnv): Database => createDb(env.DATABASE_URL),
};

// The legacy code-adapter registry — still consumed by the admin model
// connectivity pre-test (ModelTestService). Dies with the resource world (D3).
const adaptersProvider: Provider = {
  provide: ADAPTERS,
  useFactory: () => createDefaultRegistry(),
};

// The ApiKeyGuard's db surface, exported globally so it can be overridden with a
// fake repo in unit tests without touching the live database.
const apiKeyRepoProvider: Provider = { provide: API_KEY_REPO, useValue: defaultApiKeyRepo };

// The two-level rate limiter, backed by a dedicated Redis client. Exported so
// tests can override it with an in-memory fake.
const rateLimiterProvider: Provider = {
  provide: RATE_LIMITER,
  inject: [ENV],
  useFactory: (env: AppEnv): RateLimiter => new RedisRateLimiter(createRedis(env.REDIS_URL)),
};

// In-flight (concurrency) limiter for the §7.8 concurrency gates; same Redis,
// overridable with a fake in tests.
const concurrencyLimiterProvider: Provider = {
  provide: CONCURRENCY_LIMITER,
  inject: [ENV],
  useFactory: (env: AppEnv): ConcurrencyLimiter =>
    new RedisConcurrencyLimiter(createRedis(env.REDIS_URL)),
};

// The per-(channel, model) circuit breaker (弹性2.0), over a dedicated Redis
// client (window + half-open trial gate) + the PG FSM state, with every
// transition mirrored into the audit_log via AuditService. Fail-open /
// best-effort. Overridable with a fake in tests.
const breakerProvider: Provider = {
  provide: BREAKER,
  inject: [ENV, DB, AuditService],
  useFactory: (env: AppEnv, db: Database, audit: AuditService): BreakerStore =>
    buildBreakerStore(db, createRedis(env.REDIS_URL), (input) => {
      void audit.record(input);
    }),
};

/**
 * Global infrastructure module: one shared drizzle `Database`, the parsed env,
 * the adapter registry (admin model pre-test), the secret resolver, and the
 * shared limiter/breaker primitives. Exported so feature modules inject them
 * by token without re-instantiating per request.
 */
@Global()
@Module({
  imports: [AuditModule],
  providers: [
    envProvider,
    dbProvider,
    adaptersProvider,
    apiKeyRepoProvider,
    rateLimiterProvider,
    concurrencyLimiterProvider,
    breakerProvider,
    SecretResolver,
  ],
  exports: [
    ENV,
    DB,
    ADAPTERS,
    API_KEY_REPO,
    RATE_LIMITER,
    CONCURRENCY_LIMITER,
    BREAKER,
    SecretResolver,
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class DbModule {}
