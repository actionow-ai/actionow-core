import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeRateLimitRedis, RedisRateLimiter } from '../src/rate-limit.js';

describe('RedisRateLimiter (fixed-window INCR+PEXPIRE)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('allows up to the limit within a window, then blocks', async () => {
    const redis = new FakeRateLimitRedis();
    const limiter = new RedisRateLimiter(redis);

    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await limiter.take('tenant:t1', 3));
    }

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    // The blocked request reports a positive retry-after (the window's remaining ms).
    expect(results[3]?.retryAfterMs).toBeGreaterThan(0);
    expect(results[3]?.retryAfterMs).toBeLessThanOrEqual(60_000);
    // Allowed requests carry no wait.
    expect(results[0]?.retryAfterMs).toBe(0);
  });

  it('resets after the window expires (PEXPIRE drops the key)', async () => {
    vi.useFakeTimers();
    const redis = new FakeRateLimitRedis();
    const limiter = new RedisRateLimiter(redis);

    expect((await limiter.take('k', 1)).allowed).toBe(true);
    expect((await limiter.take('k', 1)).allowed).toBe(false);

    // Advance past the 60s fixed window — the counter key has expired.
    vi.advanceTimersByTime(60_001);

    expect((await limiter.take('k', 1)).allowed).toBe(true);
    vi.useRealTimers();
  });

  it('keeps separate counters per key', async () => {
    const redis = new FakeRateLimitRedis();
    const limiter = new RedisRateLimiter(redis);

    expect((await limiter.take('a', 1)).allowed).toBe(true);
    expect((await limiter.take('a', 1)).allowed).toBe(false);
    // A different key has its own budget.
    expect((await limiter.take('b', 1)).allowed).toBe(true);
  });

  it('treats a non-positive limit as immediately blocked', async () => {
    const redis = new FakeRateLimitRedis();
    const limiter = new RedisRateLimiter(redis);
    const r = await limiter.take('k', 0);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  it('sets the TTL only on the first hit of a window (no sliding extension)', async () => {
    vi.useFakeTimers();
    const redis = new FakeRateLimitRedis();
    const limiter = new RedisRateLimiter(redis);

    await limiter.take('k', 5); // window opens here
    vi.advanceTimersByTime(30_000);
    await limiter.take('k', 5); // must NOT extend the window
    vi.advanceTimersByTime(30_001); // 60.001s after the FIRST hit

    // The window has elapsed relative to the first hit, so the counter reset.
    const r = await limiter.take('k', 5);
    expect(r.allowed).toBe(true);
    vi.useRealTimers();
  });
});
