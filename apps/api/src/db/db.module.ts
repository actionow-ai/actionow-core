import { createDefaultRegistry } from '@actionow/adapters';
import type { Database } from '@actionow/db';
import { createDb } from '@actionow/db';
import type { BreakerStore } from '@actionow/engine';
import { registerEngineAdapters } from '@actionow/engine';
import type { AppEnv, ConcurrencyLimiter, RateLimiter } from '@actionow/infra';
import { createRedis, loadEnv, RedisConcurrencyLimiter, RedisRateLimiter } from '@actionow/infra';
import type { Provider } from '@nestjs/common';
import { Global, Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { AuditService } from '../audit/audit.service.js';
import { API_KEY_REPO, defaultApiKeyRepo } from '../auth/api-key.guard.js';
import { buildBreakerStore } from '../common/breaker-store.js';
import { BullmqJobQueue } from '../common/bullmq-queue.js';
import { SecretResolver } from '../common/secret-resolver.js';
import {
  ADAPTERS,
  BREAKER,
  CONCURRENCY_LIMITER,
  DB,
  ENV,
  JOB_PROGRESS,
  JOB_QUEUE,
  RATE_LIMITER,
} from '../common/tokens.js';
import { RedisJobProgressBus } from '../jobs/job-progress.bus.js';

const envProvider: Provider = {
  provide: ENV,
  useFactory: (): AppEnv => loadEnv(),
};

const dbProvider: Provider = {
  provide: DB,
  inject: [ENV],
  useFactory: (env: AppEnv): Database => createDb(env.DATABASE_URL),
};

const adaptersProvider: Provider = {
  provide: ADAPTERS,
  useFactory: () => registerEngineAdapters(createDefaultRegistry()),
};

const queueProvider: Provider = {
  provide: JOB_QUEUE,
  inject: [ENV],
  useFactory: (env: AppEnv): BullmqJobQueue => new BullmqJobQueue(env.REDIS_URL),
};

// The ApiKeyGuard's db surface, exported globally so it can be overridden with a
// fake repo in unit tests without touching the live database.
const apiKeyRepoProvider: Provider = { provide: API_KEY_REPO, useValue: defaultApiKeyRepo };

// The two-level rate limiter, backed by a dedicated Redis client. Exported so
// tests can override it with an in-memory fake (the blocking /v1/run e2e does
// not stand up Redis).
const rateLimiterProvider: Provider = {
  provide: RATE_LIMITER,
  inject: [ENV],
  useFactory: (env: AppEnv): RateLimiter => new RedisRateLimiter(createRedis(env.REDIS_URL)),
};

// In-flight (concurrency) limiter for governance `concurrency` rules; same Redis,
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
// best-effort, so it only OPTIMIZES the relay routing. Overridable with a fake
// in tests.
const breakerProvider: Provider = {
  provide: BREAKER,
  inject: [ENV, DB, AuditService],
  useFactory: (env: AppEnv, db: Database, audit: AuditService): BreakerStore =>
    buildBreakerStore(db, createRedis(env.REDIS_URL), (input) => {
      void audit.record(input);
    }),
};

// The job-progress SSE bus (`GET /v1/jobs/:id/stream`), over a DEDICATED ioredis
// SUBSCRIBER client (subscriber mode is exclusive — must not reuse the breaker /
// rate-limiter client). Ref-counts channel subscriptions across connections and
// quits the client on module destroy (it owns its lifecycle). Fail-open, so a
// Redis outage only degrades latency — the SSE service's DB-poll backstop keeps
// the stream correct. Overridable with a fake in tests.
const jobProgressProvider: Provider = {
  provide: JOB_PROGRESS,
  inject: [ENV],
  useFactory: (env: AppEnv): RedisJobProgressBus =>
    new RedisJobProgressBus(createRedis(env.REDIS_URL)),
};

/**
 * Global infrastructure module: one shared drizzle `Database`, the parsed env,
 * the engine's default adapter registry, the stub secret resolver, and the
 * BullMQ job queue. Exported so feature modules (execution, jobs) inject them
 * by token without re-instantiating per request.
 */
@Global()
@Module({
  imports: [AuditModule],
  providers: [
    envProvider,
    dbProvider,
    adaptersProvider,
    queueProvider,
    apiKeyRepoProvider,
    rateLimiterProvider,
    concurrencyLimiterProvider,
    breakerProvider,
    jobProgressProvider,
    SecretResolver,
  ],
  exports: [
    ENV,
    DB,
    ADAPTERS,
    JOB_QUEUE,
    API_KEY_REPO,
    RATE_LIMITER,
    CONCURRENCY_LIMITER,
    BREAKER,
    JOB_PROGRESS,
    SecretResolver,
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class DbModule {}
