import { describe, expect, it } from 'vitest';

import { compareMicroDesc, formatCreditsSigned } from './money';

describe('compareMicroDesc', () => {
  it('sorts µ-credit strings descending (largest first), no floats', () => {
    expect(['1000000', '3000000', '2000000'].sort(compareMicroDesc)).toEqual([
      '3000000',
      '2000000',
      '1000000',
    ]);
  });

  it('orders values beyond Number.MAX_SAFE_INTEGER correctly', () => {
    const big = '9007199254740993000000'; // ≫ 2^53
    const bigger = '9007199254740994000000';
    expect(compareMicroDesc(big, bigger)).toBe(1); // big comes after bigger (descending)
    expect([big, bigger].sort(compareMicroDesc)).toEqual([bigger, big]);
  });

  it('returns 0 for equal values', () => {
    expect(compareMicroDesc('5', '5')).toBe(0);
  });
});

describe('formatCreditsSigned', () => {
  it('prefixes + for positive, keeps - for negative, leaves 0 unsigned', () => {
    expect(formatCreditsSigned('2500000')).toBe('+2.5');
    expect(formatCreditsSigned('-2500000')).toBe('-2.5');
    expect(formatCreditsSigned('0')).toBe('0');
  });
});
