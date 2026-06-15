import { createDefaultRegistry } from '@actionow/adapters';
import type { Database } from '@actionow/db';
import { createDb } from '@actionow/db';
import type { AppEnv } from '@actionow/infra';
import { loadEnv } from '@actionow/infra';
import type { Provider } from '@nestjs/common';
import { Global, Module } from '@nestjs/common';

import { API_KEY_REPO, defaultApiKeyRepo } from '../auth/api-key.guard.js';
import { BullmqJobQueue } from '../common/bullmq-queue.js';
import { SecretResolver } from '../common/secret-resolver.js';
import { ADAPTERS, DB, ENV, JOB_QUEUE } from '../common/tokens.js';

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
  useFactory: () => createDefaultRegistry(),
};

const queueProvider: Provider = {
  provide: JOB_QUEUE,
  inject: [ENV],
  useFactory: (env: AppEnv): BullmqJobQueue => new BullmqJobQueue(env.REDIS_URL),
};

// The ApiKeyGuard's db surface, exported globally so it can be overridden with a
// fake repo in unit tests without touching the live database.
const apiKeyRepoProvider: Provider = { provide: API_KEY_REPO, useValue: defaultApiKeyRepo };

/**
 * Global infrastructure module: one shared drizzle `Database`, the parsed env,
 * the engine's default adapter registry, the stub secret resolver, and the
 * BullMQ job queue. Exported so feature modules (execution, jobs) inject them
 * by token without re-instantiating per request.
 */
@Global()
@Module({
  providers: [
    envProvider,
    dbProvider,
    adaptersProvider,
    queueProvider,
    apiKeyRepoProvider,
    SecretResolver,
  ],
  exports: [ENV, DB, ADAPTERS, JOB_QUEUE, API_KEY_REPO, SecretResolver],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class DbModule {}
