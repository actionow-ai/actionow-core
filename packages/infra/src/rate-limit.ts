/** The fixed window length (one minute) for the per-minute rate limit. */
const WINDOW_MS = 60_000;

/** The outcome of a {@link RateLimiter.take} call. */
export interface RateLimitResult {
  /** True when the request is within budget for the current window. */
  allowed: boolean;
  /**
   * Milliseconds the caller should wait before retrying. `0` when allowed;
   * the remaining window when blocked (so the 429 can carry `retry_after_ms`).
   */
  retryAfterMs: number;
}

/**
 * A per-minute rate limiter. `take` records one hit against `key` and reports
 * whether it was within `limitPerMin`. Implemented over Redis in production and
 * a deterministic in-memory fake in tests.
 */
export interface RateLimiter {
  take(key: string, limitPerMin: number): Promise<RateLimitResult>;
}

/** The result of incrementing a fixed-window counter. */
interface WindowState {
  /** The post-increment count within the current window. */
  count: number;
  /** Milliseconds remaining until the window's counter expires. */
  ttlMs: number;
}

/**
 * The minimal Redis surface the limiter needs: an atomic "increment this
 * window's counter and return the count + remaining TTL". Backed by a Lua
 * `eval` on the real client (one round-trip, no read-modify-write race) and by
 * {@link FakeRateLimitRedis} in tests.
 */
export interface RateLimitRedis {
  incrementWindow(key: string, windowMs: number): Promise<WindowState>;
}

// Atomic fixed-window counter. INCR creates the key at 1; on that first hit we
// set the window TTL. Subsequent hits in the same window only INCR (the TTL is
// never extended, so the window is fixed, not sliding). Returns {count, ttlMs}.
const INCR_WINDOW_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

/** The subset of an ioredis client the {@link RedisRateLimiter} invokes. */
export interface EvalCapableRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/** Wrap an ioredis-like client as a {@link RateLimitRedis} via a Lua script. */
export class LuaRateLimitRedis implements RateLimitRedis {
  constructor(private readonly redis: EvalCapableRedis) {}

  async incrementWindow(key: string, windowMs: number): Promise<WindowState> {
    const raw = await this.redis.eval(INCR_WINDOW_LUA, 1, key, windowMs);
    const [count, ttl] = raw as [number, number];
    return { count, ttlMs: ttl };
  }
}

/**
 * Per-minute fixed-window rate limiter over a {@link RateLimitRedis}.
 *
 * Each `take` increments `key`'s counter for the current minute window and
 * compares it to `limitPerMin`. When over budget the request is blocked and the
 * window's remaining TTL is surfaced as `retryAfterMs` so the caller can return
 * a 429 with `retry_after_ms`.
 */
export class RedisRateLimiter implements RateLimiter {
  private readonly store: RateLimitRedis;

  constructor(redis: RateLimitRedis | EvalCapableRedis) {
    this.store = isRateLimitRedis(redis) ? redis : new LuaRateLimitRedis(redis);
  }

  async take(key: string, limitPerMin: number): Promise<RateLimitResult> {
    // A non-positive limit means "never allow" — block without consuming Redis.
    if (limitPerMin <= 0) {
      return { allowed: false, retryAfterMs: WINDOW_MS };
    }

    const { count, ttlMs } = await this.store.incrementWindow(key, WINDOW_MS);
    if (count <= limitPerMin) {
      return { allowed: true, retryAfterMs: 0 };
    }
    // Over budget — wait out the rest of the window. Guard a non-positive TTL
    // (a key with no expiry, count just reset) by falling back to the window.
    return { allowed: false, retryAfterMs: ttlMs > 0 ? ttlMs : WINDOW_MS };
  }
}

/** Narrow a constructor arg to {@link RateLimitRedis} (vs. a raw eval client). */
function isRateLimitRedis(redis: RateLimitRedis | EvalCapableRedis): redis is RateLimitRedis {
  return typeof (redis as RateLimitRedis).incrementWindow === 'function';
}

