// §7.8 dual (offering, credential) semaphore unit tests (批次3 slice 3b).
// All timing is deterministic: the clock is a counter the fake `sleep`
// advances — no real waits anywhere.
import type { ConcurrencyLimiter, ConcurrencySlot } from '@actionow/infra';
import { FakeConcurrencyLimiter } from '@actionow/infra';
import { describe, expect, it } from 'vitest';

import {
  acquireDualSemaphore,
  acquireDualSemaphoreFromPool,
  credentialSemaphoreKey,
  type DualSemaphoreDeps,
  type DualSlot,
  offeringSemaphoreKey,
  UNBOUNDED_CONCURRENCY,
} from '../../src/index.js';

/** A deterministic clock: `sleep(ms)` advances `nowMs` by exactly ms. */
function fakeClock(): {
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  t: () => number;
} {
  let t = 0;
  return {
    nowMs: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
    t: () => t,
  };
}

function deps(
  limiter: ConcurrencyLimiter,
  clock = fakeClock(),
  extra: Partial<DualSemaphoreDeps> = {},
): DualSemaphoreDeps & { clock: ReturnType<typeof fakeClock> } {
  return {
    concurrency: limiter,
    sleep: clock.sleep,
    nowMs: clock.nowMs,
    rng: () => 1, // jitter factor 1.0 → delays are exactly base, 2×base, …
    clock,
    ...extra,
  };
}

function acquire(
  d: DualSemaphoreDeps,
  o: {
    offering?: string;
    offeringMax?: number | null;
    credential?: string;
    credentialMax?: number | null;
    maxWaitMs?: number;
  } = {},
): Promise<DualSlot | 'timeout' | 'unavailable'> {
  return acquireDualSemaphore(d, {
    offeringId: o.offering ?? 'off-1',
    offeringMax: o.offeringMax === undefined ? 2 : o.offeringMax,
    credentialId: o.credential ?? 'cred-1',
    credentialMax: o.credentialMax === undefined ? 5 : o.credentialMax,
    maxWaitMs: o.maxWaitMs ?? 0,
  });
}

describe('acquireDualSemaphore — min(offering, credential) via dual holding (§7.8)', () => {
  it('offering=2 × credential=5 → effective 2: third acquire times out', async () => {
    const d = deps(new FakeConcurrencyLimiter());
    const s1 = await acquire(d, { maxWaitMs: 0 });
    const s2 = await acquire(d, { maxWaitMs: 0 });
    expect(s1).not.toBe('timeout');
    expect(s2).not.toBe('timeout');
    const s3 = await acquire(d, { maxWaitMs: 100 });
    expect(s3).toBe('timeout');
  });

  it('single-credential channel (credential max 1) degrades the pool to 1', async () => {
    const d = deps(new FakeConcurrencyLimiter());
    const s1 = await acquire(d, { offeringMax: 10, credentialMax: 1, maxWaitMs: 0 });
    expect(s1).not.toBe('timeout');
    const s2 = await acquire(d, { offeringMax: 10, credentialMax: 1, maxWaitMs: 50 });
    expect(s2).toBe('timeout');
  });

  it('null max on a dimension = unbounded on that dimension (other still binds)', async () => {
    const taken: { key: string; max: number }[] = [];
    const inner = new FakeConcurrencyLimiter();
    const recording: ConcurrencyLimiter = {
      acquire: (key, max): Promise<ConcurrencySlot> => {
        taken.push({ key, max });
        return inner.acquire(key, max);
      },
    };
    const d = deps(recording);
    // Both null → never blocks, but BOTH dimensions still run through the
    // semaphore (in-flight accounting for observability).
    const slot = await acquire(d, { offeringMax: null, credentialMax: null, maxWaitMs: 0 });
    expect(slot).not.toBe('timeout');
    expect(taken).toEqual([
      { key: offeringSemaphoreKey('off-1'), max: UNBOUNDED_CONCURRENCY },
      { key: credentialSemaphoreKey('cred-1'), max: UNBOUNDED_CONCURRENCY },
    ]);
    // credential-only cap: offering unbounded, credential 1 → second waits out.
    const s1 = await acquire(d, { offeringMax: null, credentialMax: 1, credential: 'cred-2' });
    expect(s1).not.toBe('timeout');
    const s2 = await acquire(d, {
      offeringMax: null,
      credentialMax: 1,
      credential: 'cred-2',
      maxWaitMs: 40,
    });
    expect(s2).toBe('timeout');
  });
});

