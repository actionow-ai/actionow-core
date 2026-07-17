// packages/engine/src/planner/plan.ts
//
// model-supply-greenfield 批次3 slice 4 — planExecution, THE composition entry
// of the execution planner (批次4 的唯一挂载点). It stitches the already-landed
// slices IN DESIGN ORDER and adds NO new routing/gate/param logic of its own:
//
//   1. resolveSupplyModelByNameForTenant (slice 1, §2.1/§10 visibility gate)
//      — unknown/ungranted/disabled model ⇒ model_not_found; `deprecated`
//      still serves and stamps a DeprecationNotice for 批次4's §10 预告头.
//   2. operation ∈ model.operations (对外范式挂模型) ⇒ else invalid_input.
//   3. planParadigm (slice 3a, §3) — external shape sync/stream/task +
//      server-side slow auto-upgrade marker.
//   4. assembleCandidates (slice 3a over slices 1+2, §8/§4) — enabled ×
//      visibility/BYOK × route-tag pin × breaker-closed × pool-not-all-cold ×
//      param-aware filter; its errors (invalid_input route-tag zero-match /
//      unsupported_parameter total annihilation) pass through VERBATIM.
//   5. sortCandidates (slice 3a, §8) — tier desc + recoverable-fetch sub-tier
//      + weighted random.
//   6. runExecutionGates (slice 3b, §7.8 fixed order) — limits → read-only
//      quota precheck → model gate → credential pool → dual semaphore → hold.
//   7. PlanResult — the Reservation (carrying release() for 批次4's §7.8
//      failure rollback) + paradigm/fetch plans + EffectiveParams.
//
// planExecution NEVER calls the upstream: dispatching between semaphore-acquire
// and commit — and calling reservation.release() when that dispatch fails — is
// 批次4's contract (§7.8). planFetch placement (slice-3b 复核观察): the gate
// already derives the ONE FetchPlan per reservation AFTER the slot+hold are
// secured (gate.ts step 7); planExecution re-exposes `reservation.fetchPlan`
// instead of recomputing — a single derivation, at the safe point.
import type {
  BillingDims,
  EffectiveParams,
  GatewayError,
  GatewayRequest,
  GatewayWarning,
  Modifier,
  UsageVector,
} from '@actionow/contracts';
import type { DbOrTx, SupplyModelRow } from '@actionow/db';
import { resolveSupplyModelByNameForTenant } from '@actionow/db';
import type { MicroCredits } from '@actionow/domain';
import type { ConcurrencyLimiter, RateLimiter } from '@actionow/infra';

import type { BreakerConfig } from '../breaker.js';
import { assembleCandidates, type AssembleQueries, type AssembleRejection } from './candidates.js';
import {
  type FetchPlan,
  type ParadigmPlan,
  type ParadigmSettings,
  planParadigm,
} from './fetch-plan.js';
import {
  type GateAccounting,
  type GateAttempt,
  type GateQueries,
  type Reservation,
  runExecutionGates,
} from './gate.js';
import type { ModelLimitResolver, ScopedLimitRule } from './limits.js';
import type { FilterMode } from './param-filter.js';
import { sortCandidates } from './sort.js';

/** Production defaults for the per-minute caps (dynamic-config resolution is 批次4 wiring). */
const DEFAULT_RATE_DEFAULTS = { tenantRpm: 600, keyRpm: 120 } as const;
/** §7.8 bounded per-candidate semaphore wait, absent an explicit budget. */
const DEFAULT_MAX_WAIT_MS = 2_000;
/** Overall admission budget across all candidates, absent an explicit budget. */
const DEFAULT_MAX_QUEUE_MS = 10_000;

/**
 * The db lookups planExecution itself performs (beyond what assembly/gate do),
 * injectable for tests alongside the assemble/gate query surfaces.
 */
export interface PlanQueries extends AssembleQueries, GateQueries {
  resolveSupplyModelByNameForTenant: typeof resolveSupplyModelByNameForTenant;
}

/**
 * Dependencies for {@link planExecution} — the UNION of the slice-3a assembly
 * deps and the slice-3b gate deps (one bag, so 批次4 wires the planner once).
 * Only the primitives are required; everything else has production defaults.
 */
