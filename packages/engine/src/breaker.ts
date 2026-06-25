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

import type { BreakerRedis } from '@actionow/infra';

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

/**
 * A breaker's recent-window stats for the admin status surface: the Redis
 * sliding-window counts plus the derived failure rate (%). Returned by
 * {@link BreakerStore.windowStats}; `null` when the window can't be read
 * (Redis miss / error — the surface degrades to no failure_rate, never an error).
 */
export interface BreakerWindowStats {
  total: number;
  fail: number;
  /** `fail / total × 100`, or 0 when the window is empty. */
  failureRatePct: number;
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

// ---------------------------------------------------------------------------
// BreakerStore — ties the Redis window/trial gate (infra) + PG FSM state (db)
// + the pure FSM transitions above into the read/write surface the routing
// layer consumes. Injected via engine deps; the app layer supplies a concrete
// {@link BreakerPersistence} (wrapping getBreakerRows/upsertBreaker) and a
// {@link BreakerConfig} resolver.
//
// CRITICAL INVARIANT: the breaker only OPTIMIZES routing — every Redis/PG
// read+write here is best-effort. `filterAvailable` fails OPEN (returns every
// channel) on any error; `onSuccess`/`onFailure` swallow errors entirely. A
// breaker outage must NEVER fail a request that could have succeeded.
// ---------------------------------------------------------------------------

/** Minimal shape `filterAvailable` needs from a routable channel: its id. */
export interface RoutableChannelRef {
  id: string;
}

/**
 * The PG state surface the store needs, wrapping `getBreakerRows`/`upsertBreaker`
 * (Task 2). The app layer binds these to a live `db`. The closed state is the
 * absence of a row, so `getRows` returns ONLY the non-closed `(channel, model)`
 * rows for the given channels.
 */
export interface BreakerPersistence {
  getRows(channelIds: string[], model: string): Promise<BreakerRowSnapshot[]>;
  upsert(channelId: string, model: string, snap: BreakerSnapshot, now: Date): Promise<void>;
}

/** A {@link BreakerSnapshot} tagged with the channel it belongs to (from `getRows`). */
export type BreakerRowSnapshot = { channelId: string } & BreakerSnapshot;

/** Dependencies for {@link DefaultBreakerStore}. */
export interface BreakerDeps {
  redis: BreakerRedis;
  /** PG read/write for FSM rows (wraps getBreakerRows/upsertBreaker — Task 2). */
  persistence: BreakerPersistence;
  /** Resolve a channel's effective config (fault_policy → resolveBreakerConfig; defaults if none). */
  configFor: (channelId: string) => Promise<BreakerConfig>;
  /** Best-effort audit hook fired on every state transition (actor_type='system'). */
  onTransition?: (
    channelId: string,
    model: string,
    from: BreakerState,
    to: BreakerState,
    meta: Record<string, unknown>,
  ) => void;
}

/**
 * The read/write breaker surface consumed by routing. `filterAvailable` is the
 * read path (exclude Open / trial-gate HalfOpen); `onSuccess`/`onFailure` are
 * the write path (increment the Redis window + run the FSM + persist/audit
 * transitions).
 */
export interface BreakerStore {
  /** The subset of channels routable now for `model` (excludes Open; trial-gates HalfOpen). Fail-open on error. */
  filterAvailable<C extends RoutableChannelRef>(
    channels: readonly C[],
    model: string,
    now: Date,
  ): Promise<C[]>;
  onSuccess(channelId: string, model: string, now: Date): Promise<void>;
  onFailure(channelId: string, model: string, now: Date, retryAfterMs?: number): Promise<void>;
  /**
   * The recent-window outcome stats for one `(channel, model)` (read-only — does
   * NOT record an outcome). Backs the admin status surface's `failure_rate`.
   * Returns `null` on any error (the surface omits the rate, never fails).
   */
  windowStats(channelId: string, model: string, now: Date): Promise<BreakerWindowStats | null>;
}

/**
 * Cap (ms) on the admin `windowStats` Redis read. The shared client is built with
 * `maxRetriesPerRequest: null` (commands queue indefinitely when Redis is down),
 * so the synchronous status surface needs its OWN timeout to degrade to `null`
 * instead of hanging — the FSM state is still authoritative without the rate.
 */
const WINDOW_STATS_TIMEOUT_MS = 1_000;

/** Reject after `ms` — used to bound the admin `windowStats` Redis read (fail-open). */
function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('breaker windowStats timeout'));
    }, ms);
    // Don't keep the event loop alive for this guard timer.
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  });
}

/** The implicit closed snapshot for a `(channel, model)` with no persisted row. */
const CLOSED_SNAPSHOT: BreakerSnapshot = {
  state: 'closed',
  openedAt: null,
  cooldownUntil: null,
  tripCount: 0,
  halfOpenSuccesses: 0,
};

/** The `${channelId}:${model}` Redis/trial key for one breaker. */
function breakerKey(channelId: string, model: string): string {
  return `${channelId}:${model}`;
}

/** Drop the `channelId` tag from a {@link BreakerRowSnapshot}, leaving the FSM snapshot. */
function stripChannelId(row: BreakerRowSnapshot): BreakerSnapshot {
  const { channelId, ...snap } = row;
  void channelId;
  return snap;
}

/**
 * Concrete {@link BreakerStore} wiring Redis (window + trial gate), PG (FSM
 * rows), and the pure FSM transitions. Every method is fail-open / best-effort.
 */