describe('acquireDualSemaphore — bounded wait queue (§7.8 有界等待)', () => {
  it('waits with deterministic backoff and times out after exactly the budget', async () => {
    const limiter = new FakeConcurrencyLimiter();
    const clock = fakeClock();
    const d = deps(limiter, clock);
    const holder = await acquire(d, { offeringMax: 1, maxWaitMs: 0 });
    expect(holder).not.toBe('timeout');

    const result = await acquire(d, { offeringMax: 1, maxWaitMs: 100 });
    expect(result).toBe('timeout');
    // rng=1 → sleeps 25, 50, then the 25 remaining of the 100ms budget.
    expect(clock.t()).toBe(100);
  });

  it('a slot released while waiting is acquired on a later retry', async () => {
    const limiter = new FakeConcurrencyLimiter();
    let held: DualSlot | 'timeout' | 'unavailable' = 'timeout';
    let t = 0;
    const d: DualSemaphoreDeps = {
      concurrency: limiter,
      nowMs: () => t,
      rng: () => 1,
      sleep: async (ms: number) => {
        t += ms;
        // The competing request finishes 60ms in → frees both dimensions.
        if (t >= 60 && typeof held !== 'string') {
          await held.release();
          held = 'timeout';
        }
      },
    };
    held = await acquire(d, { offeringMax: 1, maxWaitMs: 0 });
    expect(held).not.toBe('timeout');
    const waiter = await acquire(d, { offeringMax: 1, maxWaitMs: 500 });
    expect(waiter).not.toBe('timeout');
  });

  it('credential-dimension refusal releases the already-held offering dimension (no half-hold leak)', async () => {
    const limiter = new FakeConcurrencyLimiter();
    const d = deps(limiter);
    // cred-X is fully held via another offering's dual slot.
    const blocker = await acquire(d, {
      offering: 'off-B',
      offeringMax: 1,
      credential: 'cred-X',
      credentialMax: 1,
    });
    expect(blocker).not.toBe('timeout');
    // (off-A, cred-X) must fail on the credential dimension AND leave off-A clean.
    const attempt = await acquire(d, {
      offering: 'off-A',
      offeringMax: 1,
      credential: 'cred-X',
      credentialMax: 1,
    });
    expect(attempt).toBe('timeout');
    // off-A (max 1) is immediately acquirable with a different credential —
    // proof the half-hold was released.
    const clean = await acquire(d, {
      offering: 'off-A',
      offeringMax: 1,
      credential: 'cred-Y',
      credentialMax: 1,
    });
    expect(clean).not.toBe('timeout');
  });

  it('release is idempotent: double release frees the slot exactly once', async () => {
    const limiter = new FakeConcurrencyLimiter();
    const d = deps(limiter);
    const slot = await acquire(d, { offeringMax: 1, credentialMax: 1 });
    expect(slot).not.toBe('timeout');
    if (typeof slot === 'string') return;
    await slot.release();
    await slot.release(); // second release must be a no-op
    // Exactly ONE capacity unit exists again: first acquire fits, second not.
    const again = await acquire(d, { offeringMax: 1, credentialMax: 1 });
    expect(again).not.toBe('timeout');
    const overflow = await acquire(d, { offeringMax: 1, credentialMax: 1 });
    expect(overflow).toBe('timeout');
  });
});

