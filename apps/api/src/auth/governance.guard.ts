import {
  type Database,
  getModelRateLimit,
  getUsage,
  incrUsage,
  type LimitRuleRow,
  periodKeyFor,
  periodStartFor,
  resolveEffectiveRules,
  windowedUsage,
} from '@actionow/db';
import type { AppEnv, ConcurrencyLimiter, RateLimiter, RateLimitResult } from '@actionow/infra';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';

import { engineLimitExceeded, engineRateLimited, engineUnauthorized } from '../common/errors.js';
import { CONCURRENCY_LIMITER, DB, ENV, RATE_LIMITER } from '../common/tokens.js';
import type { AuthedRequest } from './api-key.guard.js';

/** TTL (ms) for the per-model rate-limit cache (legacy bucket). */
const MODEL_LIMIT_CACHE_TTL_MS = 30_000;
/** TTL (ms) for the per-key/tenant effective-rules cache. */
const RULES_CACHE_TTL_MS = 15_000;
const ROLLING_MS: Record<string, number> = { rolling_24h: 86_400_000, rolling_30d: 2_592_000_000 };

/** A plan rule tagged with the subject it counts against. */
interface ScopedRule {
  rule: LimitRuleRow;
  subjectType: 'key' | 'tenant';
  subjectId: string;
}

/**
 * Governance & limits enforcement (额度套餐). Runs AFTER {@link ApiKeyGuard} on
 * the relay routes, SUBSUMING the old `RateLimitGuard`:
 *
 * 1. The legacy per-minute RPM buckets (per-tenant, per-(tenant,resource)=key
 *    `rateLimit`, per-(tenant,model)) are preserved verbatim — zero behavior
 *    change when no limit plan is bound.
 * 2. Then the effective `limit_plan` rules — the key's plan (counted per key) ∪
 *    the tenant's plan (counted per tenant) — are enforced: `rpm` (Redis window),
 *    `concurrency` (Redis in-flight, released on response finish), `requests`
 *    (period counter, check-then-incr), and `spend`/`tokens` (pre-check the
 *    period total; accrued at settle). Calendar/total periods read `limit_usage`;
 *    rolling windows aggregate `usage_log`. Breaches throw 429 (rpm/concurrency)
 *    or 402 (requests/tokens/spend).
 */
@Injectable()
export class GovernanceGuard implements CanActivate {
  private readonly modelLimitCache = new Map<string, { limit: number | null; expiresAt: number }>();
  private readonly rulesCache = new Map<string, { rules: ScopedRule[]; expiresAt: number }>();

  constructor(
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(CONCURRENCY_LIMITER) private readonly concurrency: ConcurrencyLimiter,
    @Inject(ENV) private readonly env: AppEnv,
    @Inject(DB) private readonly db: Database,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const res = context.switchToHttp().getResponse<Response>();
    const auth = req.auth;
    if (auth === undefined) throw engineUnauthorized('request is not authenticated');

    const modelName = this.readModelName(req);

    // 1) Legacy RPM buckets (unchanged behavior).
    await this.legacyRpm(auth.tenantId, auth.rateLimit, this.resourceId(req), modelName);

    // 2) Plan rules. Non-concurrency first; acquire concurrency slots last so a
    //    later rejection never leaves a slot held.
    const rules = await this.effectiveRules(auth);
    const applicable = rules.filter(
      (s) => s.rule.modelScope === null || s.rule.modelScope === modelName,
    );
    const now = new Date();
    for (const s of applicable) {
      if (s.rule.dimension === 'concurrency') continue;
      await this.enforceCounter(s, modelName, now);
    }
    await this.enforceConcurrency(
      applicable.filter((s) => s.rule.dimension === 'concurrency'),
      res,
    );
    return true;
  }

  // ── legacy RPM (verbatim from RateLimitGuard) ────────────────────────────

  private async legacyRpm(
    tenantId: string,
    keyRateLimit: number | null,
    resourceId: string,
    modelName: string | undefined,
  ): Promise<void> {
    const tenantLimit = this.env.RATE_LIMIT_TENANT_PER_MIN;
    const resourceLimit = keyRateLimit ?? this.env.RATE_LIMIT_RESOURCE_PER_MIN;
    const [tenantResult, resourceResult] = await Promise.all([
      this.limiter.take(`rl:tenant:${tenantId}`, tenantLimit),
      this.limiter.take(`rl:resource:${tenantId}:${resourceId}`, resourceLimit),
    ]);
    this.assertRate(tenantResult, 'tenant rate limit exceeded');
    this.assertRate(resourceResult, 'resource rate limit exceeded');
    if (modelName !== undefined) {
      const modelLimit = await this.resolveModelLimit(modelName);
      if (modelLimit !== null) {
        const r = await this.limiter.take(`rl:model:${tenantId}:${modelName}`, modelLimit);
        this.assertRate(r, `model '${modelName}' rate limit exceeded`);
      }
    }
  }

  // ── plan rule enforcement ─────────────────────────────────────────────────

