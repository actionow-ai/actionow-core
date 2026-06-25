import type { EvalCapableRedis } from './rate-limit.js';

/** Counts accumulated over the breaker's sliding window. */
export interface BreakerWindow {
  /** Total outcomes recorded in the window (current + previous bucket). */
  total: number;
  /** The subset of {@link total} that were failures. */
  fail: number;
}

/**
 * The Redis surface the circuit breaker needs: a sliding-window outcome counter
 * (approximated with a fixed two-bucket window, like the rate limiter) and an
 * atomic half-open trial gate. Backed by Lua `eval` on the real client and by
 * {@link FakeBreakerRedis} in tests.
 *
 * Every method is best-effort from the breaker's perspective — callers swallow
 * errors and fail open (treat the window as empty / never trip), so a Redis
 * outage never fails a request that could have succeeded.
 */
export interface BreakerRedis {
  /**
   * Record one upstream outcome against `base` (a `${channelId}:${model}` key)
   * for the current window and return the running totals over the current +
   * previous epoch buckets (sliding-window approximation).
   */
  recordOutcome(
    base: string,
    windowMs: number,
    isFail: boolean,
    now: number,
  ): Promise<BreakerWindow>;
  /**
   * Read the running totals over the current + previous epoch buckets for `base`
   * WITHOUT recording an outcome (read-only sibling of {@link recordOutcome}).
   * Backs the admin status surface's `failure_rate` column. Returns `{0, 0}` when
   * the window is empty (or on a Redis miss).
   */
  readWindow(base: string, windowMs: number, now: number): Promise<BreakerWindow>;
  /**
   * Claim a half-open trial slot for `base`. Returns true for the first `max`
   * callers within `ttlMs`, false thereafter. Mirrors the concurrency limiter's
   * INCR-with-cap, but slots are never released — the TTL is the only reset.
   */
  tryTrial(base: string, max: number, ttlMs: number): Promise<boolean>;
  /** Drop the current + previous window buckets for `base` (used on →closed). */
  clearWindow(base: string, windowMs: number, now: number): Promise<void>;
}

/** Compute the fixed-window epoch index for `now`. */
function epochOf(now: number, windowMs: number): number {
  return Math.floor(now / windowMs);
}

/** The window hash key for a given base + epoch. */
function winKey(base: string, epoch: number): string {
  return `breaker:win:${base}:${String(epoch)}`;
}

/** The half-open trial-gate key for a base. */
function trialKey(base: string): string {
  return `breaker:trial:${base}`;
}

// Increment the current epoch's total (and fail) hash fields, set a 2×window
// TTL on first touch, then sum current + previous epoch buckets and return the
// combined {total, fail}. One round-trip, no read-modify-write race.
const RECORD_OUTCOME_LUA = `
local cur = KEYS[1]
local prev = KEYS[2]
local ttl = tonumber(ARGV[1])
local isFail = tonumber(ARGV[2])

local total = redis.call('HINCRBY', cur, 'total', 1)
if total == 1 then
  redis.call('PEXPIRE', cur, ttl)
end
local fail = 0
if isFail == 1 then
  fail = redis.call('HINCRBY', cur, 'fail', 1)
else
  fail = tonumber(redis.call('HGET', cur, 'fail')) or 0
end

local pTotal = tonumber(redis.call('HGET', prev, 'total')) or 0
local pFail = tonumber(redis.call('HGET', prev, 'fail')) or 0

return {total + pTotal, fail + pFail}
`;

// Read-only sum of the current + previous epoch buckets (the same window
// {@link RECORD_OUTCOME_LUA} returns, without the increment). For the admin
// `failure_rate` surface — a miss on either bucket reads as 0.
const READ_WINDOW_LUA = `
local cur = KEYS[1]
local prev = KEYS[2]
local cTotal = tonumber(redis.call('HGET', cur, 'total')) or 0
local cFail = tonumber(redis.call('HGET', cur, 'fail')) or 0
local pTotal = tonumber(redis.call('HGET', prev, 'total')) or 0
local pFail = tonumber(redis.call('HGET', prev, 'fail')) or 0
return {cTotal + pTotal, cFail + pFail}
`;

