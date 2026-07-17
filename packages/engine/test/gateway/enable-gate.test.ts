// 批次5 slice1 — the offering ENABLE gate (enable-gate.ts): the batch-3
// CONFIG-TIME INVARIANTS contract (effective-params.ts header) + §10
// needs_pricing, each invariant locked by a violating config that MUST be
// rejected with a structured (gate, param, operation) verdict, and a clean
// config that MUST pass. Pure — no I/O.
import type {
  CanonicalParam,
  ModelOperation,
  OfferingParamDecl,
  PriceSpec,
} from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import type { EnableGateInput } from '../../src/index.js';
import { validateEnableGates } from '../../src/index.js';

// --- fixture helpers -----------------------------------------------------------

function param(o: Partial<CanonicalParam> & { name: string }): CanonicalParam {
  return { type: 'string', billingRelevant: false, required: false, ...o };
}

function op(params: CanonicalParam[]): ModelOperation {
  return { operation: 'video.generation', paradigms: ['task'], slow: false, params };
}

function decl(
  paramName: string,
  origin: 'upstream' | 'operator',
  rule: OfferingParamDecl['rule'],
): OfferingParamDecl {
  return { param: paramName, origin, rule };
}

const MATRIX_CARD: { spec: PriceSpec; tierDims: string[] } = {
  spec: {
    method: 'matrix',
    key: ['resolution'],
    table: { '720p': 1_000, '1080p': 2_000, hd: 1_000 },
  },
  tierDims: ['resolution'],
};

function input(o: {
  params?: CanonicalParam[];
  declarations?: OfferingParamDecl[];
  priceCardId?: string | null;
  saleCard?: EnableGateInput['saleCard'] | null;
}): EnableGateInput {
  return {
    model: {
      name: 'test-model',
      priceCardId: o.priceCardId === undefined ? 'card-1' : o.priceCardId,
      operations: [op(o.params ?? [])],
    },
    offering: { id: 'off-1', paramDeclarations: o.declarations ?? [] },
    saleCard: o.saleCard === null ? undefined : (o.saleCard ?? MATRIX_CARD),
  };
}

function gatesOf(violations: ReturnType<typeof validateEnableGates>): string[] {
  return violations.map((v) => v.gate);
}

// --- gate 1: needs_pricing (§10) --------------------------------------------------

describe('enable gate 1 — needs_pricing', () => {
  it('rejects a model without a sale price card', () => {
    const v = validateEnableGates(input({ priceCardId: null, saleCard: null }));
    expect(gatesOf(v)).toContain('needs_pricing');
  });

  it('rejects a DANGLING sale card (id set, row missing/soft-deleted)', () => {
    const v = validateEnableGates(input({ priceCardId: 'card-gone', saleCard: null }));
    expect(gatesOf(v)).toContain('needs_pricing');
    expect(v[0]?.message).toContain('missing or soft-deleted');
  });

  it('passes a priced model', () => {
    expect(validateEnableGates(input({}))).toEqual([]);
  });
});

// --- gate 2: operator variant ⊆ upstream domain (invariant ①) ----------------------