  /** rpm / requests / tokens / spend for one scoped rule. */
  private async enforceCounter(
    s: ScopedRule,
    modelName: string | undefined,
    now: Date,
  ): Promise<void> {
    const { rule, subjectType, subjectId } = s;
    const cap = rule.cap;
    const scope = rule.modelScope ?? '';
    const tag = `${subjectType}:${subjectId}:${rule.id}`;

    if (rule.dimension === 'rpm') {
      const r = await this.limiter.take(`gl:rpm:${tag}`, Number(cap));
      this.assertRate(r, `rpm limit exceeded`);
      return;
    }

    const period = rule.period ?? 'total';
    if (period === 'rolling_24h' || period === 'rolling_30d') {
      const since = new Date(now.getTime() - (ROLLING_MS[period] ?? 0));
      const used = await windowedUsage(this.db, {
        subjectType,
        subjectId,
        dimension: rule.dimension,
        since,
        modelScope: rule.modelScope,
      });
      if (used >= cap) throw engineLimitExceeded(this.msg(rule));
      return;
    }

    // Calendar / total (materialized in limit_usage).
    const key = {
      subjectType,
      subjectId,
      dimension: rule.dimension,
      periodKey: periodKeyFor(period, now),
      modelScope: scope,
    };
    if (rule.dimension === 'requests') {
      // Known at request time → check-then-incr (one request consumes one count).
      const used = await getUsage(this.db, key);
      if (used >= cap) throw engineLimitExceeded(this.msg(rule));
      await incrUsage(this.db, key, 1n, periodStartFor(period, now));
      return;
    }
    // spend / tokens — value known only at settle → pre-check the period total.
    const used = await getUsage(this.db, key);
    if (used >= cap) throw engineLimitExceeded(this.msg(rule));
  }

  /** Acquire all concurrency slots; release every slot on response finish/close. */
  private async enforceConcurrency(rules: ScopedRule[], res: Response): Promise<void> {
    const releases: (() => Promise<void>)[] = [];
    const releaseAll = (): void => {
      for (const r of releases) void r();
    };
    for (const s of rules) {
      const slot = await this.concurrency.acquire(
        `gl:conc:${s.subjectType}:${s.subjectId}:${s.rule.id}`,
        Number(s.rule.cap),
      );
      if (!slot.ok) {
        releaseAll();
        throw engineRateLimited('concurrency limit exceeded', 0);
      }
      releases.push(slot.release);
    }
    if (releases.length > 0) {
      res.once('finish', releaseAll);
      res.once('close', releaseAll);
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async effectiveRules(auth: NonNullable<AuthedRequest['auth']>): Promise<ScopedRule[]> {
    const cacheKey = `${auth.apiKeyId ?? 'dev'}:${auth.tenantId}`;
    const now = Date.now();
    const cached = this.rulesCache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > now) return cached.rules;

    const [keyRules, tenantRules] = await Promise.all([
      auth.limitPlanId !== null
        ? resolveEffectiveRules(this.db, auth.limitPlanId, null)
        : Promise.resolve([] as LimitRuleRow[]),
      auth.tenantLimitPlanId !== null
        ? resolveEffectiveRules(this.db, auth.tenantLimitPlanId, null)
        : Promise.resolve([] as LimitRuleRow[]),
    ]);
    const keyId = auth.apiKeyId;
    const scoped: ScopedRule[] = [
      ...(keyId !== null
        ? keyRules.map((rule) => ({ rule, subjectType: 'key' as const, subjectId: keyId }))
        : []),
      ...tenantRules.map((rule) => ({
        rule,
        subjectType: 'tenant' as const,
        subjectId: auth.tenantId,
      })),
    ];
    this.rulesCache.set(cacheKey, { rules: scoped, expiresAt: now + RULES_CACHE_TTL_MS });
    return scoped;
  }

  private msg(rule: LimitRuleRow): string {
    const what = rule.dimension === 'spend' ? 'budget' : `${rule.dimension} quota`;
    return `${what} exceeded${rule.period !== null ? ` (${rule.period})` : ''}`;
  }

  private resourceId(req: AuthedRequest): string {
    return (req.params as Record<string, string | undefined>).resourceId ?? '_';
  }

  private readModelName(req: AuthedRequest): string | undefined {
    const body = req.body as { model?: unknown } | undefined;
    const model = body?.model;
    return typeof model === 'string' && model.length > 0 ? model : undefined;
  }

  private async resolveModelLimit(name: string): Promise<number | null> {
    const now = Date.now();
    const cached = this.modelLimitCache.get(name);
    if (cached !== undefined && cached.expiresAt > now) return cached.limit;
    const limit = await getModelRateLimit(this.db, name);
    this.modelLimitCache.set(name, { limit, expiresAt: now + MODEL_LIMIT_CACHE_TTL_MS });
    return limit;
  }

  private assertRate(result: RateLimitResult, message: string): void {
    if (!result.allowed) throw engineRateLimited(message, result.retryAfterMs);
  }
}