// INCR + safety TTL on first hit (mirrors CONC_INCR_LUA). Slots are never
// released; the TTL is the only reset, so the gate admits at most `max` trials
// per cooldown window.
const TRY_TRIAL_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n
`;

/** {@link BreakerRedis} over an ioredis-like client via Lua scripts. */
export class LuaBreakerRedis implements BreakerRedis {
  constructor(private readonly redis: EvalCapableRedis) {}

  async recordOutcome(
    base: string,
    windowMs: number,
    isFail: boolean,
    now: number,
  ): Promise<BreakerWindow> {
    const epoch = epochOf(now, windowMs);
    const cur = winKey(base, epoch);
    const prev = winKey(base, epoch - 1);
    const raw = await this.redis.eval(
      RECORD_OUTCOME_LUA,
      2,
      cur,
      prev,
      windowMs * 2,
      isFail ? 1 : 0,
    );
    const [total, fail] = raw as [number, number];
    return { total, fail };
  }

  async readWindow(base: string, windowMs: number, now: number): Promise<BreakerWindow> {
    const epoch = epochOf(now, windowMs);
    const raw = await this.redis.eval(
      READ_WINDOW_LUA,
      2,
      winKey(base, epoch),
      winKey(base, epoch - 1),
    );
    const [total, fail] = raw as [number, number];
    return { total, fail };
  }

  async tryTrial(base: string, max: number, ttlMs: number): Promise<boolean> {
    if (max <= 0) return false;
    const n = (await this.redis.eval(TRY_TRIAL_LUA, 1, trialKey(base), ttlMs)) as number;
    return n <= max;
  }

  async clearWindow(base: string, windowMs: number, now: number): Promise<void> {
    const epoch = epochOf(now, windowMs);
    await this.redis.eval(
      'redis.call("DEL", KEYS[1], KEYS[2]); return 1',
      2,
      winKey(base, epoch),
      winKey(base, epoch - 1),
    );
  }
}

/** One window bucket's accumulated counts plus its expiry. */
interface FakeBucket {
  total: number;
  fail: number;
  expiresAt: number;
}

/**
 * Deterministic in-memory {@link BreakerRedis} for tests. Mirrors the Lua
 * semantics: a fixed-window hash per epoch with a 2×window TTL, summed over the
 * current + previous epoch; an INCR-with-cap trial gate using `Date.now()` for
 * its TTL so `vi.useFakeTimers()` can drive expiry.
 */
export class FakeBreakerRedis implements BreakerRedis {
  private readonly windows = new Map<string, FakeBucket>();
  private readonly trials = new Map<string, { count: number; expiresAt: number }>();

  recordOutcome(
    base: string,
    windowMs: number,
    isFail: boolean,
    now: number,
  ): Promise<BreakerWindow> {
    const epoch = epochOf(now, windowMs);
    const curKey = winKey(base, epoch);

    let cur = this.windows.get(curKey);
    if (cur === undefined || cur.expiresAt <= now) {
      cur = { total: 0, fail: 0, expiresAt: now + windowMs * 2 };
      this.windows.set(curKey, cur);
    }
    cur.total += 1;
    if (isFail) cur.fail += 1;

    const prevKey = winKey(base, epoch - 1);
    const prev = this.windows.get(prevKey);
    const pTotal = prev !== undefined && prev.expiresAt > now ? prev.total : 0;
    const pFail = prev !== undefined && prev.expiresAt > now ? prev.fail : 0;

    return Promise.resolve({ total: cur.total + pTotal, fail: cur.fail + pFail });
  }

  readWindow(base: string, windowMs: number, now: number): Promise<BreakerWindow> {
    const epoch = epochOf(now, windowMs);
    const cur = this.windows.get(winKey(base, epoch));
    const prev = this.windows.get(winKey(base, epoch - 1));
    const cTotal = cur !== undefined && cur.expiresAt > now ? cur.total : 0;
    const cFail = cur !== undefined && cur.expiresAt > now ? cur.fail : 0;
    const pTotal = prev !== undefined && prev.expiresAt > now ? prev.total : 0;
    const pFail = prev !== undefined && prev.expiresAt > now ? prev.fail : 0;
    return Promise.resolve({ total: cTotal + pTotal, fail: cFail + pFail });
  }

  tryTrial(base: string, max: number, ttlMs: number): Promise<boolean> {
    if (max <= 0) return Promise.resolve(false);
    const now = Date.now();
    const key = trialKey(base);
    const existing = this.trials.get(key);

    if (existing === undefined || existing.expiresAt <= now) {
      this.trials.set(key, { count: 1, expiresAt: now + ttlMs });
      return Promise.resolve(1 <= max);
    }
    existing.count += 1;
    return Promise.resolve(existing.count <= max);
  }

  clearWindow(base: string, windowMs: number, now: number): Promise<void> {
    const epoch = epochOf(now, windowMs);
    this.windows.delete(winKey(base, epoch));
    this.windows.delete(winKey(base, epoch - 1));
    return Promise.resolve();
  }
}
