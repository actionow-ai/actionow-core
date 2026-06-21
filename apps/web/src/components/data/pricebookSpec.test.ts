import { describe, expect, it } from 'vitest';

import { buildSpec, emptySpecForm, validateFormula } from './pricebookSpec';

function form(overrides: Partial<ReturnType<typeof emptySpecForm>>) {
  return { ...emptySpecForm(), ...overrides };
}

describe('buildSpec', () => {
  it('unit collapses dimension rows into a rate map', () => {
    expect(buildSpec('unit', form({ dimensions: [{ name: 'tokens', rate: 1 }] }))).toEqual({
      method: 'unit',
      dimensions: { tokens: { rate: 1 } },
    });
  });

  it('passthrough emits the markup when enabled', () => {
    expect(
      buildSpec('passthrough', form({ markup: { enabled: true, type: 'percent', value: 20 } })),
    ).toEqual({
      method: 'passthrough',
      markup: { type: 'percent', value: 20 },
    });
  });

  it('formula trims the expression', () => {
    expect(buildSpec('formula', form({ expr: 'a + b' }))).toEqual({
      method: 'formula',
      expr: 'a + b',
    });
  });

  it('matrix collapses table rows into a keyed table', () => {
    expect(buildSpec('matrix', form({ key: ['res'], table: [{ k: '720p', cell: 1000 }] }))).toEqual(
      {
        method: 'matrix',
        key: ['res'],
        table: { '720p': 1000 },
      },
    );
  });

  it('fixed emits only the method (amount supplied via fixedCredits)', () => {
    expect(buildSpec('fixed', emptySpecForm())).toEqual({ method: 'fixed' });
  });
});

describe('validateFormula', () => {
  it('accepts identifiers, ints, and + - * ( )', () => {
    expect(validateFormula('a + b*2')).toBe(true);
  });

  it('rejects division, decimals, and other operators', () => {
    expect(validateFormula('a / b')).toBe(false);
    expect(validateFormula('1.5')).toBe(false);
    expect(validateFormula('x%y')).toBe(false);
  });

  it('rejects an empty expression', () => {
    expect(validateFormula('   ')).toBe(false);
  });
});
