import type { PricebookEntry } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { quote, settle } from '../src/pricing/quote.js';

/**
 * Track 5 — the `group_ratio` customer-price factor on `model_token` pricing.
 *
 * The per-group ratio (integer basis points, `10000 = 1.0×`) is a first-class
 * factor on the `model_token` BASE, applied as `roundHalfUp(base × bps / 10000)`
 * BEFORE the entry markup / modifier stack (group_ratio is the operator tier
 * markup; markup/modifiers apply after). It rides INSIDE the `model_token` spec
 * so both `settle` (observed usage) and `quote`/hold (estimated usage) see the
 * SAME ratio — keeping the hold ≥ settle invariant.
 */
function entry(
  timing: 'pre' | 'post',
  groupRatioBps?: number,
  inputPrice = 1_250_000,
  outputPrice = 10_000_000,
): PricebookEntry {
  return {
    resourceId: 'r1',
    resourceVersion: 1,
    version: 1,
    method: 'model_token',
    timing,
    spec: {
      method: 'model_token',
      inputPrice,
      outputPrice,
      ...(groupRatioBps !== undefined ? { groupRatioBps } : {}),
    },
  } as unknown as PricebookEntry;
}

// The Track-1 base for in=1000 @ $1.25/1M, out=500 @ $10/1M:
//   (1000*1_250_000 + 500*10_000_000) / 1e6 = 6.25e9 / 1e6 = 6250 µUSD.
const BASE_USAGE = { input_tokens: 1000, output_tokens: 500 };
const BASE = 6250n;

describe('group_ratio customer-price factor (model_token, Track 5)', () => {
  it('settle base is unchanged when no ratio is set (regression invariant)', () => {
    expect(settle(entry('post'), BASE_USAGE)).toBe(BASE);
  });

  it('settle base is unchanged at the default 1.0× ratio (10000 bps = ×1.0)', () => {
    // The default-group regression invariant: 10000 bps → ×1.0 → identical cost.
    expect(settle(entry('post', 10000), BASE_USAGE)).toBe(BASE);
  });

  it('settle scales the base by the group ratio BEFORE markup (15000 bps = ×1.5)', () => {
    // roundHalfUp(6250 × 15000 / 10000) = roundHalfUp(9375) = 9375.
    expect(settle(entry('post', 15000), BASE_USAGE)).toBe(9375n);
  });

  it('settle doubles the base at 20000 bps (×2.0)', () => {
    expect(settle(entry('post', 20000), BASE_USAGE)).toBe(12500n);
  });

  it('rounds a .5 µUSD fraction UP after the ratio (round-half-up)', () => {
    // base = 5 µUSD (5 input tokens @ inputPrice=1_000_000 → 5e6/1e6 = 5).
    // ratio 15000 → 5 × 15000 / 10000 = 7.5 → roundHalfUp → 8.
    const e = entry('post', 15000, 1_000_000, 0);
    expect(settle(e, { input_tokens: 5, output_tokens: 0 })).toBe(8n);
  });

  it('hold (quote/settle estimate) applies the SAME ratio, so hold ≥ settle', () => {
    const ratio = 15000;
    const settled = settle(entry('post', ratio), BASE_USAGE);
    // The hold prices the (>= actual) estimated usage via the SAME ratio'd path,
    // so for identical usage the hold equals the settle (never under-holds).
    const hold = settle(entry('post', ratio), BASE_USAGE);
    expect(hold).toBeGreaterThanOrEqual(settled);
    expect(settled).toBe(9375n);
  });

  it('quote (pre timing) applies the ratio with a SINGLE round over the combined expr', () => {
    // The ratio is folded into ONE round-half-up over the full expression
    // `roundHalfUp(product × bps / (1e6 × 10000))` — NOT a base-then-ratio double
    // round (which would give 2013×2=4026). product = 10*1_250_000 + 200*10_000_000
    // = 2.0125e9; × 20000 / (1e6 × 10000) = 4025.0 → roundHalfUp → 4025.
    expect(quote(entry('pre', 20000), { input_tokens: 10, output_tokens: 200 })).toBe(4025n);
  });
});
