import { describe, expect, it } from 'vitest';

import {
  apiKeyViewSchema,
  breakerViewSchema,
  jobViewSchema,
  ledgerViewSchema,
  paymentIntentViewSchema,
  usageLogViewSchema,
  usageRollupViewSchema,
} from './ops-views.js';

describe('admin operational view contracts (single source of truth for FE + BE)', () => {
  it('apiKeyViewSchema accepts a valid key and rejects a missing field', () => {
    const k = {
      id: 'k1',
      tenant_id: 't1',
      resource_allowlist: ['chat'],
      rate_limit: null,
      status: 'active',
      route_group_id: null,
      limit_plan_id: null,
      subject_id: null,
      created_at: '2026-01-01T00:00:00Z',
    };
    expect(apiKeyViewSchema.parse(k)).toEqual(k);
    expect(() => apiKeyViewSchema.parse({ ...k, status: undefined })).toThrow();
  });

  it('jobViewSchema accepts a null cost and rejects a numeric cost (money is a string)', () => {
    const j = {
      job_id: 'j1',
      tenant_id: 't1',
      subject_id: null,
      resource_id: 'r1',
      status: 'succeeded',
      exec_mode: 'sync',
      cost: null,
      created_at: '2026-01-01T00:00:00Z',
    };
    expect(jobViewSchema.parse(j)).toEqual(j);
    // cost is a µcredit decimal STRING, never a JS number — guard against drift.
    expect(() => jobViewSchema.parse({ ...j, cost: 1234 })).toThrow();
  });

  it('ledgerViewSchema keeps money fields as strings', () => {
    const l = {
      id: 'l1',
      tenant_id: 't1',
      account_id: 'a1',
      subject_id: null,
      type: 'topup',
      credits_delta: '1000000',
      balance_after: '1000000',
      resource_id: null,
      job_id: null,
      created_at: '2026-01-01T00:00:00Z',
    };
    expect(ledgerViewSchema.parse(l)).toEqual(l);
    expect(() => ledgerViewSchema.parse({ ...l, balance_after: 1_000_000 })).toThrow();
  });

  it('usageLogViewSchema keeps token counts as numbers but cost as a string', () => {
    const u = {
      id: 'u1',
      tenant_id: 't1',
      subject_id: null,
      model: 'gpt-4o',
      input_tokens: 10,
      output_tokens: 20,
      cost: '300000',
      latency_ms: null,
      status: 'ok',
      created_at: '2026-01-01T00:00:00Z',
    };
    expect(usageLogViewSchema.parse(u)).toEqual(u);
    expect(() => usageLogViewSchema.parse({ ...u, cost: 300000 })).toThrow();
  });

  it('usageRollupViewSchema keeps the bigint sums as strings', () => {
    const r = {
      bucket: '2026-01-01',
      requests: 5,
      input_tokens: '100',
      output_tokens: '200',
      cost: '1500000',
      provider_cost: '1000000',
      margin: '500000',
      errors: 0,
      avg_latency_ms: 820,
      p95_latency_ms: null,
    };
    expect(usageRollupViewSchema.parse(r)).toEqual(r);
    expect(() => usageRollupViewSchema.parse({ ...r, margin: 500000 })).toThrow();
  });

  it('paymentIntentViewSchema accepts a null credit_amount and keeps amount_minor a string', () => {
    const p = {
      id: 'pi1',
      tenant_id: 't1',
      provider: 'stripe',
      provider_ref: 'cs_123',
      purpose: 'topup',
      target_ref: null,
      amount_minor: '1000',
      currency: 'usd',
      credit_amount: null,
      status: 'pending',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    expect(paymentIntentViewSchema.parse(p)).toEqual(p);
    expect(() => paymentIntentViewSchema.parse({ ...p, amount_minor: 1000 })).toThrow();
  });

  it('breakerViewSchema accepts an open breaker and rejects an unknown state (弹性2.0)', () => {
    const b = {
      channel_id: 'c1',
      channel_name: 'openai',
      resource_id: 'deepseek',
      model: 'deepseek-chat',
      state: 'open',
      opened_at: '2026-06-25T00:00:00Z',
      cooldown_until: '2026-06-25T00:05:00Z',
      trip_count: 3,
      half_open_successes: 0,
      failure_rate: 75.5,
      last_transition_at: '2026-06-25T00:00:00Z',
    };
    expect(breakerViewSchema.parse(b)).toEqual(b);
    // state is a closed enum — guard against drift.
    expect(() => breakerViewSchema.parse({ ...b, state: 'tripped' })).toThrow();
    // failure_rate is nullable (Redis unreadable) — a null is valid.
    expect(breakerViewSchema.parse({ ...b, failure_rate: null })).toMatchObject({
      failure_rate: null,
    });
    // a closed breaker with a null name + null timestamps is valid.
    expect(
      breakerViewSchema.parse({
        ...b,
        channel_name: null,
        state: 'closed',
        opened_at: null,
        cooldown_until: null,
        last_transition_at: null,
      }),
    ).toMatchObject({ state: 'closed', channel_name: null });
  });
});
