import type { PricebookEntry } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import {
  applyMarkup,
  priceFormula,
  priceMatrix,
  priceUnit,
  quote,
  settle,
} from '../src/pricing/index.js';

const unitEntry: PricebookEntry = {
  resourceId: 'm',
  resourceVersion: 1,
  version: 1,
  method: 'unit',
  timing: 'post',
  spec: {
    method: 'unit',
    dimensions: { input_tokens: { rate: 150 }, output_tokens: { rate: 600 } },
  },
};
const matrixEntry: PricebookEntry = {
  resourceId: 'm',
  resourceVersion: 1,
  version: 1,
  method: 'matrix',
  timing: 'pre',
  spec: {
    method: 'matrix',
    key: ['resolution'],
    table: { '720p': 1_200_000, '1080p': 2_500_000 },
    multiplier: 'duration_seconds',
  },
};
const fixedEntry: PricebookEntry = {
  resourceId: 'cap',
  resourceVersion: 1,
  version: 1,
  method: 'fixed',
  timing: 'pre',
  spec: { method: 'fixed', amount: 10_000_000 },
};
const passEntry: PricebookEntry = {
  resourceId: 'cap',
  resourceVersion: 1,
  version: 1,
  method: 'passthrough',
  timing: 'post',
  spec: { method: 'passthrough', markup: { type: 'percent', value: 20 } },
};

describe('pricing', () => {
  it('unit settles by usage', () => {
    expect(settle(unitEntry, { input_tokens: 1000, output_tokens: 500 })).toBe(150_000n + 300_000n);
  });
  it('matrix quotes table * multiplier', () => {
    expect(quote(matrixEntry, { resolution: '1080p', duration_seconds: 5 })).toBe(12_500_000n);
  });
  it('matrix throws on missing key', () => {
    expect(() => quote(matrixEntry, { resolution: '4k', duration_seconds: 5 })).toThrow(
      /price_key_not_found/,
    );
  });
  it('fixed quotes its amount', () => {
    expect(quote(fixedEntry, {})).toBe(10_000_000n);
  });
  it('passthrough settles subtotal + markup', () => {
    expect(settle(passEntry, { subtotal: 1_000_000 })).toBe(1_200_000n);
  });
  it('formula evaluates restricted integer expr', () => {
    expect(
      priceFormula({ method: 'formula', expr: 'base + steps * 3' }, { base: 100, steps: 4 }),
    ).toBe(112n);
  });
  it('formula rejects division / eval injection', () => {
    expect(() => priceFormula({ method: 'formula', expr: 'base / 0' }, { base: 1 })).toThrow();
    expect(() => priceFormula({ method: 'formula', expr: 'process.exit(1)' }, {})).toThrow();
  });
});

