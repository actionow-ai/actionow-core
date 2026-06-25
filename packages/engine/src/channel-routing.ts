import { AdapterError, routeWithFailover, type WeightedChannel } from '@actionow/adapters';
import type { DbOrTx } from '@actionow/db';

import type { BreakerStore } from './breaker.js';
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

/**
 * The db/clock/rng the channel router reads from. An optional {@link BreakerStore}
 * (弹性2.0) drives the per-`(channel, model)` circuit breaker: it excludes Open
 * channels + trial-gates HalfOpen ones in {@link availableChannels}, and is fed
 * each upstream outcome in {@link routeBlocking}. The store is fail-open and its
 * writes are fire-and-forget, so it only OPTIMIZES routing — a breaker outage
 * never fails a request that could have succeeded.
 */
export interface ChannelRouterDeps {
  db: DbOrTx;
  now: () => Date;
  rng: () => number;
  breaker?: BreakerStore | undefined;
}

/**
 * The channels routable right now for `model`. A single channel is returned
 * as-is (nothing to choose between, and the breaker only narrows a set). With no
 * injected breaker the full set is returned unchanged. The breaker's
 * {@link BreakerStore.filterAvailable} is fail-open internally, so an evaluation
 * error yields the full set rather than dropping a viable candidate.
 */
export function availableChannels<C extends RoutableChannel>(
  deps: ChannelRouterDeps,
  channels: readonly C[],
  model: string,
): Promise<C[]> {
  if (channels.length <= 1) return Promise.resolve([...channels]);
  if (deps.breaker === undefined) return Promise.resolve([...channels]);
  return deps.breaker.filterAvailable(channels, model, deps.now());
}

/**
 * Weighted-pick + failover over the available channels for a BLOCKING attempt.
 * A non-retryable error is rethrown immediately; on a retryable failure the
 * router advances to the next channel. Throws the last error if every channel is
 * exhausted.
 *
 * Each upstream outcome drives the breaker FSM: a returned attempt feeds
 * {@link BreakerStore.onSuccess}, a RETRYABLE failure feeds
 * {@link BreakerStore.onFailure}. A non-retryable failure (a content filter,
 * bad input, auth) is the caller's fault, not the channel's, so it is NOT
 * recorded. The outcome hooks are `void`-ed (fire-and-forget) — the store
 * already swallows errors, and this guarantees a breaker write can never block
 * or throw on the relay hot path.
 */
export async function routeBlocking<C extends RoutableChannel, R>(
  deps: ChannelRouterDeps,
  channels: readonly C[],
  model: string,
  attempt: (channel: C) => Promise<R>,
): Promise<R> {
  const available = await availableChannels(deps, channels, model);
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
        const result = await attempt(value);
        if (deps.breaker !== undefined) {
          void deps.breaker.onSuccess(channel.id, model, deps.now());
        }
        return result;
      } catch (err) {
        if (deps.breaker !== undefined && isFailoverRetryable(err)) {
          void deps.breaker.onFailure(channel.id, model, deps.now());
        }
        throw err;
      }
    },
    isFailoverRetryable,
  );
}
