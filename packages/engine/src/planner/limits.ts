// packages/engine/src/planner/limits.ts
//
// model-supply-greenfield 批次3 slice 3b — §9.1 限流四层's first THREE layers
// (租户/key 限流 → 额度预检 → 模型全局闸) as ORCHESTRATABLE gate functions.
//
// PROVENANCE: the algorithms are ported from the proven
// apps/api/src/auth/governance.guard.ts (legacyRpm / enforceCounter's
// read-only spend-tokens branch / resolveModelLimit's 30s cache) with the
// NestJS shell stripped — no ExecutionContext, no req/res, no DI decorators;
// deps (RateLimiter / db / query fns) are explicit. The RATE-LIMIT PRIMITIVES
// themselves (fixed-window RateLimiter.take) are REUSED from
// packages/infra/rate-limit.ts, never re-implemented.
//
// PURITY CONTRACT (§7.8 hard red line — 交接卡死胡同 #3): none of these three
// functions touches the credit ledger, places a hold, or increments a
// `requests` usage counter. `precheckQuota` is STRICTLY read-only
// (getUsage/windowedUsage compares only — the counting/accrual happens at
// settle, 批次4); the RPM token-bucket `take` is a rate-limit primitive, not
// ledger accounting. A rejection from any of these gates therefore leaves
// ZERO accounting traces.
//
// §9.1 note on TPM: as in the production GovernanceGuard, there is no
// per-minute TOKEN bucket primitive — token caps are `tokens`-dimension plan
// rules enforced by the read-only quota precheck (accrued at settle), while
// per-minute REQUEST caps ride the RateLimiter buckets here.
import type { GatewayError } from '@actionow/contracts';
import type { DbOrTx, LimitRuleRow } from '@actionow/db';
import { getUsage, periodKeyFor, windowedUsage } from '@actionow/db';
import type { RateLimiter, RateLimitResult } from '@actionow/infra';

/** The verdict every gate function answers: pass, or a normalized GatewayError. */
export type GateVerdict = { ok: true } | { ok: false; error: GatewayError };

/** The shared pass verdict (gate functions return this exact object on success). */
export const GATE_OK: GateVerdict = { ok: true };

/** Rolling-window lengths (ms) — mirrors governance.guard.ts `ROLLING_MS`. */
const ROLLING_MS: Record<string, number> = { rolling_24h: 86_400_000, rolling_30d: 2_592_000_000 };

/**
 * A plan rule tagged with the subject it counts against (key / tenant /
 * subject) — the exact `ScopedRule` shape governance.guard.ts resolves via
 * `resolveEffectiveRules`; the CALLER resolves and scopes rules (批次4 wiring),
 * these gates only enforce.
 */
export interface ScopedLimitRule {
  rule: LimitRuleRow;
  subjectType: 'key' | 'tenant' | 'subject';
  subjectId: string;
}

/** The read-only usage queries the quota precheck consumes (injectable for tests). */
export interface LimitsQueries {
  getUsage: typeof getUsage;
  windowedUsage: typeof windowedUsage;
}

/** Dependencies for {@link checkRateLimit} / {@link precheckQuota}. */
export interface LimitsDeps {
  db: DbOrTx;
  /** The infra fixed-window per-minute limiter (RateLimiter.take) — REUSED primitive. */
  limiter: RateLimiter;
  /**
   * Default per-minute caps when the key carries none — the caller resolves
   * them from dynamic config (RATE_LIMIT_TENANT_PER_MIN / …_RESOURCE_PER_MIN
   * semantics), exactly as GovernanceGuard.legacyRpm did via SettingsService.
   */
  defaults: { tenantRpm: number; keyRpm: number };
  queries?: Partial<LimitsQueries> | undefined;
}

