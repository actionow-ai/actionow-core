// 批次6 P5 — executeGateway's `requests` accrual seam (§9.1/§7.8): the incr
// runs EXACTLY ONCE per gateway execution, only after the first reservation
// exists (hold placed = 确定发上游), never on replay/conflict/plan-refusal
// paths, never a second time on §8 failover hops, and NEVER inside the
// read-only precheck (the gate suite locks that half). Fake plan + fake
// limitWrites over POISONED_DB — the accrual must ride the injected surface.
import type { DbOrTx, LimitRuleRow } from '@actionow/db';
import { describe, expect, it, vi } from 'vitest';

import { executeGateway, type ScopedLimitRule } from '../../src/index.js';
import { fakePlan, gatewayRequest, harness, taskRowOf } from './gateway-fixtures.js';

function requestsRule(o: { id?: string; period?: string | null; modelScope?: string | null } = {}) {
  return {
    id: o.id ?? 'rule-req',
    planId: 'plan-1',
    dimension: 'requests',
    period: o.period ?? 'day',
    cap: 100n,
    modelScope: o.modelScope ?? null,
    alertPct: null,
    enforce: 'hard',
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  } as LimitRuleRow;
}

function scopedRules(): ScopedLimitRule[] {
  return [{ rule: requestsRule(), subjectType: 'key', subjectId: 'key-1' }];
}

function limitWrites() {
  return {
    incrUsage: vi.fn().mockResolvedValue(1n),
    checkLimitAlert: vi.fn().mockResolvedValue(undefined),
  };
}

describe('executeGateway — requests accrual (批次6 P5)', () => {
  it('sync success: incr exactly once, AFTER admission, with the guard-shape usage key', async () => {
    const { plan } = fakePlan();
    const h = harness({ plan });
    const writes = limitWrites();
    h.deps.limitWrites = writes;

    const res = await executeGateway(h.deps, gatewayRequest(), {
      accountId: 'acct-1',
      scopedRules: scopedRules(),
    });

    expect(res.kind).toBe('sync');
    expect(writes.incrUsage).toHaveBeenCalledTimes(1);
    const [db, key, delta] = writes.incrUsage.mock.calls[0] as [DbOrTx, unknown, bigint];
    expect(db).toBe(h.deps.db); // the caller's db, through the injected write
    expect(key).toMatchObject({
      subjectType: 'key',
      subjectId: 'key-1',
      dimension: 'requests',
      periodKey: '2026-07-12',
      modelScope: '',
    });
    expect(delta).toBe(1n);
    expect(writes.checkLimitAlert).toHaveBeenCalledTimes(1);
  });

  it('counts once even when the dispatch FAILS after admission (guard parity: admitted = counted)', async () => {
    const { plan } = fakePlan();
    // 500 → upstream_error{failover:true} → re-plan excludes the only offering → error.
    const h = harness({ plan, http: { responses: [{ status: 500, body: { msg: 'boom' } }] } });
    const writes = limitWrites();
    h.deps.limitWrites = writes;

    const res = await executeGateway(h.deps, gatewayRequest(), {
      accountId: 'acct-1',
      scopedRules: scopedRules(),
    });

    expect(res.kind).toBe('error');
    expect(h.planLog).toHaveLength(2); // hop 0 + the exhausted re-plan
    expect(writes.incrUsage).toHaveBeenCalledTimes(1); // ONE request, ONE count
  });

  it('§8 failover to a sibling offering never double-counts', async () => {
    const a = fakePlan({ offeringId: 'off-A', channelId: 'chan-A' });
    const b = fakePlan({ offeringId: 'off-B', channelId: 'chan-B' });
    const h = harness({
      plan: a.plan,
      http: {
        responses: [
          { status: 500, body: { msg: 'A boom' } },
          { status: 200, body: { ok: true, output: { text: 'via-B' }, metrics: { requests: 1 } } },
        ],
      },
    });
    h.deps.planner = (_deps, input) =>
      Promise.resolve(input.excludeOfferingIds === undefined ? a.plan : b.plan);
    const writes = limitWrites();
    h.deps.limitWrites = writes;

    const res = await executeGateway(h.deps, gatewayRequest(), {
      accountId: 'acct-1',
      scopedRules: scopedRules(),
    });

    expect(res.kind).toBe('sync');
    expect(writes.incrUsage).toHaveBeenCalledTimes(1); // hop B re-planned, never re-counted
  });

  it('plan refusal (gate/visibility rejection) counts NOTHING — 额度预检只读 end to end', async () => {
    const h = harness({
      planError: {
        code: 'insufficient_credits',
        message: 'requests quota exceeded (day)',
        retryable: false,
        failover: false,
      },
    });
    const writes = limitWrites();
    h.deps.limitWrites = writes;

    const res = await executeGateway(h.deps, gatewayRequest(), {
      accountId: 'acct-1',
      scopedRules: scopedRules(),
    });

    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.error.code).toBe('insufficient_credits');
    expect(writes.incrUsage).not.toHaveBeenCalled();
    expect(writes.checkLimitAlert).not.toHaveBeenCalled();
  });

  it('§5 idempotent replay counts NOTHING (no new upstream dispatch)', async () => {
    const { plan } = fakePlan();
    const h = harness({ plan });
    h.taskStore.tasks.set(
      't-replay',
      taskRowOf({
        id: 't-replay',
        status: 'succeeded',
        idempotencyKey: 'idem-1',
        requestFingerprint: 'fp-aaa',
      }),
    );
    const writes = limitWrites();
    h.deps.limitWrites = writes;

    const res = await executeGateway(
      h.deps,
      gatewayRequest({ idempotency: { key: 'idem-1', bodyFingerprint: 'fp-aaa' } }),
      { accountId: 'acct-1', scopedRules: scopedRules() },
    );

    expect(res.kind).toBe('replay');
    expect(writes.incrUsage).not.toHaveBeenCalled();
  });

  it('a failing counter write is BEST-EFFORT: the admitted request still serves', async () => {
    const { plan } = fakePlan();
    const h = harness({ plan });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.deps.limitWrites = {
      incrUsage: vi.fn().mockRejectedValue(new Error('limit_usage down')),
      checkLimitAlert: vi.fn(),
    };

    const res = await executeGateway(h.deps, gatewayRequest(), {
      accountId: 'acct-1',
      scopedRules: scopedRules(),
    });

    expect(res.kind).toBe('sync'); // the held request was never failed by bookkeeping
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('no scopedRules → zero limit_usage traffic (rows without plans stay free of writes)', async () => {
    const { plan } = fakePlan();
    const h = harness({ plan });
    const writes = limitWrites();
    h.deps.limitWrites = writes;

    const res = await executeGateway(h.deps, gatewayRequest(), { accountId: 'acct-1' });

    expect(res.kind).toBe('sync');
    expect(writes.incrUsage).not.toHaveBeenCalled();
  });
});
