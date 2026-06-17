import { AdapterError } from './errors.js';

/** A routing candidate carrying its selection `weight` and the routed `value`. */
export interface WeightedChannel<T> {
  id: string;
  weight: number;
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
 * Order channels for a failover attempt: the weighted pick first, then the
 * remaining channels by descending weight (ties keep list order).
 *
 * Exported for callers (e.g. the engine's streaming chat path) that must drive
 * the failover loop themselves — `routeWithFailover` returns a value, but a
 * stream has to commit to a channel mid-attempt (after the first frame).
 */
export function orderForFailover<T>(
  channels: readonly WeightedChannel<T>[],
  rng: () => number,
): WeightedChannel<T>[] {
  const picked = selectWeighted(channels, rng);
  const rest = channels.filter((c) => c !== picked).sort((a, b) => b.weight - a.weight);
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
