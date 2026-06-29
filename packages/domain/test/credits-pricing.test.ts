import type { CreditsSpec, PricebookEntry } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { minimumHold, priceCredits, quote, settle } from '../src/pricing/index.js';

/**
 * The `credits` method (富媒体计费 — Vidu/Kling): the provider meters opaque
 * "credits"; the spec converts to integer µUSD via
 *   `credits = baseCredits + Σ dimensions[d].credits×v[d] + Σ addOns(flag truthy)`
 *   `cost   = credits × creditValueMicroUsd`.
 * All-integer bigint. The vector is read in the same snake_case shape as `unit`,
 * so the SAME spec drives `quote` (request params) and `settle` (observed usage).
 */

/** Worked-example spec: 1 credit = 10_000 µUSD; base 2 credits; per-second 1 credit; +5 credits on audio. */
const spec: CreditsSpec = {
  method: 'credits',
  creditValueMicroUsd: 10_000,
  baseCredits: 2,
  dimensions: { duration_seconds: { credits: 1 }, frames: { credits: 3 } },
  addOns: [{ flag: 'audio', credits: 5 }],
};

function entry(s: CreditsSpec, markup?: PricebookEntry['markup']): PricebookEntry {
  return {
    resourceId: 'vidu',
    resourceVersion: 1,
    version: 1,
    method: 'credits',
    timing: 'post',
    spec: s,
    ...(markup !== undefined ? { markup } : {}),
  };
}

describe('priceCredits (µUSD = credits × creditValueMicroUsd)', () => {
  it('base + per-dimension credits, no add-on', () => {
    // credits = base 2 + 4s×1 + 2frames×3 = 2 + 4 + 6 = 12; ×10_000 = 120_000 µUSD.
    expect(priceCredits(spec, { duration_seconds: 4, frames: 2 })).toBe(120_000n);
  });

  it('base only when no dimensions present (missing = 0)', () => {
    // credits = base 2; ×10_000 = 20_000 µUSD.
    expect(priceCredits(spec, {})).toBe(20_000n);
  });

  it('add-on credits added when the flag is truthy', () => {
    // base 2 + 3s×1 + audio 5 = 10 credits; ×10_000 = 100_000 µUSD.
    expect(priceCredits(spec, { duration_seconds: 3, audio: true })).toBe(100_000n);
  });

  it('add-on charged for a non-zero number / "true" / "1" / non-empty string', () => {
    // each variant flips the +5 add-on on: base 2 + 5 = 7 credits → 70_000 µUSD.
    for (const audio of [1, 1.0, 'true', '1', 'yes', true]) {
      expect(priceCredits(spec, { audio })).toBe(70_000n);
    }
  });

  it('add-on NOT charged for falsy flags (0, "0", "false", "", absent, false, null)', () => {
    // base 2 only → 20_000 µUSD; the add-on must stay off for every falsy form.
    for (const audio of [0, '0', 'false', 'FALSE', '', false, null, undefined]) {
      expect(priceCredits(spec, { audio })).toBe(20_000n);
    }
    expect(priceCredits(spec, {})).toBe(20_000n); // absent
  });

  it('clamps a fractional / negative dimension count to a non-negative integer', () => {
    // 2.9s truncs to 2; a negative count clamps to 0; never throws a BigInt RangeError.
    expect(priceCredits(spec, { duration_seconds: 2.9 })).toBe((2n + 2n) * 10_000n); // base2 + 2s
    expect(priceCredits(spec, { duration_seconds: -5 })).toBe(2n * 10_000n); // base only
  });

  it('a 0-value-per-credit spec costs 0 (all integer)', () => {
    const free: CreditsSpec = { ...spec, creditValueMicroUsd: 0 };
    expect(priceCredits(free, { duration_seconds: 100, audio: true })).toBe(0n);
  });
});

describe('credits dispatch through quote / settle', () => {
  it('settle prices observed usage (post timing)', () => {
    expect(settle(entry(spec), { duration_seconds: 4, frames: 2 })).toBe(120_000n);
  });

  it('quote prices estimated usage (pre — inputs from request params)', () => {
    expect(quote(entry(spec), { duration_seconds: 4, frames: 2 })).toBe(120_000n);
  });

  it('quote and settle agree for an identical vector (hold === settle)', () => {
    // A real `UsageVector` is `Record<string, number>`, so the audio flag arrives
    // as `1` here (settle's contract); `priceCredits` tolerates boolean/string
    // forms too — covered in the `priceCredits` block above.
    const v = { duration_seconds: 7, frames: 3, audio: 1 };
    expect(quote(entry(spec), v)).toBe(settle(entry(spec), v));
  });

  it('applies the entry percent markup over the credit base', () => {
    // base 120_000 µUSD × 1.5 = 180_000 µUSD.
    expect(
      settle(entry(spec, { type: 'percent', value: 50 }), { duration_seconds: 4, frames: 2 }),
    ).toBe(180_000n);
  });

  it('applies the entry flat markup over the credit base', () => {
    // base 20_000 µUSD + 5_000 flat = 25_000 µUSD.
    expect(settle(entry(spec, { type: 'flat', value: 5_000 }), {})).toBe(25_000n);
  });
});

describe('minimumHold for a credits spec (billing-integrity floor)', () => {
  it('floors at base + one of each priced dimension', () => {
    // one of each dim: base 2 + 1s×1 + 1frame×3 = 6 credits; ×10_000 = 60_000 µUSD.
    expect(minimumHold(entry(spec))).toBe(60_000n);
  });

  it('applies the entry markup to the credits floor', () => {
    // 60_000 × 1.5 = 90_000 µUSD.
    expect(minimumHold(entry(spec, { type: 'percent', value: 50 }))).toBe(90_000n);
  });

  it('floors on baseCredits alone when there are no priced dimensions', () => {
    const baseOnly: CreditsSpec = {
      method: 'credits',
      creditValueMicroUsd: 10_000,
      baseCredits: 3,
      dimensions: {},
    };
    expect(minimumHold(entry(baseOnly))).toBe(30_000n); // 3 credits × 10_000
  });

  it('excludes conditional add-ons from the floor (flags are not a baseline)', () => {
    // floor = base 2 + 1s + 1frame = 6 credits → 60_000; the +5 audio add-on is NOT counted.
    expect(minimumHold(entry(spec))).toBe(60_000n);
  });

  it('returns undefined for a 0-rate credits spec (creditValueMicroUsd = 0)', () => {
    const free: CreditsSpec = { ...spec, creditValueMicroUsd: 0 };
    expect(minimumHold(entry(free))).toBeUndefined();
  });

  it('returns undefined for an all-zero credits spec (no base, no dims, no value)', () => {
    const zero: CreditsSpec = {
      method: 'credits',
      creditValueMicroUsd: 0,
      baseCredits: 0,
      dimensions: {},
    };
    expect(minimumHold(entry(zero))).toBeUndefined();
  });
});
