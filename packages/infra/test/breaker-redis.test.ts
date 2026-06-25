import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeBreakerRedis } from '../src/breaker-redis.js';

const WINDOW_MS = 60_000;

describe('FakeBreakerRedis (sliding fixed-window over current+previous epoch)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('recordOutcome counts totals and failures within a window', async () => {
    const r = new FakeBreakerRedis();
    const now = 1_000_000;

    expect(await r.recordOutcome('c:m', WINDOW_MS, false, now)).toEqual({ total: 1, fail: 0 });
    expect(await r.recordOutcome('c:m', WINDOW_MS, true, now)).toEqual({ total: 2, fail: 1 });
    expect(await r.recordOutcome('c:m', WINDOW_MS, true, now)).toEqual({ total: 3, fail: 2 });
  });

  it('keeps separate counters per base key', async () => {
    const r = new FakeBreakerRedis();
    const now = 2_000_000;

    await r.recordOutcome('a:m', WINDOW_MS, true, now);
    expect(await r.recordOutcome('b:m', WINDOW_MS, false, now)).toEqual({ total: 1, fail: 0 });
  });

  it('sums the current and previous epoch buckets (sliding approximation)', async () => {
    const r = new FakeBreakerRedis();
    // Epoch boundary is floor(now / windowMs). Pick a now near a boundary.
    const base = 5 * WINDOW_MS; // start of epoch 5

    // Two outcomes land in epoch 5.
    await r.recordOutcome('k', WINDOW_MS, true, base + 10);
    await r.recordOutcome('k', WINDOW_MS, false, base + 20);

    // One outcome lands in epoch 6 (the next window). The returned totals span
    // the current (6) + previous (5) buckets.
    const res = await r.recordOutcome('k', WINDOW_MS, true, base + WINDOW_MS + 5);
    expect(res).toEqual({ total: 3, fail: 2 });
  });

  it('drops a bucket older than the previous epoch (window slid past it)', async () => {
    const r = new FakeBreakerRedis();
    const base = 10 * WINDOW_MS; // epoch 10

    await r.recordOutcome('k', WINDOW_MS, true, base + 5); // epoch 10
    await r.recordOutcome('k', WINDOW_MS, true, base + 5); // epoch 10

    // Jump two epochs forward (to epoch 12). Epoch 10 is now older than the
    // previous bucket (epoch 11), so it no longer counts.
    const res = await r.recordOutcome('k', WINDOW_MS, false, base + 2 * WINDOW_MS + 5);
    expect(res).toEqual({ total: 1, fail: 0 });
  });

  it('tryTrial admits up to max then rejects', async () => {
    const r = new FakeBreakerRedis();

    expect(await r.tryTrial('c:m', 3, 5_000)).toBe(true);
    expect(await r.tryTrial('c:m', 3, 5_000)).toBe(true);
    expect(await r.tryTrial('c:m', 3, 5_000)).toBe(true);
    expect(await r.tryTrial('c:m', 3, 5_000)).toBe(false);
  });

  it('tryTrial keeps separate gates per key', async () => {
    const r = new FakeBreakerRedis();
    expect(await r.tryTrial('a', 1, 5_000)).toBe(true);
    expect(await r.tryTrial('a', 1, 5_000)).toBe(false);
    expect(await r.tryTrial('b', 1, 5_000)).toBe(true);
  });

  it('tryTrial with a non-positive max never admits', async () => {
    const r = new FakeBreakerRedis();
    expect(await r.tryTrial('c:m', 0, 5_000)).toBe(false);
  });

  it('tryTrial resets after its TTL expires', async () => {
    vi.useFakeTimers();
    const r = new FakeBreakerRedis();

    expect(await r.tryTrial('k', 1, 5_000)).toBe(true);
    expect(await r.tryTrial('k', 1, 5_000)).toBe(false);

    vi.advanceTimersByTime(5_001);

    expect(await r.tryTrial('k', 1, 5_000)).toBe(true);
    vi.useRealTimers();
  });

  it('readWindow returns the current+previous totals WITHOUT recording an outcome', async () => {
    const r = new FakeBreakerRedis();
    const now = 8_000_000;

    // Empty window reads as zero.
    expect(await r.readWindow('k', WINDOW_MS, now)).toEqual({ total: 0, fail: 0 });

    await r.recordOutcome('k', WINDOW_MS, true, now);
    await r.recordOutcome('k', WINDOW_MS, false, now);

    // Read twice — the read must be idempotent (no increment).
    expect(await r.readWindow('k', WINDOW_MS, now)).toEqual({ total: 2, fail: 1 });
    expect(await r.readWindow('k', WINDOW_MS, now)).toEqual({ total: 2, fail: 1 });

    // A following recordOutcome still sees exactly the two prior outcomes.
    expect(await r.recordOutcome('k', WINDOW_MS, false, now)).toEqual({ total: 3, fail: 1 });
  });

  it('readWindow sums the current and previous epoch buckets like recordOutcome', async () => {
    const r = new FakeBreakerRedis();
    const base = 6 * WINDOW_MS; // start of epoch 6

    await r.recordOutcome('k', WINDOW_MS, true, base + 10); // epoch 6
    await r.recordOutcome('k', WINDOW_MS, false, base + 20); // epoch 6
    await r.recordOutcome('k', WINDOW_MS, true, base + WINDOW_MS + 5); // epoch 7

    // Reading at epoch 7 spans the current (7) + previous (6) buckets.
    expect(await r.readWindow('k', WINDOW_MS, base + WINDOW_MS + 30)).toEqual({
      total: 3,
      fail: 2,
    });
  });

  it('clearWindow resets the counted totals back to zero', async () => {
    const r = new FakeBreakerRedis();
    const now = 7_000_000;

    await r.recordOutcome('k', WINDOW_MS, true, now);
    await r.recordOutcome('k', WINDOW_MS, true, now);
    await r.clearWindow('k', WINDOW_MS, now);

    expect(await r.recordOutcome('k', WINDOW_MS, false, now)).toEqual({ total: 1, fail: 0 });
  });
});
