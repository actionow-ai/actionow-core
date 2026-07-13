// apps/api/src/gateway/gateway.service.ts
//
// model-supply-greenfield 批次4 slice3 — the NestJS seam around the slice2
// executeGateway: assembles the production ExecuteGatewayDeps ONCE (db + the
// §7.8 gate primitives + the §6 dialect registry + the SPI HttpClient) and
// exposes the thin read surface the controllers need (visibility-gated model
// resolution, the §2.6 key model-allowlist, the §5 discovery list).
//
// Governance note (择稳裁决, slice3): the NEW gateway does NOT mount the
// old-world GovernanceGuard. The §7.8 gate INSIDE planExecution already runs
// the four-layer 限流 (tenant/key RPM → read-only quota precheck → model gate
// → credential mirror → dual semaphore → hold) — mounting the legacy guard on
// top would double-count RPM windows and acquire legacy concurrency slots the
// new path never releases through. The key's own RPM override rides
// `keyRpm` into the planner instead. Limit-plan scoped rules / modifier
// stacks are slice6 wiring (documented deviation).
import { hostname } from 'node:os';

import type { GatewayRequest, HttpClient } from '@actionow/contracts';
import type { Database, SupplyModelRow } from '@actionow/db';
import {
  getApiKeyModelAllowlist,
  listVisibleSupplyModels,
  resolveSupplyModelByNameForTenant,
} from '@actionow/db';
import type {
  ExecuteGatewayDeps,
  ExecuteGatewayOptions,
  ExecuteResult,
  PersistHook,
} from '@actionow/engine';
import { executeGateway } from '@actionow/engine';
import type { ConcurrencyLimiter, RateLimiter } from '@actionow/infra';
import type { DialectRegistry } from '@actionow/spi';
import { Inject, Injectable, Optional } from '@nestjs/common';

import { CONCURRENCY_LIMITER, DB, RATE_LIMITER } from '../common/tokens.js';
import { GATEWAY_DIALECTS, GATEWAY_HTTP, GATEWAY_PERSIST } from './gateway.tokens.js';

/** The db reads this service performs, injectable for unit tests. */
export interface GatewayQueries {
  resolveSupplyModelByNameForTenant: typeof resolveSupplyModelByNameForTenant;
  listVisibleSupplyModels: typeof listVisibleSupplyModels;
  getApiKeyModelAllowlist: typeof getApiKeyModelAllowlist;
}

const DEFAULT_QUERIES: GatewayQueries = {
  resolveSupplyModelByNameForTenant,
  listVisibleSupplyModels,
  getApiKeyModelAllowlist,
};

@Injectable()
export class GatewayService {
  private readonly deps: ExecuteGatewayDeps;
  private readonly queries: GatewayQueries;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(RATE_LIMITER) limiter: RateLimiter,
    @Inject(CONCURRENCY_LIMITER) concurrency: ConcurrencyLimiter,
    @Inject(GATEWAY_DIALECTS) dialects: DialectRegistry,
    @Inject(GATEWAY_HTTP) http: HttpClient,
    // §7.5 转存 hook (slice5) — the in-request settle path (sync / stream /
    // inline task) runs 转存先于 succeeded through it. @Optional so partial
    // test modules keep today's behavior (no persist).
    @Optional() @Inject(GATEWAY_PERSIST) persist?: PersistHook,
  ) {
    this.deps = {
      db,
      now: () => new Date(),
      rng: Math.random,
      limiter,
      concurrency,
      dialectRegistry: dialects,
      spiHttp: http,
      // §7.2 lease identity — which node drives recoverable tasks it created.
      ownerNode: hostname(),
      persist,
    };
    this.queries = DEFAULT_QUERIES;
  }

  /** One end-to-end gateway execution (slice2 seam — §5 幂等 → §8 failover 循环 → §3 矩阵 → settle). */
  execute(request: GatewayRequest, opts: ExecuteGatewayOptions): Promise<ExecuteResult> {
    return executeGateway(this.deps, request, opts);
  }

  /** §2.1/§10 visibility-gated model resolution (active|deprecated ∩ public|granted). */
  resolveVisibleModel(name: string, tenantId: string): Promise<SupplyModelRow | undefined> {
    return this.queries.resolveSupplyModelByNameForTenant(this.db, name, tenantId);
  }

  /**
   * The key's §2.6 model whitelist. `[]` = allow all (frozen 批次1 semantics);
   * an unknown/soft-deleted key answers `[]` too — the ApiKeyGuard already
   * authenticated it, so a vanished row mid-request degrades to no EXTRA
   * restriction rather than a spurious lockout.
   */
  async modelAllowlist(apiKeyId: string): Promise<string[]> {
    return (await this.queries.getApiKeyModelAllowlist(this.db, apiKeyId)) ?? [];
  }

  /** §5 发现面: every supply model visible to the tenant (public ∪ granted). */
  listVisibleModels(tenantId: string): Promise<SupplyModelRow[]> {
    return this.queries.listVisibleSupplyModels(this.db, tenantId);
  }
}
