import { describe, expect, it } from 'vitest';

import {
  applyPercent,
  creditsToMicro,
  MICRO_PER_CREDIT,
  MICRO_USD_PER_USD,
  microToDisplay,
  PER_1M_TOKENS,
  roundHalfUpDiv,
} from '../src/credits.js';

describe('credits (µUSD doctrine)', () => {
  it('MICRO_PER_CREDIT is 1e6', () => {
    expect(MICRO_PER_CREDIT).toBe(1_000_000n);
  });
  it('MICRO_USD_PER_USD is 1e6 (1 credit = $1, µunit = µUSD)', () => {
    // The doctrine anchor: 1 USD = 1 credit = 1_000_000 µUSD. The existing
    // µunit IS µUSD with no rescale of the credit path.
    expect(MICRO_USD_PER_USD).toBe(1_000_000n);
    expect(MICRO_USD_PER_USD).toBe(MICRO_PER_CREDIT);
  });
  it('PER_1M_TOKENS is 1e6', () => {
    expect(PER_1M_TOKENS).toBe(1_000_000n);
  });
  it('creditsToMicro converts a decimal credit value exactly', () => {
    expect(creditsToMicro(12.5)).toBe(12_500_000n);
    expect(creditsToMicro(0.00015)).toBe(150n);
    // $1 (1 credit) → 1_000_000 µUSD.
    expect(creditsToMicro(1)).toBe(1_000_000n);
  });
  it('microToDisplay formats µUSD as a USD/credit string', () => {
    expect(microToDisplay(12_500_000n)).toBe('12.5');
    expect(microToDisplay(150n)).toBe('0.00015');
  });
  it('roundHalfUpDiv divides with round-half-up', () => {
    // exact
    expect(roundHalfUpDiv(6_250_000_000n, 1_000_000n)).toBe(6250n);
    // .5 rounds up
    expect(roundHalfUpDiv(500_000n, 1_000_000n)).toBe(1n);
    // just below .5 rounds down
    expect(roundHalfUpDiv(499_999n, 1_000_000n)).toBe(0n);
    // .5 boundary at a larger quotient: 2_012_500_000 / 1e6 = 2012.5 → 2013
    expect(roundHalfUpDiv(2_012_500_000n, 1_000_000n)).toBe(2013n);
  });
  it('applyPercent rounds half up', () => {
    // 10% off 1000005 => 1000005 * 90 / 100 = 900004.5 -> 900005
    expect(applyPercent(1_000_005n, -10)).toBe(900_005n);
    // 20% add on 10 => 10 * 120 / 100 = 12
    expect(applyPercent(10n, 20)).toBe(12n);
  });
});