export class DefaultBreakerStore implements BreakerStore {
  constructor(private readonly deps: BreakerDeps) {}

  async filterAvailable<C extends RoutableChannelRef>(
    channels: readonly C[],
    model: string,
    now: Date,
  ): Promise<C[]> {
    if (channels.length === 0) return [];
    try {
      const ids = channels.map((c) => c.id);
      const rows = await this.deps.persistence.getRows(ids, model);
      const byId = new Map<string, BreakerSnapshot>();
      for (const r of rows) {
        const { channelId, ...snap } = r;
        byId.set(channelId, snap);
      }

      const out: C[] = [];
      for (const ch of channels) {
        const snap = byId.get(ch.id);
        // No row or closed → always routable.
        if (!snap || snap.state === 'closed') {
          out.push(ch);
          continue;
        }
        if (snap.state === 'open') {
          // Still cooling down → exclude.
          if (!openEligibleAt(snap, now)) continue;
          // Cooldown elapsed → lazily promote to half_open (reset successes),
          // persist, then trial-gate this request as the probe.
          const promoted: BreakerSnapshot = { ...snap, state: 'half_open', halfOpenSuccesses: 0 };
          const cfg = await this.deps.configFor(ch.id);
          await this.persist(ch.id, model, snap.state, promoted, now, {
            reason: 'cooldown_elapsed',
          });
          if (await this.tryTrial(ch.id, model, cfg)) out.push(ch);
          continue;
        }
        // half_open → trial-gate (include iff a slot is claimed).
        const cfg = await this.deps.configFor(ch.id);
        if (await this.tryTrial(ch.id, model, cfg)) out.push(ch);
      }
      return out;
    } catch {
      // Fail open: the breaker never removes a candidate it could not evaluate.
      return [...channels];
    }
  }

  // `retryAfterMs` is part of the {@link BreakerStore} contract but unused: the
  // FSM's exponential cooldown (scaled by trip_count) supersedes the old
  // `channel_health` Retry-After honoring, so the implementation omits the arg.
  async onFailure(channelId: string, model: string, now: Date): Promise<void> {
    try {
      const cfg = await this.deps.configFor(channelId);
      const key = breakerKey(channelId, model);
      const win = await this.deps.redis.recordOutcome(key, cfg.windowMs, true, now.getTime());
      const cur = await this.loadSnapshot(channelId, model);
      const next = onFailureTransition(cur, cfg, win, now);
      if (next) {
        await this.persist(channelId, model, cur.state, next, now, {
          failureRate: win.total > 0 ? (win.fail / win.total) * 100 : 0,
          window: win,
          tripCount: next.tripCount,
        });
      }
    } catch {
      // Best-effort: a breaker write must never block/throw on the relay path.
    }
  }

  async onSuccess(channelId: string, model: string, now: Date): Promise<void> {
    try {
      const cfg = await this.deps.configFor(channelId);
      const key = breakerKey(channelId, model);
      await this.deps.redis.recordOutcome(key, cfg.windowMs, false, now.getTime());
      const cur = await this.loadSnapshot(channelId, model);
      const next = onSuccessTransition(cur, cfg);
      if (next) {
        await this.persist(channelId, model, cur.state, next, now, { tripCount: next.tripCount });
        // Closing the breaker clears the window so a stale failure burst can't
        // immediately re-trip it.
        if (next.state === 'closed') {
          await this.deps.redis.clearWindow(key, cfg.windowMs, now.getTime());
        }
      }
    } catch {
      // Best-effort: swallow.
    }
  }

  async windowStats(
    channelId: string,
    model: string,
    now: Date,
  ): Promise<BreakerWindowStats | null> {
    try {
      const cfg = await this.deps.configFor(channelId);
      // Bound the read: the shared Redis client queues commands indefinitely when
      // Redis is down, so without this race the synchronous admin surface would
      // hang. On timeout we fail open to null (the FSM state stays authoritative).
      const win = await Promise.race([
        this.deps.redis.readWindow(breakerKey(channelId, model), cfg.windowMs, now.getTime()),
        timeoutAfter(WINDOW_STATS_TIMEOUT_MS),
      ]);
      return {
        total: win.total,
        fail: win.fail,
        failureRatePct: win.total > 0 ? (win.fail / win.total) * 100 : 0,
      };
    } catch {
      // Read-only + best-effort: the status surface omits the rate, never errors.
      return null;
    }
  }

  /** Load the current FSM snapshot, defaulting to closed when there is no row. */
  private async loadSnapshot(channelId: string, model: string): Promise<BreakerSnapshot> {
    const rows = await this.deps.persistence.getRows([channelId], model);
    const row = rows.find((r) => r.channelId === channelId);
    return row ? stripChannelId(row) : CLOSED_SNAPSHOT;
  }

  /** Persist a transition + fire the audit hook. */
  private async persist(
    channelId: string,
    model: string,
    from: BreakerState,
    next: BreakerSnapshot,
    now: Date,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.persistence.upsert(channelId, model, next, now);
    this.deps.onTransition?.(channelId, model, from, next.state, { model, ...meta });
  }

  /** Claim a Redis half-open trial slot for this `(channel, model)`. */
  private tryTrial(channelId: string, model: string, cfg: BreakerConfig): Promise<boolean> {
    return this.deps.redis.tryTrial(
      breakerKey(channelId, model),
      cfg.halfOpenTrial,
      cooldownMs(cfg, 0),
    );
  }
}
