import { describe, expect, it } from 'vitest';

import {
  officialPriceViewSchema,
  routeGroupChannelViewSchema,
  routeGroupViewSchema,
} from './billing-views.js';

describe('billing & routing view contracts', () => {
  it('routeGroupViewSchema keeps group_ratio_bps a number (basis points, not money)', () => {
    const g = {
      id: 'g1',
      name: 'premium',
      group_ratio_bps: 12000,
      fallback_group_id: null,
      status: 'active',
      description: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    expect(routeGroupViewSchema.parse(g)).toEqual(g);
    // bps is an integer ratio — a string would be wrong here.
    expect(() => routeGroupViewSchema.parse({ ...g, group_ratio_bps: '12000' })).toThrow();
  });

  it('routeGroupViewSchema carries the cross-group fallback id (nullable string)', () => {
    const g = {
      id: 'g1',
      name: 'premium',
      group_ratio_bps: 10000,
      fallback_group_id: 'g2',
      status: 'active',
      description: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    expect(routeGroupViewSchema.parse(g)).toEqual(g);
    // a non-string fallback id must be rejected.
    expect(() => routeGroupViewSchema.parse({ ...g, fallback_group_id: 123 })).toThrow();
  });

  it('routeGroupChannelViewSchema accepts a valid membership and rejects a missing knob', () => {
    const m = {
      group_id: 'g1',
      channel_id: 'c1',
      priority: 10,
      weight: 1,
      created_at: '2026-01-01T00:00:00Z',
    };
    expect(routeGroupChannelViewSchema.parse(m)).toEqual(m);
    expect(() => routeGroupChannelViewSchema.parse({ ...m, weight: undefined })).toThrow();
  });

  it('officialPriceViewSchema keeps µUSD/1M prices as strings (never numbers)', () => {
    const p = {
      id: 'op1',
      provider: 'openai',
      model_slug: 'gpt-4o',
      display_name: null,
      input_price_per_1m: '2500000',
      output_price_per_1m: '10000000',
      cached_input_price_per_1m: null,
      source_url: null,
      effective_at: null,
      notes: null,
      updated_by: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    expect(officialPriceViewSchema.parse(p)).toEqual(p);
    // prices are µUSD/1M decimal strings — guard against a number creeping in.
    expect(() => officialPriceViewSchema.parse({ ...p, input_price_per_1m: 2_500_000 })).toThrow();
  });
});
