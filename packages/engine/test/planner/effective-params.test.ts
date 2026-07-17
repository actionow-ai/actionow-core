// §4.1 layer-2 resolver unit tests (model-supply-greenfield 批次3 slice 2).
// Pure logic — every case builds canonical contracts / request params /
// offering declarations inline and asserts both EffectiveParams bags plus
// billingDims.
import type {
  CanonicalParam,
  CanonicalParamType,
  CanonicalParamValue,
  OfferingParamDecl,
  Operation,
  ParamDeclOrigin,
  ParamDeclRule,
} from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { resolveEffectiveParams } from '../../src/planner/index.js';

const OP: Operation = 'video.generation';

function param(
  name: string,
  o: {
    type?: CanonicalParamType;
    billingRelevant?: boolean;
    default?: unknown;
    values?: (string | number)[];
    min?: number;
    max?: number;
  } = {},
): CanonicalParam {
  const p: CanonicalParam = {
    name,
    type: o.type ?? 'string',
    billingRelevant: o.billingRelevant ?? false,
    required: false,
  };
  if (o.default !== undefined) p.default = o.default;
  if (o.values !== undefined) p.values = o.values;
  if (o.min !== undefined) p.min = o.min;
  if (o.max !== undefined) p.max = o.max;
  return p;
}

function decl(
  paramName: string,
  rule: ParamDeclRule,
  origin: ParamDeclOrigin = 'upstream',
  operation?: Operation,
): OfferingParamDecl {
  return operation === undefined
    ? { param: paramName, origin, rule }
    : { param: paramName, origin, rule, operation };
}

function explicit(value: unknown): CanonicalParamValue {
  return { value, isDefault: false };
}

function dflt(value: unknown): CanonicalParamValue {
  return { value, isDefault: true };
}

