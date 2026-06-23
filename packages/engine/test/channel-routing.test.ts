import { AdapterError } from '@actionow/adapters';
import type { DbOrTx } from '@actionow/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The router reads cooldown + records failures via these two repo fns; fake them.
const cooledIds: string[] = [];
const failureCalls: string[] = [];
vi.mock('@actionow/db', () => ({
  listCooledDownChannelIds: vi.fn((_db: unknown, ids: string[]) =>
    Promise.resolve(ids.filter((id) => cooledIds.includes(id))),
  ),
  recordChannelFailure: vi.fn((_db: unknown, id: string) => {
    failureCalls.push(id);
    return Promise.resolve();
  }),
}));

const { availableChannels, routeBlocking } = await import('../src/channel-routing.js');
const { EngineError } = await import('../src/errors.js');

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

beforeEach(() => {
  cooledIds.length = 0;
  failureCalls.length = 0;
});

describe('availableChannels', () => {
  it('returns all-but-cooled, and falls back to all when every channel is cooled', async () => {
    expect((await availableChannels(deps, chans)).map((c) => c.id)).toEqual(['a', 'b']);
    cooledIds.push('a');
    expect((await availableChannels(deps, chans)).map((c) => c.id)).toEqual(['b']);
    cooledIds.push('b');
    expect((await availableChannels(deps, chans)).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('returns a single channel without a cooldown query', async () => {
    expect((await availableChannels(deps, [{ id: 'solo', weight: 1 }])).map((c) => c.id)).toEqual([
      'solo',
    ]);
  });
});

describe('routeBlocking', () => {
  it('routes to the weighted pick', async () => {
    const result = await routeBlocking(deps, chans, (ch) => Promise.resolve(ch.id));
    expect(result).toBe('a');
    expect(failureCalls).toEqual([]);
  });

  it('fails over to the next channel on a retryable error and cools the failed one', async () => {
    const result = await routeBlocking(deps, chans, (ch) => {
      if (ch.id === 'a') throw retryable();
      return Promise.resolve(ch.id);
    });
    expect(result).toBe('b');
    expect(failureCalls).toEqual(['a']);
  });

  it('rethrows a non-retryable error without failover or cooldown', async () => {
    await expect(
      routeBlocking(deps, chans, (ch) => {
        if (ch.id === 'a') throw nonRetryable();
        return Promise.resolve(ch.id);
      }),
    ).rejects.toThrow('bad');
    expect(failureCalls).toEqual([]);
  });

  it('fails over + cools down on a RAW transport error (not an AdapterError)', async () => {
    // A fetch AbortError / ECONNRESET / DNS failure surfaces as a plain Error; a
    // dead channel must cascade to the next one, not hard-fail the request.
    const result = await routeBlocking(deps, chans, (ch) => {
      if (ch.id === 'a') throw new Error('ECONNRESET');
      return Promise.resolve(ch.id);
    });
    expect(result).toBe('b');
    expect(failureCalls).toEqual(['a']);
  });

  it('does NOT fail over on a non-retryable EngineError (honors its verdict)', async () => {
    await expect(
      routeBlocking(deps, chans, (ch) => {
        if (ch.id === 'a')
          throw new EngineError({ code: 'invalid_input', message: 'nope', retryable: false });
        return Promise.resolve(ch.id);
      }),
    ).rejects.toThrow('nope');
    expect(failureCalls).toEqual([]);
  });

  it('skips a cooled-down channel', async () => {
    cooledIds.push('a');
    const result = await routeBlocking(deps, chans, (ch) => Promise.resolve(ch.id));
    expect(result).toBe('b');
  });

  it('falls back to all channels when every channel is cooled down', async () => {
    cooledIds.push('a', 'b');
    const result = await routeBlocking(deps, chans, (ch) => Promise.resolve(ch.id));
    expect(result).toBe('a');
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
    const result = await routeBlocking(highRng, tiered, (ch) => Promise.resolve(ch.id));
    expect(result).toBe('primary');
  });

  it('cascades to the lower-priority tier when the higher one retryably fails', async () => {
    const attempted: string[] = [];
    const result = await routeBlocking(deps, tiered, (ch) => {
      attempted.push(ch.id);
      if (ch.id === 'primary') throw retryable();
      return Promise.resolve(ch.id);
    });
    expect(result).toBe('fallback');
    expect(attempted).toEqual(['primary', 'fallback']);
    expect(failureCalls).toEqual(['primary']);
  });

  it('weighted-picks within a tier of equal-priority channels', async () => {
    // Two channels in the SAME (top) tier; weight 1 vs 3. rng=0.99 lands in the
    // weight-3 band → `heavy` is picked first.
    const sameTier = [
      { id: 'light', weight: 1, priority: 10 },
      { id: 'heavy', weight: 3, priority: 10 },
    ];
    const highRng = { ...deps, rng: () => 0.99 };
    const result = await routeBlocking(highRng, sameTier, (ch) => Promise.resolve(ch.id));
    expect(result).toBe('heavy');
  });
});
