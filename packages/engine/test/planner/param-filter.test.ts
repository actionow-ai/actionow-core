// §4 parameter-aware candidate filtering unit tests (model-supply-greenfield
// 批次3 slice 2). Covers the five routing rules, the margin-inversion red
// line (rule 2 on defaults), strict vs lenient, and rule-5 statelessness.
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

import {
  filterCandidates,
  type FilterCandidatesInput,
  PARAMETER_DROPPED_WARNING,
} from '../../src/planner/index.js';

const OP: Operation = 'video.generation';

function param(
  name: string,
  o: {
    type?: CanonicalParamType;
    billingRelevant?: boolean;
    default?: unknown;
    values?: (string | number)[];
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
  return p;
}

function decl(
  paramName: string,
  rule: ParamDeclRule,
  origin: ParamDeclOrigin = 'upstream',
): OfferingParamDecl {
  return { param: paramName, origin, rule };
}

function explicit(value: unknown): CanonicalParamValue {
  return { value, isDefault: false };
}

function dflt(value: unknown): CanonicalParamValue {
  return { value, isDefault: true };
}

describe('filterCandidates', () => {
  describe('rule 2: billing_relevant filters on the RESOLVED value — the margin-inversion killer', () => {
    const resolution = param('resolution', {
      billingRelevant: true,
      values: ['720p', '1080p'],
    });

    it('filters an offering whose fixed billing value differs from the resolved DEFAULT (毛利倒挂)', () => {
      const r = filterCandidates({
        operation: OP,
        canonicalParams: [resolution],
        requestParams: { resolution: dflt('720p') },
        candidates: [
          {
            offeringId: 'off-fixed-1080',
            declarations: [decl('resolution', { kind: 'fixed', value: '1080p' })],
          },
          { offeringId: 'off-plain', declarations: [] },
        ],
      });
      expect(r.survivors.map((s) => s.offeringId)).toEqual(['off-plain']);
      expect(r.rejected).toEqual([
        {
          offeringId: 'off-fixed-1080',
          param: 'resolution',
          reason: expect.stringContaining('1080p'),
        },
      ]);
      expect(r.error).toBeUndefined();
    });

    it('keeps an offering whose fixed billing value equals the resolved default', () => {
      const r = filterCandidates({
        operation: OP,
        canonicalParams: [resolution],
        requestParams: { resolution: dflt('1080p') },
        candidates: [
          {
            offeringId: 'off-fixed-1080',
            declarations: [decl('resolution', { kind: 'fixed', value: '1080p' })],
          },
        ],
      });
      expect(r.survivors.map((s) => s.offeringId)).toEqual(['off-fixed-1080']);
      expect(r.survivors[0]?.billingDims).toEqual({ resolution: '1080p' });
    });

    it('forces DEFAULT billing values through domain filtering (defaults are not exempt)', () => {
      const r = filterCandidates({
        operation: OP,
        canonicalParams: [resolution],
        requestParams: { resolution: dflt('1080p') },
        candidates: [
          {
            offeringId: 'off-720-only',
            declarations: [decl('resolution', { kind: 'domain', values: ['720p'] })],
          },
        ],
      });
      expect(r.survivors).toEqual([]);
      expect(r.rejected[0]?.param).toBe('resolution');
      expect(r.error?.code).toBe('unsupported_parameter');
    });

    it('falls back to the canonical default when the facade omitted the billing param', () => {
      const r = filterCandidates({
        operation: OP,
        canonicalParams: [param('resolution', { billingRelevant: true, default: '720p' })],
        requestParams: {},
        candidates: [
          {
            offeringId: 'off-fixed-1080',
            declarations: [decl('resolution', { kind: 'fixed', value: '1080p' })],
          },
        ],
      });
      expect(r.survivors).toEqual([]);
      expect(r.rejected[0]?.param).toBe('resolution');
    });

    it('explicit billing values must fall inside the offering domain', () => {
      const r = filterCandidates({
        operation: OP,
        canonicalParams: [resolution],
        requestParams: { resolution: explicit('1080p') },
        candidates: [
          {
            offeringId: 'off-720-only',
            declarations: [decl('resolution', { kind: 'domain', values: ['720p'] })],
          },
          {
            offeringId: 'off-both',
            declarations: [decl('resolution', { kind: 'domain', values: ['720p', '1080p'] })],
          },
        ],
      });
      expect(r.survivors.map((s) => s.offeringId)).toEqual(['off-both']);
      expect(r.survivors[0]?.billingDims).toEqual({ resolution: '1080p' });
    });

    it('rejects billing params declared unsupported (unverifiable billing dimension)', () => {
      const r = filterCandidates({
        operation: OP,
        canonicalParams: [resolution],
        requestParams: { resolution: dflt('720p') },
        candidates: [
          { offeringId: 'off-unsup', declarations: [decl('resolution', { kind: 'unsupported' })] },
        ],
      });
      expect(r.survivors).toEqual([]);
      expect(r.rejected[0]?.reason).toContain('unsupported');
    });

    it('checks numeric range domains on billing values', () => {
      const duration = param('duration', { type: 'int', billingRelevant: true, default: 10 });
      const r = filterCandidates({
        operation: OP,
        canonicalParams: [duration],
        requestParams: { duration: dflt(10) },
        candidates: [
          { offeringId: 'off-short', declarations: [decl('duration', { kind: 'domain', max: 5 })] },
          {
            offeringId: 'off-long',
            declarations: [decl('duration', { kind: 'domain', min: 5, max: 30 })],
          },
        ],
      });
      expect(r.survivors.map((s) => s.offeringId)).toEqual(['off-long']);
      expect(r.rejected[0]?.offeringId).toBe('off-short');
    });
  });

  describe('rule 1: explicit params filter on existence + domain', () => {
    it('rejects candidates declaring an explicit param unsupported (strict default)', () => {
      const r = filterCandidates({
        operation: OP,
        canonicalParams: [param('seed', { type: 'int' })],
        requestParams: { seed: explicit(42) },
        candidates: [
          { offeringId: 'off-no-seed', declarations: [decl('seed', { kind: 'unsupported' })] },
          { offeringId: 'off-seed', declarations: [] },
        ],
      });
      expect(r.survivors.map((s) => s.offeringId)).toEqual(['off-seed']);
      expect(r.rejected).toEqual([
        {
          offeringId: 'off-no-seed',
          param: 'seed',
          reason: expect.stringContaining('unsupported'),
        },
      ]);
    });

    it('rejects explicit values outside a domain declaration', () => {
      const r = filterCandidates({
        operation: OP,
        canonicalParams: [param('style')],
        requestParams: { style: explicit('anime') },
        candidates: [
          {
            offeringId: 'off-realistic',
            declarations: [decl('style', { kind: 'domain', values: ['realistic'] })],
          },
        ],
      });
      expect(r.survivors).toEqual([]);
      expect(r.rejected[0]?.reason).toContain('anime');
    });

    it('rejects explicit values that disagree with a fixed pin', () => {
      const r = filterCandidates({
        operation: OP,
        canonicalParams: [param('style')],
        requestParams: { style: explicit('anime') },
        candidates: [
          {
            offeringId: 'off-pinned',
            declarations: [decl('style', { kind: 'fixed', value: 'realistic' })],
          },
        ],
      });
      expect(r.survivors).toEqual([]);
      expect(r.rejected[0]?.param).toBe('style');
    });
  });

  describe('rule 3: non-billing defaults do not participate in filtering', () => {
    it('keeps a candidate whose domain excludes a non-billing DEFAULT value', () => {
      const r = filterCandidates({
        operation: OP,
        canonicalParams: [param('style')],
        requestParams: { style: dflt('anime') },
        candidates: [
          {
            offeringId: 'off-realistic',
            declarations: [decl('style', { kind: 'domain', values: ['realistic'] })],
          },
        ],
      });
      expect(r.survivors.map((s) => s.offeringId)).toEqual(['off-realistic']);
    });

    it('keeps a candidate declaring a non-billing DEFAULT param unsupported (resolution omits it)', () => {
      const r = filterCandidates({
        operation: OP,
        canonicalParams: [param('seed', { type: 'int' })],
        requestParams: { seed: dflt(42) },
        candidates: [
          { offeringId: 'off-no-seed', declarations: [decl('seed', { kind: 'unsupported' })] },
        ],
      });
      expect(r.survivors.map((s) => s.offeringId)).toEqual(['off-no-seed']);
      expect(r.survivors[0]?.effective.upstream).toEqual({});
      expect(r.warnings).toEqual([]);
    });
  });

  describe('rule 4: all filtered / strict vs lenient', () => {
    it('yields unsupported_parameter with per-param exclusion details when every candidate falls', () => {
      const r = filterCandidates({
        operation: OP,
        canonicalParams: [param('seed', { type: 'int' })],
        requestParams: { seed: explicit(42) },
        candidates: [
          { offeringId: 'off-a', declarations: [decl('seed', { kind: 'unsupported' })] },
          { offeringId: 'off-b', declarations: [decl('seed', { kind: 'unsupported' })] },
        ],
      });
      expect(r.survivors).toEqual([]);
      expect(r.error).toMatchObject({
        code: 'unsupported_parameter',
        retryable: false,
        failover: false,
      });
      expect(r.error?.details).toMatchObject({ excludedBy: { seed: ['off-a', 'off-b'] } });
      expect(r.error?.message).toContain('seed');
    });

    it('lenient drops non-billing unsupported EXPLICIT params and echoes a warning (no silent drop)', () => {
      const r = filterCandidates({
        operation: OP,
        canonicalParams: [param('resolution'), param('seed', { type: 'int' })],
        requestParams: { resolution: explicit('720p'), seed: explicit(42) },
        candidates: [
          { offeringId: 'off-no-seed', declarations: [decl('seed', { kind: 'unsupported' })] },
        ],
        mode: 'lenient',
      });
      expect(r.survivors.map((s) => s.offeringId)).toEqual(['off-no-seed']);
      expect(r.survivors[0]?.dropped).toEqual(['seed']);
      expect(r.survivors[0]?.effective.canonical).toEqual({ resolution: '720p' });
      expect(r.survivors[0]?.effective.upstream).toEqual({ resolution: '720p' });
      expect(r.warnings).toEqual([
        {
          code: PARAMETER_DROPPED_WARNING,
          message: expect.stringContaining('off-no-seed'),
          param: 'seed',
        },
      ]);
      expect(r.error).toBeUndefined();
    });

    it('strict rejects exactly where lenient drops', () => {
      const input: FilterCandidatesInput = {
        operation: OP,
        canonicalParams: [param('seed', { type: 'int' })],
        requestParams: { seed: explicit(42) },
        candidates: [
          { offeringId: 'off-no-seed', declarations: [decl('seed', { kind: 'unsupported' })] },
        ],
      };
      const strict = filterCandidates(input);
      expect(strict.survivors).toEqual([]);
      expect(strict.error?.code).toBe('unsupported_parameter');
      const lenient = filterCandidates({ ...input, mode: 'lenient' });
      expect(lenient.survivors).toHaveLength(1);
      expect(lenient.warnings).toHaveLength(1);
    });

    it('lenient NEVER relaxes billing_relevant filtering (倒挂红线)', () => {
      const r = filterCandidates({
        operation: OP,
        canonicalParams: [param('resolution', { billingRelevant: true, default: '720p' })],
        requestParams: { resolution: dflt('720p') },
        candidates: [
          { offeringId: 'off-unsup', declarations: [decl('resolution', { kind: 'unsupported' })] },
          {
            offeringId: 'off-fixed-1080',
            declarations: [decl('resolution', { kind: 'fixed', value: '1080p' })],
          },
        ],
        mode: 'lenient',
      });
      expect(r.survivors).toEqual([]);
      expect(r.rejected.map((x) => x.offeringId)).toEqual(['off-unsup', 'off-fixed-1080']);
      expect(r.error?.code).toBe('unsupported_parameter');
      expect(r.warnings).toEqual([]);
    });

    it('lenient still rejects explicit domain violations (only unsupported is droppable)', () => {
      const r = filterCandidates({
        operation: OP,
        canonicalParams: [param('style')],
        requestParams: { style: explicit('anime') },
        candidates: [
          {
            offeringId: 'off-realistic',
            declarations: [decl('style', { kind: 'domain', values: ['realistic'] })],
          },
        ],
        mode: 'lenient',
      });
      expect(r.survivors).toEqual([]);
      expect(r.error?.code).toBe('unsupported_parameter');
    });
  });

  describe('map rows never mask constraint rows (BUG1 exploit B 回归)', () => {
    const resolution = param('resolution', {
      billingRelevant: true,
      values: ['720p', '1080p', '4k'],
    });
    const mapRow = decl('resolution', {
      kind: 'map',
      upstreamName: 'res',
      values: { '720p': 'hd', '1080p': 'fhd' },
    });
    const domainRow = decl('resolution', { kind: 'domain', values: ['720p', '1080p'] });

    it('a map row listed BEFORE a domain row does not exempt billing values from the domain (毛利倒挂红线)', () => {
      // Pre-fix the map row occupied the single upstream slot and the domain
      // row was silently dropped → '4k' passed filtering, was billed at the 4k
      // tier, and the upstream never served it.
      const r = filterCandidates({
        operation: OP,
        canonicalParams: [resolution],
        requestParams: { resolution: explicit('4k') },
        candidates: [{ offeringId: 'off-map-first', declarations: [mapRow, domainRow] }],
      });
      expect(r.survivors).toEqual([]);
      expect(r.rejected).toEqual([
        {
          offeringId: 'off-map-first',
          param: 'resolution',
          reason: expect.stringContaining('domain'),
        },
      ]);
      expect(r.error?.code).toBe('unsupported_parameter');
    });

    it('in-domain values survive with the translated upstream bag regardless of row order', () => {
      for (const declarations of [
        [mapRow, domainRow],
        [domainRow, mapRow],
      ]) {
        const r = filterCandidates({
          operation: OP,
          canonicalParams: [resolution],
          requestParams: { resolution: explicit('720p') },
          candidates: [{ offeringId: 'off-x', declarations }],
        });
        expect(r.survivors).toHaveLength(1);
        expect(r.survivors[0]?.effective.upstream).toEqual({ res: 'hd' });
        expect(r.survivors[0]?.billingDims).toEqual({ resolution: '720p' });
      }
    });

    it('a map row does not mask an unsupported row (existence still filters)', () => {
      const r = filterCandidates({
        operation: OP,
        canonicalParams: [param('seed', { type: 'int' })],
        requestParams: { seed: explicit(42) },
        candidates: [
          {
            offeringId: 'off-x',
            declarations: [
              decl('seed', { kind: 'map', upstreamName: 'random_seed' }),
              decl('seed', { kind: 'unsupported' }),
            ],
          },
        ],
      });
      expect(r.survivors).toEqual([]);
      expect(r.rejected[0]?.reason).toContain('unsupported');
    });
  });

  describe('structural equality for object values (BUG3 回归)', () => {
    function judge(fixedValue: unknown, explicitValue: unknown) {
      return filterCandidates({
        operation: OP,
        canonicalParams: [param('cfg', { type: 'json' })],
        requestParams: { cfg: explicit(explicitValue) },
        candidates: [
          {
            offeringId: 'off-pin',
            declarations: [decl('cfg', { kind: 'fixed', value: fixedValue })],
          },
        ],
      });
    }

    it('object key ORDER never matters: {a,b} equals {b,a} (no false 400)', () => {
      const r = judge({ b: 2, a: 1 }, { a: 1, b: 2 });
      expect(r.survivors).toHaveLength(1);
      expect(r.error).toBeUndefined();
    });

    it('a key present with value undefined is NOT an absent key', () => {
      const r = judge({}, { a: undefined });
      expect(r.survivors).toEqual([]);
      expect(r.rejected[0]?.param).toBe('cfg');
    });

    it('NaN equals NaN inside objects', () => {
      expect(judge({ x: NaN }, { x: NaN }).survivors).toHaveLength(1);
    });

    it('NaN does not equal Infinity (JSON null-collapse abolished — no false serve)', () => {
      expect(judge({ x: NaN }, { x: Infinity }).survivors).toEqual([]);
    });

    it('nested objects compare by key set, arrays element-wise in order', () => {
      expect(
        judge({ outer: { b: 'x', a: [1, 2] } }, { outer: { a: [1, 2], b: 'x' } }).survivors,
      ).toHaveLength(1);
      expect(judge({ outer: { a: [1, 2] } }, { outer: { a: [2, 1] } }).survivors).toEqual([]);
      expect(judge({ a: [1] }, { a: { 0: 1 } }).survivors).toEqual([]);
    });
  });

  describe('operator precedence inside filtering', () => {
    it('operator domain tightens on top of upstream domain (intersection)', () => {
      const resolution = param('resolution', { billingRelevant: true, values: ['720p', '1080p'] });
      const candidates = [
        {
          offeringId: 'off-tightened',
          declarations: [
            decl('resolution', { kind: 'domain', values: ['720p', '1080p'] }),
            decl('resolution', { kind: 'domain', values: ['720p'] }, 'operator'),
          ],
        },
      ];
      const outside = filterCandidates({
        operation: OP,
        canonicalParams: [resolution],
        requestParams: { resolution: explicit('1080p') },
        candidates,
      });
      expect(outside.survivors).toEqual([]);
      const inside = filterCandidates({
        operation: OP,
        canonicalParams: [resolution],
        requestParams: { resolution: explicit('720p') },
        candidates,
      });
      expect(inside.survivors).toHaveLength(1);
    });

    it('operator unsupported (delete variant) governs existence over upstream supports', () => {
      const r = filterCandidates({
        operation: OP,
        canonicalParams: [param('seed', { type: 'int' })],
        requestParams: { seed: explicit(42) },
        candidates: [
          {
            offeringId: 'off-deleted',
            declarations: [
              decl('seed', { kind: 'supports' }),
              decl('seed', { kind: 'unsupported' }, 'operator'),
            ],
          },
        ],
      });
      expect(r.survivors).toEqual([]);
      expect(r.rejected[0]?.reason).toContain('unsupported');
    });
  });

  describe('survivors and rule 5 (stateless re-run)', () => {
    const canonicalParams = [
      param('resolution', { billingRelevant: true, values: ['720p', '1080p'] }),
      param('duration', { type: 'int', billingRelevant: true, default: 5 }),
    ];
    const requestParams = {
      resolution: explicit('1080p'),
      duration: dflt(5),
    };
    const candidates = [
      {
        offeringId: 'off-a',
        declarations: [
          decl('resolution', {
            kind: 'map',
            upstreamName: 'size',
            values: { '1080p': '1920x1080' },
          }),
        ],
      },
      {
        offeringId: 'off-b',
        declarations: [decl('duration', { kind: 'map', scale: 1000 })],
      },
      {
        offeringId: 'off-dead',
        declarations: [decl('resolution', { kind: 'domain', values: ['720p'] })],
      },
    ];

    it('partial survival: each survivor carries its OWN effective params and billing dims', () => {
      const r = filterCandidates({ operation: OP, canonicalParams, requestParams, candidates });
      expect(r.survivors.map((s) => s.offeringId)).toEqual(['off-a', 'off-b']);
      expect(r.rejected.map((x) => x.offeringId)).toEqual(['off-dead']);
      const [a, b] = r.survivors;
      expect(a?.effective.upstream).toEqual({ size: '1920x1080', duration: 5 });
      expect(a?.effective.canonical).toEqual({ resolution: '1080p', duration: 5 });
      expect(b?.effective.upstream).toEqual({ resolution: '1080p', duration: 5000 });
      expect(b?.effective.canonical).toEqual({ resolution: '1080p', duration: 5 });
      expect(a?.billingDims).toEqual({ resolution: '1080p', duration: 5 });
      expect(b?.billingDims).toEqual({ resolution: '1080p', duration: 5 });
    });

    it('re-filtering the surviving subset is a fixed point (per failover hop)', () => {
      const first = filterCandidates({ operation: OP, canonicalParams, requestParams, candidates });
      const subset = candidates.filter((c) =>
        first.survivors.some((s) => s.offeringId === c.offeringId),
      );
      const second = filterCandidates({
        operation: OP,
        canonicalParams,
        requestParams,
        candidates: subset,
      });
      expect(second.survivors).toEqual(first.survivors);
      expect(second.rejected).toEqual([]);
      expect(second.error).toBeUndefined();
    });
  });

  it('empty candidate list yields no error (not a parameter problem)', () => {
    const r = filterCandidates({
      operation: OP,
      canonicalParams: [param('resolution')],
      requestParams: { resolution: explicit('720p') },
      candidates: [],
    });
    expect(r.survivors).toEqual([]);
    expect(r.rejected).toEqual([]);
    expect(r.error).toBeUndefined();
  });
});
