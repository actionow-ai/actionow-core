import { describe, expect, it } from 'vitest';

import { priceProviderCost } from '../src/pricing/methods.js';

/**
 * Track 5 — `provider_cost`: the SERVED channel's ACTUAL cost (µUSD) for a call,
 * `roundHalfUp((in×inputCostPer1m + out×outputCostPer1m) / 1e6)`. Independent of
 * the customer charge — drives margin analytics only. Null cost cols → 0.
 */
describe('priceProviderCost (served channel cost, Track 5)', () => {
  it('prices observed usage at the channel cost rates (µUSD/1M)', () => {
    // in=10 @ $1/1M, out=5 @ $2/1M: (10*1_000_000 + 5*2_000_000)/1e6 = 20 µUSD.
    expect(priceProviderCost({ input_tokens: 10, output_tokens: 5 }, 1_000_000n, 2_000_000n)).toBe(
      20n,
    );
  });

  it('treats null cost columns as 0 (subscription channel ≈ 0 cost)', () => {
    expect(priceProviderCost({ input_tokens: 1000, output_tokens: 500 }, null, null)).toBe(0n);
  });

  it('treats a single null cost column as 0 for that side', () => {
    // Only output is priced: 500 @ $2/1M = 1 µUSD.
    expect(priceProviderCost({ input_tokens: 1000, output_tokens: 500 }, null, 2_000_000n)).toBe(
      1000n,
    );
  });

  it('rounds half up on the per-1M divide', () => {
    // 1 input token @ inputCost=500_000 → 500_000/1e6 = 0.5 → roundHalfUp → 1.
    expect(priceProviderCost({ input_tokens: 1, output_tokens: 0 }, 500_000n, 0n)).toBe(1n);
    // 499_999/1e6 → 0.499999 → 0.
    expect(priceProviderCost({ input_tokens: 1, output_tokens: 0 }, 499_999n, 0n)).toBe(0n);
  });

  it('treats missing token counts as 0', () => {
    expect(priceProviderCost({}, 1_000_000n, 2_000_000n)).toBe(0n);
  });
});
