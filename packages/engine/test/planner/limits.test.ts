// §9.1 layers 1–3 gate-function unit tests (批次3 slice 3b). Locks the
// red-line purity contract: the quota precheck is STRICTLY read-only (zero db
// writes, zero `requests` incr) and every gate rejects without touching the
// ledger — the db handed in is POISONED and throws on any direct use.
import type { DbOrTx, LimitRuleRow } from '@actionow/db';
import type { RateLimiter, RateLimitResult } from '@actionow/infra';
import { describe, expect, it } from 'vitest';

import {
  checkModelGate,
  checkRateLimit,
  createCachedModelLimitResolver,
  type LimitsDeps,
  precheckQuota,
  type ScopedLimitRule,
} from '../../src/index.js';
import { NOW, T0 } from './supply-fixtures.js';

/** Any direct db access inside a READ-ONLY gate is a red-line violation. */
const POISONED_DB = new Proxy(
  {},
  {
    get(_t, prop): never {
      throw new Error(`red-line violation: gate touched db.${String(prop)} directly`);
    },
  },
) as unknown as DbOrTx;

/** A RateLimiter fake recording every take and rejecting configured keys. */
class FakeLimiter implements RateLimiter {
  readonly takes: { key: string; limit: number }[] = [];
  constructor(private readonly rejectKeys: Set<string> = new Set()) {}

  take(key: string, limitPerMin: number): Promise<RateLimitResult> {
    this.takes.push({ key, limit: limitPerMin });
    if (this.rejectKeys.has(key)) return Promise.resolve({ allowed: false, retryAfterMs: 1234 });
    return Promise.resolve({ allowed: true, retryAfterMs: 0 });
  }
}

function rule(o: {
  id?: string;
  dimension: string;
  cap: bigint;
  period?: string | null;
  modelScope?: string | null;
}): LimitRuleRow {
  return {
    id: o.id ?? 'rule-1',
    planId: 'plan-1',
    dimension: o.dimension,
    period: o.period ?? null,
    cap: o.cap,
    modelScope: o.modelScope ?? null,
    alertPct: null,
    enforce: 'hard',
    createdAt: T0,
    updatedAt: T0,
  };
}

function scoped(
  r: LimitRuleRow,
  subjectType: 'key' | 'tenant' | 'subject' = 'key',
): ScopedLimitRule {
  return { rule: r, subjectType, subjectId: subjectType === 'key' ? 'key-1' : 't1' };
}

function limitsDeps(o: {
  limiter?: RateLimiter;
  getUsage?: (...args: unknown[]) => Promise<bigint>;
  windowedUsage?: (...args: unknown[]) => Promise<bigint>;
}): LimitsDeps {
  return {
    db: POISONED_DB,
    limiter: o.limiter ?? new FakeLimiter(),
    defaults: { tenantRpm: 600, keyRpm: 120 },
    queries: {
      getUsage: o.getUsage ?? (() => Promise.resolve(0n)),
      windowedUsage: o.windowedUsage ?? (() => Promise.resolve(0n)),
    },
  };
}