describe('pricing — exhaustive', () => {
  it('priceUnit treats a missing dimension as zero usage', () => {
    expect(priceUnit(unitEntry.spec as never, { input_tokens: 1000 })).toBe(150_000n);
  });

  it('matrix applies both multiplier and perItem', () => {
    const entry: PricebookEntry = {
      ...matrixEntry,
      spec: {
        method: 'matrix',
        key: ['resolution'],
        table: { '1080p': 1_000_000 },
        multiplier: 'duration_seconds',
        perItem: 'count',
      },
    };
    // 1_000_000 * 5 * 3 = 15_000_000
    expect(quote(entry, { resolution: '1080p', duration_seconds: 5, count: 3 })).toBe(15_000_000n);
  });

  it('matrix defaults multiplier/perItem to 1 when absent from params', () => {
    expect(quote(matrixEntry, { resolution: '720p' })).toBe(1_200_000n);
  });

  it('matrix builds a composite key from multiple key dimensions', () => {
    const entry: PricebookEntry = {
      ...matrixEntry,
      spec: {
        method: 'matrix',
        key: ['resolution', 'fps'],
        table: { '1080p|60': 4_000_000 },
      },
    };
    expect(quote(entry, { resolution: '1080p', fps: 60 })).toBe(4_000_000n);
    expect(() => quote(entry, { resolution: '1080p', fps: 30 })).toThrow(/price_key_not_found/);
  });

  it('priceMatrix is callable directly', () => {
    expect(
      priceMatrix(matrixEntry.spec as never, { resolution: '720p', duration_seconds: 2 }),
    ).toBe(2_400_000n);
  });

  it('formula honours parentheses and operator precedence', () => {
    expect(priceFormula({ method: 'formula', expr: '(a + b) * c' }, { a: 2, b: 3, c: 4 })).toBe(
      20n,
    );
    expect(priceFormula({ method: 'formula', expr: 'a + b * c' }, { a: 2, b: 3, c: 4 })).toBe(14n);
  });

  it('formula supports subtraction and integer literals', () => {
    expect(priceFormula({ method: 'formula', expr: '10 - 3 - 2' }, {})).toBe(5n);
  });

  it('formula rejects unbalanced parens, unknown/negative vars, and empty result', () => {
    expect(() => priceFormula({ method: 'formula', expr: '(a + b' }, { a: 1, b: 2 })).toThrow(
      /invalid_pricing/,
    );
    expect(() => priceFormula({ method: 'formula', expr: 'a + b)' }, { a: 1, b: 2 })).toThrow(
      /invalid_pricing/,
    );
    expect(() => priceFormula({ method: 'formula', expr: 'missing + 1' }, {})).toThrow(
      /invalid_pricing/,
    );
    expect(() => priceFormula({ method: 'formula', expr: 'neg + 1' }, { neg: -5 })).toThrow(
      /invalid_pricing/,
    );
    expect(() => priceFormula({ method: 'formula', expr: 'frac + 1' }, { frac: 1.5 })).toThrow(
      /invalid_pricing/,
    );
  });

  it('formula rejects division, modulo and other illegal tokens', () => {
    expect(() => priceFormula({ method: 'formula', expr: 'a / b' }, { a: 4, b: 2 })).toThrow();
    expect(() => priceFormula({ method: 'formula', expr: 'a % b' }, { a: 4, b: 2 })).toThrow();
    expect(() => priceFormula({ method: 'formula', expr: 'a ** b' }, { a: 4, b: 2 })).toThrow();
    expect(() => priceFormula({ method: 'formula', expr: "require('fs')" }, {})).toThrow();
  });

  it('applyMarkup applies percent, flat, and undefined', () => {
    expect(applyMarkup(1_000_000n, { type: 'percent', value: 20 })).toBe(1_200_000n);
    expect(applyMarkup(1_000_000n, { type: 'flat', value: 50_000 })).toBe(1_050_000n);
    expect(applyMarkup(1_000_000n, undefined)).toBe(1_000_000n);
  });

  it('quote applies an entry-level percent markup over the base', () => {
    const entry: PricebookEntry = {
      ...fixedEntry,
      markup: { type: 'percent', value: 10 },
    };
    expect(quote(entry, {})).toBe(11_000_000n);
  });

  it('quote applies an entry-level flat markup over the base', () => {
    const entry: PricebookEntry = {
      ...fixedEntry,
      markup: { type: 'flat', value: 250_000 },
    };
    expect(quote(entry, {})).toBe(10_250_000n);
  });

  it('quote rejects post-only methods (unit/passthrough)', () => {
    expect(() => quote(unitEntry, {})).toThrow(/invalid_pricing/);
    expect(() => quote(passEntry, {})).toThrow(/invalid_pricing/);
  });

  it('settle rejects pre-only methods (fixed/matrix/formula)', () => {
    expect(() => settle(fixedEntry, {})).toThrow(/invalid_pricing/);
    expect(() => settle(matrixEntry, {})).toThrow(/invalid_pricing/);
  });

  it('settle stacks the entry markup on top of the passthrough markup', () => {
    const entry: PricebookEntry = {
      ...passEntry,
      markup: { type: 'flat', value: 100_000 },
    };
    // subtotal 1_000_000 -> *1.2 = 1_200_000 -> +100_000 = 1_300_000
    expect(settle(entry, { subtotal: 1_000_000 })).toBe(1_300_000n);
  });

  it('settle treats a missing passthrough subtotal as zero', () => {
    expect(settle(passEntry, {})).toBe(0n);
  });

  it('settle applies the entry markup on top of unit usage', () => {
    const entry: PricebookEntry = {
      ...unitEntry,
      markup: { type: 'percent', value: 50 },
    };
    // 150_000 -> *1.5 = 225_000
    expect(settle(entry, { input_tokens: 1000 })).toBe(225_000n);
  });
});
