// packages/engine/src/planner/candidates.ts
//
// model-supply-greenfield 批次3 slice 3a — §8 候选装配 (candidate assembly).
//
//   候选 = enabled 供给项 ∩ 可见性 ∩ route-tag/钉选 ∩ 熔断闭合
//        ∩ 凭证池非全冷却 ∩ 参数感知过滤 (§4)
//
// Thin I/O orchestration over the slice-1 repo queries + the slice-2 pure
// param filter. Stage order (each elimination lands in `rejected` for the
// trace):
//
//   1. SQL raw candidates (listRoutingCandidates already enforces: enabled
//      offering × live active channel × BYOK ownership × routeTag/routeGroup
//      narrowing — all in the WHERE).
//   2. route-tag narrow-only pin: tag given + zero matches → 400 invalid_input
//      (route-tagging 现状语义; no tag + zero matches is NOT an error here —
//      "no supply" is the orchestrator's concern).
//   2b/2c. §8 failover exclusion + §3 paradigm×fetch servability (isServable):
//      already-tried offerings and fetch modes that cannot serve the planned
//      external paradigm INLINE fall out BEFORE any hold can be taken on them.
//   3. breaker-closed filter — PURE FSM verdicts from breaker.ts, never a
//      re-implementation: open & cooling → out; open & cooldown elapsed →
//      in (half-open probes route through the normal pool, §2.5); half_open →
//      in; missing row → closed initial state → in.
//   4. credential-pool-not-all-cold filter (§2.4): an empty active pool marks
//      the offering 暂不可用 — filtered, breaker UNTOUCHED (key 病与渠道病分开
//      表达). Pools are memoized per channel (multiple offerings share one
//      channel's pool). This stage only CONFIRMS the pool is non-empty —
//      picking the key is slice 3b.
//   5. §4 parameter-aware filtering (filterCandidates) — survivors carry their
//      EffectiveParams + billingDims; total annihilation propagates the
//      unsupported_parameter GatewayError verbatim (§4 rule 4).
//
// Output is UNORDERED (raw SQL tier-desc order preserved); ranking is
// sort.ts's job. Hold / semaphore / key selection are slice 3b — not here.
import type {
  BillingDims,
  CanonicalParamValue,
  EffectiveParams,
  GatewayError,
  GatewayWarning,
  ModelOperation,
  Operation,
} from '@actionow/contracts';
import type {
  DbOrTx,
  ListRoutingCandidatesParams,
  RoutingCandidate,
  SupplyCredentialRow,
  SupplyOfferingBreakerRow,
} from '@actionow/db';
import {
  getSupplyOfferingBreakers,
  listActiveCredentialsForChannel,
  listRoutingCandidates,
} from '@actionow/db';

import {
  type BreakerConfig,
  type BreakerSnapshot,
  type BreakerState,
  cooldownMs,
  DEFAULT_BREAKER_CONFIG,
  openEligibleAt,
} from '../breaker.js';
import { type ExternalParadigm, isServable } from './fetch-plan.js';
import { filterCandidates, type FilterMode } from './param-filter.js';

/**
 * The slice-1 data-access surface this orchestration consumes. Injectable via
 * {@link AssembleDeps.queries} so tests run against handwritten fakes (fixed
 * RoutingCandidate[] / credential pools / breaker maps) without a live db;
 * production omits it and gets the real @actionow/db repo functions.
 */
export interface AssembleQueries {
  listRoutingCandidates: (
    db: DbOrTx,
    params: ListRoutingCandidatesParams,
  ) => Promise<RoutingCandidate[]>;
  listActiveCredentialsForChannel: (
    db: DbOrTx,
    channelId: string,
    now: Date,
  ) => Promise<SupplyCredentialRow[]>;
  getSupplyOfferingBreakers: (
    db: DbOrTx,
    offeringIds: string[],
  ) => Promise<Map<string, SupplyOfferingBreakerRow>>;
}

/** Thin-orchestration dependencies: db + clock (+ optional query fakes for tests). */
export interface AssembleDeps {
  db: DbOrTx;
  now: () => Date;
  queries?: Partial<AssembleQueries> | undefined;
}

