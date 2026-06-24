import { FakeConcurrencyLimiter, FakeRateLimitRedis, RedisRateLimiter } from '@actionow/infra';
import type { ExecutionContext } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the db layer the guard calls — the guard logic is what's under test.
const m = vi.hoisted(() => ({
  resolveEffectiveRules: vi.fn(),
  getUsage: vi.fn(),
  incrUsage: vi.fn(),
  windowedUsage: vi.fn(),
  getModelRateLimit: vi.fn(),
}));
vi.mock('@actionow/db', () => ({
  resolveEffectiveRules: m.resolveEffectiveRules,
  getUsage: m.getUsage,
  incrUsage: m.incrUsage,
  windowedUsage: m.windowedUsage,
  getModelRateLimit: m.getModelRateLimit,
  periodKeyFor: (period: string) => period,
  periodStartFor: () => new Date(0),
}));

const { GovernanceGuard } = await import('../src/auth/governance.guard.js');

const ENV = { RATE_LIMIT_TENANT_PER_MIN: 1000, RATE_LIMIT_RESOURCE_PER_MIN: 1000 } as never;

function ctxOf(body: Record<string, unknown> = {}): ExecutionContext {
  const req = {
    headers: {},
    params: {},
    body,
    auth: {
      tenantId: 't1',
      apiKeyId: 'k1',
      accountId: 'a1',
      resourceAllowlist: [],
      rateLimit: null,
      routeGroupId: null,
      limitPlanId: 'plan-key',
      tenantLimitPlanId: null,
    },
  };
  const res = { once: () => undefined };
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

function mkGuard(): InstanceType<typeof GovernanceGuard> {
  const limiter = new RedisRateLimiter(new FakeRateLimitRedis());
  return new GovernanceGuard(limiter, new FakeConcurrencyLimiter(), ENV, {} as never);
}

function rule(over: Record<string, unknown>) {
  return {
    id: 'r1',
    planId: 'plan-key',
    period: null,
    cap: 0n,
    modelScope: null,
    alertPct: null,
    enforce: 'hard',
    ...over,
  };
}

beforeEach(() => {
  m.resolveEffectiveRules.mockReset();
  m.getUsage.mockReset();
  m.incrUsage.mockReset();
  m.windowedUsage.mockReset();
  m.getModelRateLimit.mockReset().mockResolvedValue(null);
});

describe('GovernanceGuard', () => {
  it('passes when no plan rules are bound (legacy RPM only)', async () => {
    m.resolveEffectiveRules.mockResolvedValue([]);
    await expect(mkGuard().canActivate(ctxOf())).resolves.toBe(true);
  });

  it('rejects (402) a spend budget that is already exhausted', async () => {
    m.resolveEffectiveRules.mockImplementation((_db, keyPlan) =>
      Promise.resolve(
        keyPlan === 'plan-key' ? [rule({ dimension: 'spend', period: 'month', cap: 100n })] : [],
      ),
    );
    m.getUsage.mockResolvedValue(100n); // already at cap
    await expect(mkGuard().canActivate(ctxOf())).rejects.toMatchObject({
      unified: { code: 'insufficient_credits' },
    });
  });

  it('allows a requests/day quota under cap (and increments)', async () => {
    m.resolveEffectiveRules.mockImplementation((_db, keyPlan) =>
      Promise.resolve(
        keyPlan === 'plan-key' ? [rule({ dimension: 'requests', period: 'day', cap: 5n })] : [],
      ),
    );
    m.getUsage.mockResolvedValue(2n);
    m.incrUsage.mockResolvedValue(3n);
    await expect(mkGuard().canActivate(ctxOf())).resolves.toBe(true);
    expect(m.incrUsage).toHaveBeenCalledOnce();
  });

  it('rejects (429) an rpm rule on the second call within the window', async () => {
    m.resolveEffectiveRules.mockImplementation((_db, keyPlan) =>
      Promise.resolve(
        keyPlan === 'plan-key' ? [rule({ dimension: 'rpm', period: 'minute', cap: 1n })] : [],
      ),
    );
    const g = mkGuard();
    await expect(g.canActivate(ctxOf())).resolves.toBe(true);
    await expect(g.canActivate(ctxOf())).rejects.toMatchObject({
      unified: { code: 'rate_limited' },
    });
  });

  it('rejects (429) a concurrency rule when the in-flight cap is exceeded', async () => {
    m.resolveEffectiveRules.mockImplementation((_db, keyPlan) =>
      Promise.resolve(
        keyPlan === 'plan-key' ? [rule({ dimension: 'concurrency', period: null, cap: 1n })] : [],
      ),
    );
    const g = mkGuard();
    // First holds the only slot (response.once is a no-op here, so it stays held).
    await expect(g.canActivate(ctxOf())).resolves.toBe(true);
    await expect(g.canActivate(ctxOf())).rejects.toMatchObject({
      unified: { code: 'rate_limited' },
    });
  });

  it('rolling-window spend uses windowedUsage and rejects at cap', async () => {
    m.resolveEffectiveRules.mockImplementation((_db, keyPlan) =>
      Promise.resolve(
        keyPlan === 'plan-key'
          ? [rule({ dimension: 'spend', period: 'rolling_24h', cap: 50n })]
          : [],
      ),
    );
    m.windowedUsage.mockResolvedValue(50n);
    await expect(mkGuard().canActivate(ctxOf())).rejects.toMatchObject({
      unified: { code: 'insufficient_credits' },
    });
    expect(m.windowedUsage).toHaveBeenCalledOnce();
  });
});
