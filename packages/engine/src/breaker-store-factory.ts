/**
 * Shared {@link DefaultBreakerStore} factory (弹性2.0) — the db-backed glue that
 * BOTH the API (`apps/api`, Nest DI over `AuditService`) and the worker
 * (`apps/worker`, no DI, audits via `appendAuditLog`) construct their breaker
 * from. Keeps the PG persistence adapter + per-channel config resolution in ONE
 * place so the two app-layer wirings can't drift.
 *
 * Every read/write here is fail-open / best-effort by construction: the store's
 * own try/catch swallows persistence errors and `resolveBreakerConfig()` falls
 * back to the global defaults, so a breaker outage only stops the OPTIMIZATION —
 * never a request that could have succeeded.
 */

import {
  type DbOrTx,
  getBreakerRows,
  getChannelById,
  getFaultPolicyById,
  upsertBreaker,
} from '@actionow/db';
import type { BreakerRedis } from '@actionow/infra';
import { LuaBreakerRedis, type Redis } from '@actionow/infra';

import {
  type BreakerConfig,
  type BreakerPersistence,
  type BreakerRowSnapshot,
  type BreakerSnapshot,
  type BreakerState,
  DefaultBreakerStore,
  resolveBreakerConfig,
} from './breaker.js';

/**
 * Build the {@link BreakerPersistence} over a live `db`, wrapping the breaker
 * repo functions. The store treats a missing `(channel, model)` row as the
 * implicit closed state, so `getRows` returns only the persisted (non-closed)
 * rows for the queried channels.
 */
export function pgBreakerPersistence(db: DbOrTx): BreakerPersistence {
  return {
    async getRows(channelIds: string[], model: string): Promise<BreakerRowSnapshot[]> {
      const rows = await getBreakerRows(db, channelIds, model);
      return rows.map((r) => ({
        channelId: r.channelId,
        state: r.state,
        openedAt: r.openedAt,
        cooldownUntil: r.cooldownUntil,
        tripCount: r.tripCount,
        halfOpenSuccesses: r.halfOpenSuccesses,
      }));
    },
    async upsert(
      channelId: string,
      model: string,
      snap: BreakerSnapshot,
      now: Date,
    ): Promise<void> {
      await upsertBreaker(db, {
        channelId,
        model,
        state: snap.state,
        openedAt: snap.openedAt,
        cooldownUntil: snap.cooldownUntil,
        tripCount: snap.tripCount,
        halfOpenSuccesses: snap.halfOpenSuccesses,
        now,
      });
    },
  };
}

/**
 * Resolve a channel's effective {@link BreakerConfig}: read its `fault_policy_id`,
 * load that policy's nullable breaker columns, and merge them over the global
 * defaults (`resolveBreakerConfig`). An unknown channel / unbound policy → the
 * defaults. Best-effort: any read failure is swallowed by the store's outer
 * try/catch and falls back to the defaults via `resolveBreakerConfig`.
 */
export async function resolveChannelBreakerConfig(
  db: DbOrTx,
  channelId: string,
): Promise<BreakerConfig> {
  const channel = await getChannelById(db, channelId);
  if (channel?.faultPolicyId == null) return resolveBreakerConfig();
  const policy = await getFaultPolicyById(db, channel.faultPolicyId);
  return resolveBreakerConfig(policy);
}

/** A best-effort audit callback for a single breaker state transition. */
export type BreakerTransitionAudit = (input: {
  actorType: 'system';
  action: string;
  targetType: 'channel';
  targetId: string;
  meta: Record<string, unknown>;
}) => void;

/**
 * Construct a {@link DefaultBreakerStore}: a {@link LuaBreakerRedis} window/trial
 * gate + the PG FSM state ({@link pgBreakerPersistence}) + per-channel config
 * resolution ({@link resolveChannelBreakerConfig}). The optional `audit` callback
 * mirrors every state transition (actor_type `system`, action `breaker.<state>`)
 * — the API passes `AuditService.record`, the worker passes an `appendAuditLog`
 * adapter. Fail-open / best-effort throughout (see the module note).
 */
export function buildBreakerStore(
  db: DbOrTx,
  redis: Redis,
  audit?: BreakerTransitionAudit,
): DefaultBreakerStore {
  const breakerRedis: BreakerRedis = new LuaBreakerRedis(redis);
  return new DefaultBreakerStore({
    redis: breakerRedis,
    persistence: pgBreakerPersistence(db),
    configFor: (channelId: string): Promise<BreakerConfig> =>
      resolveChannelBreakerConfig(db, channelId),
    ...(audit !== undefined
      ? {
          onTransition: (
            channelId: string,
            model: string,
            from: BreakerState,
            to: BreakerState,
            meta: Record<string, unknown>,
          ): void => {
            audit({
              actorType: 'system',
              action: `breaker.${to}`,
              targetType: 'channel',
              targetId: channelId,
              meta: { model, from, ...meta },
            });
          },
        }
      : {}),
  });
}
