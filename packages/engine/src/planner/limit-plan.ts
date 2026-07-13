// packages/engine/src/planner/limit-plan.ts
//
// model-supply-greenfield 批次6 P5 — limit-plan (额度套餐) wiring for the NEW
// gateway face, in two halves:
//
//   1. resolveScopedRules — the ORCHESTRATABLE extraction of the proven
//      GovernanceGuard.effectiveRules(auth) algorithm (governance.guard.ts
//      L203): the key plan's rules counted per KEY ∪ the tenant plan's rules
//      counted per TENANT ∪ the subject plan's rules counted per SUBJECT
//      (unified tenancy G-D). NestJS shell stripped — no ExecutionContext, no
//      DI; deps are explicit and the underlying `resolveEffectiveRules` db
//      primitive is REUSED, never re-implemented. The guard itself stays
//      UNTOUCHED (双面并存: the legacy surfaces still mount it; this module
//      only feeds planExecution's §7.8 gates on the new face).
//
//   2. accrueRequestCount — the WRITE half of the guard's `requests`
//      check-then-incr, deliberately split per §7.8: the gate's precheckQuota
//      stays STRICTLY read-only (交接卡死胡同 #3), and the one-request-one-count
//      increment lands only AFTER admission fully passed and the hold is
//      placed (确定发上游后 — executeGateway calls this once per request, never
//      per §8 failover hop). Reuses incrUsage/checkLimitAlert verbatim
//      (governance.guard.ts L165-171's incr half).
import type { DbOrTx, LimitRuleRow } from '@actionow/db';
import {
  checkLimitAlert,
  incrUsage,
  periodKeyFor,
  periodStartFor,
  resolveEffectiveRules,
} from '@actionow/db';

import type { ScopedLimitRule } from './limits.js';

/** Guard-parity TTL for the per-(key,tenant,subject) effective-rules cache. */
const RULES_CACHE_TTL_MS = 15_000;

// --- resolveScopedRules (read) ------------------------------------------------------

/** The db read the resolver consumes (injectable for tests). */
export interface ScopedRulesQueries {
  resolveEffectiveRules: typeof resolveEffectiveRules;
}

/** Dependencies for {@link resolveScopedRules} — explicit, no NestJS anywhere. */
export interface ScopedRulesDeps {
  db: DbOrTx;
  queries?: Partial<ScopedRulesQueries> | undefined;
}

/**
 * The auth-derived binding triple. The PLAN IDS are inputs (not re-resolved
 * here) for exact guard parity: ApiKeyGuard already resolved
 * api_key.limit_plan_id / account.limit_plan_id / subject.limit_plan_id onto
 * the auth context, and effectiveRules(auth) consumed them as-is.
 */
export interface ScopedRulesInput {
  tenantId: string;
  /** null = console/dev auth without a key row — key-plan rules are dropped. */
  apiKeyId: string | null;
  /** The subject (end-user) the key is scoped to; null → tenant-level key. */
  subjectId?: string | null | undefined;
  /** The key's bound plan (api_key.limit_plan_id); null → no key rules. */
  keyLimitPlanId: string | null;
  /** The tenant's bound plan (account.limit_plan_id); null → no tenant rules. */
  tenantLimitPlanId: string | null;
  /** The subject's bound plan (subject.limit_plan_id); null/absent → none. */
  subjectLimitPlanId?: string | null | undefined;
}

/**
 * GovernanceGuard.effectiveRules(auth), extracted verbatim (minus the guard's
 * in-instance cache — wrap with {@link createCachedScopedRulesResolver} for
 * that): resolve each bound plan's ACTIVE rules and tag them with the subject
 * they count against. A disabled/deleted/absent plan contributes nothing
 * (resolveEffectiveRules' own filter); rules of a key plan without a real key
 * id (dev fallback) are dropped exactly like the guard's `keyId !== null`
 * branch.
 */
export async function resolveScopedRules(
  deps: ScopedRulesDeps,
  input: ScopedRulesInput,
): Promise<ScopedLimitRule[]> {
  const resolve = deps.queries?.resolveEffectiveRules ?? resolveEffectiveRules;
  const [keyRules, tenantRules, subjectRules] = await Promise.all([
    input.keyLimitPlanId !== null
      ? resolve(deps.db, input.keyLimitPlanId, null)
      : Promise.resolve([] as LimitRuleRow[]),
    input.tenantLimitPlanId !== null
      ? resolve(deps.db, input.tenantLimitPlanId, null)
      : Promise.resolve([] as LimitRuleRow[]),
    input.subjectLimitPlanId != null
      ? resolve(deps.db, input.subjectLimitPlanId, null)
      : Promise.resolve([] as LimitRuleRow[]),
  ]);
  const keyId = input.apiKeyId;
  const subjectId = input.subjectId;
  return [
    ...(keyId !== null
      ? keyRules.map((rule) => ({ rule, subjectType: 'key' as const, subjectId: keyId }))
      : []),
    ...tenantRules.map((rule) => ({
      rule,
      subjectType: 'tenant' as const,
      subjectId: input.tenantId,
    })),
    ...(subjectId != null
      ? subjectRules.map((rule) => ({ rule, subjectType: 'subject' as const, subjectId }))
      : []),
  ];
}

