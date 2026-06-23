import { AdapterError, routeWithFailover, type WeightedChannel } from '@actionow/adapters';
import { type DbOrTx, listCooledDownChannelIds, recordChannelFailure } from '@actionow/db';

import { EngineError } from './errors.js';

/**
 * The CROSS-channel failover verdict: should this error cause the router to cool
 * down the channel and try the next one?
 *
 * - An {@link AdapterError}/{@link EngineError} carries an explicit `retryable`
 *   verdict — honor it (a `content_filtered`/`invalid_input`/`unauthorized` must
 *   NOT failover; a `rate_limited`/`upstream_error` should).
 * - ANY OTHER thrown value is a RAW transport failure (a `fetch` AbortError, DNS
 *   failure, ECONNRESET — never wrapped in an AdapterError) → the channel is
 *   effectively unreachable, so cool it down and cascade to the next channel.
 *   (`isRetryableAdapterError` returned `false` for these, hard-failing the whole
 *   request on a single dead channel — this widens it to a proper failover.)
 */
export function isFailoverRetryable(err: unknown): boolean {
  if (err instanceof AdapterError) return err.unified.retryable;
  if (err instanceof EngineError) return err.unified.retryable;
  return true;
}

/**
 * The minimal channel shape the router needs: `id` (cooldown), `weight`
 * (weighted selection within a tier) and an optional `priority` (the fallback
 * TIER — HIGHER is tried first; absent → `0`, a single tier). Track 4 sources
 * `priority`/`weight` from the key's route-group membership; legacy
 * resource-level routing leaves `priority` absent → a single tier, so the
 * behavior is unchanged.
 */
export interface RoutableChannel {
  id: string;
  weight: number;
  /** Fallback tier — HIGHER is tried first. Absent → `0` (single tier). */
  priority?: number | undefined;
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
    priority: c.priority,
    value: c,
  }));
  return routeWithFailover(
    weighted,
    deps.rng,
    async (value, channel) => {
      try {
        return await attempt(value);
      } catch (err) {
        if (isFailoverRetryable(err)) {
          try {
            await recordChannelFailure(deps.db, channel.id, deps.now());
          } catch {
            // Best-effort cooldown write; never let it mask the upstream failure.
          }
        }
        throw err;
      }
    },
    isFailoverRetryable,
  );
}