describe('enable gate 2 — operator_subset (运营者收紧不放宽)', () => {
  const resolution = param({ name: 'resolution', type: 'enum', values: ['720p', '1080p'] });

  it('rejects an operator FIXED pin outside the upstream domain', () => {
    const v = validateEnableGates(
      input({
        params: [resolution],
        declarations: [
          decl('resolution', 'upstream', { kind: 'domain', values: ['720p'] }),
          decl('resolution', 'operator', { kind: 'fixed', value: '1080p' }),
        ],
      }),
    );
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ gate: 'operator_subset', param: 'resolution' });
  });

  it('rejects an operator DOMAIN value the upstream does not serve', () => {
    const v = validateEnableGates(
      input({
        params: [resolution],
        declarations: [
          decl('resolution', 'upstream', { kind: 'domain', values: ['720p'] }),
          decl('resolution', 'operator', { kind: 'domain', values: ['720p', '1080p'] }),
        ],
      }),
    );
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ gate: 'operator_subset', param: 'resolution' });
    expect(v[0]?.message).toContain('1080p');
  });

  it("rejects an operator 'supports' (full domain) over a narrowed upstream", () => {
    const v = validateEnableGates(
      input({
        params: [resolution],
        declarations: [
          decl('resolution', 'upstream', { kind: 'domain', values: ['720p'] }),
          decl('resolution', 'operator', { kind: 'supports' }),
        ],
      }),
    );
    expect(gatesOf(v)).toEqual(['operator_subset']);
  });

  it('rejects ANY operator row on an upstream-unsupported param (existence leg)', () => {
    const v = validateEnableGates(
      input({
        params: [resolution],
        declarations: [
          decl('resolution', 'upstream', { kind: 'unsupported' }),
          decl('resolution', 'operator', { kind: 'fixed', value: '720p' }),
        ],
      }),
    );
    expect(gatesOf(v)).toEqual(['operator_subset']);
  });

  it('rejects an operator numeric range WIDER than the upstream range', () => {
    const duration = param({ name: 'duration', type: 'int', min: 1, max: 60 });
    const v = validateEnableGates(
      input({
        params: [duration],
        declarations: [
          decl('duration', 'upstream', { kind: 'domain', min: 1, max: 10 }),
          decl('duration', 'operator', { kind: 'domain', min: 1, max: 30 }),
        ],
      }),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('exceeds the upstream max');
  });

  it('rejects an operator map that translates a canonical value the upstream does not serve', () => {
    const v = validateEnableGates(
      input({
        params: [resolution],
        declarations: [
          decl('resolution', 'upstream', { kind: 'domain', values: ['720p'] }),
          decl('resolution', 'operator', { kind: 'map', values: { '1080p': 'fhd' } }),
        ],
      }),
    );
    expect(gatesOf(v)).toEqual(['operator_subset']);
  });

  it('passes a pure TIGHTENING (fixed inside the upstream domain, narrower range)', () => {
    const duration = param({ name: 'duration', type: 'int', min: 1, max: 60 });
    const v = validateEnableGates(
      input({
        params: [resolution, duration],
        declarations: [
          decl('resolution', 'upstream', { kind: 'domain', values: ['720p', '1080p'] }),
          decl('resolution', 'operator', { kind: 'fixed', value: '720p' }),
          decl('duration', 'upstream', { kind: 'domain', min: 1, max: 10 }),
          decl('duration', 'operator', { kind: 'domain', min: 2, max: 5 }),
        ],
      }),
    );
    expect(v).toEqual([]);
  });
});

// --- gate 3: canonical default ⊆ offering domain (invariant ②) ----------------------

describe('enable gate 3 — default_in_domain', () => {
  it('rejects a canonical default the offering domain excludes (runtime would passthrough it upstream)', () => {
    const style = param({
      name: 'style',
      type: 'enum',
      values: ['vivid', 'natural'],
      default: 'vivid',
    });
    const v = validateEnableGates(
      input({
        params: [style],
        declarations: [decl('style', 'upstream', { kind: 'domain', values: ['natural'] })],
      }),
    );
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      gate: 'default_in_domain',
      param: 'style',
      operation: 'video.generation',
    });
  });

  it('rejects a numeric default outside the declared bounds', () => {
    const duration = param({ name: 'duration', type: 'int', default: 30 });
    const v = validateEnableGates(
      input({
        params: [duration],
        declarations: [decl('duration', 'upstream', { kind: 'domain', min: 1, max: 10 })],
      }),
    );
    expect(gatesOf(v)).toEqual(['default_in_domain']);
  });

  it('passes when the default is admitted / pinned / unsupported', () => {
    const style = param({
      name: 'style',
      type: 'enum',
      values: ['vivid', 'natural'],
      default: 'vivid',
    });
    const rules: OfferingParamDecl['rule'][] = [
      { kind: 'domain', values: ['vivid', 'natural'] },
      { kind: 'fixed', value: 'natural' },
      { kind: 'unsupported' },
    ];
    for (const rule of rules) {
      const v = validateEnableGates(
        input({ params: [style], declarations: [decl('style', 'upstream', rule)] }),
      );
      expect(v).toEqual([]);
    }
  });
});

// --- gate 4: billing translation must not cross price tiers (invariant ③) ------------

