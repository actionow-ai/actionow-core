import { AdapterError } from '@actionow/adapters';
import type { DbOrTx } from '@actionow/db';
import { describe, expect, it, vi } from 'vitest';

import type { BreakerStore, RoutableChannelRef } from '../src/breaker.js';
import { availableChannels, routeBlocking } from '../src/channel-routing.js';
import { EngineError } from '../src/errors.js';

// NOTE (resilience-v2 Task 2): the binary `channel_health` cooldown
// (`listCooledDownChannelIds` / `recordChannelFailure`) was removed from the
// router — `availableChannels` temporarily returns the full set and
// `routeBlocking` no longer records per-failure cooldown. Phase 3 (Task 7)
// re-adds exclusion + outcome hooks via the injected `BreakerStore`; the
// cooldown-specific cases move there. These tests now cover the failover +
// priority-tier behavior that is unchanged in Task 2.

const deps = {
  db: {} as DbOrTx,
  now: () => new Date('2026-06-17T00:00:00.000Z'),
  rng: () => 0, // weighted pick lands on the first channel
};
const chans = [
  { id: 'a', weight: 1 },
  { id: 'b', weight: 1 },
];

const retryable = (): AdapterError =>
  new AdapterError({ code: 'rate_limited', message: 'slow', retryable: true });
const nonRetryable = (): AdapterError =>
  new AdapterError({ code: 'invalid_input', message: 'bad', retryable: false });

