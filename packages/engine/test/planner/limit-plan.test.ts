// 批次6 P5 — limit-plan resolution + requests accrual unit tests.
//
// resolveScopedRules is the EXTRACTED GovernanceGuard.effectiveRules(auth)
// algorithm — these tests lock the guard-parity semantics (plan → tagged
// subject scoping, dev-fallback key drop, subject gating, the 15s/G-D cache);
// accrueRequestCount is the split WRITE half of the guard's requests
// check-then-incr — locked here as post-admission-only bookkeeping (calendar/
// total periods, model scoping, alert threading). The db handed in is
// POISONED: every read/write must flow through the injected fakes.
import type { DbOrTx, LimitRuleRow } from '@actionow/db';
import { describe, expect, it, vi } from 'vitest';

import {
  accrueRequestCount,
  createCachedScopedRulesResolver,
  resolveScopedRules,
  type ScopedRulesInput,
} from '../../src/index.js';
import { NOW, T0 } from './supply-fixtures.js';

/** Any direct db access is a red-line violation — everything goes through fakes. */
const POISONED_DB = new Proxy(
  {},
  {
    get(_t, prop): never {
      throw new Error(`red-line violation: limit-plan touched db.${String(prop)} directly`);
    },
  },
) as unknown as DbOrTx;

function rule(o: {
  id?: string;
  planId?: string;
  dimension?: string;
  cap?: bigint;
  period?: string | null;
  modelScope?: string | null;
  alertPct?: number | null;
}): LimitRuleRow {
  return {
    id: o.id ?? 'rule-1',
    planId: o.planId ?? 'plan-1',
    dimension: o.dimension ?? 'requests',
    period: o.period ?? null,
    cap: o.cap ?? 100n,
    modelScope: o.modelScope ?? null,
    alertPct: o.alertPct ?? null,
    enforce: 'hard',
    createdAt: T0,
    updatedAt: T0,
  };
}

/** A per-plan rules table behind a fake resolveEffectiveRules. */
function rulesByPlan(table: Record<string, LimitRuleRow[]>) {
  const calls: (string | null)[] = [];
  const tenantArgs: (string | null)[] = [];
  const fn = vi.fn((_db: DbOrTx, keyPlanId: string | null, tenantPlanId: string | null) => {
    calls.push(keyPlanId);
    tenantArgs.push(tenantPlanId);
    return Promise.resolve(keyPlanId !== null ? (table[keyPlanId] ?? []) : []);
  });
  return { fn, calls, tenantArgs };
}

const FULL_INPUT: ScopedRulesInput = {
  tenantId: 't1',
  apiKeyId: 'key-1',
  subjectId: 'subj-1',
  keyLimitPlanId: 'plan-key',
  tenantLimitPlanId: 'plan-tenant',
  subjectLimitPlanId: 'plan-subject',
};

