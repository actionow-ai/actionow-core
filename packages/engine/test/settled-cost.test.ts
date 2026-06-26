import type { PricebookEntry } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { settledCost } from '../src/pricing.js';

// A post-timed unit entry (one priced dimension), like the seeded media relays.
const unitPost: PricebookEntry = {
  resourceId: 'img',
  resourceVersion: 1,
  version: 1,
  method: 'unit',
  timing: 'post',
  spec: { method: 'unit', dimensions: { images: { rate: 250_000 } } },
};

describe('settledCost — cap-at-hold settle policy (billing integrity)', () => {
  it('charges the real cost when it is within the hold', () => {
    // 1 image × 250_000 = 250_000, hold 300_000 → charge the real 250_000.
    expect(settledCost(unitPost, { images: 1 }, {}, [], 300_000n).credits).toBe(250_000n);
  });

  it('caps the charge at the hold when real cost exceeds it (under-estimate cannot overcharge / underflow)', () => {
    // 5 images × 250_000 = 1_250_000 real, but only 250_000 was reserved →
    // capped to 250_000 so the settle can never drive the wallet negative.
    expect(settledCost(unitPost, { images: 5 }, {}, [], 250_000n).credits).toBe(250_000n);
  });

  it('charges the held upper bound on a no-usage success (never settle to 0 and leak revenue)', () => {
    expect(settledCost(unitPost, {}, {}, [], 250_000n).credits).toBe(250_000n);
  });

  it('does NOT cap when hold is 0 — charges the real metered cost (the chat-blocking discipline)', () => {
    // A hold of 0 means "no reservation, charge the real cost" (chat blocking sets
    // holdFloor: 0). 3 × 250_000 = 750_000, uncapped. Media post-unit entries never
    // reach settle with a 0 hold because computeHold floors them at minimumHold().
    expect(settledCost(unitPost, { images: 3 }, {}, [], 0n).credits).toBe(750_000n);
  });

  it('charges 0 on a no-usage success when nothing was reserved (hold 0, no usage)', () => {
    expect(settledCost(unitPost, {}, {}, [], 0n).credits).toBe(0n);
  });
});
