// §8 candidate ordering unit tests (model-supply-greenfield 批次3 slice 3a):
// tier descending first, weighted random inside a tier (deterministic via
// injected rng), the §3 recoverable-fetch sub-tier bonus, and the guarantee
// that the bonus never crosses offering tiers.
import { describe, expect, it } from 'vitest';

import { sortCandidates } from '../../src/index.js';
import { assembled, offering } from './supply-fixtures.js';

const rngZero = (): number => 0;

describe('sortCandidates', () => {
  it('orders by offering tier DESCENDING first', () => {
    const candidates = [
      assembled(offering({ id: 'low', tier: 0 })),
      assembled(offering({ id: 'high', tier: 2 })),
      assembled(offering({ id: 'mid', tier: 1 })),
    ];
    const sorted = sortCandidates(candidates, { rng: rngZero });
    expect(sorted.map((c) => c.offering.id)).toEqual(['high', 'mid', 'low']);
  });

  it('weight-randomizes within a tier — deterministic under an injected rng', () => {
    const candidates = [
      assembled(offering({ id: 'a', weight: 1 })),
      assembled(offering({ id: 'b', weight: 1 })),
      assembled(offering({ id: 'c', weight: 8 })),
    ];
    // target = rng × 10. 0.0 → lands in a's band (picked first), rest by
    // weight desc: c(8), b(1).
    expect(sortCandidates(candidates, { rng: () => 0 }).map((c) => c.offering.id)).toEqual([
      'a',
      'c',
      'b',
    ]);
    // 0.5 → target 5 → past a(1) and b(2), lands in c's band; rest a, b
    // (equal weights keep list order).
    expect(sortCandidates(candidates, { rng: () => 0.5 }).map((c) => c.offering.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('prefers recoverable fetch modes within a tier (§3 加权: submit_poll before direct)', () => {
    // The direct offering vastly outweighs the recoverable one — the sub-tier
    // bonus must still put submit_poll first.
    const candidates = [
      assembled(offering({ id: 'direct-heavy', mode: 'direct', weight: 100 })),
      assembled(offering({ id: 'poll-light', mode: 'submit_poll', weight: 1 })),
    ];
    const sorted = sortCandidates(candidates, { rng: () => 0.99 });
    expect(sorted.map((c) => c.offering.id)).toEqual(['poll-light', 'direct-heavy']);
  });

  it('treats submit_callback as recoverable and stream as non-recoverable', () => {
    const candidates = [
      assembled(offering({ id: 'stream', mode: 'stream', weight: 50 })),
      assembled(offering({ id: 'callback', mode: 'submit_callback', weight: 1 })),
    ];
    const sorted = sortCandidates(candidates, { rng: rngZero });
    expect(sorted.map((c) => c.offering.id)).toEqual(['callback', 'stream']);
  });

  it('never lets the recoverable bonus flip tiers (tier stays first-order)', () => {
    const candidates = [
      assembled(offering({ id: 'poll-tier1', mode: 'submit_poll', tier: 1, weight: 100 })),
      assembled(offering({ id: 'direct-tier2', mode: 'direct', tier: 2, weight: 1 })),
    ];
    const sorted = sortCandidates(candidates, { rng: rngZero });
    expect(sorted.map((c) => c.offering.id)).toEqual(['direct-tier2', 'poll-tier1']);
  });

  it('keeps tier order correct for negative tiers with the sub-tier encoding', () => {
    const candidates = [
      assembled(offering({ id: 'neg-poll', mode: 'submit_poll', tier: -1 })),
      assembled(offering({ id: 'zero-direct', mode: 'direct', tier: 0 })),
    ];
    const sorted = sortCandidates(candidates, { rng: rngZero });
    expect(sorted.map((c) => c.offering.id)).toEqual(['zero-direct', 'neg-poll']);
  });

  it('does not mutate the input array', () => {
    const candidates = [
      assembled(offering({ id: 'low', tier: 0 })),
      assembled(offering({ id: 'high', tier: 2 })),
    ];
    const before = candidates.map((c) => c.offering.id);
    sortCandidates(candidates, { rng: rngZero });
    expect(candidates.map((c) => c.offering.id)).toEqual(before);
  });

  it('returns [] for an empty candidate set', () => {
    expect(sortCandidates([], { rng: rngZero })).toEqual([]);
  });
});
