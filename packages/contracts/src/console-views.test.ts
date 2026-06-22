import { describe, expect, it } from 'vitest';

import {
  consoleApiKeyViewSchema,
  consoleBalanceViewSchema,
  consoleIntentViewSchema,
  consoleJobViewSchema,
  consoleLedgerViewSchema,
  consoleMeViewSchema,
  consoleModelViewSchema,
  consolePaymentViewSchema,
  consoleUsageLogViewSchema,
  consoleUsageRollupViewSchema,
} from './console-views.js';

describe('tenant console view contracts (single source of truth for FE + BE)', () => {
  it('consoleApiKeyViewSchema omits tenant scope fields and rejects a missing one', () => {
    const k = {
      id: 'k1',
      resource_allowlist: ['chat'],
      rate_limit: null,
      status: 'active',
      created_at: '2026-01-01T00:00:00Z',
    };
    expect(consoleApiKeyViewSchema.parse(k)).toEqual(k);
    expect(() => consoleApiKeyViewSchema.parse({ ...k, status: undefined })).toThrow();
  });

  it('consoleJobViewSchema keeps cost a string-or-null', () => {
    const j = {
      job_id: 'j1',
      resource_id: 'r1',
      status: 'succeeded',
      exec_mode: 'sync',
      cost: '500000',
      created_at: '2026-01-01T00:00:00Z',
    };
    expect(consoleJobViewSchema.parse(j)).toEqual(j);
    expect(() => consoleJobViewSchema.parse({ ...j, cost: 500000 })).toThrow();
  });

  it('consoleLedgerViewSchema keeps money fields as strings', () => {
    const l = {
      id: 'l1',
      type: 'spend',
      credits_delta: '-1000',
      balance_after: '9000',
      job_id: 'j1',
      created_at: '2026-01-01T00:00:00Z',
    };
    expect(consoleLedgerViewSchema.parse(l)).toEqual(l);
    expect(() => consoleLedgerViewSchema.parse({ ...l, balance_after: 9000 })).toThrow();
  });

  it('consoleModelViewSchema accepts free-form capabilities', () => {
    const m = {
      name: 'gpt-4o',
      display: 'GPT-4o',
      modality: 'text',
      capabilities: { tools: true },
      visibility: 'public',
    };
    expect(consoleModelViewSchema.parse(m)).toEqual(m);
  });

  it('consoleUsageLogViewSchema keeps cost a string but tokens numbers', () => {
    const u = {
      id: 'u1',
      model: 'gpt-4o',
      input_tokens: 10,
      output_tokens: 20,
      cost: '300000',
      latency_ms: 42,
      status: 'ok',
      created_at: '2026-01-01T00:00:00Z',
    };
    expect(consoleUsageLogViewSchema.parse(u)).toEqual(u);
    expect(() => consoleUsageLogViewSchema.parse({ ...u, cost: 300000 })).toThrow();
  });

  it('consoleUsageRollupViewSchema STRIPS operator-only provider_cost/margin (no markup leak to tenants)', () => {
    const safe = {
      bucket: '2026-01-01',
      requests: 12,
      input_tokens: '1000',
      output_tokens: '2000',
      cost: '500000',
      errors: 1,
      avg_latency_ms: 640,
      p95_latency_ms: 1800,
    };
    // A clean tenant rollup round-trips.
    expect(consoleUsageRollupViewSchema.parse(safe)).toEqual(safe);
    // Even if the DB row carries provider_cost/margin, the tenant view must DROP
    // them — they reveal the platform's per-tenant markup.
    const parsed = consoleUsageRollupViewSchema.parse({
      ...safe,
      provider_cost: '300000',
      margin: '200000',
    });
    expect(parsed).toEqual(safe);
    expect(parsed).not.toHaveProperty('provider_cost');
    expect(parsed).not.toHaveProperty('margin');
    // Money stays a string (BigInt-safe), like the other console views.
    expect(() => consoleUsageRollupViewSchema.parse({ ...safe, cost: 500000 })).toThrow();
  });

  it('consolePaymentViewSchema keeps amount_minor a string and credit_amount nullable', () => {
    const p = {
      id: 'pi1',
      provider: 'stripe',
      purpose: 'topup',
      amount_minor: '1000',
      currency: 'usd',
      credit_amount: null,
      status: 'pending',
      created_at: '2026-01-01T00:00:00Z',
    };
    expect(consolePaymentViewSchema.parse(p)).toEqual(p);
    expect(() => consolePaymentViewSchema.parse({ ...p, amount_minor: 1000 })).toThrow();
  });

  it('consoleMeViewSchema accepts a null tenant_id and rejects a non-boolean verified flag', () => {
    const me = {
      id: 'u1',
      email: 'a@b.com',
      email_verified: false,
      role: 'user',
      status: 'active',
      tenant_id: null,
    };
    expect(consoleMeViewSchema.parse(me)).toEqual(me);
    expect(() => consoleMeViewSchema.parse({ ...me, email_verified: 'false' })).toThrow();
  });

  it('consoleBalanceViewSchema keeps balance/held as strings', () => {
    const b = { balance: '1000000', held: '0' };
    expect(consoleBalanceViewSchema.parse(b)).toEqual(b);
    expect(() => consoleBalanceViewSchema.parse({ balance: 1000000, held: '0' })).toThrow();
  });

  it('consoleIntentViewSchema accepts omitted optional handles', () => {
    const i = { intent_id: 'pi_1' };
    expect(consoleIntentViewSchema.parse(i)).toEqual(i);
    expect(consoleIntentViewSchema.parse({ intent_id: 'pi_1', redirect_url: 'https://x' })).toEqual(
      {
        intent_id: 'pi_1',
        redirect_url: 'https://x',
      },
    );
  });
});