export interface CheckRateLimitInput {
  tenantId: string;
  /** null = console/dev auth without a key row — the key bucket falls back to `_`. */
  apiKeyId: string | null;
  /** The key's own per-minute override (api_key.rate_limit); null/absent → default. */
  keyRpm?: number | null | undefined;
  /** The external model name — narrows model-scoped `rpm` plan rules only. */
  modelName?: string | undefined;
  /**
   * Optional `rpm`-dimension plan rules (enforceCounter's rpm branch). Other
   * dimensions are IGNORED here — spend/tokens/requests belong to
   * {@link precheckQuota}, concurrency to the §7.8 semaphore.
   */
  scopedRules?: ScopedLimitRule[] | undefined;
}

/**
 * §9.1 layer 1 — 租户/key 限流 (legacyRpm semantics, governance.guard.ts L97):
 * a per-tenant fixed-window RPM bucket + a per-(tenant,key) bucket (the key's
 * own `rate_limit` overriding the default), plus any `rpm`-dimension plan
 * rules. Rejection → `rate_limited` with `retryAfterMs` (§9.3 Retry-After).
 * Token-bucket takes only — never a ledger/usage write.
 */
export async function checkRateLimit(
  deps: LimitsDeps,
  input: CheckRateLimitInput,
): Promise<GateVerdict> {
  const keyLimit = input.keyRpm ?? deps.defaults.keyRpm;
  // Tenant + key buckets in parallel — verbatim legacyRpm shape.
  const [tenantResult, keyResult] = await Promise.all([
    deps.limiter.take(`rl:tenant:${input.tenantId}`, deps.defaults.tenantRpm),
    deps.limiter.take(`rl:key:${input.tenantId}:${input.apiKeyId ?? '_'}`, keyLimit),
  ]);
  const tenantVerdict = rateVerdict(tenantResult, 'tenant rate limit exceeded');
  if (!tenantVerdict.ok) return tenantVerdict;
  const keyVerdict = rateVerdict(keyResult, 'api key rate limit exceeded');
  if (!keyVerdict.ok) return keyVerdict;

  // Plan-rule rpm buckets (enforceCounter's rpm branch, governance.guard.ts L137).
  for (const s of input.scopedRules ?? []) {
    if (s.rule.dimension !== 'rpm') continue;
    if (s.rule.modelScope !== null && s.rule.modelScope !== input.modelName) continue;
    const tag = `${s.subjectType}:${s.subjectId}:${s.rule.id}`;
    const r = await deps.limiter.take(`gl:rpm:${tag}`, Number(s.rule.cap));
    const verdict = rateVerdict(r, 'rpm limit exceeded');
    if (!verdict.ok) return verdict;
  }
  return GATE_OK;
}

export interface PrecheckQuotaInput {
  scopedRules: ScopedLimitRule[];
  /** The external model name — narrows model-scoped rules (`modelScope` match). */
  model?: string | undefined;
  now: Date;
}

/**
 * §9.1 layer 2 / §7.8 step 2 — 额度预检, STRICTLY READ-ONLY (hard red line):
 * `spend` / `tokens` / `requests` plan rules are compared against their
 * accumulated usage (calendar/total via `getUsage`, rolling via
 * `windowedUsage`) and ANY at-or-over-cap bucket rejects with
 * `insufficient_credits` — but nothing is written: no `incrUsage` (the
 * governance guard's check-then-incr for `requests` is deliberately split;
 * the incr happens at settle/dispatch accounting, 批次4), no limit alerts, no
 * ledger. §7.8: the precheck runs BEFORE the model gate / semaphore / hold so
 * a 429/402 storm never touches the books (交接卡死胡同 #3).
 *
 * `rpm` rules belong to {@link checkRateLimit}; `concurrency` rules to the
 * §7.8 (offering, credential) semaphore — both are skipped here.
 */