describe('resolveScopedRules — the extracted GovernanceGuard.effectiveRules', () => {
  it('tags key/tenant/subject plan rules with their counting subject (guard parity)', async () => {
    const keyRule = rule({ id: 'rk', planId: 'plan-key', dimension: 'rpm', cap: 10n });
    const tenantRule = rule({ id: 'rt', planId: 'plan-tenant', dimension: 'spend', cap: 500n });
    const subjRule = rule({ id: 'rs', planId: 'plan-subject', dimension: 'tokens', cap: 9n });
    const { fn, tenantArgs } = rulesByPlan({
      'plan-key': [keyRule],
      'plan-tenant': [tenantRule],
      'plan-subject': [subjRule],
    });

    const scoped = await resolveScopedRules(
      { db: POISONED_DB, queries: { resolveEffectiveRules: fn } },
      FULL_INPUT,
    );

    expect(scoped).toEqual([
      { rule: keyRule, subjectType: 'key', subjectId: 'key-1' },
      { rule: tenantRule, subjectType: 'tenant', subjectId: 't1' },
      { rule: subjRule, subjectType: 'subject', subjectId: 'subj-1' },
    ]);
    // Each plan resolved through the REUSED primitive, second arg always null
    // (the guard's exact call shape).
    expect(fn).toHaveBeenCalledTimes(3);
    expect(tenantArgs).toEqual([null, null, null]);
  });

  it('null plan ids contribute nothing (no resolver call for them)', async () => {
    const { fn, calls } = rulesByPlan({ 'plan-tenant': [rule({ planId: 'plan-tenant' })] });
    const scoped = await resolveScopedRules(
      { db: POISONED_DB, queries: { resolveEffectiveRules: fn } },
      {
        tenantId: 't1',
        apiKeyId: 'key-1',
        keyLimitPlanId: null,
        tenantLimitPlanId: 'plan-tenant',
        subjectLimitPlanId: null,
      },
    );
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.subjectType).toBe('tenant');
    expect(calls).toEqual(['plan-tenant']);
  });

  it('dev fallback (apiKeyId null) drops key-plan rules exactly like the guard', async () => {
    const { fn } = rulesByPlan({ 'plan-key': [rule({ planId: 'plan-key' })] });
    const scoped = await resolveScopedRules(
      { db: POISONED_DB, queries: { resolveEffectiveRules: fn } },
      {
        tenantId: 't1',
        apiKeyId: null,
        keyLimitPlanId: 'plan-key',
        tenantLimitPlanId: null,
      },
    );
    expect(scoped).toEqual([]); // rules resolved but never tagged without a key id
  });

  it('subject rules require BOTH a subject id and a subject plan', async () => {
    const { fn } = rulesByPlan({ 'plan-subject': [rule({ planId: 'plan-subject' })] });
    const noSubjectId = await resolveScopedRules(
      { db: POISONED_DB, queries: { resolveEffectiveRules: fn } },
      {
        tenantId: 't1',
        apiKeyId: 'key-1',
        keyLimitPlanId: null,
        tenantLimitPlanId: null,
        subjectLimitPlanId: 'plan-subject',
      },
    );
    expect(noSubjectId).toEqual([]);
  });
});

describe('createCachedScopedRulesResolver — guard cache semantics (15s TTL, G-D key)', () => {
  it('caches per (key, tenant, subject) and refetches after the TTL', async () => {
    let clock = 0;
    const { fn } = rulesByPlan({ 'plan-key': [rule({ planId: 'plan-key' })] });
    const resolver = createCachedScopedRulesResolver({
      deps: { db: POISONED_DB, queries: { resolveEffectiveRules: fn } },
      ttlMs: 15_000,
      nowMs: () => clock,
    });
    const input: ScopedRulesInput = {
      tenantId: 't1',
      apiKeyId: 'key-1',
      keyLimitPlanId: 'plan-key',
      tenantLimitPlanId: null,
    };

    const first = await resolver(input);
    const second = await resolver(input); // within TTL → cached
    expect(second).toBe(first);
    expect(fn).toHaveBeenCalledTimes(1);

    clock = 15_001;
    await resolver(input); // TTL elapsed → refetch
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a DIFFERENT subject on the same key never sees the cached entry (unified tenancy G-D)', async () => {
    const { fn } = rulesByPlan({ 'plan-subject': [rule({ planId: 'plan-subject' })] });
    const resolver = createCachedScopedRulesResolver({
      deps: { db: POISONED_DB, queries: { resolveEffectiveRules: fn } },
      nowMs: () => 0,
    });
    const base: ScopedRulesInput = {
      tenantId: 't1',
      apiKeyId: 'key-1',
      keyLimitPlanId: null,
      tenantLimitPlanId: null,
      subjectLimitPlanId: 'plan-subject',
    };

    const a = await resolver({ ...base, subjectId: 'subj-A' });
    const b = await resolver({ ...base, subjectId: 'subj-B' });
    expect(a[0]?.subjectId).toBe('subj-A');
    expect(b[0]?.subjectId).toBe('subj-B');
    expect(fn).toHaveBeenCalledTimes(2); // two cache entries, never cross-served
  });
});