export interface PlanDeps {
  db: DbOrTx;
  /** Wall clock — sampled ONCE per plan so every stage judges the same instant. */
  now: () => Date;
  /** Uniform RNG in [0,1) — sort randomization + credential rotation + wait jitter. */
  rng: () => number;
  /** Fixed-window per-minute limiter (infra primitive; Redis in production). */
  limiter: RateLimiter;
  /** Concurrency primitive backing the §7.8 dual semaphore. */
  concurrency: ConcurrencyLimiter;
  /** Injected sleep for the bounded semaphore wait; absent → real setTimeout. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Millisecond clock for wait/queue budgets; absent → Date.now. */
  nowMs?: (() => number) | undefined;
  /** Default per-minute caps; absent → 600/120 (production defaults). */
  rateDefaults?: { tenantRpm: number; keyRpm: number } | undefined;
  /**
   * Model global-gate cap resolver (§9.1 layer 3). Absent → no model gate:
   * where the cap comes from in the new world (supply_model 对外限额) is 批次4
   * wiring, so the default resolver answers `null` (= gate not configured).
   */
  resolveModelLimit?: ModelLimitResolver | undefined;
  /** §3 auto-upgrade knobs (dynamic-config resolved by the caller). */
  settings?: ParadigmSettings | undefined;
  /** Effective breaker thresholds (§2.5); absent → DEFAULT_BREAKER_CONFIG. */
  breakerConfig?: BreakerConfig | undefined;
  waitBaseDelayMs?: number | undefined;
  waitMaxDelayMs?: number | undefined;
  /** Injectable query fakes (tests); production omits and gets the real repos. */
  queries?: Partial<PlanQueries> | undefined;
  /** Injectable ledger surface (tests); production omits → account.ts/sub-account.ts. */
  accounting?: Partial<GateAccounting> | undefined;
}

/**
 * One plan request: the frozen GatewayRequest plus the orchestration inputs
 * the §7.8 gate needs (accountId is auth-derived; rules/modifiers/estimates
 * are the caller's resolutions — 批次4 wiring).
 */
export interface PlanExecutionInput {
  request: GatewayRequest;
  /** The tenant pool account the hold lands on (auth-derived). */
  accountId: string;
  /** The key's own per-minute override (api_key.rate_limit); null/absent → default. */
  keyRpm?: number | null | undefined;
  /** Resolved limit-plan rules (rpm → gate step 1; spend/tokens/requests → step 2). */
  scopedRules?: ScopedLimitRule[] | undefined;
  /** The RESOLVED sale-side modifier stack (倍率组 → 租户折扣, §9.2). */
  modifiers?: Modifier[] | undefined;
  /** Caller-estimated usage for post-timed holds (§9.2 按模型契约估算). */
  estimatedUsage?: UsageVector | undefined;
  /** Explicit hold floor override (e.g. 0n = chat's no-reservation discipline). */
  holdFloor?: MicroCredits | undefined;
  /** §7.8 per-candidate bounded semaphore wait; absent → 2s. */
  maxWaitMs?: number | undefined;
  /** Overall admission budget across all candidates; absent → 10s. */
  maxQueueMs?: number | undefined;
  /** Narrow candidates to channels bound to this route group. */
  routeGroupId?: string | undefined;
  /** §4 rule 4 filter mode; absent → 'strict'. */
  mode?: FilterMode | undefined;
  /**
   * §8 failover loop (批次4): offerings already attempted this request —
   * excluded from candidate assembly so each re-plan hop selects a fresh
   * sibling (and re-runs the FULL assemble/filter/gate pipeline, 每跳重过
   * 参数校验与映射 by construction).
   */
  excludeOfferingIds?: readonly string[] | undefined;
}

/**
 * §10 下线预告 marker: the resolved model is `deprecated` — still served, but
 * 批次4 must attach the deprecation response header / catalog marker.
 */
export interface DeprecationNotice {
  /** The model's external name (what the header names). */
  model: string;
  status: 'deprecated';
}

/** The planner's full observability trail (relay_trace fodder for 批次4). */
export interface PlanTrace {
  /** Per-offering assembly eliminations (breaker / credentials / params). */
  rejected: AssembleRejection[];
  /** Per-candidate gate-loop eliminations (credentials / semaphore / hold). */
  attempts: GateAttempt[];
}