export interface AssembleInput {
  operation: Operation;
  /**
   * The resolved supply model (the facade's visibility-gated lookup). Only
   * `id` + `operations` are consumed — structurally satisfied by a full
   * SupplyModelRow.
   */
  model: { id: string; operations: ModelOperation[] };
  /** GatewayRequest.params — explicit-vs-default tagged (§4.1 layer 1). */
  requestParams: Record<string, CanonicalParamValue>;
  tenantId: string;
  /** §8 route-tag narrow-only pin; given + zero matches ⇒ 400. */
  routeTag?: string | undefined;
  routeGroupId?: string | undefined;
  /** §4 rule 4 filter mode; default 'strict'. */
  mode?: FilterMode | undefined;
  /**
   * Effective breaker thresholds (§2.5: 默认沿用现 breaker 参数 60s 窗/50%/20
   * 样本). Per-offering fault-policy resolution is a later slice; absent →
   * {@link DEFAULT_BREAKER_CONFIG}.
   */
  breakerConfig?: BreakerConfig | undefined;
  /**
   * §8 failover loop (批次4): offerings ALREADY TRIED this request — excluded
   * from assembly so every re-plan hop lands on a fresh sibling (每跳重过参数
   * 校验与映射 happens naturally because the whole pipeline re-runs).
   */
  excludeOfferingIds?: readonly string[] | undefined;
  /**
   * The request's PLANNED external shape (§3 planParadigm verdict). When
   * present, candidates whose fetch mode cannot serve this paradigm INLINE
   * ({@link isServable} — stream×submit_* / task×stream await worker
   * synthesis in a later slice) are filtered here rather than discovered as a
   * dispatch mismatch after the hold — zero hold-write/rollback churn.
   * Absent → no servability filtering (direct assembly callers).
   */
  externalParadigm?: ExternalParadigm | undefined;
}

/**
 * One assembled (UNORDERED) routing candidate: the offering + its channel
 * routing dimensions, the §4.1 layer-2 resolution for THIS offering, and the
 * size of its channel's active key pool (pool non-emptiness is confirmed
 * here; SELECTING the key is slice 3b).
 */
export interface AssembledCandidate {
  offering: RoutingCandidate;
  effective: EffectiveParams;
  billingDims: BillingDims;
  activeCredentialCount: number;
}

export type AssembleRejectionStage =
  | 'excluded'
  | 'servability'
  | 'breaker'
  | 'credentials'
  | 'params';

/** One offering's elimination record (observability — relay_trace fodder). */
export interface AssembleRejection {
  offeringId: string;
  stage: AssembleRejectionStage;
  reason: string;
  /** The canonical param that excluded this offering (`params` stage only). */
  param?: string | undefined;
}

export interface AssembleResult {
  /** Survivors, UNORDERED (raw tier-desc SQL order) — ranking is sortCandidates's job. */
  candidates: AssembledCandidate[];
  /** Per-stage elimination trail for every offering that fell. */
  rejected: AssembleRejection[];
  /** Lenient-mode drop echoes forwarded from §4 filtering (empty in strict mode). */
  warnings: GatewayWarning[];
  /**
   * Set when assembly must answer an error instead of a (possibly empty)
   * candidate set: route-tag zero-match (400 invalid_input), undeclared
   * operation (400 invalid_input), or §4 rule 4 total param annihilation
   * (unsupported_parameter, passed through verbatim).
   */
  error?: GatewayError | undefined;
}

/**
 * §8 candidate assembly. See the module header for the stage pipeline. The
 * clock is sampled ONCE (`deps.now()`) so breaker eligibility and credential
 * cooldown judge the same instant.
 */