describe('checkRateLimit — §9.1 layer 1 (legacyRpm semantics)', () => {
  it('takes the tenant and key buckets and passes under budget', async () => {
    const limiter = new FakeLimiter();
    const verdict = await checkRateLimit(limitsDeps({ limiter }), {
      tenantId: 't1',
      apiKeyId: 'key-1',
    });
    expect(verdict.ok).toBe(true);
    expect(limiter.takes.map((t) => t.key)).toEqual(['rl:tenant:t1', 'rl:key:t1:key-1']);
    expect(limiter.takes[1]?.limit).toBe(120); // default keyRpm
  });

  it("the key's own rate_limit overrides the default key cap", async () => {
    const limiter = new FakeLimiter();
    await checkRateLimit(limitsDeps({ limiter }), { tenantId: 't1', apiKeyId: 'key-1', keyRpm: 7 });
    expect(limiter.takes.find((t) => t.key === 'rl:key:t1:key-1')?.limit).toBe(7);
  });

  it('tenant bucket breach → rate_limited carrying retryAfterMs', async () => {
    const limiter = new FakeLimiter(new Set(['rl:tenant:t1']));
    const verdict = await checkRateLimit(limitsDeps({ limiter }), {
      tenantId: 't1',
      apiKeyId: 'key-1',
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.error.code).toBe('rate_limited');
      expect(verdict.error.retryAfterMs).toBe(1234);
    }
  });

  it('enforces rpm-dimension plan rules (scoped bucket) and skips other dimensions', async () => {
    const limiter = new FakeLimiter(new Set(['gl:rpm:key:key-1:rule-rpm']));
    const rules = [
      scoped(rule({ id: 'rule-rpm', dimension: 'rpm', cap: 10n })),
      scoped(rule({ id: 'rule-spend', dimension: 'spend', cap: 10n })), // not layer 1
    ];
    const verdict = await checkRateLimit(limitsDeps({ limiter }), {
      tenantId: 't1',
      apiKeyId: 'key-1',
      scopedRules: rules,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error.code).toBe('rate_limited');
    expect(limiter.takes.find((t) => t.key === 'gl:rpm:key:key-1:rule-rpm')?.limit).toBe(10);
    expect(limiter.takes.some((t) => t.key.includes('rule-spend'))).toBe(false);
  });

  it('a model-scoped rpm rule for ANOTHER model is skipped', async () => {
    const limiter = new FakeLimiter();
    await checkRateLimit(limitsDeps({ limiter }), {
      tenantId: 't1',
      apiKeyId: 'key-1',
      modelName: 'gpt-x',
      scopedRules: [scoped(rule({ id: 'r', dimension: 'rpm', cap: 5n, modelScope: 'other' }))],
    });
    expect(limiter.takes.some((t) => t.key.startsWith('gl:rpm:'))).toBe(false);
  });
});

describe('precheckQuota — §7.8 step 2, STRICTLY read-only (red line)', () => {
  it('under-cap spend/tokens/requests pass with ONLY reads — zero db writes, zero incr', async () => {
    const reads: string[] = [];
    const deps = limitsDeps({
      getUsage: () => {
        reads.push('getUsage');
        return Promise.resolve(4n);
      },
      windowedUsage: () => {
        reads.push('windowedUsage');
        return Promise.resolve(4n);
      },
    });
    const verdict = await precheckQuota(deps, {
      scopedRules: [
        scoped(rule({ id: 'r1', dimension: 'spend', cap: 100n, period: 'day' })),
        scoped(rule({ id: 'r2', dimension: 'requests', cap: 100n })),
        scoped(rule({ id: 'r3', dimension: 'tokens', cap: 100n, period: 'rolling_24h' })),
      ],
      model: 'gpt-x',
      now: NOW,
    });
    expect(verdict.ok).toBe(true);
    // The ONLY observable effects are the three usage READS. The poisoned db
    // guarantees no direct write slipped through; `requests` was NOT
    // incremented (no incrUsage exists on this surface at all).
    expect(reads).toEqual(['getUsage', 'getUsage', 'windowedUsage']);
  });

  it('an at-cap requests bucket rejects with insufficient_credits WITHOUT incrementing', async () => {
    const reads: string[] = [];
    const deps = limitsDeps({
      getUsage: () => {
        reads.push('getUsage');
        return Promise.resolve(100n);
      },
    });
    const verdict = await precheckQuota(deps, {
      scopedRules: [scoped(rule({ dimension: 'requests', cap: 100n }))],
      now: NOW,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error.code).toBe('insufficient_credits');
    expect(reads).toEqual(['getUsage']); // read-compare only, never check-then-incr
  });

  it('rolling windows aggregate via windowedUsage with the correct since instant', async () => {
    let since: Date | undefined;
    const deps = limitsDeps({
      windowedUsage: (_db: unknown, opts: unknown) => {
        since = (opts as { since: Date }).since;
        return Promise.resolve(999n);
      },
    });
    const verdict = await precheckQuota(deps, {
      scopedRules: [scoped(rule({ dimension: 'spend', cap: 500n, period: 'rolling_24h' }))],
      now: NOW,
    });
    expect(verdict.ok).toBe(false);
    expect(since?.getTime()).toBe(NOW.getTime() - 86_400_000);
  });

  it('P5b 层2 闭环: a settle-accrued spend bucket (getUsage reflects the NEW-FACE limit_usage incr) at/over cap rejects the next request', async () => {
    // The settle side (settleGatewayTask + usageLog envelope) accrued two
    // 1500µ settles into the tenant spend bucket — the SAME limit_usage row
    // getUsage reads here (task-settle-accrual.int.test.ts proves the write).
    const deps = limitsDeps({ getUsage: () => Promise.resolve(3_000n) });
    const verdict = await precheckQuota(deps, {
      scopedRules: [scoped(rule({ dimension: 'spend', cap: 2_000n, period: 'month' }), 'tenant')],
      now: NOW,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.error.code).toBe('insufficient_credits');
      expect(verdict.error.details).toMatchObject({ dimension: 'spend', subjectType: 'tenant' });
    }
  });

  it('rpm and concurrency dimensions are not this gate’s concern', async () => {
    const reads: string[] = [];
    const deps = limitsDeps({
      getUsage: () => {
        reads.push('getUsage');
        return Promise.resolve(999n);
      },
    });
    const verdict = await precheckQuota(deps, {
      scopedRules: [
        scoped(rule({ id: 'r1', dimension: 'rpm', cap: 1n })),
        scoped(rule({ id: 'r2', dimension: 'concurrency', cap: 1n })),
      ],
      now: NOW,
    });
    expect(verdict.ok).toBe(true);
    expect(reads).toEqual([]);
  });
});

describe('checkModelGate — §7.8 step 3 (30s cached resolver semantics)', () => {
  it('null cap = no gate (no bucket take)', async () => {
    const limiter = new FakeLimiter();
    const verdict = await checkModelGate(
      { limiter, resolveModelLimit: () => Promise.resolve(null) },
      { modelName: 'gpt-x' },
    );
    expect(verdict.ok).toBe(true);
    expect(limiter.takes).toEqual([]);
  });

  it('a configured cap gates through the global per-model bucket', async () => {
    const limiter = new FakeLimiter(new Set(['rl:model:gpt-x']));
    const verdict = await checkModelGate(
      { limiter, resolveModelLimit: () => Promise.resolve(30) },
      { modelName: 'gpt-x' },
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error.code).toBe('rate_limited');
    expect(limiter.takes).toEqual([{ key: 'rl:model:gpt-x', limit: 30 }]);
  });

  it('createCachedModelLimitResolver caches for the TTL and refetches after', async () => {
    let clock = 0;
    let fetches = 0;
    const resolver = createCachedModelLimitResolver({
      fetch: () => {
        fetches += 1;
        return Promise.resolve(42);
      },
      ttlMs: 30_000,
      nowMs: () => clock,
    });
    await resolver('gpt-x');
    await resolver('gpt-x'); // within TTL → cached
    expect(fetches).toBe(1);
    clock = 30_001;
    await resolver('gpt-x'); // TTL elapsed → refetch
    expect(fetches).toBe(2);
  });
});