/** A successful plan: everything 批次4 needs to dispatch upstream. */
export interface PlanSuccess {
  ok: true;
  /**
   * The §7.8 admission product: candidate + credential + held dual slot +
   * placed hold. 批次4 dispatches upstream between acquire and commit; on
   * dispatch failure it MUST call `reservation.release()` (frees both
   * semaphore dimensions + rolls back the hold — idempotent).
   */
  reservation: Reservation;
  /** §3 external shape (sync/stream/task + autoUpgraded server-side 升格). */
  paradigmPlan: ParadigmPlan;
  /** §3 fetch-strategy markers for the SELECTED offering (= reservation.fetchPlan). */
  fetchPlan: FetchPlan;
  /** §4.1 layer-2 resolution for the selected offering (canonical + upstream bags). */
  effective: EffectiveParams;
  /** billing_relevant effective canonical values — the price-card tier key. */
  billingDims: BillingDims;
  /** The resolved supply model row (status/artifact/max_run_time for 批次4). */
  model: SupplyModelRow;
  /** Present iff the model is `deprecated` (§10 — attach the 预告 header). */
  deprecation?: DeprecationNotice | undefined;
  /** Lenient-mode drop echoes (§4 rule 4) — empty in strict mode. */
  warnings: GatewayWarning[];
  trace: PlanTrace;
}

/** A failed plan: the normalized GatewayError of whichever stage refused. */
export interface PlanFailure {
  ok: false;
  error: GatewayError;
  /** Still present on failure when the model resolved as `deprecated` (§10). */
  deprecation?: DeprecationNotice | undefined;
  warnings: GatewayWarning[];
  trace: PlanTrace;
}

export type PlanResult = PlanSuccess | PlanFailure;

/**
 * THE planner entry (批次3 收口): compose slices 1/2/3a/3b into one
 * request-scoped plan. Pure composition — every decision below is delegated to
 * the module that owns it; failure at ANY stage short-circuits into a
 * PlanFailure carrying that stage's verbatim GatewayError plus the
 * observability trail accumulated so far. No upstream I/O happens here, and on
 * the failure path no ledger residue survives (§7.8 — the gate rolls back its
 * own partial acquisitions before answering an error).
 */