describe('enable gate 4 — billing_translation_tier (毛利倒挂防线)', () => {
  const resolution = param({
    name: 'resolution',
    type: 'enum',
    values: ['720p', '1080p'],
    billingRelevant: true,
  });

  it('rejects a map translation that crosses matrix tiers (720p charged, 1080p delivered)', () => {
    const v = validateEnableGates(
      input({
        params: [resolution],
        declarations: [
          decl('resolution', 'upstream', { kind: 'map', values: { '720p': '1080p' } }),
        ],
      }),
    );
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ gate: 'billing_translation_tier', param: 'resolution' });
    expect(v[0]?.message).toContain('crosses price tiers');
  });

  it('rejects a FIXED pin whose upstreamValue crosses matrix tiers', () => {
    const v = validateEnableGates(
      input({
        params: [resolution],
        declarations: [
          decl('resolution', 'upstream', {
            kind: 'fixed',
            value: '720p',
            upstreamValue: '1080p',
          }),
        ],
      }),
    );
    expect(gatesOf(v)).toEqual(['billing_translation_tier']);
  });

  it('rejects a translation to a value the sale card has NO cell for', () => {
    const v = validateEnableGates(
      input({
        params: [resolution],
        declarations: [decl('resolution', 'upstream', { kind: 'map', values: { '720p': '4k' } })],
      }),
    );
    expect(gatesOf(v)).toEqual(['billing_translation_tier']);
    expect(v[0]?.message).toContain('no cell');
  });

  it('passes a SAME-tier rename translation (720p → hd, equal cells)', () => {
    const v = validateEnableGates(
      input({
        params: [resolution],
        declarations: [
          decl('resolution', 'upstream', {
            kind: 'map',
            upstreamName: 'res',
            values: { '720p': 'hd' },
          }),
        ],
      }),
    );
    expect(v).toEqual([]);
  });

  it('rejects a non-identity linear rescale on a param priced per unit (credits card)', () => {
    const duration = param({ name: 'duration', type: 'int', min: 1, billingRelevant: true });
    const creditsCard: EnableGateInput['saleCard'] = {
      spec: {
        method: 'credits',
        creditValueMicroUsd: 10_000,
        baseCredits: 0,
        dimensions: { duration: { credits: 5 } },
      },
      tierDims: ['duration'],
    };
    const v = validateEnableGates(
      input({
        params: [duration],
        declarations: [decl('duration', 'upstream', { kind: 'map', scale: 1000 })],
        saleCard: creditsCard,
      }),
    );
    expect(gatesOf(v)).toContain('billing_translation_tier');
  });

  it('passes a translation on a param the sale card does not price (fixed-amount card)', () => {
    const v = validateEnableGates(
      input({
        params: [resolution],
        declarations: [
          decl('resolution', 'upstream', { kind: 'map', values: { '720p': '1080p' } }),
        ],
        saleCard: { spec: { method: 'fixed', amount: 5_000 }, tierDims: [] },
      }),
    );
    expect(v).toEqual([]);
  });

  it('never checks tier honesty on values the offering does not serve (domain-excluded map keys are dead config, caught by gate 2 when operator-origin)', () => {
    const v = validateEnableGates(
      input({
        params: [resolution],
        declarations: [
          decl('resolution', 'upstream', { kind: 'domain', values: ['720p'] }),
          // upstream map covering 1080p too — 1080p is filtered at routing, so
          // its (crossing) translation can never bill.
          decl('resolution', 'upstream', { kind: 'map', values: { '1080p': '720p' } }),
        ],
      }),
    );
    expect(v).toEqual([]);
  });
});

// --- all four gates together --------------------------------------------------------

describe('enable gates — aggregate verdict', () => {
  it('reports EVERY violation in one pass (never fail-fast)', () => {
    const style = param({ name: 'style', type: 'enum', values: ['a', 'b'], default: 'a' });
    const resolution = param({
      name: 'resolution',
      type: 'enum',
      values: ['720p', '1080p'],
      billingRelevant: true,
    });
    const v = validateEnableGates(
      input({
        priceCardId: null,
        saleCard: null,
        params: [style, resolution],
        declarations: [
          decl('style', 'upstream', { kind: 'domain', values: ['b'] }), // default 'a' excluded
          decl('resolution', 'upstream', { kind: 'domain', values: ['720p'] }),
          decl('resolution', 'operator', { kind: 'fixed', value: '1080p' }), // widen
        ],
      }),
    );
    const gates = gatesOf(v);
    expect(gates).toContain('needs_pricing');
    expect(gates).toContain('operator_subset');
    expect(gates).toContain('default_in_domain');
  });
});