export async function precheckQuota(
  deps: LimitsDeps,
  input: PrecheckQuotaInput,
): Promise<GateVerdict> {
  const q: LimitsQueries = {
    getUsage: deps.queries?.getUsage ?? getUsage,
    windowedUsage: deps.queries?.windowedUsage ?? windowedUsage,
  };
  for (const s of input.scopedRules) {
    const { rule, subjectType, subjectId } = s;
    if (rule.dimension !== 'spend' && rule.dimension !== 'tokens' && rule.dimension !== 'requests')
      continue;
    if (rule.modelScope !== null && rule.modelScope !== input.model) continue;

    const period = rule.period ?? 'total';
    let used: bigint;
    if (period === 'rolling_24h' || period === 'rolling_30d') {
      const since = new Date(input.now.getTime() - (ROLLING_MS[period] ?? 0));
      used = await q.windowedUsage(deps.db, {
        subjectType,
        subjectId,
        dimension: rule.dimension,
        since,
        modelScope: rule.modelScope,
      });
    } else {
      used = await q.getUsage(deps.db, {
        subjectType,
        subjectId,
        dimension: rule.dimension,
        periodKey: periodKeyFor(period, input.now),
        modelScope: rule.modelScope ?? '',
      });
    }
    if (used >= rule.cap) {
      return {
        ok: false,
        error: {
          code: 'insufficient_credits',
          message: quotaMessage(rule),
          retryable: false,
          failover: false,
          details: { dimension: rule.dimension, subjectType, ruleId: rule.id },
        },
      };
    }
  }
  return GATE_OK;
}

/** Resolve a model's GLOBAL per-minute cap; `null` = no gate configured. */
export type ModelLimitResolver = (modelName: string) => Promise<number | null>;

/** Dependencies for {@link checkModelGate}. */
export interface ModelGateDeps {
  limiter: RateLimiter;
  resolveModelLimit: ModelLimitResolver;
}

/**
 * §9.1 layer 3-adjacent 模型全局闸 (§7.8 step 3): one GLOBAL fixed-window RPM
 * bucket per model, capped by the injected resolver (wrap it with
 * {@link createCachedModelLimitResolver} for the guard's 30s cache semantics —
 * governance.guard.ts resolveModelLimit L258). `null` cap = no gate. Where the
 * cap comes from in the new world (supply_model 对外限额 wiring) is the
 * CALLER's resolution, 批次4.
 */
export async function checkModelGate(
  deps: ModelGateDeps,
  input: { modelName: string },
): Promise<GateVerdict> {
  const limit = await deps.resolveModelLimit(input.modelName);
  if (limit === null) return GATE_OK;
  const r = await deps.limiter.take(`rl:model:${input.modelName}`, limit);
  return rateVerdict(r, `model '${input.modelName}' rate limit exceeded`);
}

/**
 * Wrap a raw model-limit fetch with the 30s TTL cache the guard used
 * (MODEL_LIMIT_CACHE_TTL_MS semantics). `nowMs` injectable for deterministic
 * tests.
 */
export function createCachedModelLimitResolver(opts: {
  fetch: ModelLimitResolver;
  ttlMs?: number | undefined;
  nowMs?: (() => number) | undefined;
}): ModelLimitResolver {
  const ttl = opts.ttlMs ?? 30_000;
  const nowMs = opts.nowMs ?? Date.now;
  const cache = new Map<string, { limit: number | null; expiresAt: number }>();
  return async (modelName: string): Promise<number | null> => {
    const now = nowMs();
    const cached = cache.get(modelName);
    if (cached !== undefined && cached.expiresAt > now) return cached.limit;
    const limit = await opts.fetch(modelName);
    cache.set(modelName, { limit, expiresAt: now + ttl });
    return limit;
  };
}

/** Map a RateLimiter result to a verdict (429 carries retryAfterMs — §9.3). */
function rateVerdict(result: RateLimitResult, message: string): GateVerdict {
  if (result.allowed) return GATE_OK;
  return {
    ok: false,
    error: {
      code: 'rate_limited',
      message,
      retryable: true,
      failover: false,
      retryAfterMs: result.retryAfterMs,
    },
  };
}

/** The guard's breach message shape (governance.guard.ts `msg`). */
function quotaMessage(rule: LimitRuleRow): string {
  const what = rule.dimension === 'spend' ? 'budget' : `${rule.dimension} quota`;
  return `${what} exceeded${rule.period !== null ? ` (${rule.period})` : ''}`;
}
