import { describe, expect, it } from 'vitest';

import {
  batchCreateSupplyOfferingsSchema,
  batchProbeEnableSupplyOfferingsResponseSchema,
  batchProbeEnableSupplyOfferingsSchema,
  batchSupplyOfferingItemSchema,
  DISCOVERED_MODEL_SOURCES,
  discoveredSupplyModelSchema,
  discoverSupplyModelsResponseSchema,
  OFFERING_PRICING_STATUSES,
  offeringPricingOutcomeSchema,
} from './supply-discovery.js';

// 批次5 slice2 — 发现与批建 admin views (NOT frozen; shape locks only).
describe('supply discovery vocabulary', () => {
  it('two discovery sources (§10 方言 discovery 端点或目录勾选 二选一)', () => {
    expect(DISCOVERED_MODEL_SOURCES).toEqual(['dialect_discovery', 'catalog']);
  });

  it('three pricing outcomes (§10 售价卡默认由官方价目生成 + needs_pricing 闸)', () => {
    expect(OFFERING_PRICING_STATUSES).toEqual(['existing', 'minted', 'needs_pricing']);
  });
});

describe('discoverSupplyModelsResponseSchema', () => {
  it('parses a catalog answer with optional display_name', () => {
    const parsed = discoverSupplyModelsResponseSchema.parse({
      source: 'catalog',
      models: [
        {
          upstream_model_name: 'gpt-4o',
          display_name: 'GPT-4o',
          source: 'catalog',
          exists_as_offering: true,
        },
        {
          upstream_model_name: 'gpt-4o-mini',
          source: 'dialect_discovery',
          exists_as_offering: false,
        },
      ],
    });
    expect(parsed.models).toHaveLength(2);
    expect(parsed.models[1]?.display_name).toBeUndefined();
  });

  it('rejects an empty upstream name', () => {
    expect(
      discoveredSupplyModelSchema.safeParse({
        upstream_model_name: '',
        source: 'catalog',
        exists_as_offering: false,
      }).success,
    ).toBe(false);
  });
});

describe('batchSupplyOfferingItemSchema — exactly one of model_id / new_model', () => {
  const MODEL_ID = '6f0a2f3a-0000-4000-8000-000000000001';

  it('accepts model_id alone and new_model alone', () => {
    expect(
      batchSupplyOfferingItemSchema.safeParse({ upstream_model_name: 'up', model_id: MODEL_ID })
        .success,
    ).toBe(true);
    expect(
      batchSupplyOfferingItemSchema.safeParse({
        upstream_model_name: 'up',
        new_model: { name: 'ext' },
      }).success,
    ).toBe(true);
  });

  it('rejects neither and both', () => {
    expect(batchSupplyOfferingItemSchema.safeParse({ upstream_model_name: 'up' }).success).toBe(
      false,
    );
    expect(
      batchSupplyOfferingItemSchema.safeParse({
        upstream_model_name: 'up',
        model_id: MODEL_ID,
        new_model: { name: 'ext' },
      }).success,
    ).toBe(false);
  });

  it('an inline new_model operation row parses WITH the modelOperation defaults (slow/params)', () => {
    // The nested frozen modelOperationSchema carries `.default()`s — the parse
    // OUTPUT gains those keys (the known contracts gotcha; locked here so a
    // consumer asserting exact shapes is not surprised).
    const parsed = batchSupplyOfferingItemSchema.parse({
      upstream_model_name: 'up',
      new_model: {
        name: 'ext',
        operations: [{ operation: 'chat.completions', paradigms: ['sync'] }],
      },
    });
    expect(parsed.new_model?.operations?.[0]).toEqual({
      operation: 'chat.completions',
      paradigms: ['sync'],
      slow: false,
      params: [],
    });
  });

  it('the batch request bounds items to 1..100', () => {
    expect(batchCreateSupplyOfferingsSchema.safeParse({ items: [] }).success).toBe(false);
    const many = Array.from({ length: 101 }, (_, i) => ({
      upstream_model_name: `up-${String(i)}`,
      new_model: { name: `ext-${String(i)}` },
    }));
    expect(batchCreateSupplyOfferingsSchema.safeParse({ items: many }).success).toBe(false);
  });
});

describe('probe-and-enable request/response', () => {
  it('an empty body means "the whole channel" (offering_ids optional)', () => {
    expect(batchProbeEnableSupplyOfferingsSchema.parse({})).toEqual({});
  });

  it('parses a per-offering verdict list with the slice-1 probe payload embedded', () => {
    const parsed = batchProbeEnableSupplyOfferingsResponseSchema.parse({
      results: [
        {
          offering_id: 'off-1',
          upstream_model_name: 'up',
          enabled: false,
          offering_status: 'probing',
          violations: [{ gate: 'golden_probe', message: 'golden probe did not pass: boom' }],
          probe: {
            status: 'rejected',
            rejection: { reason: 'min_interval', message: 'paced', retry_after_seconds: 42 },
          },
        },
      ],
      enabled_count: 0,
    });
    expect(parsed.results[0]?.probe?.status).toBe('rejected');
  });

  it('pricing outcome allows the message-only needs_pricing shape', () => {
    expect(
      offeringPricingOutcomeSchema.parse({ status: 'needs_pricing', message: 'no match' }),
    ).toEqual({ status: 'needs_pricing', message: 'no match' });
  });
});