/** A single acquired concurrency slot; `release` is idempotent. */
export interface ConcurrencySlot {
  /** True when the slot was within `max` (the request may proceed). */
  ok: boolean;
  /** Free the slot — call in a `finally`/response-finish handler. No-op when `!ok`. */
  release: () => Promise<void>;
}

/**
 * An in-flight (concurrency) limiter: `acquire` takes one slot for `key` and
 * reports whether the count stayed within `max`. Backed by a Redis counter
 * (INCR/DECR) with a safety TTL so a leaked slot self-heals.
 */
export interface ConcurrencyLimiter {
  acquire(key: string, max: number): Promise<ConcurrencySlot>;
}

// INCR + set a safety TTL on first hit (so a crashed request can't pin a slot
// forever). DECR on release, clamped at 0.
const CONC_INCR_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n
`;
const CONC_DECR_LUA = `
local n = redis.call('DECR', KEYS[1])
if n < 0 then redis.call('SET', KEYS[1], 0); n = 0 end
return n
`;

/** Redis-backed {@link ConcurrencyLimiter}. */
export class RedisConcurrencyLimiter implements ConcurrencyLimiter {
  constructor(
    private readonly redis: EvalCapableRedis,
    private readonly safetyTtlMs = 120_000,
  ) {}

  private decr(key: string): Promise<unknown> {
    return this.redis.eval(CONC_DECR_LUA, 1, key);
  }

  async acquire(key: string, max: number): Promise<ConcurrencySlot> {
    if (max <= 0) return { ok: false, release: () => Promise.resolve() };
    const n = (await this.redis.eval(CONC_INCR_LUA, 1, key, this.safetyTtlMs)) as number;
    if (n > max) {
      await this.decr(key);
      return { ok: false, release: () => Promise.resolve() };
    }
    let released = false;
    return {
      ok: true,
      release: async () => {
        if (released) return;
        released = true;
        await this.decr(key);
      },
    };
  }
}

/** Deterministic in-memory {@link ConcurrencyLimiter} for tests. */
export class FakeConcurrencyLimiter implements ConcurrencyLimiter {
  private readonly counts = new Map<string, number>();

  acquire(key: string, max: number): Promise<ConcurrencySlot> {
    if (max <= 0) return Promise.resolve({ ok: false, release: () => Promise.resolve() });
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    if (n > max) {
      this.counts.set(key, n - 1);
      return Promise.resolve({ ok: false, release: () => Promise.resolve() });
    }
    let released = false;
    return Promise.resolve({
      ok: true,
      release: () => {
        if (!released) {
          released = true;
          this.counts.set(key, Math.max(0, (this.counts.get(key) ?? 1) - 1));
        }
        return Promise.resolve();
      },
    });
  }
}

/**
 * Deterministic in-memory {@link RateLimitRedis} for tests. Mirrors the Lua
 * semantics: INCR creates the key with a TTL on the first hit, the TTL is fixed
 * (never extended), and an expired key resets the counter. Uses `Date.now()`
 * so `vi.useFakeTimers()` can drive window expiry.
 */
export class FakeRateLimitRedis implements RateLimitRedis {
  private readonly counters = new Map<string, { count: number; expiresAt: number }>();

  incrementWindow(key: string, windowMs: number): Promise<WindowState> {
    const now = Date.now();
    const existing = this.counters.get(key);

    if (existing === undefined || existing.expiresAt <= now) {
      // First hit of a new window: create the counter and set its TTL.
      const entry = { count: 1, expiresAt: now + windowMs };
      this.counters.set(key, entry);
      return Promise.resolve({ count: 1, ttlMs: windowMs });
    }

    existing.count += 1;
    return Promise.resolve({ count: existing.count, ttlMs: existing.expiresAt - now });
  }
}