describe('acquireDualSemaphoreFromPool — §9.1 触顶先池内换 key (BUG-A regression)', () => {
  function poolAcquire(
    d: DualSemaphoreDeps,
    o: {
      offeringMax?: number | null;
      credentials: { credentialId: string; credentialMax: number | null }[];
      maxWaitMs?: number;
    },
  ): Promise<DualSlot | 'timeout' | 'unavailable'> {
    return acquireDualSemaphoreFromPool(d, {
      offeringId: 'off-1',
      offeringMax: o.offeringMax === undefined ? 10 : o.offeringMax,
      credentials: o.credentials,
      maxWaitMs: o.maxWaitMs ?? 0,
    });
  }

  it('a saturated first key rotates onto a free sibling in the SAME attempt — no wait, no timeout', async () => {
    const limiter = new FakeConcurrencyLimiter();
    const clock = fakeClock();
    const d = deps(limiter, clock);
    // keyA (max 1) is fully held by another request.
    const blocker = await limiter.acquire(credentialSemaphoreKey('keyA'), 1);
    expect(blocker.ok).toBe(true);
    const slot = await poolAcquire(d, {
      credentials: [
        { credentialId: 'keyA', credentialMax: 1 },
        { credentialId: 'keyB', credentialMax: 1 },
      ],
      maxWaitMs: 100,
    });
    expect(slot).not.toBe('timeout');
    if (typeof slot === 'string') return;
    expect(slot.credentialId).toBe('keyB'); // in-pool swap, not offering failover
    expect(clock.t()).toBe(0); // zero backoff sleeps — the sibling was tried immediately
  });

  it('a fully saturated pool times out (→ the gate fails over to the next offering)', async () => {
    const limiter = new FakeConcurrencyLimiter();
    const clock = fakeClock();
    const d = deps(limiter, clock);
    const a = await limiter.acquire(credentialSemaphoreKey('keyA'), 1);
    const b = await limiter.acquire(credentialSemaphoreKey('keyB'), 1);
    expect(a.ok && b.ok).toBe(true);
    const slot = await poolAcquire(d, {
      credentials: [
        { credentialId: 'keyA', credentialMax: 1 },
        { credentialId: 'keyB', credentialMax: 1 },
      ],
      maxWaitMs: 100,
    });
    expect(slot).toBe('timeout');
    expect(clock.t()).toBe(100); // budget honored exactly (rng=1 → 25, 50, 25)
  });

  it('a full pool sweep leaves the offering dimension clean before backing off (no half-hold)', async () => {
    const limiter = new FakeConcurrencyLimiter();
    let offeringHeldDuringSleep = false;
    let t = 0;
    const d: DualSemaphoreDeps = {
      concurrency: limiter,
      nowMs: () => t,
      rng: () => 1,
      sleep: async (ms: number) => {
        t += ms;
        // During EVERY backoff the offering dimension (max 1) must be free.
        const probe = await limiter.acquire(offeringSemaphoreKey('off-1'), 1);
        if (!probe.ok) offeringHeldDuringSleep = true;
        else await probe.release();
      },
    };
    const blocker = await limiter.acquire(credentialSemaphoreKey('keyA'), 1);
    expect(blocker.ok).toBe(true);
    const slot = await poolAcquire(d, {
      offeringMax: 1,
      credentials: [{ credentialId: 'keyA', credentialMax: 1 }],
      maxWaitMs: 80,
    });
    expect(slot).toBe('timeout');
    expect(offeringHeldDuringSleep).toBe(false);
  });
});

describe('acquireDualSemaphore(pool) — declared-dead dimensions fast-fail (BUG-F regression)', () => {
  it('offeringMax = 0 answers unavailable IMMEDIATELY — no budget burned', async () => {
    const clock = fakeClock();
    const d = deps(new FakeConcurrencyLimiter(), clock);
    const slot = await acquire(d, { offeringMax: 0, maxWaitMs: 5_000 });
    expect(slot).toBe('unavailable');
    expect(clock.t()).toBe(0); // did NOT spin the 5s maxWaitMs
  });

  it('a single credential with max 0 answers unavailable immediately (negative likewise)', async () => {
    const clock = fakeClock();
    const d = deps(new FakeConcurrencyLimiter(), clock);
    expect(await acquire(d, { credentialMax: 0, maxWaitMs: 5_000 })).toBe('unavailable');
    expect(await acquire(d, { credentialMax: -3, maxWaitMs: 5_000 })).toBe('unavailable');
    expect(clock.t()).toBe(0);
  });

  it('a max-0 key inside a mixed pool is SKIPPED (never spun on) and the healthy sibling wins', async () => {
    const taken: string[] = [];
    const inner = new FakeConcurrencyLimiter();
    const recording: ConcurrencyLimiter = {
      acquire: (key, max): Promise<ConcurrencySlot> => {
        taken.push(key);
        return inner.acquire(key, max);
      },
    };
    const clock = fakeClock();
    const d = deps(recording, clock);
    const slot = await acquireDualSemaphoreFromPool(d, {
      offeringId: 'off-1',
      offeringMax: 10,
      credentials: [
        { credentialId: 'dead-key', credentialMax: 0 },
        { credentialId: 'live-key', credentialMax: 2 },
      ],
      maxWaitMs: 100,
    });
    expect(slot).not.toBe('timeout');
    if (typeof slot === 'string') return;
    expect(slot.credentialId).toBe('live-key');
    expect(taken).not.toContain(credentialSemaphoreKey('dead-key'));
    expect(clock.t()).toBe(0);
  });

  it('null stays UNBOUNDED — not confused with the explicit 0 unavailable signal', async () => {
    const d = deps(new FakeConcurrencyLimiter());
    const slot = await acquire(d, { offeringMax: null, credentialMax: null, maxWaitMs: 0 });
    expect(slot).not.toBe('unavailable');
    expect(slot).not.toBe('timeout');
  });
});