export async function planExecution(
  deps: PlanDeps,
  input: PlanExecutionInput,
): Promise<PlanResult> {
  const { request } = input;
  const resolveModel =
    deps.queries?.resolveSupplyModelByNameForTenant ?? resolveSupplyModelByNameForTenant;
  // One instant per plan: assembly (breaker eligibility / credential cooldown)
  // and the gate (hold bookkeeping) judge the same clock sample.
  const now = deps.now();

  // ── 1. §2.1/§10 visibility-gated model resolution. Unknown, ungranted,
  //       draft and disabled are all the SAME answer (model_not_found — an
  //       ungranted model is indistinguishable from a missing one); a
  //       deprecated model resolves and is marked for the 预告 header. ───────
  const model = await resolveModel(deps.db, request.model, request.tenantId);
  if (model === undefined) {
    return failure(
      {
        code: 'model_not_found',
        message: `model '${request.model}' does not exist or is not available`,
        retryable: false,
        failover: false,
      },
      undefined,
    );
  }
  const deprecation: DeprecationNotice | undefined =
    model.status === 'deprecated' ? { model: model.name, status: 'deprecated' } : undefined;

  // ── 2. operation ∈ model.operations (对外范式挂模型). Checked here so the
  //       §3 paradigm planning below can never throw on an undeclared op. ────
  const op = model.operations.find((o) => o.operation === request.operation);
  if (op === undefined) {
    return failure(
      {
        code: 'invalid_input',
        message: `model '${model.name}' does not expose operation '${request.operation}'`,
        retryable: false,
        failover: false,
      },
      deprecation,
    );
  }

  // ── 3. §3 external paradigm (model-side ONLY; never reads a fetch_profile). ─
  const paradigmPlan = planParadigm({
    operation: request.operation,
    model,
    requestedStream: request.options.stream ?? false,
    settings: deps.settings,
  });

  // ── 4. §8/§4 candidate assembly (slice 3a): enabled × BYOK × tag pin ×
  //       §3 servability (paradigm×fetch, isServable — an unservable pairing
  //       never enters the set, so it can never hold-and-bounce) × breaker ×
  //       pool × param filter. Its errors pass through VERBATIM. ─────────────
  const assembled = await assembleCandidates(
    { db: deps.db, now: () => now, queries: deps.queries },
    {
      operation: request.operation,
      model,
      requestParams: request.params,
      tenantId: request.tenantId,
      routeTag: request.options.routeTag,
      routeGroupId: input.routeGroupId,
      mode: input.mode,
      breakerConfig: deps.breakerConfig,
      excludeOfferingIds: input.excludeOfferingIds,
      externalParadigm: paradigmPlan.externalParadigm,
    },
  );
  if (assembled.error !== undefined) {
    return failure(assembled.error, deprecation, assembled.warnings, assembled.rejected);
  }
  if (assembled.candidates.length === 0) {
    // The model is visible but NOTHING can serve it right now (no enabled
    // offering, every breaker open, every pool cold …) — a supply-side outage,
    // not a caller mistake: retryable, no failover (there is nowhere to go).
    return failure(
      {
        code: 'upstream_error',
        message: `no routable supply offering for model '${model.name}'`,
        retryable: true,
        failover: false,
        details: { rejected: assembled.rejected },
      },
      deprecation,
      assembled.warnings,
      assembled.rejected,
    );
  }

  // ── 5. §8 ordering: tier desc + recoverable-fetch sub-tier + weighted rng. ─
  const sorted = sortCandidates(assembled.candidates, { rng: deps.rng });

  // ── 6. §7.8 execution gates (slice 3b): limits → read-only quota precheck →
  //       model gate → credential pool → dual semaphore → hold → Reservation. ─
  const gate = await runExecutionGates(
    {
      db: deps.db,
      limiter: deps.limiter,
      concurrency: deps.concurrency,
      sleep: deps.sleep ?? sleepReal,
      nowMs: deps.nowMs ?? Date.now,
      rateDefaults: deps.rateDefaults ?? DEFAULT_RATE_DEFAULTS,
      resolveModelLimit: deps.resolveModelLimit ?? resolveNoModelLimit,
      waitBaseDelayMs: deps.waitBaseDelayMs,
      waitMaxDelayMs: deps.waitMaxDelayMs,
      queries: deps.queries,
      accounting: deps.accounting,
    },
    {
      sortedCandidates: sorted,
      tenantId: request.tenantId,
      accountId: input.accountId,
      subjectId: request.subjectId ?? null,
      apiKeyId: request.apiKeyId,
      keyRpm: input.keyRpm,
      model: {
        id: model.id,
        name: model.name,
        priceCardId: model.priceCardId,
        modifierGroupId: model.modifierGroupId,
      },
      scopedRules: input.scopedRules ?? [],
      modifiers: input.modifiers,
      estimatedUsage: input.estimatedUsage,
      holdFloor: input.holdFloor,
      paradigmPlan,
      maxWaitMs: input.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
      maxQueueMs: input.maxQueueMs ?? DEFAULT_MAX_QUEUE_MS,
      now,
      rng: deps.rng,
    },
  );
  if (gate.reservation === undefined) {
    return failure(
      gate.error ?? {
        // Unreachable by the gate's contract (it always answers one of the
        // two) — defensive so a PlanFailure can never carry a missing error.
        code: 'internal_error',
        message: 'execution gate answered neither a reservation nor an error',
        retryable: false,
        failover: false,
      },
      deprecation,
      assembled.warnings,
      assembled.rejected,
      gate.attempts,
    );
  }

  // ── 7. the plan. fetchPlan is the gate's own post-reservation derivation
  //       (single computation, after the slot+hold are secured — 你择稳). ────
  const reservation = gate.reservation;
  return {
    ok: true,
    reservation,
    paradigmPlan,
    fetchPlan: reservation.fetchPlan,
    effective: reservation.candidate.effective,
    billingDims: reservation.candidate.billingDims,
    model,
    deprecation,
    warnings: assembled.warnings,
    trace: { rejected: assembled.rejected, attempts: gate.attempts },
  };
}

/** Shape a stage refusal into a PlanFailure (trail defaults to empty). */
function failure(
  error: GatewayError,
  deprecation: DeprecationNotice | undefined,
  warnings: GatewayWarning[] = [],
  rejected: AssembleRejection[] = [],
  attempts: GateAttempt[] = [],
): PlanFailure {
  return { ok: false, error, deprecation, warnings, trace: { rejected, attempts } };
}

/** Production default sleep for the bounded semaphore wait. */
function sleepReal(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default model-limit resolver: no global gate configured (批次4 wires the real cap source). */
function resolveNoModelLimit(): Promise<number | null> {
  return Promise.resolve(null);
}
