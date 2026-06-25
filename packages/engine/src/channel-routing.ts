import { AdapterError, routeWithFailover, type WeightedChannel } from '@actionow/adapters';
import type { DbOrTx } from '@actionow/db';

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
 * The channels routable right now. A single channel is returned as-is (nothing
 * to choose between).
 *
 * TODO(resilience-v2 Phase 3): the binary `channel_health` cooldown
 * (`listCooledDownChannelIds`) was removed here in Task 2 — this temporarily
 * returns the FULL set so the package builds while the schema/repos land. Phase 3
 * (Task 7) wires the injected `BreakerStore.filterAvailable` (per-(channel,model)
 * Closed/Open/HalfOpen), fail-open inside the store.
 */
export function availableChannels<C extends RoutableChannel>(
  _deps: ChannelRouterDeps,
  channels: readonly C[],
): Promise<C[]> {
  return Promise.resolve([...channels]);
}

/**
 * Weighted-pick + failover over the available channels for a BLOCKING attempt.
 * A non-retryable error is rethrown immediately; on a retryable failure the
 * router advances to the next channel. Throws the last error if every channel is
 * exhausted.
 *
 * TODO(resilience-v2 Phase 3): the per-failure cooldown write (`recordChannelFailure`)
 * was removed here in Task 2. Phase 3 (Task 7) replaces it with best-effort
 * `BreakerStore.onSuccess`/`onFailure` outcome hooks (fire-and-forget, never
 * blocking the relay hot path).
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
  return routeWithFailover(weighted, deps.rng, (value) => attempt(value), isFailoverRetryable);
}
