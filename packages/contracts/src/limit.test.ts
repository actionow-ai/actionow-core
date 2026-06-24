import { describe, expect, it } from 'vitest';

import {
  createLimitPlanRequestSchema,
  limitPlanViewSchema,
  limitRuleInputSchema,
} from './limit.js';

describe('limitRuleInputSchema dimension↔period validation', () => {
  it('accepts valid dimension/period pairings', () => {
    expect(() =>
      limitRuleInputSchema.parse({ dimension: 'spend', period: 'month', cap: 5_000_000 }),
    ).not.toThrow();
    expect(() =>
      limitRuleInputSchema.parse({ dimension: 'requests', period: 'rolling_24h', cap: 100 }),
    ).not.toThrow();
    expect(() =>
      limitRuleInputSchema.parse({ dimension: 'rpm', period: 'minute', cap: 60 }),
    ).not.toThrow();
    expect(() => limitRuleInputSchema.parse({ dimension: 'concurrency', cap: 4 })).not.toThrow();
  });

  it('rejects mismatched pairings', () => {
    // spend must use an accumulating period, not minute
    expect(() =>
      limitRuleInputSchema.parse({ dimension: 'spend', period: 'minute', cap: 1 }),
    ).toThrow();
    // rpm must be minute
    expect(() => limitRuleInputSchema.parse({ dimension: 'rpm', period: 'day', cap: 1 })).toThrow();
    // concurrency must have no period
    expect(() =>
      limitRuleInputSchema.parse({ dimension: 'concurrency', period: 'day', cap: 1 }),
    ).toThrow();
    // negative cap rejected
    expect(() =>
      limitRuleInputSchema.parse({ dimension: 'requests', period: 'day', cap: -1 }),
    ).toThrow();
    // alert_pct out of range
    expect(() =>
      limitRuleInputSchema.parse({ dimension: 'requests', period: 'day', cap: 1, alertPct: 150 }),
    ).toThrow();
  });
});

describe('createLimitPlanRequestSchema', () => {
  it('defaults rules to [] and requires a name', () => {
    expect(createLimitPlanRequestSchema.parse({ name: 'Free' }).rules).toEqual([]);
    expect(() => createLimitPlanRequestSchema.parse({})).toThrow();
  });
});

describe('limitPlanViewSchema', () => {
  it('parses a plan view with string caps + counts', () => {
    const v = {
      id: 'p1',
      name: 'Pro',
      description: null,
      status: 'active',
      rules: [
        {
          id: 'r1',
          dimension: 'spend' as const,
          period: 'month',
          cap: '5000000',
          model_scope: null,
          alert_pct: 80,
          enforce: 'hard',
        },
      ],
      key_count: 3,
      tenant_count: 1,
      created_at: '2026-06-24T00:00:00Z',
      updated_at: '2026-06-24T00:00:00Z',
    };
    expect(limitPlanViewSchema.parse(v)).toEqual(v);
  });
});
