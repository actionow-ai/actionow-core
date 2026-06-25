import {
  type Database,
  getBreakerRows,
  getChannelById,
  getFaultPolicyById,
  upsertBreaker,
} from '@actionow/db';
import {
  type BreakerConfig,
  type BreakerPersistence,
  type BreakerRowSnapshot,
  type BreakerSnapshot,
  type BreakerState,
  DefaultBreakerStore,
  resolveBreakerConfig,
} from '@actionow/engine';
import { type BreakerRedis, LuaBreakerRedis, type Redis } from '@actionow/infra';

/**
 * Build the engine {@link BreakerPersistence} over a live drizzle `db`, wrapping
 * the Task-2 breaker repo functions. The store treats a missing `(channel,
 * model)` row as the implicit closed state, so `getRows` returns only the
 * persisted (non-closed) rows for the queried channels.
 */
export function pgBreakerPersistence(db: Database): BreakerPersistence {
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
 * defaults. Best-effort by construction: any read failure here is swallowed by
 * the store's outer try/catch and falls back to the defaults via `resolveBreakerConfig`.
 */
export function resolveChannelBreakerConfig(
  db: Database,
  channelId: string,
): Promise<BreakerConfig> {
  return (async (): Promise<BreakerConfig> => {
    const channel = await getChannelById(db, channelId);
    if (channel?.faultPolicyId == null) return resolveBreakerConfig();
    const policy = await getFaultPolicyById(db, channel.faultPolicyId);
    return resolveBreakerConfig(policy);
  })();
}

/** A best-effort audit sink for breaker transitions (the API's `AuditService.record`). */
export type BreakerAuditSink = (input: {
  actorType: 'system';
  action: string;
  targetType: 'channel';
  targetId: string;
  meta: Record<string, unknown>;
}) => void;

/**
 * Construct the API's {@link DefaultBreakerStore} (弹性2.0): Redis window/trial
 * gate ({@link LuaBreakerRedis}) + PG FSM state ({@link pgBreakerPersistence}) +
 * per-channel config resolution. The optional `audit` sink mirrors every state
 * transition into the `audit_log` (actor_type `system`, action `breaker.<state>`).
 * Every read/write inside the store is fail-open / best-effort, so a breaker
 * outage only stops the OPTIMIZATION — never a request that could have succeeded.
 */
export function buildBreakerStore(
  db: Database,
  redis: Redis,
  audit?: BreakerAuditSink,
): DefaultBreakerStore {
  const breakerRedis: BreakerRedis = new LuaBreakerRedis(redis);
  return new DefaultBreakerStore({
    redis: breakerRedis,
    persistence: pgBreakerPersistence(db),
    configFor: (channelId: string) => resolveChannelBreakerConfig(db, channelId),
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
