import type { Database } from '@actionow/db';
import {
  type BreakerConfig,
  type BreakerPersistence,
  buildBreakerStore as buildEngineBreakerStore,
  type DefaultBreakerStore,
  pgBreakerPersistence as enginePgBreakerPersistence,
  resolveChannelBreakerConfig as engineResolveChannelBreakerConfig,
} from '@actionow/engine';
import type { Redis } from '@actionow/infra';

/**
 * Build the engine {@link BreakerPersistence} over a live drizzle `db`. Thin
 * re-export of the shared engine factory so the API + worker can't drift.
 */
export function pgBreakerPersistence(db: Database): BreakerPersistence {
  return enginePgBreakerPersistence(db);
}

/**
 * Resolve a channel's effective {@link BreakerConfig} (its `fault_policy` breaker
 * columns merged over the global defaults). Thin re-export of the shared engine
 * helper. An unknown channel / unbound policy → the defaults.
 */
export function resolveChannelBreakerConfig(
  db: Database,
  channelId: string,
): Promise<BreakerConfig> {
  return engineResolveChannelBreakerConfig(db, channelId);
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
 * gate + PG FSM state + per-channel config resolution, via the shared engine
 * factory. The optional `audit` sink mirrors every transition into the
 * `audit_log` (actor_type `system`, action `breaker.<state>`). Fail-open /
 * best-effort throughout — a breaker outage only stops the OPTIMIZATION.
 */
export function buildBreakerStore(
  db: Database,
  redis: Redis,
  audit?: BreakerAuditSink,
): DefaultBreakerStore {
  return buildEngineBreakerStore(db, redis, audit);
}