export async function assembleCandidates(
  deps: AssembleDeps,
  input: AssembleInput,
): Promise<AssembleResult> {
  const q: AssembleQueries = {
    listRoutingCandidates: deps.queries?.listRoutingCandidates ?? listRoutingCandidates,
    listActiveCredentialsForChannel:
      deps.queries?.listActiveCredentialsForChannel ?? listActiveCredentialsForChannel,
    getSupplyOfferingBreakers: deps.queries?.getSupplyOfferingBreakers ?? getSupplyOfferingBreakers,
  };
  const now = deps.now();
  const rejected: AssembleRejection[] = [];

  // 0. the operation must be declared on the model (对外范式挂模型) — an
  //    undeclared operation would make the §4 canonical contract empty and
  //    silently pass everything, so it is an explicit 400 instead.
  const op = input.model.operations.find((o) => o.operation === input.operation);
  if (op === undefined) {
    return {
      candidates: [],
      rejected,
      warnings: [],
      error: {
        code: 'invalid_input',
        message: `model does not expose operation '${input.operation}'`,
        retryable: false,
        failover: false,
      },
    };
  }

  // 1. raw candidates — enabled × visibility/BYOK × routeTag/routeGroup are
  //    already in the SQL WHERE (slice 1).
  const raw = await q.listRoutingCandidates(deps.db, {
    modelId: input.model.id,
    tenantId: input.tenantId,
    routeTag: input.routeTag,
    routeGroupId: input.routeGroupId,
  });

  // 2. route-tag narrow-only pin: tag given + zero matches → 400 (§8 钉选).
  //    No tag → an empty set is NOT an error here.
  if (raw.length === 0) {
    if (input.routeTag !== undefined) {
      return {
        candidates: [],
        rejected,
        warnings: [],
        error: {
          code: 'invalid_input',
          message: `no offering matches route tag '${input.routeTag}' for this model`,
          retryable: false,
          failover: false,
          details: { routeTag: input.routeTag },
        },
      };
    }
    return { candidates: [], rejected, warnings: [] };
  }

  // 2b. §8 failover exclusion (批次4 loop): offerings already attempted this
  //     request fall out AFTER the tag pin judgment (a tag that matched only
  //     already-tried offerings is exhaustion, not a caller mistake). All
  //     excluded → empty set → the orchestrator answers "no routable supply".
  let pool = raw;
  if (input.excludeOfferingIds !== undefined && input.excludeOfferingIds.length > 0) {
    const excludedIds = new Set(input.excludeOfferingIds);
    pool = [];
    for (const cand of raw) {
      if (excludedIds.has(cand.id)) {
        rejected.push({
          offeringId: cand.id,
          stage: 'excluded',
          reason: 'offering already attempted this request (§8 failover loop exclusion)',
        });
        continue;
      }
      pool.push(cand);
    }
    if (pool.length === 0) {
      return { candidates: [], rejected, warnings: [] };
    }
  }

  // 2c. §3 paradigm×fetch servability filter: an offering whose fetch mode
  //     cannot serve the planned external paradigm INLINE (stream×submit_* /
  //     task×stream — worker synthesis is a later slice) never enters the
  //     candidate set, so it can never win the sort, take a hold and bounce
  //     back as a dispatch mismatch (确定性空转). Judged AFTER the tag pin
  //     (a tag matching only unservable supply is exhaustion, not a caller
  //     mistake) and BEFORE the I/O stages (no breaker/pool lookups wasted).
  //     sync passes everything — the filter can never starve the common path.
  if (input.externalParadigm !== undefined) {
    const paradigm = input.externalParadigm;
    const servable: RoutingCandidate[] = [];
    for (const cand of pool) {
      if (!isServable(paradigm, cand.fetchProfile.mode)) {
        rejected.push({
          offeringId: cand.id,
          stage: 'servability',
          reason: `fetch mode '${cand.fetchProfile.mode}' cannot serve the '${paradigm}' paradigm inline (§3 servability matrix)`,
        });
        continue;
      }
      servable.push(cand);
    }
    pool = servable;
    if (pool.length === 0) {
      return { candidates: [], rejected, warnings: [] };
    }
  }

  // 3. breaker-closed filter (pure FSM verdicts from breaker.ts).
  const cfg = input.breakerConfig ?? DEFAULT_BREAKER_CONFIG;
  const afterBreaker: RoutingCandidate[] = [];
  if (!cfg.enabled) {
    // Breaker administratively disabled → it never removes a candidate.
    afterBreaker.push(...pool);
  } else {
    const breakers = await q.getSupplyOfferingBreakers(
      deps.db,
      pool.map((o) => o.id),
    );
    for (const cand of pool) {
      const row = breakers.get(cand.id);
      // Missing row = closed initial state → routable (slice-1 contract).
      if (row === undefined) {
        afterBreaker.push(cand);
        continue;
      }
      const snap = breakerSnapshotFromRow(row, cfg);
      // open & still cooling → out. open & cooldown elapsed → in (the probe
      // routes through the normal pool, §2.5 半开走池内轮转). half_open → in.
      if (snap.state === 'open' && !openEligibleAt(snap, now)) {
        rejected.push({
          offeringId: cand.id,
          stage: 'breaker',
          reason: `circuit breaker open (cooling until ${snap.cooldownUntil?.toISOString() ?? 'unknown'})`,
        });
        continue;
      }
      afterBreaker.push(cand);
    }
  }

  // 4. credential-pool-not-all-cold filter (§2.4), memoized per channel —
  //    offerings on the same channel share one pool lookup.
  const poolByChannel = new Map<string, SupplyCredentialRow[]>();
  const afterCredentials: { offering: RoutingCandidate; activeCredentialCount: number }[] = [];
  for (const cand of afterBreaker) {
    let pool = poolByChannel.get(cand.channelId);
    if (pool === undefined) {
      pool = await q.listActiveCredentialsForChannel(deps.db, cand.channelId, now);
      poolByChannel.set(cand.channelId, pool);
    }
    if (pool.length === 0) {
      rejected.push({
        offeringId: cand.id,
        stage: 'credentials',
        reason:
          'credential pool exhausted: no active key outside cooldown (offering 暂不可用, breaker untouched — §2.4)',
      });
      continue;
    }
    afterCredentials.push({ offering: cand, activeCredentialCount: pool.length });
  }
  if (afterCredentials.length === 0) {
    return { candidates: [], rejected, warnings: [] };
  }

  // 5. §4 parameter-aware filtering (slice 2, pure).
  const filter = filterCandidates({
    operation: input.operation,
    canonicalParams: op.params,
    requestParams: input.requestParams,
    candidates: afterCredentials.map((c) => ({
      offeringId: c.offering.id,
      declarations: c.offering.paramDeclarations,
    })),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
  });
  for (const r of filter.rejected) {
    rejected.push({ offeringId: r.offeringId, stage: 'params', reason: r.reason, param: r.param });
  }
  if (filter.error !== undefined) {
    // §4 rule 4 total annihilation — pass the unsupported_parameter error
    // through verbatim (it already names WHICH param excluded WHICH offerings).
    return { candidates: [], rejected, warnings: filter.warnings, error: filter.error };
  }

  const byOfferingId = new Map(afterCredentials.map((c) => [c.offering.id, c]));
  const candidates: AssembledCandidate[] = [];
  for (const survivor of filter.survivors) {
    const base = byOfferingId.get(survivor.offeringId);
    // The filter only ever sees ids we fed it; an unknown id is unreachable.
    if (base === undefined) continue;
    candidates.push({
      offering: base.offering,
      effective: survivor.effective,
      billingDims: survivor.billingDims,
      activeCredentialCount: base.activeCredentialCount,
    });
  }
  return { candidates, rejected, warnings: filter.warnings };
}

