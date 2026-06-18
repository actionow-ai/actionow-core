import { AdapterError } from './errors.js';

/**
 * A routing candidate carrying its selection `weight`, optional fallback
 * `priority`, and the routed `value`.
 *
 * `priority` defines the fallback TIER (Track 4): channels are grouped by
 * `priority`, tiers sorted HIGHEST-first, and a whole tier is tried (weighted
 * pick, then the rest by weight) before the next-lower tier is reached. An
 * absent `priority` is treated as `0`, so a list with no priorities collapses to
 * a single tier and behaves exactly like the pre-Track-4 weighted+failover.
 */
export interface WeightedChannel<T> {
  id: string;
  weight: number;
  /** Fallback tier — HIGHER is tried first. Absent → `0` (single tier). */
  priority?: number | undefined;
  value: T;
}

/**
 * Pick a channel by cumulative weight given `rng()` in `[0, 1)`.
 *
 * The interval `[0, 1)` is partitioned into bands proportional to each
 * channel's weight (in list order); `rng()` scaled by the total weight selects
 * the band it lands in. Deterministic for a deterministic `rng`. Throws on an
 * empty list.
 */
export function selectWeighted<T>(
  channels: readonly WeightedChannel<T>[],
  rng: () => number,
): WeightedChannel<T> {
  const first = channels[0];
  if (first === undefined) {
    throw new Error('selectWeighted: no channels to select from');
  }

  const total = channels.reduce((sum, c) => sum + c.weight, 0);
  if (total <= 0) {
    return first;
  }

  const target = rng() * total;
  let cumulative = 0;
  for (const channel of channels) {
    cumulative += channel.weight;
    if (target < cumulative) {
      return channel;
    }
  }

  // `rng()` is in [0,1) so `target < total`; this is unreachable in practice,
  // but we return the last channel defensively to avoid a non-null assertion.
  const last = channels[channels.length - 1];
  return last ?? first;
}

/**
 * Order channels for a failover attempt as PRIORITY TIERS (Track 4): channels
 * are grouped by `priority` (absent → `0`), the tiers sorted HIGHEST-priority
 * first, and EACH tier is internally ordered by the weighted pick (then the rest
 * by descending weight) before the next-lower tier is appended. The failover
 * loop therefore exhausts a whole tier before cascading to the next-lower one.
 *
 * A list with no priorities (or all equal) is a single tier → the result is
 * identical to the pre-Track-4 "weighted pick, then rest by weight" ordering, so
 * existing single-tier callers/tests are unaffected.
 *
 * Exported for callers (e.g. the engine's streaming chat path) that must drive
 * the failover loop themselves — `routeWithFailover` returns a value, but a
 * stream has to commit to a channel mid-attempt (after the first frame).
 */
export function orderForFailover<T>(
  channels: readonly WeightedChannel<T>[],
  rng: () => number,
): WeightedChannel<T>[] {
  if (channels.length === 0) return [];

  // Group into tiers keyed by priority (absent → 0), preserving list order
  // within each tier so a deterministic `rng` yields a deterministic ordering.
  const tiers = new Map<number, WeightedChannel<T>[]>();
  for (const c of channels) {
    const tier = c.priority ?? 0;
    const bucket = tiers.get(tier);
    if (bucket === undefined) tiers.set(tier, [c]);
    else bucket.push(c);
  }

  // Tiers HIGHEST-priority first; each tier weighted-ordered independently.
  const sortedTiers = [...tiers.keys()].sort((a, b) => b - a);
  return sortedTiers.flatMap((tier) => orderTier(tiers.get(tier) ?? [], rng));
}

/**
 * Order ONE priority tier: the weighted pick first, then the remaining channels
 * by descending weight (ties keep list order). This is the pre-Track-4 ordering,
 * now applied per-tier.
 */
function orderTier<T>(
  tier: readonly WeightedChannel<T>[],
  rng: () => number,
): WeightedChannel<T>[] {
  if (tier.length === 0) return [];
  const picked = selectWeighted(tier, rng);
  const rest = tier.filter((c) => c !== picked).sort((a, b) => b.weight - a.weight);
  return [picked, ...rest];
}

/**
 * Try each channel in failover order (weighted pick first, then the rest by
 * descending weight). For each, run `attempt`; if it throws and `isRetryable`
 * returns `true`, advance to the next channel. A non-retryable error is
 * rethrown immediately. If every channel is exhausted, the last error is thrown.
 */
export async function routeWithFailover<T, R>(
  channels: readonly WeightedChannel<T>[],
  rng: () => number,
  attempt: (value: T, channel: WeightedChannel<T>) => Promise<R>,
  isRetryable: (err: unknown) => boolean,
): Promise<R> {
  if (channels.length === 0) {
    throw new Error('routeWithFailover: no channels to route to');
  }
  const ordered = orderForFailover(channels, rng);

  let lastError: unknown;
  for (const channel of ordered) {
    try {
      return await attempt(channel.value, channel);
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) {
        throw err;
      }
    }
  }

  // `channels` was non-empty, so the loop ran and `lastError` was set on the
  // final retryable failure (the only way to exit the loop without returning).
  throw lastError;
}

/**
 * Read the `retryable` verdict from an {@link AdapterError}'s unified error.
 * Returns `false` for any other (non-adapter) error value.
 */
export function isRetryableAdapterError(err: unknown): boolean {
  return err instanceof AdapterError && err.unified.retryable;
}
