// 批次6 P5 — 对拍: the extracted engine `resolveScopedRules` must answer
// EXACTLY what the legacy GovernanceGuard.effectiveRules(auth) answers for the
// same bindings (双面并存 correctness precondition — when the guard is deleted
// the new face must already enforce the identical rule set). Both sides run
// over the SAME mocked `resolveEffectiveRules` table; the guard is UNTOUCHED
// production code (this file must keep passing until the delete slice).
import { FakeConcurrencyLimiter, FakeRateLimitRedis, RedisRateLimiter } from '@actionow/infra';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ resolveEffectiveRules: vi.fn() }));
vi.mock('@actionow/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveEffectiveRules: m.resolveEffectiveRules,
}));

const { GovernanceGuard } = await import('../src/auth/governance.guard.js');
const { resolveScopedRules } = await import('@actionow/engine');

interface Auth {
  tenantId: string;
  accountId: string;
  apiKeyId: string | null;
  resourceAllowlist: string[];
  rateLimit: number | null;
  routeGroupId: string | null;
  limitPlanId: string | null;
  tenantLimitPlanId: string | null;
  subjectId: string | null;
  subjectLimitPlanId: string | null;
}

const ENV = { RATE_LIMIT_TENANT_PER_MIN: 1000, RATE_LIMIT_RESOURCE_PER_MIN: 1000 } as never;

function rule(id: string, planId: string, dimension: string) {
  return {
    id,
    planId,
    dimension,
    period: 'day',
    cap: 10n,
    modelScope: null,
    alertPct: null,
    enforce: 'hard',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

const TABLE: Record<string, ReturnType<typeof rule>[]> = {
  'plan-key': [rule('rk1', 'plan-key', 'rpm'), rule('rk2', 'plan-key', 'requests')],
  'plan-tenant': [rule('rt1', 'plan-tenant', 'spend')],
  'plan-subject': [rule('rs1', 'plan-subject', 'tokens')],
};

/** The guard's PRIVATE effectiveRules, driven directly (the algorithm under 对拍). */
function guardEffectiveRules(auth: Auth) {
  const guard = new GovernanceGuard(
    new RedisRateLimiter(new FakeRateLimitRedis()),
    new FakeConcurrencyLimiter(),
    ENV,
    {} as never,
  );
  return (
    guard as unknown as {
      effectiveRules(a: Auth): Promise<unknown[]>;
    }
  ).effectiveRules(auth);
}

function authOf(over: Partial<Auth> = {}): Auth {
  return {
    tenantId: 't1',
    accountId: 'a1',
    apiKeyId: 'k1',
    resourceAllowlist: [],
    rateLimit: null,
    routeGroupId: null,
    limitPlanId: 'plan-key',
    tenantLimitPlanId: 'plan-tenant',
    subjectId: 'subj-1',
    subjectLimitPlanId: 'plan-subject',
    ...over,
  };
}

async function engineScopedRules(auth: Auth) {
  return resolveScopedRules(
    { db: {} as never },
    {
      tenantId: auth.tenantId,
      apiKeyId: auth.apiKeyId,
      subjectId: auth.subjectId,
      keyLimitPlanId: auth.limitPlanId,
      tenantLimitPlanId: auth.tenantLimitPlanId,
      subjectLimitPlanId: auth.subjectLimitPlanId,
    },
  );
}

beforeEach(() => {
  m.resolveEffectiveRules
    .mockReset()
    .mockImplementation((_db: unknown, planId: string | null) =>
      Promise.resolve(planId !== null ? (TABLE[planId] ?? []) : []),
    );
});

describe('resolveScopedRules ⇄ GovernanceGuard.effectiveRules 对拍', () => {
  it('full binding (key + tenant + subject plans): identical scoped rule sets', async () => {
    const auth = authOf();
    const guardRules = await guardEffectiveRules(auth);
    const engineRules = await engineScopedRules(auth);
    expect(engineRules).toEqual(guardRules);
    expect(engineRules).toHaveLength(4); // 2 key + 1 tenant + 1 subject
  });

  it('key-plan-only binding: identical', async () => {
    const auth = authOf({ tenantLimitPlanId: null, subjectId: null, subjectLimitPlanId: null });
    expect(await engineScopedRules(auth)).toEqual(await guardEffectiveRules(auth));
  });

  it('tenant-plan-only binding: identical', async () => {
    const auth = authOf({ limitPlanId: null, subjectId: null, subjectLimitPlanId: null });
    const engineRules = await engineScopedRules(auth);
    expect(engineRules).toEqual(await guardEffectiveRules(auth));
    expect(engineRules).toEqual([
      { rule: TABLE['plan-tenant']?.[0], subjectType: 'tenant', subjectId: 't1' },
    ]);
  });

  it('dev fallback (no api key): both sides drop key-plan rules', async () => {
    const auth = authOf({ apiKeyId: null, subjectId: null, subjectLimitPlanId: null });
    const guardRules = await guardEffectiveRules(auth);
    const engineRules = await engineScopedRules(auth);
    expect(engineRules).toEqual(guardRules);
    expect(engineRules.every((s) => s.subjectType !== 'key')).toBe(true);
  });

  it('subject WITHOUT a subject plan: both sides answer only key+tenant scopes', async () => {
    const auth = authOf({ subjectLimitPlanId: null });
    const guardRules = await guardEffectiveRules(auth);
    const engineRules = await engineScopedRules(auth);
    expect(engineRules).toEqual(guardRules);
    expect(engineRules).toHaveLength(3);
  });

  it('no bindings anywhere: both sides answer []', async () => {
    const auth = authOf({
      limitPlanId: null,
      tenantLimitPlanId: null,
      subjectId: null,
      subjectLimitPlanId: null,
    });
    expect(await engineScopedRules(auth)).toEqual([]);
    expect(await guardEffectiveRules(auth)).toEqual([]);
    expect(m.resolveEffectiveRules).not.toHaveBeenCalled();
  });
});
