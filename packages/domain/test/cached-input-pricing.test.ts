import type { PricebookEntry } from '@actionow/contracts';
import { modelTokenSpecSchema } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { priceModelToken } from '../src/pricing/methods.js';
import { settle } from '../src/pricing/quote.js';

/**
 * 用拆分计费 — bill prompt-cached input tokens at the cheaper cached rate.
 *
 * `priceModelToken` now reads `usage.cached_input_tokens` (captured by #70) and,
 * when `spec.cachedInputPrice` is set, prices `cached = clamp(cached_input_tokens,
 * 0, input_tokens)` at the cached rate and the remaining input at `inputPrice`.
 * Output (which already includes any reasoning tokens) is billed once at
 * `outputPrice`. When the cached rate or the cached usage is absent, the result
 * is byte-identical to the all-input-at-`inputPrice` math (the regression
 * invariant). The cached/non-cached split is folded into the SAME product so the
 * single round-half-up + `groupRatioBps` semantics are preserved.
 *
 * Worked example used below: $3/1M input, $0.30/1M cached, $15/1M output
 * (3_000_000 / 300_000 / 15_000_000 µUSD per 1M).
 */
const IN = 3_000_000; // $3 / 1M
const CACHED = 300_000; // $0.30 / 1M
const OUT = 15_000_000; // $15 / 1M

function spec(opts: {
  inputPrice?: number;
  outputPrice?: number;
  cachedInputPrice?: number;
  groupRatioBps?: number;
}) {
  return modelTokenSpecSchema.parse({
    method: 'model_token',
    inputPrice: opts.inputPrice ?? IN,
    outputPrice: opts.outputPrice ?? OUT,
    ...(opts.cachedInputPrice !== undefined ? { cachedInputPrice: opts.cachedInputPrice } : {}),
    ...(opts.groupRatioBps !== undefined ? { groupRatioBps: opts.groupRatioBps } : {}),
  });
}

