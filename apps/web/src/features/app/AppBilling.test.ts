import { describe, expect, it } from 'vitest';

import { toMinorUnits } from './AppBilling';

describe('AppBilling toMinorUnits', () => {
  it('converts a major amount to integer minor units (×100), rounding float error', () => {
    expect(toMinorUnits(10)).toBe(1000);
    expect(toMinorUnits(9.99)).toBe(999); // 9.99*100 = 998.9999… → 999
    expect(toMinorUnits(0)).toBe(0);
    expect(toMinorUnits(0.1)).toBe(10);
  });
});
