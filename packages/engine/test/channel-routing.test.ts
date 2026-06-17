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