describe('accrueRequestCount — the split write half of check-then-incr', () => {
  // A plain sentinel (not the throwing proxy): the accrual legitimately hands
  // the db to its injected write fns, and the assertions deep-compare it.
  const SENTINEL_DB = { __sentinel: 'db' } as unknown as DbOrTx;

  function writes(newUsed = 3n) {
    return {
      incrUsage: vi.fn().mockResolvedValue(newUsed),
      checkLimitAlert: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('increments a requests/day rule by 1 and threads the new total into the alert check', async () => {
    const w = writes(7n);
    const r = rule({ id: 'r-day', dimension: 'requests', period: 'day', alertPct: 80 });
    await accrueRequestCount(
      { db: SENTINEL_DB, writes: w },
      {
        scopedRules: [{ rule: r, subjectType: 'key', subjectId: 'key-1' }],
        model: 'gpt-x',
        now: NOW,
      },
    );
    expect(w.incrUsage).toHaveBeenCalledTimes(1);
    expect(w.incrUsage).toHaveBeenCalledWith(
      SENTINEL_DB,
      {
        subjectType: 'key',
        subjectId: 'key-1',
        dimension: 'requests',
        periodKey: '2026-07-12',
        modelScope: '',
      },
      1n,
      new Date('2026-07-12T00:00:00.000Z'),
    );
    expect(w.checkLimitAlert).toHaveBeenCalledTimes(1);
    expect(w.checkLimitAlert).toHaveBeenCalledWith(
      SENTINEL_DB,
      r,
      'key',
      'key-1',
      '2026-07-12',
      7n,
    );
  });

  it('a null period counts into the `total` bucket (guard parity)', async () => {
    const w = writes();
    await accrueRequestCount(
      { db: SENTINEL_DB, writes: w },
      {
        scopedRules: [
          {
            rule: rule({ dimension: 'requests', period: null }),
            subjectType: 'tenant',
            subjectId: 't1',
          },
        ],
        now: NOW,
      },
    );
    expect(w.incrUsage.mock.calls[0]?.[1]).toMatchObject({ periodKey: 'total' });
    expect(w.incrUsage.mock.calls[0]?.[3]).toEqual(new Date(0));
  });

  it('rolling requests windows are NOT materialized — no incr (usage_log counts them)', async () => {
    const w = writes();
    await accrueRequestCount(
      { db: SENTINEL_DB, writes: w },
      {
        scopedRules: [
          {
            rule: rule({ dimension: 'requests', period: 'rolling_24h' }),
            subjectType: 'key',
            subjectId: 'key-1',
          },
        ],
        now: NOW,
      },
    );
    expect(w.incrUsage).not.toHaveBeenCalled();
    expect(w.checkLimitAlert).not.toHaveBeenCalled();
  });

  it('skips non-requests dimensions and model-scoped rules for OTHER models', async () => {
    const w = writes();
    await accrueRequestCount(
      { db: SENTINEL_DB, writes: w },
      {
        scopedRules: [
          { rule: rule({ dimension: 'spend', period: 'day' }), subjectType: 'key', subjectId: 'k' },
          { rule: rule({ dimension: 'rpm' }), subjectType: 'key', subjectId: 'k' },
          {
            rule: rule({ dimension: 'requests', period: 'day', modelScope: 'other-model' }),
            subjectType: 'key',
            subjectId: 'k',
          },
        ],
        model: 'gpt-x',
        now: NOW,
      },
    );
    expect(w.incrUsage).not.toHaveBeenCalled();
  });

  it('a model-scoped requests rule for THIS model counts under its scope key', async () => {
    const w = writes();
    await accrueRequestCount(
      { db: SENTINEL_DB, writes: w },
      {
        scopedRules: [
          {
            rule: rule({ dimension: 'requests', period: 'month', modelScope: 'gpt-x' }),
            subjectType: 'subject',
            subjectId: 'subj-1',
          },
        ],
        model: 'gpt-x',
        now: NOW,
      },
    );
    expect(w.incrUsage).toHaveBeenCalledTimes(1);
    expect(w.incrUsage).toHaveBeenCalledWith(
      SENTINEL_DB,
      {
        subjectType: 'subject',
        subjectId: 'subj-1',
        dimension: 'requests',
        periodKey: '2026-07',
        modelScope: 'gpt-x',
      },
      1n,
      new Date('2026-07-01T00:00:00.000Z'),
    );
  });
});