/**
 * Rehydrate a persisted `supply_offering_breaker` row into the pure-FSM
 * {@link BreakerSnapshot} shape breaker.ts consumes. The table stores no
 * `cooldown_until` (derivable — slice-1 design): it is reconstructed as
 * `opened_at + cooldownMs(cfg, consecutive_opens − 1)`, mirroring the FSM's
 * own `open()` (trip n stamps `now + cooldownMs(cfg, tripCount − 1)`).
 * `consecutive_opens` IS the FSM's `tripCount`. An unknown/corrupt state
 * string degrades to `closed` (fail-open: the breaker only OPTIMIZES routing);
 * an open row missing `opened_at` falls back to `updated_at` (the instant the
 * open transition was written).
 */
export function breakerSnapshotFromRow(
  row: SupplyOfferingBreakerRow,
  cfg: BreakerConfig,
): BreakerSnapshot {
  const state: BreakerState =
    row.state === 'open' || row.state === 'half_open' ? row.state : 'closed';
  const openInstant = row.openedAt ?? row.updatedAt;
  const cooldownUntil =
    state === 'open'
      ? new Date(openInstant.getTime() + cooldownMs(cfg, row.consecutiveOpens - 1))
      : null;
  return {
    state,
    openedAt: row.openedAt,
    cooldownUntil,
    tripCount: row.consecutiveOpens,
    halfOpenSuccesses: row.halfOpenSuccesses,
  };
}
