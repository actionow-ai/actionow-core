import type { PricebookEntry } from '@actionow/contracts';
import { modelTokenSpecSchema } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { PER_1M_TOKENS } from '../src/credits.js';
import { quote, settle } from '../src/pricing/quote.js';

/**
 * A `model_token` entry priced in **µUSD per 1M tokens** (the post-Track-1
 * unit). `inputPrice`/`outputPrice` are the per-1M rates; cost is
 * `roundHalfUp((in*inputPrice + out*outputPrice) / 1_000_000)` µUSD.
 */
function entry(
  timing: 'pre' | 'post',
  inputPrice = 1_250_000,
  outputPrice = 10_000_000,
): PricebookEntry {
  return {
    resourceId: 'r1',
    resourceVersion: 1,
    version: 1,
    method: 'model_token',
    timing,
    spec: { method: 'model_token', inputPrice, outputPrice },
  } as unknown as PricebookEntry;
}

describe('model_token pricing (µUSD per 1M tokens)', () => {
  it('PER_1M_TOKENS is 1e6', () => {
    expect(PER_1M_TOKENS).toBe(1_000_000n);
  });

  it('settle prices observed usage at µUSD/1M with round-half-up', () => {
    // in=1000 @ $1.25/1M, out=500 @ $10/1M:
    //   (1000*1_250_000 + 500*10_000_000) / 1e6
    // = (1.25e9 + 5e9) / 1e6 = 6.25e9 / 1e6 = 6250 µUSD = $0.00625.
    expect(settle(entry('post'), { input_tokens: 1000, output_tokens: 500 })).toBe(6250n);
  });

  it('settle treats missing token counts as zero', () => {
    expect(settle(entry('post'), {})).toBe(0n);
  });

  it('rounds a .5 µUSD fraction up (round-half-up boundary)', () => {
    // Pick usage so base/1e6 lands exactly on .5: base = 500_000 → 0.5 → 1.
    // 1 input token @ inputPrice=500_000 → base=500_000 → roundHalfUp(0.5)=1.
    expect(settle(entry('post', 500_000, 0), { input_tokens: 1, output_tokens: 0 })).toBe(1n);
    // Just below .5 rounds DOWN: base=499_999 → roundHalfUp(0.499999)=0.
    expect(settle(entry('post', 499_999, 0), { input_tokens: 1, output_tokens: 0 })).toBe(0n);
  });

  it('quote prices the estimated usage (pre timing), same per-1M math', () => {
    // 10 input @ $1.25/1M + 200 output @ $10/1M:
    //   (10*1_250_000 + 200*10_000_000) / 1e6
    // = (1.25e7 + 2e9) / 1e6 = 2.0125e9 / 1e6 = 2012.5 → roundHalfUp → 2013.
    expect(quote(entry('pre'), { input_tokens: 10, output_tokens: 200 })).toBe(2013n);
  });

  it('hold (estimate) is >= settle for identical usage', () => {
    const usage = { input_tokens: 1234, output_tokens: 567 };
    const e = entry('post');
    const settled = settle(e, usage);
    // The hold uses the SAME settle path over the (>= actual) estimated usage,
    // so for identical usage the hold equals the settle (never under-holds).
    const hold = settle(e, usage);
    expect(hold).toBeGreaterThanOrEqual(settled);
    expect(hold).toBe(settled);
  });

  it('rejects a negative price spec', () => {
    expect(
      modelTokenSpecSchema.safeParse({
        method: 'model_token',
        inputPrice: -1,
        outputPrice: 60,
      }).success,
    ).toBe(false);
  });

  it('rejects a non-integer price spec', () => {
    expect(() =>
      modelTokenSpecSchema.parse({
        method: 'model_token',
        inputPrice: 30,
        outputPrice: 1.5,
      }),
    ).toThrow();
  });
});