describe('resolveEffectiveParams', () => {
  it('passes values through under the canonical name with no declarations (implicit supports)', () => {
    const r = resolveEffectiveParams({
      operation: OP,
      canonicalParams: [param('resolution')],
      requestParams: { resolution: explicit('720p') },
      declarations: [],
    });
    expect(r.effective.canonical).toEqual({ resolution: '720p' });
    expect(r.effective.upstream).toEqual({ resolution: '720p' });
    expect(r.billingDims).toEqual({});
  });

  it('supports declaration is a plain passthrough', () => {
    const r = resolveEffectiveParams({
      operation: OP,
      canonicalParams: [param('resolution')],
      requestParams: { resolution: explicit('720p') },
      declarations: [decl('resolution', { kind: 'supports' })],
    });
    expect(r.effective.upstream).toEqual({ resolution: '720p' });
  });

  it('domain narrows the filter domain only — it never transforms the value', () => {
    const r = resolveEffectiveParams({
      operation: OP,
      canonicalParams: [param('resolution')],
      requestParams: { resolution: explicit('720p') },
      declarations: [decl('resolution', { kind: 'domain', values: ['720p', '1080p'] })],
    });
    expect(r.effective.canonical).toEqual({ resolution: '720p' });
    expect(r.effective.upstream).toEqual({ resolution: '720p' });
  });

  it('default-tagged request values resolve exactly like explicit ones (isDefault is filter-only)', () => {
    const r = resolveEffectiveParams({
      operation: OP,
      canonicalParams: [param('resolution')],
      requestParams: { resolution: dflt('720p') },
      declarations: [],
    });
    expect(r.effective.canonical).toEqual({ resolution: '720p' });
  });

  it('falls back to the canonical default when the request omits the param entirely', () => {
    const r = resolveEffectiveParams({
      operation: OP,
      canonicalParams: [param('resolution', { default: '480p' })],
      requestParams: {},
      declarations: [],
    });
    expect(r.effective.canonical).toEqual({ resolution: '480p' });
    expect(r.effective.upstream).toEqual({ resolution: '480p' });
  });

  it('omits params with no request value and no default', () => {
    const r = resolveEffectiveParams({
      operation: OP,
      canonicalParams: [param('seed')],
      requestParams: {},
      declarations: [],
    });
    expect(r.effective.canonical).toEqual({});
    expect(r.effective.upstream).toEqual({});
  });

  it('ignores request params unknown to the canonical contract', () => {
    const r = resolveEffectiveParams({
      operation: OP,
      canonicalParams: [param('resolution')],
      requestParams: { resolution: explicit('720p'), bogus: explicit('x') },
      declarations: [],
    });
    expect(r.effective.canonical).toEqual({ resolution: '720p' });
    expect(r.effective.upstream).toEqual({ resolution: '720p' });
  });

  describe('map', () => {
    it('upstreamName renames the wire key, value untouched', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('resolution')],
        requestParams: { resolution: explicit('720p') },
        declarations: [decl('resolution', { kind: 'map', upstreamName: 'res' })],
      });
      expect(r.effective.canonical).toEqual({ resolution: '720p' });
      expect(r.effective.upstream).toEqual({ res: '720p' });
    });

    it('values maps canonical to upstream values — canonical bag stays canonical (双值分离)', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('resolution')],
        requestParams: { resolution: explicit('720p') },
        declarations: [
          decl('resolution', { kind: 'map', values: { '720p': 'hd', '1080p': 'fhd' } }),
        ],
      });
      expect(r.effective.canonical).toEqual({ resolution: '720p' });
      expect(r.effective.upstream).toEqual({ resolution: 'hd' });
    });

    it('values keys are the stringified canonical value (numeric canonical values match)', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('fps', { type: 'int' })],
        requestParams: { fps: explicit(24) },
        declarations: [decl('fps', { kind: 'map', values: { '24': 'cinema' } })],
      });
      expect(r.effective.upstream).toEqual({ fps: 'cinema' });
    });

    it('a partial values map carries uncovered values as-is (honest passthrough)', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('resolution')],
        requestParams: { resolution: explicit('4k') },
        declarations: [decl('resolution', { kind: 'map', values: { '720p': 'hd' } })],
      });
      expect(r.effective.upstream).toEqual({ resolution: '4k' });
    });

    it('scale+offset translates numbers linearly', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('duration', { type: 'int' })],
        requestParams: { duration: explicit(5) },
        declarations: [decl('duration', { kind: 'map', scale: 1000, offset: 500 })],
      });
      expect(r.effective.canonical).toEqual({ duration: 5 });
      expect(r.effective.upstream).toEqual({ duration: 5500 });
    });

    it('scale defaults to 1 when only offset is declared, offset to 0 when only scale', () => {
      const offsetOnly = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('duration', { type: 'int' })],
        requestParams: { duration: explicit(5) },
        declarations: [decl('duration', { kind: 'map', offset: 2 })],
      });
      expect(offsetOnly.effective.upstream).toEqual({ duration: 7 });
      const scaleOnly = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('duration', { type: 'int' })],
        requestParams: { duration: explicit(5) },
        declarations: [decl('duration', { kind: 'map', scale: 60 })],
      });
      expect(scaleOnly.effective.upstream).toEqual({ duration: 300 });
    });

    it('scale never applies to non-numeric values (carried as-is)', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('resolution')],
        requestParams: { resolution: explicit('720p') },
        declarations: [decl('resolution', { kind: 'map', scale: 2 })],
      });
      expect(r.effective.upstream).toEqual({ resolution: '720p' });
    });

    it('values wins for covered values; scale applies to uncovered numbers', () => {
      const canonicalParams = [param('duration', { type: 'int' })];
      const declarations = [decl('duration', { kind: 'map', values: { '5': 'short' }, scale: 10 })];
      const covered = resolveEffectiveParams({
        operation: OP,
        canonicalParams,
        requestParams: { duration: explicit(5) },
        declarations,
      });
      expect(covered.effective.upstream).toEqual({ duration: 'short' });
      const uncovered = resolveEffectiveParams({
        operation: OP,
        canonicalParams,
        requestParams: { duration: explicit(8) },
        declarations,
      });
      expect(uncovered.effective.upstream).toEqual({ duration: 80 });
    });

    it('upstreamName + values combine (rename and translate)', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('resolution')],
        requestParams: { resolution: explicit('1080p') },
        declarations: [
          decl('resolution', {
            kind: 'map',
            upstreamName: 'size',
            values: { '1080p': '1920x1080' },
          }),
        ],
      });
      expect(r.effective.canonical).toEqual({ resolution: '1080p' });
      expect(r.effective.upstream).toEqual({ size: '1920x1080' });
    });
  });

  describe('fixed', () => {
    it('records the declared value on BOTH sides when no upstreamValue is given', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('resolution')],
        requestParams: { resolution: explicit('1080p') },
        declarations: [decl('resolution', { kind: 'fixed', value: '1080p' })],
      });
      expect(r.effective.canonical).toEqual({ resolution: '1080p' });
      expect(r.effective.upstream).toEqual({ resolution: '1080p' });
    });

    it('separates canonical (value) from upstream (upstreamValue) — 双值分离', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('resolution')],
        requestParams: { resolution: dflt('1080p') },
        declarations: [decl('resolution', { kind: 'fixed', value: '1080p', upstreamValue: 'fhd' })],
      });
      expect(r.effective.canonical).toEqual({ resolution: '1080p' });
      expect(r.effective.upstream).toEqual({ resolution: 'fhd' });
    });

    it('materializes even when the request never carried the param', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('watermark', { type: 'boolean' })],
        requestParams: {},
        declarations: [decl('watermark', { kind: 'fixed', value: true })],
      });
      expect(r.effective.canonical).toEqual({ watermark: true });
      expect(r.effective.upstream).toEqual({ watermark: true });
    });
  });

  it('unsupported excludes the param from both bags', () => {
    const r = resolveEffectiveParams({
      operation: OP,
      canonicalParams: [param('resolution'), param('seed', { type: 'int' })],
      requestParams: { resolution: explicit('720p'), seed: dflt(42) },
      declarations: [decl('seed', { kind: 'unsupported' })],
    });
    expect(r.effective.canonical).toEqual({ resolution: '720p' });
    expect(r.effective.upstream).toEqual({ resolution: '720p' });
  });

  describe('precedence: operator > upstream > canonical default', () => {
    it('operator fixed overrides upstream fixed for the same param', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('resolution')],
        requestParams: { resolution: dflt('720p') },
        declarations: [
          decl('resolution', { kind: 'fixed', value: '720p' }, 'upstream'),
          decl('resolution', { kind: 'fixed', value: '540p' }, 'operator'),
        ],
      });
      expect(r.effective.canonical).toEqual({ resolution: '540p' });
      expect(r.effective.upstream).toEqual({ resolution: '540p' });
    });

    it('operator map overrides upstream map wholesale', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('resolution')],
        requestParams: { resolution: explicit('720p') },
        declarations: [
          decl('resolution', { kind: 'map', upstreamName: 'res', values: { '720p': 'hd' } }),
          decl(
            'resolution',
            { kind: 'map', upstreamName: 'video_size', values: { '720p': '1280x720' } },
            'operator',
          ),
        ],
      });
      expect(r.effective.upstream).toEqual({ video_size: '1280x720' });
    });

    it('operator unsupported (delete variant) wins over upstream supports', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('seed', { type: 'int' })],
        requestParams: { seed: explicit(42) },
        declarations: [
          decl('seed', { kind: 'supports' }),
          decl('seed', { kind: 'unsupported' }, 'operator'),
        ],
      });
      expect(r.effective.canonical).toEqual({});
      expect(r.effective.upstream).toEqual({});
    });

    it('operator fixed composes with the upstream map for wire name and value translation', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('resolution')],
        requestParams: { resolution: explicit('720p') },
        declarations: [
          decl('resolution', {
            kind: 'map',
            upstreamName: 'res',
            values: { '720p': 'hd', '1080p': 'fhd' },
          }),
          decl('resolution', { kind: 'fixed', value: '1080p' }, 'operator'),
        ],
      });
      // Operator pins the canonical value; the upstream dialect fact (wire key
      // 'res', spelling 'fhd') still applies on the upstream side.
      expect(r.effective.canonical).toEqual({ resolution: '1080p' });
      expect(r.effective.upstream).toEqual({ res: 'fhd' });
    });

    it('operator fixed upstreamValue bypasses the upstream map translation', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('resolution')],
        requestParams: { resolution: explicit('720p') },
        declarations: [
          decl('resolution', { kind: 'map', upstreamName: 'res', values: { '1080p': 'fhd' } }),
          decl(
            'resolution',
            { kind: 'fixed', value: '1080p', upstreamValue: 'FULL_HD' },
            'operator',
          ),
        ],
      });
      expect(r.effective.canonical).toEqual({ resolution: '1080p' });
      expect(r.effective.upstream).toEqual({ res: 'FULL_HD' });
    });
  });

  describe('constraint + translation aspects are orthogonal (BUG1/BUG2 回归)', () => {
    const domainRow = decl('resolution', { kind: 'domain', values: ['720p', '1080p'] });
    const mapRow = decl('resolution', {
      kind: 'map',
      upstreamName: 'res',
      values: { '720p': 'hd', '1080p': 'fhd' },
    });

    it('same-origin domain + map BOTH apply: domain constrains, map renames and translates (exploit A)', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('resolution', { billingRelevant: true })],
        requestParams: { resolution: explicit('720p') },
        declarations: [domainRow, mapRow],
      });
      expect(r.effective.canonical).toEqual({ resolution: '720p' });
      // Pre-fix the map row was silently dropped: wire key stayed 'resolution'
      // and the value stayed '720p' → upstream 400.
      expect(r.effective.upstream).toEqual({ res: 'hd' });
      expect(r.billingDims).toEqual({ resolution: '720p' });
    });

    it('declaration row ORDER never matters: map-then-domain resolves identically (exploit B, resolution side)', () => {
      const forward = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('resolution', { billingRelevant: true })],
        requestParams: { resolution: explicit('720p') },
        declarations: [domainRow, mapRow],
      });
      const reversed = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('resolution', { billingRelevant: true })],
        requestParams: { resolution: explicit('720p') },
        declarations: [mapRow, domainRow],
      });
      expect(reversed).toEqual(forward);
    });

    it('same-origin fixed + map compose: fixed pins the canonical value, map renames and spells the wire value', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('resolution')],
        requestParams: { resolution: explicit('720p') },
        declarations: [decl('resolution', { kind: 'fixed', value: '1080p' }), mapRow],
      });
      expect(r.effective.canonical).toEqual({ resolution: '1080p' });
      expect(r.effective.upstream).toEqual({ res: 'fhd' });
    });

    it("same-origin fixed.upstreamValue outranks that origin's map translation (pin spelling wins)", () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('resolution')],
        requestParams: { resolution: explicit('720p') },
        declarations: [
          decl('resolution', { kind: 'fixed', value: '1080p', upstreamValue: 'FHD_WIRE' }),
          mapRow,
        ],
      });
      expect(r.effective.canonical).toEqual({ resolution: '1080p' });
      expect(r.effective.upstream).toEqual({ res: 'FHD_WIRE' });
    });

    it('a pure-value operator map keeps the upstream wire name (BUG2: operator 收紧不可抹掉上游 wire 事实)', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('resolution')],
        requestParams: { resolution: explicit('720p') },
        declarations: [
          decl('resolution', { kind: 'map', upstreamName: 'res', values: { '720p': 'hd' } }),
          decl('resolution', { kind: 'map', values: { '720p': 'HD_FORCED' } }, 'operator'),
        ],
      });
      expect(r.effective.canonical).toEqual({ resolution: '720p' });
      // Pre-fix the operator map replaced the upstream map WHOLESALE: the wire
      // key fell back to the canonical name → { resolution: 'HD_FORCED' }.
      expect(r.effective.upstream).toEqual({ res: 'HD_FORCED' });
    });

    it('an operator map that does not cover the value falls through to the upstream translation', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('resolution')],
        requestParams: { resolution: explicit('1080p') },
        declarations: [
          mapRow,
          decl('resolution', { kind: 'map', values: { '720p': 'HD_FORCED' } }, 'operator'),
        ],
      });
      expect(r.effective.upstream).toEqual({ res: 'fhd' });
    });
  });

  describe('billingDims', () => {
    it('carries only billing_relevant params at their effective canonical values', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [
          param('resolution', { billingRelevant: true }),
          param('duration', { type: 'int', billingRelevant: true, default: 5 }),
          param('seed', { type: 'int' }),
        ],
        requestParams: { resolution: explicit('720p'), seed: explicit(42) },
        declarations: [],
      });
      expect(r.billingDims).toEqual({ resolution: '720p', duration: 5 });
    });

    it('uses the fixed declared value for pinned billing params (honest actual value)', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('resolution', { billingRelevant: true, default: '720p' })],
        requestParams: { resolution: dflt('720p') },
        declarations: [decl('resolution', { kind: 'fixed', value: '720p', upstreamValue: 'hd' })],
      });
      expect(r.billingDims).toEqual({ resolution: '720p' });
      expect(r.effective.upstream).toEqual({ resolution: 'hd' });
    });

    it('billing dims track the canonical value, never the mapped upstream value (红线回归)', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('resolution', { billingRelevant: true })],
        requestParams: { resolution: explicit('1080p') },
        declarations: [
          decl('resolution', {
            kind: 'map',
            upstreamName: 'size',
            values: { '1080p': '1920x1080' },
          }),
        ],
      });
      expect(r.billingDims).toEqual({ resolution: '1080p' });
      expect(r.effective.canonical).toEqual({ resolution: '1080p' });
      expect(r.effective.upstream).toEqual({ size: '1920x1080' });
    });
  });

  describe('operation scoping', () => {
    it('ignores declarations pinned to a different operation', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('resolution')],
        requestParams: { resolution: explicit('720p') },
        declarations: [
          decl('resolution', { kind: 'fixed', value: '1080p' }, 'upstream', 'images.generation'),
        ],
      });
      expect(r.effective.canonical).toEqual({ resolution: '720p' });
    });

    it('an operation-specific row wins over the all-operations row', () => {
      const r = resolveEffectiveParams({
        operation: OP,
        canonicalParams: [param('resolution')],
        requestParams: { resolution: explicit('720p') },
        declarations: [
          decl('resolution', { kind: 'map', values: { '720p': 'generic' } }),
          decl('resolution', { kind: 'map', values: { '720p': 'video_hd' } }, 'upstream', OP),
        ],
      });
      expect(r.effective.upstream).toEqual({ resolution: 'video_hd' });
    });
  });
});