describe('用拆分计费: priceModelToken cached-input rate', () => {
  it('bills cached input cheaper than all-at-input (worked example)', () => {
    // 1,000,000 input of which 800,000 cached, 0 output:
    //   non-cached 200,000 @ $3/1M  = 200_000 * 3_000_000   = 6.0e11
    //   cached     800,000 @ $0.30/1M = 800_000 * 300_000   = 2.4e11
    //   product = 8.4e11 → /1e6 = 840_000 µUSD = $0.84.
    const usage = { input_tokens: 1_000_000, cached_input_tokens: 800_000, output_tokens: 0 };
    const cost = priceModelToken(spec({ cachedInputPrice: CACHED }), usage);
    expect(cost).toBe(840_000n);

    // All input at the full rate would be 1_000_000 @ $3/1M = $3.00 = 3_000_000 µUSD.
    const allAtInput = priceModelToken(spec({}), usage);
    expect(allAtInput).toBe(3_000_000n);
    expect(cost).toBeLessThan(allAtInput);
  });

  it('is byte-identical to the all-input math when cachedInputPrice is absent', () => {
    // No cached rate on the spec → cached_input_tokens is ignored, ALL input at inputPrice.
    const usage = { input_tokens: 1_000_000, cached_input_tokens: 800_000, output_tokens: 500_000 };
    const withCachedUsageNoRate = priceModelToken(spec({}), usage);
    const noCachedUsage = priceModelToken(spec({}), {
      input_tokens: 1_000_000,
      output_tokens: 500_000,
    });
    // in 1e6 @ $3/1M = 3.0e6 µUSD; out 5e5 @ $15/1M = 7.5e6 µUSD; total 10.5e6 µUSD.
    expect(withCachedUsageNoRate).toBe(10_500_000n);
    expect(withCachedUsageNoRate).toBe(noCachedUsage);
  });

  it('with a cached rate but NO cached usage, prices identically to no-rate', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 500_000 };
    expect(priceModelToken(spec({ cachedInputPrice: CACHED }), usage)).toBe(
      priceModelToken(spec({}), usage),
    );
  });

  it('clamps cached to input_tokens (cached cannot exceed total input)', () => {
    // cached reported as 2,000,000 but input is only 1,000,000 → clamp to 1,000,000.
    //   1_000_000 @ $0.30/1M = 1_000_000 * 300_000 = 3.0e11 → /1e6 = 300_000 µUSD.
    const cost = priceModelToken(spec({ cachedInputPrice: CACHED }), {
      input_tokens: 1_000_000,
      cached_input_tokens: 2_000_000,
      output_tokens: 0,
    });
    expect(cost).toBe(300_000n);
    // Equals pricing ALL input at the cached rate (every input token was cached).
    const allCached = priceModelToken(spec({ inputPrice: CACHED, cachedInputPrice: CACHED }), {
      input_tokens: 1_000_000,
      output_tokens: 0,
    });
    expect(cost).toBe(allCached);
  });

  it('clamps a negative cached count to zero', () => {
    const usage = { input_tokens: 1_000_000, cached_input_tokens: -5, output_tokens: 0 };
    // Negative cached → 0 cached → all input at inputPrice = $3.00.
    expect(priceModelToken(spec({ cachedInputPrice: CACHED }), usage)).toBe(3_000_000n);
  });

  it('does NOT double-count reasoning tokens (reasoning is a subset of output)', () => {
    // reasoning_tokens is already inside output_tokens; it must not add cost.
    const withReasoning = priceModelToken(spec({ cachedInputPrice: CACHED }), {
      input_tokens: 1_000_000,
      cached_input_tokens: 800_000,
      output_tokens: 500_000,
      reasoning_tokens: 200_000,
    });
    const withoutReasoningKey = priceModelToken(spec({ cachedInputPrice: CACHED }), {
      input_tokens: 1_000_000,
      cached_input_tokens: 800_000,
      output_tokens: 500_000,
    });
    expect(withReasoning).toBe(withoutReasoningKey);
    // cached input $0.84 + output 5e5 @ $15/1M ($7.50) = 8_340_000 µUSD.
    expect(withReasoning).toBe(8_340_000n);
  });

  it('composes with groupRatioBps (the operator tier factor) in a single round', () => {
    // base product = cached worked example with output:
    //   non-cached 200_000*3_000_000   = 6.0e11
    //   cached     800_000*300_000     = 2.4e11   (input subtotal 8.4e11)
    //   output     500_000*15_000_000  = 7.5e12
    //   product = 7.5e12 + 8.4e11 = 8_340_000_000_000
    // ×1.2 (12000 bps) then /(1e6 × 10000), single round-half-up:
    //   8_340_000_000_000 * 12000 / (1e6 * 10000)
    //   = 1.00080e17 / 1e10 = 10_008_000 µUSD.
    const cost = priceModelToken(spec({ cachedInputPrice: CACHED, groupRatioBps: 12_000 }), {
      input_tokens: 1_000_000,
      cached_input_tokens: 800_000,
      output_tokens: 500_000,
    });
    expect(cost).toBe(10_008_000n);
    // At the default 10000 bps it's exactly the un-ratioed cost.
    const atDefault = priceModelToken(spec({ cachedInputPrice: CACHED }), {
      input_tokens: 1_000_000,
      cached_input_tokens: 800_000,
      output_tokens: 500_000,
    });
    expect(atDefault).toBe(8_340_000n);
  });
});

describe('用拆分计费: settle() over a breakdown-bearing usage vector', () => {
  function entry(cachedInputPrice?: number): PricebookEntry {
    return {
      resourceId: 'r1',
      resourceVersion: 1,
      version: 1,
      method: 'model_token',
      timing: 'post',
      spec: {
        method: 'model_token',
        inputPrice: IN,
        outputPrice: OUT,
        ...(cachedInputPrice !== undefined ? { cachedInputPrice } : {}),
      },
    } as unknown as PricebookEntry;
  }

  it('settles cheaper when usage carries cached_input_tokens AND the spec has a cached rate', () => {
    const usage = { input_tokens: 1_000_000, cached_input_tokens: 800_000, output_tokens: 500_000 };
    const withBreakdown = settle(entry(CACHED), usage);
    // Same usage WITHOUT the breakdown key settles at the full input rate.
    const noBreakdown = settle(entry(CACHED), { input_tokens: 1_000_000, output_tokens: 500_000 });
    expect(withBreakdown).toBe(8_340_000n);
    expect(noBreakdown).toBe(10_500_000n);
    expect(withBreakdown).toBeLessThan(noBreakdown);
  });

  it('regression: a spec WITHOUT a cached rate settles identically regardless of the breakdown', () => {
    const a = settle(entry(), {
      input_tokens: 1_000_000,
      cached_input_tokens: 800_000,
      output_tokens: 500_000,
    });
    const b = settle(entry(), { input_tokens: 1_000_000, output_tokens: 500_000 });
    expect(a).toBe(b);
    expect(a).toBe(10_500_000n);
  });
});
