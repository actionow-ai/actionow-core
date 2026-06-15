import { describe, expect, it } from 'vitest';

import { applyPercent, creditsToMicro, MICRO_PER_CREDIT, microToDisplay } from '../src/credits.js';

describe('credits', () => {
  it('MICRO_PER_CREDIT is 1e6', () => {
    expect(MICRO_PER_CREDIT).toBe(1_000_000n);
  });
  it('creditsToMicro converts a decimal credit value exactly', () => {
    expect(creditsToMicro(12.5)).toBe(12_500_000n);
    expect(creditsToMicro(0.00015)).toBe(150n);
  });
  it('microToDisplay formats µcredits as a credit string', () => {
    expect(microToDisplay(12_500_000n)).toBe('12.5');
    expect(microToDisplay(150n)).toBe('0.00015');
  });
  it('applyPercent rounds half up', () => {
    // 10% off 1000005 => 1000005 * 90 / 100 = 900004.5 -> 900005
    expect(applyPercent(1_000_005n, -10)).toBe(900_005n);
    // 20% add on 10 => 10 * 120 / 100 = 12
    expect(applyPercent(10n, 20)).toBe(12n);
  });
});