describe('availableChannels', () => {
  it('returns all channels when no breaker is injected', async () => {
    expect((await availableChannels(deps, chans, 'gpt-x')).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('returns a single channel as-is', async () => {
    expect(
      (await availableChannels(deps, [{ id: 'solo', weight: 1 }], 'gpt-x')).map((c) => c.id),
    ).toEqual(['solo']);
  });
});

describe('routeBlocking', () => {
  it('routes to the weighted pick', async () => {
    const result = await routeBlocking(deps, chans, 'gpt-x', (ch) => Promise.resolve(ch.id));
    expect(result).toBe('a');
  });

  it('fails over to the next channel on a retryable error', async () => {
    const result = await routeBlocking(deps, chans, 'gpt-x', (ch) => {
      if (ch.id === 'a') throw retryable();
      return Promise.resolve(ch.id);
    });
    expect(result).toBe('b');
  });

  it('rethrows a non-retryable error without failover', async () => {
    await expect(
      routeBlocking(deps, chans, 'gpt-x', (ch) => {
        if (ch.id === 'a') throw nonRetryable();
        return Promise.resolve(ch.id);
      }),
    ).rejects.toThrow('bad');
  });

  it('fails over on a RAW transport error (not an AdapterError)', async () => {
    // A fetch AbortError / ECONNRESET / DNS failure surfaces as a plain Error; a
    // dead channel must cascade to the next one, not hard-fail the request.
    const result = await routeBlocking(deps, chans, 'gpt-x', (ch) => {
      if (ch.id === 'a') throw new Error('ECONNRESET');
      return Promise.resolve(ch.id);
    });
    expect(result).toBe('b');
  });

  it('does NOT fail over on a non-retryable EngineError (honors its verdict)', async () => {
    await expect(
      routeBlocking(deps, chans, 'gpt-x', (ch) => {
        if (ch.id === 'a')
          throw new EngineError({ code: 'invalid_input', message: 'nope', retryable: false });
        return Promise.resolve(ch.id);
      }),
    ).rejects.toThrow('nope');
  });
});

// A minimal in-memory BreakerStore double: `filterAvailable` drops the channel
// ids in `excluded`; outcome hooks record their calls (id, model) so a test can
// assert the relay fed the FSM. Mirrors the real store's fail-open/best-effort
// surface without Redis/PG.
interface Outcome {
  id: string;
  model: string;
}
function fakeBreaker(excluded: string[] = []): BreakerStore & {
  successes: Outcome[];
  failures: Outcome[];
} {
  const successes: Outcome[] = [];
  const failures: Outcome[] = [];
  return {
    successes,
    failures,
    filterAvailable<C extends RoutableChannelRef>(channels: readonly C[]): Promise<C[]> {
      return Promise.resolve(channels.filter((c) => !excluded.includes(c.id)));
    },
    onSuccess(channelId: string, model: string): Promise<void> {
      successes.push({ id: channelId, model });
      return Promise.resolve();
    },
    onFailure(channelId: string, model: string): Promise<void> {
      failures.push({ id: channelId, model });
      return Promise.resolve();
    },
  };
}

describe('availableChannels — BreakerStore filter (Task 7)', () => {
  it('delegates to the injected store when there is more than one channel', async () => {
    const breaker = fakeBreaker(['a']);
    const withBreaker = { ...deps, breaker };
    expect((await availableChannels(withBreaker, chans, 'gpt-x')).map((c) => c.id)).toEqual(['b']);
  });

  it('skips the store (returns all) for a single channel — nothing to choose', async () => {
    const breaker = fakeBreaker(['solo']);
    const spy = vi.spyOn(breaker, 'filterAvailable');
    const withBreaker = { ...deps, breaker };
    expect(
      (await availableChannels(withBreaker, [{ id: 'solo', weight: 1 }], 'gpt-x')).map((c) => c.id),
    ).toEqual(['solo']);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('routeBlocking — BreakerStore wiring (Task 7)', () => {
  it('does not attempt a channel the store excludes', async () => {
    const breaker = fakeBreaker(['a']);
    const attempted: string[] = [];
    const result = await routeBlocking({ ...deps, breaker }, chans, 'gpt-x', (ch) => {
      attempted.push(ch.id);
      return Promise.resolve(ch.id);
    });
    expect(result).toBe('b');
    expect(attempted).toEqual(['b']);
  });

  it('records a success via store.onSuccess (with the model)', async () => {
    const breaker = fakeBreaker();
    await routeBlocking({ ...deps, breaker }, chans, 'gpt-x', (ch) => Promise.resolve(ch.id));
    expect(breaker.successes).toEqual([{ id: 'a', model: 'gpt-x' }]);
    expect(breaker.failures).toEqual([]);
  });

  it('records a retryable failure via store.onFailure before failing over', async () => {
    const breaker = fakeBreaker();
    const result = await routeBlocking({ ...deps, breaker }, chans, 'gpt-x', (ch) => {
      if (ch.id === 'a') throw retryable();
      return Promise.resolve(ch.id);
    });
    expect(result).toBe('b');
    expect(breaker.failures).toEqual([{ id: 'a', model: 'gpt-x' }]);
    expect(breaker.successes).toEqual([{ id: 'b', model: 'gpt-x' }]);
  });

  it('does NOT record a non-retryable error via store.onFailure', async () => {
    const breaker = fakeBreaker();
    await expect(
      routeBlocking({ ...deps, breaker }, chans, 'gpt-x', (ch) => {
        if (ch.id === 'a') throw nonRetryable();
        return Promise.resolve(ch.id);
      }),
    ).rejects.toThrow('bad');
    expect(breaker.failures).toEqual([]);
    expect(breaker.successes).toEqual([]);
  });

  it('with no store injected, attempts all channels and records nothing', async () => {
    const attempted: string[] = [];
    const result = await routeBlocking(deps, chans, 'gpt-x', (ch) => {
      attempted.push(ch.id);
      return Promise.resolve(ch.id);
    });
    expect(result).toBe('a');
    expect(attempted).toEqual(['a']);
  });
});

describe('routeBlocking — priority tiers (Track 4)', () => {
  // The priority-10 channel is always tried first; on a retryable failure the
  // route cascades to the priority-0 tier.
  const tiered = [
    { id: 'primary', weight: 1, priority: 10 },
    { id: 'fallback', weight: 1, priority: 0 },
  ];

  it('always routes to the higher-priority tier first regardless of rng', async () => {
    // rng=0.99 would otherwise weight-pick late, but the priority-10 tier comes
    // first as a whole, so `primary` is chosen.
    const highRng = { ...deps, rng: () => 0.99 };
    const result = await routeBlocking(highRng, tiered, 'gpt-x', (ch) => Promise.resolve(ch.id));
    expect(result).toBe('primary');
  });

  it('cascades to the lower-priority tier when the higher one retryably fails', async () => {
    const attempted: string[] = [];
    const result = await routeBlocking(deps, tiered, 'gpt-x', (ch) => {
      attempted.push(ch.id);
      if (ch.id === 'primary') throw retryable();
      return Promise.resolve(ch.id);
    });
    expect(result).toBe('fallback');
    expect(attempted).toEqual(['primary', 'fallback']);
  });

  it('weighted-picks within a tier of equal-priority channels', async () => {
    // Two channels in the SAME (top) tier; weight 1 vs 3. rng=0.99 lands in the
    // weight-3 band → `heavy` is picked first.
    const sameTier = [
      { id: 'light', weight: 1, priority: 10 },
      { id: 'heavy', weight: 3, priority: 10 },
    ];
    const highRng = { ...deps, rng: () => 0.99 };
    const result = await routeBlocking(highRng, sameTier, 'gpt-x', (ch) => Promise.resolve(ch.id));
    expect(result).toBe('heavy');
  });
});
