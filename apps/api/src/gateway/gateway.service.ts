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
// `keyRpm` into the planner instead.
//
// 批次6 P5 — limit-plan (额度套餐) is now WIRED on this face: `execute()`
// resolves the auth-derived plan bindings (key/tenant/subject, the exact
// GovernanceGuard.effectiveRules algorithm behind a 15s cache) into
// `scopedRules` for the §7.8 gates, and the §9.1 model global gate reads its
// cap through a 30s-cached resolver. The GUARD ITSELF stays untouched (双面
// 并存 — the legacy surfaces still mount it; it dies with the old world).
import { hostname } from 'node:os';

import type { GatewayRequest, HttpClient } from '@actionow/contracts';
import type { Database, SupplyModelRow } from '@actionow/db';
import {
  getApiKeyModelAllowlist,
  getSupplyModelRateLimit,
  listVisibleSupplyModels,
  resolveSupplyModelByNameForTenant,
} from '@actionow/db';
import type {
  ExecuteGatewayDeps,
  ExecuteGatewayOptions,
  ExecuteResult,
  PersistHook,
  ScopedRulesResolver,
} from '@actionow/engine';
import {
  createCachedModelLimitResolver,
  createCachedScopedRulesResolver,
  executeGateway,
} from '@actionow/engine';
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

/**
 * The auth-derived limit-plan bindings (额度套餐; ApiKeyGuard already resolved
 * them onto the auth context): the key's plan, the tenant's account-level
 * plan, and the subject's plan. `execute()` turns them into the §7.8 gates'
 * `scopedRules` through the cached resolver.
 */
export interface GatewayLimitBindings {
  keyLimitPlanId: string | null;
  tenantLimitPlanId: string | null;
  subjectLimitPlanId?: string | null | undefined;
}

/** {@link GatewayService.execute}'s options: the engine opts + the limit bindings. */
export type GatewayExecuteOptions = ExecuteGatewayOptions & {
  limits?: GatewayLimitBindings | undefined;
};

@Injectable()
export class GatewayService {
  private readonly deps: ExecuteGatewayDeps;
  private readonly queries: GatewayQueries;
  /** 批次6 P5 — the guard-parity (15s TTL, per key/tenant/subject) rules resolver. */
  private readonly scopedRules: ScopedRulesResolver;

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
      // §9.1 模型全局闸 cap source (批次6 D3 — re-sourced off the deleted
      // `model.rate_limit`): the model's bound 对外限额 plan
      // (`supply_model.limit_plan_id`) reduced to its TIGHTEST applicable
      // rpm-dimension rule (plan-wide or exact model_scope match); no live
      // model / no binding / no rpm rule → null = gate pass-through (the old
      // "rate_limit NULL" semantics). Same 30s cache as the proven guard.
      resolveModelLimit: createCachedModelLimitResolver({
        fetch: (name) => getSupplyModelRateLimit(db, name),
      }),
    };
    this.queries = DEFAULT_QUERIES;
    this.scopedRules = createCachedScopedRulesResolver({ deps: { db } });
  }

  /**
   * One end-to-end gateway execution (slice2 seam — §5 幂等 → §8 failover
   * 循环 → §3 矩阵 → settle). 批次6 P5: when the caller hands the auth-derived
   * `limits` bindings (and no explicit `scopedRules`), the limit-plan rules
   * are resolved HERE — one resolution per request, consumed by every §7.8
   * gate layer (rpm rules → step 1, spend/tokens/requests → the read-only
   * step-2 precheck) and by the post-admission `requests` accrual.
   */
  async execute(request: GatewayRequest, opts: GatewayExecuteOptions): Promise<ExecuteResult> {
    const { limits, ...engineOpts } = opts;
    const scopedRules =
      engineOpts.scopedRules ??
      (limits !== undefined
        ? await this.scopedRules({
            tenantId: request.tenantId,
            apiKeyId: request.apiKeyId,
            subjectId: request.subjectId ?? null,
            keyLimitPlanId: limits.keyLimitPlanId,
            tenantLimitPlanId: limits.tenantLimitPlanId,
            subjectLimitPlanId: limits.subjectLimitPlanId ?? null,
          })
        : undefined);
    return executeGateway(this.deps, request, {
      ...engineOpts,
      ...(scopedRules !== undefined ? { scopedRules } : {}),
    });
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