describe('dual-semaphore exception safety (BUG-B regression — 失败即释放)', () => {
  it('a REJECTED credential acquire releases the held offering dimension before the throw surfaces', async () => {
    const inner = new FakeConcurrencyLimiter();
    const rejecting: ConcurrencyLimiter = {
      acquire: (key, max): Promise<ConcurrencySlot> =>
        key.startsWith('sem:credential:')
          ? Promise.reject(new Error('redis INCR failed'))
          : inner.acquire(key, max),
    };
    const d = deps(rejecting);
    await expect(acquire(d, { offeringMax: 1, maxWaitMs: 0 })).rejects.toThrow('redis INCR failed');
    // The offering dimension (max 1) leaked nothing: a fresh acquire fits.
    const probe = await inner.acquire(offeringSemaphoreKey('off-1'), 1);
    expect(probe.ok).toBe(true);
  });

  it('a throwing credential RELEASE still releases the offering dimension, and a retry is idempotent', async () => {
    const inner = new FakeConcurrencyLimiter();
    let failNextCredentialRelease = true;
    const doctored: ConcurrencyLimiter = {
      acquire: async (key, max): Promise<ConcurrencySlot> => {
        const slot = await inner.acquire(key, max);
        if (!slot.ok || !key.startsWith('sem:credential:')) return slot;
        return {
          ok: true,
          release: async (): Promise<void> => {
            if (failNextCredentialRelease) {
              failNextCredentialRelease = false;
              throw new Error('redis DECR failed'); // transient — inner slot NOT yet released
            }
            await slot.release();
          },
        };
      },
    };
    const d = deps(doctored);
    const slot = await acquire(d, { offeringMax: 1, credentialMax: 1, maxWaitMs: 0 });
    expect(slot).not.toBe('timeout');
    if (typeof slot === 'string') return;

    // First release: credential dimension throws, offering MUST still be freed.
    await expect(slot.release()).rejects.toThrow('redis DECR failed');
    const offeringProbe = await inner.acquire(offeringSemaphoreKey('off-1'), 1);
    expect(offeringProbe.ok).toBe(true); // offering freed despite the throw
    await offeringProbe.release();
    const credStillHeld = await inner.acquire(credentialSemaphoreKey('cred-1'), 1);
    expect(credStillHeld.ok).toBe(false); // credential genuinely leaked by the transient failure

    // Retry: frees the credential; the offering re-release is a no-op (primitive
    // idempotence — no double DECR).
    await slot.release();
    const credProbe = await inner.acquire(credentialSemaphoreKey('cred-1'), 1);
    expect(credProbe.ok).toBe(true);
    await credProbe.release();
    // Third call after full success: pure no-op.
    await slot.release();
    // Capacity is EXACTLY 1 on each dimension (no double-DECR minted extra room).
    const c1 = await inner.acquire(credentialSemaphoreKey('cred-1'), 1);
    const c2 = await inner.acquire(credentialSemaphoreKey('cred-1'), 1);
    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(false);
  });
});
