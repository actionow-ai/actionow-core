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
