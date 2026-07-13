// 批次6 P5 — the API side of the limit-plan wiring: GatewayService.execute()
// turns the auth-derived `limits` bindings into the §7.8 gates' scopedRules
// (through the guard-parity cached resolver) and the constructor wires the
// §9.1 model global gate cap onto the OLD model table's rate_limit (择稳 —
// exactly GovernanceGuard.resolveModelLimit's source, 30s cache; the DELETE
// slice re-sources this when the old `model` table drops). The engine planner
// is replaced with a recorder so the assertion is on WHAT planExecution
// receives — the exact seam the 批次4 report flagged as un-wired.
import type { GatewayRequest } from '@actionow/contracts';
import type { Database } from '@actionow/db';
import type { ExecuteGatewayDeps, ScopedLimitRule, ScopedRulesResolver } from '@actionow/engine';
import type { ConcurrencyLimiter, RateLimiter } from '@actionow/infra';
import type { DialectRegistry } from '@actionow/spi';
import { describe, expect, it, vi } from 'vitest';

import { GatewayService } from '../src/gateway/gateway.service.js';

const RULES: ScopedLimitRule[] = [
  {
    rule: {
      id: 'r1',
      planId: 'plan-key',
      dimension: 'requests',
      period: 'day',
      cap: 5n,
      modelScope: null,
      alertPct: null,
      enforce: 'hard',
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    subjectType: 'key',
    subjectId: 'key-1',
  },
];

function request(over: Partial<GatewayRequest> = {}): GatewayRequest {
  return {
    tenantId: 'tenant-1',
    apiKeyId: 'key-1',
    operation: 'chat.completions',
    model: 'test-model',
    params: {},
    mediaRefs: [],
    options: {},
    ...over,
  };
}

const LIMITS = {
  keyLimitPlanId: 'plan-key',
  tenantLimitPlanId: 'plan-tenant',
  subjectLimitPlanId: null,
};

/** A service whose planner records planExecution's input and refuses (no dispatch). */
function serviceWithRecorder(db: unknown = {}) {
  const service = new GatewayService(
    db as Database,
    {} as RateLimiter,
    {} as ConcurrencyLimiter,
    {} as DialectRegistry,
    {} as never,
  );
  const internals = service as unknown as {
    deps: ExecuteGatewayDeps;
    scopedRules: ScopedRulesResolver;
  };
  const planInputs: { scopedRules?: ScopedLimitRule[] | undefined }[] = [];
  internals.deps.planner = (_deps, input) => {
    planInputs.push({ scopedRules: input.scopedRules });
    return Promise.resolve({
      ok: false,
      error: {
        code: 'model_not_found',
        message: 'recorder refusal',
        retryable: false,
        failover: false,
      },
      warnings: [],
      trace: { rejected: [], attempts: [] },
    });
  };
  const resolver = vi.fn().mockResolvedValue(RULES);
  internals.scopedRules = resolver;
  return { service, planInputs, resolver };
}

describe('GatewayService.execute — limit-plan → scopedRules threading (批次6 P5)', () => {
  it('resolves the auth bindings through the cached resolver and hands the rules to planExecution', async () => {
    const { service, planInputs, resolver } = serviceWithRecorder();

    const res = await service.execute(request(), { accountId: 'acct-1', limits: LIMITS });

    expect(res.kind).toBe('error');
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      apiKeyId: 'key-1',
      subjectId: null,
      keyLimitPlanId: 'plan-key',
      tenantLimitPlanId: 'plan-tenant',
      subjectLimitPlanId: null,
    });
    expect(planInputs[0]?.scopedRules).toBe(RULES);
  });

  it('threads the request subject into the resolution (unified tenancy G-D)', async () => {
    const { service, resolver } = serviceWithRecorder();

    await service.execute(request({ subjectId: 'subj-9' }), {
      accountId: 'acct-1',
      limits: { ...LIMITS, subjectLimitPlanId: 'plan-subject' },
    });

    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({ subjectId: 'subj-9', subjectLimitPlanId: 'plan-subject' }),
    );
  });

  it('an explicit opts.scopedRules wins — no re-resolution', async () => {
    const { service, planInputs, resolver } = serviceWithRecorder();
    const explicit: ScopedLimitRule[] = [];

    await service.execute(request(), {
      accountId: 'acct-1',
      scopedRules: explicit,
      limits: LIMITS,
    });

    expect(resolver).not.toHaveBeenCalled();
    expect(planInputs[0]?.scopedRules).toBe(explicit);
  });

  it('no limits and no scopedRules → planExecution sees undefined (rule-less callers unchanged)', async () => {
    const { service, planInputs, resolver } = serviceWithRecorder();

    await service.execute(request(), { accountId: 'acct-1' });

    expect(resolver).not.toHaveBeenCalled();
    expect(planInputs[0]?.scopedRules).toBeUndefined();
  });
});

describe('GatewayService — §9.1 model global gate cap source (批次6 P5, 择稳)', () => {
  it('reads the OLD model table rate_limit (getModelRateLimit shape) behind the 30s cache', async () => {
    let selects = 0;
    const db = {
      select: () => {
        selects += 1;
        return {
          from: () => ({ where: () => ({ limit: () => Promise.resolve([{ rateLimit: 42 }]) }) }),
        };
      },
    };
    const service = new GatewayService(
      db as unknown as Database,
      {} as RateLimiter,
      {} as ConcurrencyLimiter,
      {} as DialectRegistry,
      {} as never,
    );
    const deps = (service as unknown as { deps: ExecuteGatewayDeps }).deps;
    expect(deps.resolveModelLimit).toBeTypeOf('function');

    await expect(deps.resolveModelLimit?.('gpt-x')).resolves.toBe(42);
    await expect(deps.resolveModelLimit?.('gpt-x')).resolves.toBe(42); // cached
    expect(selects).toBe(1); // guard-parity 30s TTL — one fetch within the window
  });
});
