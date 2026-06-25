import { describe, expect, it } from 'vitest';

import {
  memberBalanceViewSchema,
  memberKeyViewSchema,
  memberLimitRuleViewSchema,
  memberLimitsViewSchema,
  memberMeViewSchema,
  memberUsageListSchema,
  memberUsageRowSchema,
} from './member-views.js';

describe('member self-service view contracts (locked to the token subject)', () => {
  it('memberMeViewSchema parses identity with nullable id fields', () => {
    const me = {
      id: 's1',
      status: 'active',
      tenant_id: 't1',
      external_id: 'end-user-1',
      email: null,
      display_name: 'Alice',
    };
    expect(memberMeViewSchema.parse(me)).toEqual(me);
    // status is required (not optional)
    expect(() => memberMeViewSchema.parse({ ...me, status: undefined })).toThrow();
    // tenant_id is a plain string (always scoped), not nullable
    expect(() => memberMeViewSchema.parse({ ...me, tenant_id: null })).toThrow();
  });

  it('memberUsageRowSchema keeps cost a string but tokens numbers; never a subject_id', () => {
    const row = {
      id: 'u1',
      model: 'gpt-4o',
      input_tokens: 10,
      output_tokens: 20,
      cost: '300000',
      latency_ms: 42,
      status: 'ok',
      created_at: '2026-06-26T00:00:00Z',
    };
    expect(memberUsageRowSchema.parse(row)).toEqual(row);
    // money stays a string (BigInt-safe)
    expect(() => memberUsageRowSchema.parse({ ...row, cost: 300000 })).toThrow();
    // the member never sees a subject_id (it is always self) — zod strips it
    const parsed = memberUsageRowSchema.parse({ ...row, subject_id: 's2' });
    expect(parsed).not.toHaveProperty('subject_id');
  });

  it('memberUsageListSchema wraps rows in a keyset envelope', () => {
    const list = {
      data: [
        {
          id: 'u1',
          model: 'gpt-4o',
          input_tokens: 1,
          output_tokens: 2,
          cost: '1',
          latency_ms: null,
          status: 'ok',
          created_at: '2026-06-26T00:00:00Z',
        },
      ],
      next_cursor: null,
    };
    expect(memberUsageListSchema.parse(list)).toEqual(list);
  });

  it('memberBalanceViewSchema is a mode-tagged union with string money', () => {
    const hard = { mode: 'hard' as const, balance: '1000000', held: '0' };
    expect(memberBalanceViewSchema.parse(hard)).toEqual(hard);
    const shared = { mode: 'shared' as const, balance: '0', held: '0' };
    expect(memberBalanceViewSchema.parse(shared)).toEqual(shared);
    // mode is constrained
    expect(() => memberBalanceViewSchema.parse({ ...hard, mode: 'pool' })).toThrow();
    // money is a string, never a number
    expect(() => memberBalanceViewSchema.parse({ ...hard, balance: 1000000 })).toThrow();
  });

  it('memberKeyViewSchema masks the key (last4 only, no plaintext)', () => {
    const k = {
      id: 'k1',
      name: 'mobile',
      status: 'active',
      created_at: '2026-06-26T00:00:00Z',
      last4: 'a1b2',
    };
    expect(memberKeyViewSchema.parse(k)).toEqual(k);
    // name nullable (unnamed key)
    expect(memberKeyViewSchema.parse({ ...k, name: null })).toEqual({ ...k, name: null });
    // any plaintext/hash field is stripped (never reaches the member)
    const parsed = memberKeyViewSchema.parse({ ...k, key: 'sk-secret', key_hash: 'deadbeef' });
    expect(parsed).not.toHaveProperty('key');
    expect(parsed).not.toHaveProperty('key_hash');
  });

  it('memberLimitRuleViewSchema keeps cap/used strings (usage-vs-cap bars)', () => {
    const rule = {
      dimension: 'spend',
      period: 'month',
      cap: '5000000',
      used: '1200000',
      model_scope: null,
      alert_pct: 80,
      enforce: 'hard',
    };
    expect(memberLimitRuleViewSchema.parse(rule)).toEqual(rule);
    expect(() => memberLimitRuleViewSchema.parse({ ...rule, used: 1200000 })).toThrow();
  });

  it('memberLimitsViewSchema carries the effective plan (or null) + rules', () => {
    const withPlan = {
      plan: { id: 'p1', name: 'Pro' },
      rules: [
        {
          dimension: 'requests',
          period: 'day',
          cap: '1000',
          used: '12',
          model_scope: null,
          alert_pct: null,
          enforce: 'hard',
        },
      ],
    };
    expect(memberLimitsViewSchema.parse(withPlan)).toEqual(withPlan);
    // unlimited (no plan bound) → plan null, empty rules
    const none = { plan: null, rules: [] };
    expect(memberLimitsViewSchema.parse(none)).toEqual(none);
  });
});
