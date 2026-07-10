import { describe, expect, it } from 'vitest';

import {
  CANONICAL_PARAM_TYPES,
  canonicalParamSchema,
  MEDIA_KINDS,
  offeringParamDeclSchema,
  PARAM_DECL_KINDS,
  PARAM_DECL_ORIGINS,
} from './supply-params.js';

// 批次0 freeze guards — additions allowed, reshaping is not (see gateway-ir.test.ts).
describe('supply params frozen vocabulary (批次0)', () => {
  it('CANONICAL_PARAM_TYPES includes the io_schema-absorbing file/media types (§2.1)', () => {
    expect(CANONICAL_PARAM_TYPES).toEqual([
      'float',
      'int',
      'boolean',
      'string',
      'enum',
      'json',
      'file',
      'media',
    ]);
    expect(MEDIA_KINDS).toEqual(['image', 'audio', 'video']);
  });

  it('PARAM_DECL_KINDS = the §4 five kinds; origins = upstream|operator (同一张声明表)', () => {
    expect(PARAM_DECL_KINDS).toEqual(['supports', 'domain', 'map', 'fixed', 'unsupported']);
    expect(PARAM_DECL_ORIGINS).toEqual(['upstream', 'operator']);
  });
});

describe('canonicalParamSchema (model-side contract, §4)', () => {
  it('defaults: NOT billing-relevant, NOT required', () => {
    const p = canonicalParamSchema.parse({ name: 'temperature', type: 'float' });
    expect(p.billingRelevant).toBe(false);
    expect(p.required).toBe(false);
  });

  it('marks a billing tier param (§4 两级)', () => {
    const p = canonicalParamSchema.parse({
      name: 'resolution',
      type: 'enum',
      values: ['720p', '1080p'],
      default: '720p',
      billingRelevant: true,
    });
    expect(p.billingRelevant).toBe(true);
    expect(p.values).toEqual(['720p', '1080p']);
  });

  it('rejects an enum param without values', () => {
    expect(canonicalParamSchema.safeParse({ name: 'style', type: 'enum' }).success).toBe(false);
    expect(
      canonicalParamSchema.safeParse({ name: 'style', type: 'enum', values: [] }).success,
    ).toBe(false);
  });

  it('media param carries kinds + input constraints (§2.1 输入媒体约束)', () => {
    const p = canonicalParamSchema.parse({
      name: 'image',
      type: 'media',
      required: true,
      mediaKinds: ['image'],
      constraint: { mimeTypes: ['image/png', 'image/jpeg'], maxSizeBytes: 10_485_760 },
    });
    expect(p.constraint?.maxSizeBytes).toBe(10_485_760);
  });

  it('rejects mediaKinds on a non-media param', () => {
    const out = canonicalParamSchema.safeParse({
      name: 'prompt',
      type: 'string',
      mediaKinds: ['image'],
    });
    expect(out.success).toBe(false);
  });
});

describe('offeringParamDeclSchema (§4 five kinds + operator variants)', () => {
  it('parses all five kinds; origin defaults to upstream', () => {
    const rows = [
      { param: 'seed', rule: { kind: 'supports' } },
      { param: 'resolution', rule: { kind: 'domain', values: ['720p'] } },
      {
        param: 'resolution',
        rule: { kind: 'map', upstreamName: 'size', values: { '720p': '1280x720' } },
      },
      { param: 'watermark', rule: { kind: 'fixed', value: true } },
      { param: 'negative_prompt', rule: { kind: 'unsupported' } },
    ];
    for (const row of rows) {
      const d = offeringParamDeclSchema.parse(row);
      expect(d.origin).toBe('upstream');
    }
  });

  it('parses an operator variant (运营者强制 — planner precedence over upstream declarations)', () => {
    const d = offeringParamDeclSchema.parse({
      param: 'resolution',
      origin: 'operator',
      rule: { kind: 'fixed', value: '720p' },
    });
    expect(d.origin).toBe('operator');
  });

  it('scopes to one operation surface when given', () => {
    const d = offeringParamDeclSchema.parse({
      param: 'quality',
      operation: 'images.generation',
      rule: { kind: 'domain', values: ['standard'] },
    });
    expect(d.operation).toBe('images.generation');
    expect(
      offeringParamDeclSchema.safeParse({
        param: 'quality',
        operation: 'images.remix',
        rule: { kind: 'supports' },
      }).success,
    ).toBe(false);
  });

  it('rejects a fixed declaration without a value (诚实声明 required)', () => {
    const out = offeringParamDeclSchema.safeParse({
      param: 'watermark',
      rule: { kind: 'fixed' },
    });
    expect(out.success).toBe(false);
  });

  it('rejects a map declaration with nothing to map', () => {
    const out = offeringParamDeclSchema.safeParse({ param: 'size', rule: { kind: 'map' } });
    expect(out.success).toBe(false);
  });

  it('rejects a domain declaration with no narrowing at all', () => {
    const out = offeringParamDeclSchema.safeParse({
      param: 'duration',
      rule: { kind: 'domain' },
    });
    expect(out.success).toBe(false);
  });

  it('numeric map translation carries scale/offset (§4.1 layer 2 — never adapter aspect ①)', () => {
    const d = offeringParamDeclSchema.parse({
      param: 'quality',
      rule: { kind: 'map', scale: 100 },
    });
    expect(d.rule.kind).toBe('map');
    if (d.rule.kind === 'map') expect(d.rule.scale).toBe(100);
  });
});