/** A rules resolver ready for per-request use (the caching wrapper's shape). */
export type ScopedRulesResolver = (input: ScopedRulesInput) => Promise<ScopedLimitRule[]>;

/**
 * Wrap {@link resolveScopedRules} with the guard's 15s TTL cache
 * (RULES_CACHE_TTL_MS semantics, governance.guard.ts L208): the subject is
 * PART of the cache key (unified tenancy G-D — a tenant-level key serving many
 * subjects must not serve subject A's rules to B). `nowMs` injectable for
 * deterministic tests.
 */
export function createCachedScopedRulesResolver(opts: {
  deps: ScopedRulesDeps;
  ttlMs?: number | undefined;
  nowMs?: (() => number) | undefined;
}): ScopedRulesResolver {
  const ttl = opts.ttlMs ?? RULES_CACHE_TTL_MS;
  const nowMs = opts.nowMs ?? Date.now;
  const cache = new Map<string, { rules: ScopedLimitRule[]; expiresAt: number }>();
  return async (input: ScopedRulesInput): Promise<ScopedLimitRule[]> => {
    const cacheKey = `${input.apiKeyId ?? 'dev'}:${input.tenantId}:${input.subjectId ?? ''}`;
    const now = nowMs();
    const cached = cache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > now) return cached.rules;
    const rules = await resolveScopedRules(opts.deps, input);
    cache.set(cacheKey, { rules, expiresAt: now + ttl });
    return rules;
  };
}

// --- accrueRequestCount (write — POST-admission, §7.8) --------------------------------

/** The limit_usage write surface the accrual drives (injectable for tests). */
export interface RequestAccrualWrites {
  incrUsage: typeof incrUsage;
  checkLimitAlert: typeof checkLimitAlert;
}

/** Dependencies for {@link accrueRequestCount}. */
export interface RequestAccrualDeps {
  db: DbOrTx;
  writes?: Partial<RequestAccrualWrites> | undefined;
}

export interface AccrueRequestCountInput {
  /** The SAME resolved rules the §7.8 gates consumed (one resolution per request). */
  scopedRules: ScopedLimitRule[];
  /** The external model name — narrows model-scoped rules, guard parity. */
  model?: string | undefined;
  now: Date;
}

/**
 * The `requests` dimension's one-request-one-count increment — the WRITE half
 * of GovernanceGuard.enforceCounter's check-then-incr (L165), split off so the
 * §7.8 precheck stays read-only. Semantics preserved verbatim:
 *
 * - only `requests`-dimension rules on materialized periods (day/month/total)
 *   accrue into `limit_usage` (+ threshold alert on the new total);
 * - ROLLING `requests` windows are NOT materialized — the guard counted them
 *   by reading `usage_log` (windowedUsage), so there is nothing to incr here;
 * - model-scoped rules only count requests for their model (guard's
 *   `applicable` filter).
 *
 * The CALLER's contract (executeGateway) is 确定发上游后: invoked exactly once
 * per gateway execution, after the first reservation (hold placed), never per
 * §8 failover hop and never on replay/plan-refusal paths.
 */
export async function accrueRequestCount(
  deps: RequestAccrualDeps,
  input: AccrueRequestCountInput,
): Promise<void> {
  const w: RequestAccrualWrites = {
    incrUsage: deps.writes?.incrUsage ?? incrUsage,
    checkLimitAlert: deps.writes?.checkLimitAlert ?? checkLimitAlert,
  };
  for (const s of input.scopedRules) {
    if (s.rule.dimension !== 'requests') continue;
    if (s.rule.modelScope !== null && s.rule.modelScope !== input.model) continue;
    const period = s.rule.period ?? 'total';
    if (period === 'rolling_24h' || period === 'rolling_30d') continue; // usage_log-counted
    const periodKey = periodKeyFor(period, input.now);
    const newUsed = await w.incrUsage(
      deps.db,
      {
        subjectType: s.subjectType,
        subjectId: s.subjectId,
        dimension: s.rule.dimension,
        periodKey,
        modelScope: s.rule.modelScope ?? '',
      },
      1n,
      periodStartFor(period, input.now),
    );
    await w.checkLimitAlert(deps.db, s.rule, s.subjectType, s.subjectId, periodKey, newUsed);
  }
}
