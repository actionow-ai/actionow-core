/**
 * Circuit-breaker FSM core (弹性2.0) — pure transition functions + global
 * defaults. Keyed per `(channel, model)` at the call sites; these functions take
 * a {@link BreakerSnapshot} (the current persisted state) plus the resolved
 * {@link BreakerConfig} and return the NEXT snapshot, or `null` when no
 * transition is warranted.
 *
 * The breaker only OPTIMIZES routing — it must never fail a request that could
 * have succeeded. These functions are pure (no I/O); the store layer (Task 6)
 * wraps every persistence read/write fail-open.
 */

export type BreakerState = 'closed' | 'open' | 'half_open';

/** Effective breaker thresholds for one channel (fault_policy merged over defaults). */
export interface BreakerConfig {
  enabled: boolean;
  windowMs: number;
  minVolume: number;
  failureRatePct: number;
  halfOpenTrial: number;
  halfOpenSuccesses: number;
  openCooldownMs: number;
  openCooldownCapMs: number;
}

/**
 * Global defaults — used when a channel has no `fault_policy` or a breaker
 * column is null. (Spec ③: window 60s, min_volume 20, failure_rate 50%,
 * half_open_trial 3, half_open_successes 2, cooldown 5s→300s cap.)
 */
export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  enabled: true,
  windowMs: 60_000,
  minVolume: 20,
  failureRatePct: 50,
  halfOpenTrial: 3,
  halfOpenSuccesses: 2,
  openCooldownMs: 5_000,
  openCooldownCapMs: 300_000,
};

/** The persisted FSM state for one `(channel, model)` (closed = no row). */
export interface BreakerSnapshot {
  state: BreakerState;
  openedAt: Date | null;
  cooldownUntil: Date | null;
  tripCount: number;
  halfOpenSuccesses: number;
}

/** Sliding-window outcome counts over the breaker window (from Redis). */
export interface WindowStats {
  total: number;
  fail: number;
}

/** Exponential backoff for the n-th trip (0-indexed), capped at `openCooldownCapMs`. */
export function cooldownMs(cfg: BreakerConfig, tripCount: number): number {
  return Math.min(cfg.openCooldownMs * 2 ** Math.max(0, tripCount), cfg.openCooldownCapMs);
}

/** Build the Open snapshot after a trip (bumps `trip_count`, sets cooldown). */
function open(cfg: BreakerConfig, prevTrip: number, now: Date): BreakerSnapshot {
  const tripCount = prevTrip + 1;
  return {
    state: 'open',
    openedAt: now,
    cooldownUntil: new Date(now.getTime() + cooldownMs(cfg, tripCount - 1)),
    tripCount,
    halfOpenSuccesses: 0,
  };
}

/**
 * Next state after a FAILURE, or `null` if no transition.
 *
 * - disabled → never trips.
 * - `half_open` → reopen (cooldown doubled via the bumped trip_count, capped).
 * - `open` → already open, no re-transition.
 * - `closed` → trip iff `volume ≥ min_volume` AND `failure_rate ≥ failure_rate_pct`.
 */
export function onFailureTransition(
  cur: BreakerSnapshot,
  cfg: BreakerConfig,
  win: WindowStats,
  now: Date,
): BreakerSnapshot | null {
  if (!cfg.enabled) return null;
  if (cur.state === 'half_open') return open(cfg, cur.tripCount, now);
  if (cur.state === 'open') return null; // already open
  // closed: trip iff volume + failure-rate thresholds met
  const ratePct = win.total > 0 ? (win.fail / win.total) * 100 : 0;
  if (win.total >= cfg.minVolume && ratePct >= cfg.failureRatePct) {
    return open(cfg, cur.tripCount, now);
  }
  return null;
}

/**
 * Next state after a SUCCESS, or `null` if no transition. Only `half_open`
 * advances: reaching `half_open_successes` consecutive successes closes the
 * breaker (clearing trip_count); short of it stays half_open. (No `now` arg —
 * closing clears all timestamps, so there is nothing to stamp.)
 */
export function onSuccessTransition(
  cur: BreakerSnapshot,
  cfg: BreakerConfig,
): BreakerSnapshot | null {
  if (cur.state !== 'half_open') return null;
  const successes = cur.halfOpenSuccesses + 1;
  if (successes >= cfg.halfOpenSuccesses) {
    return {
      state: 'closed',
      openedAt: null,
      cooldownUntil: null,
      tripCount: 0,
      halfOpenSuccesses: 0,
    };
  }
  return { ...cur, state: 'half_open', halfOpenSuccesses: successes };
}

/** An Open breaker whose cooldown has elapsed is eligible to probe (half-open). */
export function openEligibleAt(cur: BreakerSnapshot, now: Date): boolean {
  return (
    cur.state === 'open' &&
    cur.cooldownUntil !== null &&
    now.getTime() >= cur.cooldownUntil.getTime()
  );
}

/** A `fault_policy`'s nullable breaker columns (snake_case→camel from the DB row). */
export interface BreakerPolicyFields {
  breakerEnabled?: boolean | null | undefined;
  breakerWindowMs?: number | null | undefined;
  breakerMinVolume?: number | null | undefined;
  breakerFailureRatePct?: number | null | undefined;
  breakerHalfOpenTrial?: number | null | undefined;
  breakerHalfOpenSuccesses?: number | null | undefined;
  breakerOpenCooldownMs?: number | null | undefined;
  breakerOpenCooldownCapMs?: number | null | undefined;
}

/** Merge a fault_policy's nullable breaker fields over the global defaults. */
export function resolveBreakerConfig(policy?: BreakerPolicyFields | null): BreakerConfig {
  const d = DEFAULT_BREAKER_CONFIG;
  if (!policy) return d;
  return {
    enabled: policy.breakerEnabled ?? d.enabled,
    windowMs: policy.breakerWindowMs ?? d.windowMs,
    minVolume: policy.breakerMinVolume ?? d.minVolume,
    failureRatePct: policy.breakerFailureRatePct ?? d.failureRatePct,
    halfOpenTrial: policy.breakerHalfOpenTrial ?? d.halfOpenTrial,
    halfOpenSuccesses: policy.breakerHalfOpenSuccesses ?? d.halfOpenSuccesses,
    openCooldownMs: policy.breakerOpenCooldownMs ?? d.openCooldownMs,
    openCooldownCapMs: policy.breakerOpenCooldownCapMs ?? d.openCooldownCapMs,
  };
}
