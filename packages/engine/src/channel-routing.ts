import {
  isRetryableAdapterError,
  routeWithFailover,
  type WeightedChannel,
} from '@actionow/adapters';
import { type DbOrTx, listCooledDownChannelIds, recordChannelFailure } from '@actionow/db';

/** The minimal channel shape the router needs: `id` (cooldown) + `weight` (selection). */
export interface RoutableChannel {
  id: string;
  weight: number;
}

/** The db/clock/rng the channel router reads cooldown from and records failures into. */
export interface ChannelRouterDeps {
  db: DbOrTx;
  now: () => Date;
  rng: () => number;
}

/**
 * The channels routable right now: those NOT currently in cooldown. Falls back
 * to the FULL set when every channel is cooled down (better to retry a cooled
 * channel than hard-fail with no upstream). A single channel is returned as-is
 * without a cooldown query (nothing to choose between).
 */
export async function availableChannels<C extends RoutableChannel>(
  deps: ChannelRouterDeps,
  channels: readonly C[],
): Promise<C[]> {
  if (channels.length <= 1) return [...channels];
  let cooled: Set<string>;
  try {
    cooled = new Set(
      await listCooledDownChannelIds(
        deps.db,
        channels.map((c) => c.id),
        deps.now(),
      ),
    );
  } catch {
    // Best-effort: channel health is an optimization, never a gate. A
    // cooldown-store error degrades to "nothing is cooled" so routing proceeds.
    return [...channels];
  }
  const available = channels.filter((c) => !cooled.has(c.id));
  return available.length > 0 ? available : [...channels];
}

/**
 * Weighted-pick + failover over the available channels for a BLOCKING attempt.
 * On a retryable failure the channel is cooled down (so subsequent requests skip
 * it) before advancing to the next channel; a non-retryable error is rethrown
 * immediately. Throws the last error if every channel is exhausted.
 */
export async function routeBlocking<C extends RoutableChannel, R>(
  deps: ChannelRouterDeps,
  channels: readonly C[],
  attempt: (channel: C) => Promise<R>,
): Promise<R> {
  const available = await availableChannels(deps, channels);
  const weighted: WeightedChannel<C>[] = available.map((c) => ({
    id: c.id,
    weight: c.weight,
    value: c,
  }));
  return routeWithFailover(
    weighted,
    deps.rng,
    async (value, channel) => {
      try {
        return await attempt(value);
      } catch (err) {
        if (isRetryableAdapterError(err)) {
          try {
            await recordChannelFailure(deps.db, channel.id, deps.now());
          } catch {
            // Best-effort cooldown write; never let it mask the upstream failure.
          }
        }
        throw err;
      }
    },
    isRetryableAdapterError,
  );
}
