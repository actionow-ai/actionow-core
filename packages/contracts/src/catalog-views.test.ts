import { describe, expect, it } from 'vitest';

import { channelViewSchema, modelViewSchema, modifierViewSchema } from './catalog-views.js';

describe('catalog view contracts', () => {
  it('modelViewSchema accepts a valid model and rejects a money field typed as number', () => {
    const m = {
      id: 'm1',
      name: 'gpt-4o',
      display: null,
      modality: 'text',
      capabilities: { tools: true, vision: false },
      visibility: 'public',
      resource_id: 'r1',
      input_price: '5000000',
      output_price: '15000000',
      rate_limit: null,
      fallback_models: null,
      served_channel_ids: [],
      tags: ['推荐'],
      maker: 'z-ai',
      context_length: 1000000,
      reasoning: 'optional',
      status: 'active',
      created_at: '2026-01-01T00:00:00Z',
    };
    expect(modelViewSchema.parse(m)).toEqual(m);
    // prices are µcredit strings, never numbers — guard against drift.
    expect(() => modelViewSchema.parse({ ...m, input_price: 5_000_000 })).toThrow();
  });

  it('channelViewSchema accepts null cost/credential fields', () => {
    const c = {
      id: 'c1',
      resource_id: 'r1',
      provider_type: 'openai',
      credential_ref: null,
      endpoint: null,
      model: null,
      proxy_ref: null,
      config: null,
      weight: 1,
      status: 'active',
      input_cost_per_1m: null,
      output_cost_per_1m: null,
      fault_policy_id: null,
      model_count: 0,
    };
    expect(channelViewSchema.parse(c)).toEqual(c);
  });

  it('modifierViewSchema accepts a null value (e.g. for an override with no amount)', () => {
    const mod = {
      id: 'mod1',
      scope: 'global',
      when_expr: null,
      op: 'percent_off',
      value: '10',
      stackable: true,
      priority: 0,
      version: 1,
      active: true,
    };
    expect(modifierViewSchema.parse(mod)).toEqual(mod);
  });
});
