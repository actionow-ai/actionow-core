// apps/api/src/gateway/gateway.module.ts
//
// model-supply-greenfield 批次4 slice3 — the NEW gateway API face (§5). 双面
// 并存: everything here is a NEW path (/v1/videos/generations, /v1/audio/music,
// /v1/tasks 族, /v1/gateway/models) over the NEW execution seam
// (executeGateway); the old /v1/run, /v1/jobs, /v1/chat/completions and the
// old GET /v1/models are untouched.
//
// Wiring: the §6 dialect registry is assembled ONCE at boot from the builtin
// set (four code dialects + the huimeng DSL pack — createBuiltinDialectRegistry,
// single-sourced in @actionow/spi); the SPI transport is the shared infra
// HttpClient factory (undici FetchHttpClient, or curl egress under
// HTTP_EGRESS=curl). The §7.8 gate primitives (db / redis limiter /
// concurrency) come from the @Global DbModule.
import type { HttpClient } from '@actionow/contracts';
import type { Database } from '@actionow/db';
import type { PersistHook } from '@actionow/engine';
import { createPersistHook } from '@actionow/engine';
import type { AppEnv } from '@actionow/infra';
import {
  createHttpClient,
  createMediaTransfer,
  createS3StorageProvider,
  storageConfigFromEnv,
} from '@actionow/infra';
import type { DialectRegistry } from '@actionow/spi';
import { createBuiltinDialectRegistry } from '@actionow/spi';
import type { Provider } from '@nestjs/common';
import { Module } from '@nestjs/common';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { DB, ENV } from '../common/tokens.js';
import { SettingsService } from '../settings/settings.service.js';
import { GatewayChatV2Service } from './chat-v2.service.js';
import { GatewayCreateController } from './create.controller.js';
import { GatewayService } from './gateway.service.js';
import { GATEWAY_DIALECTS, GATEWAY_HTTP, GATEWAY_PERSIST } from './gateway.tokens.js';
import { GatewayCallbacksController } from './gateway-callbacks.controller.js';
import { GatewayCallbacksService } from './gateway-callbacks.service.js';
import { GatewayModelsController } from './models.controller.js';
import { GatewayTaskStreamService } from './task-stream.service.js';
import { GatewayTasksController } from './tasks.controller.js';
import { GatewayTasksService } from './tasks.service.js';

/** The builtin §6 registry (versioned, immutable per (ref, version)). */
const dialectsProvider: Provider = {
  provide: GATEWAY_DIALECTS,
  useFactory: (): DialectRegistry => createBuiltinDialectRegistry(),
};

/** The SPI transport (§6-④). Overridable in tests (no real egress). */
const httpProvider: Provider = {
  provide: GATEWAY_HTTP,
  useFactory: (): HttpClient => createHttpClient(),
};

/**
 * Build the production §7.5 persist hook (批次4 slice5). Storage comes from
 * the STORAGE_* env (the files-module pattern); a MISSING storage config still
 * returns a hook whose media persists FAIL — so `require_persist: true` fails
 * the task (no charge, §7.5 红线) instead of silently skipping 转存, while
 * `require_persist: false` degrades to the upstream URL + warnings + 告警.
 * Exported for the wiring unit test.
 */
export function buildGatewayPersistHook(
  db: Database,
  env: AppEnv,
  settings?: SettingsService,
): PersistHook {
  const cfg = storageConfigFromEnv(env);
  return createPersistHook({
    db,
    storage: cfg === null ? null : createS3StorageProvider(cfg),
    publicBaseUrl: env.STORAGE_PUBLIC_BASE_URL,
    transfer: createMediaTransfer(),
    resolveDefaultRetentionDays:
      settings !== undefined
        ? (): Promise<number | undefined> => settings.get('ARTIFACT_RETENTION_DAYS')
        : undefined,
  });
}

/**
 * §7.5/§9.4 — the artifact persist hook, live on BOTH api-side settle paths:
 * the in-request execute path (GatewayService → ExecuteGatewayDeps.persist)
 * and the callback ingress (GatewayCallbacksService → applyTaskUpdate). The
 * worker's poll path wires its own instance (task-poll.processor.ts).
 */
const persistProvider: Provider = {
  provide: GATEWAY_PERSIST,
  inject: [DB, ENV, { token: SettingsService, optional: true }],
  useFactory: (db: Database, env: AppEnv, settings?: SettingsService): PersistHook =>
    buildGatewayPersistHook(db, env, settings),
};

@Module({
  controllers: [
    GatewayCreateController,
    GatewayTasksController,
    GatewayModelsController,
    GatewayCallbacksController,
  ],
  providers: [
    GatewayService,
    GatewayChatV2Service,
    GatewayTasksService,
    GatewayTaskStreamService,
    GatewayCallbacksService,
    ApiKeyGuard,
    dialectsProvider,
    httpProvider,
    persistProvider,
  ],
  // 批次6 D2 (旧世界删除后): the ChatModule's seven legacy sync controllers
  // ride GatewayChatV2Service unconditionally (gray-release 分支已坍缩), and
  // the media dialects (/v1/images/generations, /v1/audio/speech) drive the
  // exported GatewayService directly.
  exports: [GatewayChatV2Service, GatewayService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class GatewayModule {}
