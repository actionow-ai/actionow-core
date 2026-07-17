import { and, eq, inArray, sql } from 'drizzle-orm';

import { channelBreaker } from '../schema/channel-breaker.js';
import type { DbOrTx } from './types.js';

/** A breaker FSM row projected for the engine read/write path (弹性2.0). */
export interface BreakerRow {
  readonly channelId: string;
  readonly model: string;
  readonly state: 'closed' | 'open' | 'half_open';
  readonly openedAt: Date | null;
  readonly cooldownUntil: Date | null;
  readonly tripCount: number;
  readonly halfOpenSuccesses: number;
}

/** The runtime-FSM columns selected for a {@link BreakerRow} (no audit timestamps). */
const COLS = {
  channelId: channelBreaker.channelId,
  model: channelBreaker.model,
  state: channelBreaker.state,
  openedAt: channelBreaker.openedAt,
  cooldownUntil: channelBreaker.cooldownUntil,
  tripCount: channelBreaker.tripCount,
  halfOpenSuccesses: channelBreaker.halfOpenSuccesses,
} as const;

/**
 * The breaker rows for a set of channels at one `model`. A `(channel, model)`
 * with NO row is implicitly `closed` (the absence is the closed state), so the
 * caller treats a missing channel as routable. An empty `channelIds` short-
 * circuits without a query.
 */
export async function getBreakerRows(
  db: DbOrTx,
  channelIds: string[],
  model: string,
): Promise<BreakerRow[]> {
  if (channelIds.length === 0) return [];
  return db
    .select(COLS)
    .from(channelBreaker)
    .where(
      and(inArray(channelBreaker.channelId, channelIds), eq(channelBreaker.model, model)),
    ) as Promise<BreakerRow[]>;
}

/** Fields {@link upsertBreaker} writes for one `(channel, model)` FSM row. */
export interface UpsertBreakerInput {
  readonly channelId: string;
  readonly model: string;
  readonly state: 'closed' | 'open' | 'half_open';
  readonly openedAt?: Date | null;
  readonly cooldownUntil?: Date | null;
  readonly tripCount: number;
  readonly halfOpenSuccesses: number;
  /** Stamp written to both `last_transition_at` and `updated_at`. */
  readonly now: Date;
}

/**
 * Upsert the FSM state for one `(channel, model)` on the composite PK: inserts a
 * new row or overwrites the existing one. Best-effort from the engine's outcome
 * hooks — a write failure must never block the relay (the caller swallows).
 */
export async function upsertBreaker(db: DbOrTx, row: UpsertBreakerInput): Promise<void> {
  const values = {
    channelId: row.channelId,
    model: row.model,
    state: row.state,
    openedAt: row.openedAt ?? null,
    cooldownUntil: row.cooldownUntil ?? null,
    tripCount: row.tripCount,
    halfOpenSuccesses: row.halfOpenSuccesses,
    lastTransitionAt: row.now,
    updatedAt: row.now,
  };
  await db
    .insert(channelBreaker)
    .values(values)
    .onConflictDoUpdate({
      target: [channelBreaker.channelId, channelBreaker.model],
      set: values,
    });
}

/**
 * Clear a `(channel, model)` breaker back to closed by DELETING its row (the
 * absence of a row is the closed state). Ops un-stick. Idempotent: deleting an
 * absent row is a safe no-op.
 */
export async function resetBreaker(db: DbOrTx, channelId: string, model: string): Promise<void> {
  await db
    .delete(channelBreaker)
    .where(and(eq(channelBreaker.channelId, channelId), eq(channelBreaker.model, model)));
}

/** Every breaker row across all channels+models — backs the admin status surface. */
export async function listBreakers(db: DbOrTx): Promise<BreakerRow[]> {
  return db.select(COLS).from(channelBreaker) as Promise<BreakerRow[]>;
}

/**
 * A breaker row projected for the admin status view. 批次6 D3: the
 * `upstream_channel` table (the old join target for `channelName`/`resourceId`)
 * is deleted — these historical FSM rows keep their raw `channelId` and the
 * label fields degrade to `null` (the same shape a hard-deleted channel already
 * produced), so the ops surface + contract stay unchanged.
 */
export interface BreakerStatusRow {
  readonly channelId: string;
  readonly channelName: string | null;
  readonly resourceId: string | null;
  readonly model: string;
  readonly state: 'closed' | 'open' | 'half_open';
  readonly openedAt: Date | null;
  readonly cooldownUntil: Date | null;
  readonly tripCount: number;
  readonly halfOpenSuccesses: number;
  readonly lastTransitionAt: Date | null;
}

/**
 * Every `(channel, model)` breaker row, ordered newest-transition-first. Backs
 * `GET /admin/breakers` — the ops status surface. A `(channel, model)` with no
 * row is implicitly closed and simply absent from this list (only
 * tripped/probing breakers persist a row). `channelName`/`resourceId` are
 * `null` since the old `upstream_channel` join target is deleted (D3).
 */
export async function listBreakersWithChannel(db: DbOrTx): Promise<BreakerStatusRow[]> {
  return db
    .select({
      channelId: channelBreaker.channelId,
      channelName: sql<string | null>`NULL`,
      resourceId: sql<string | null>`NULL`,
      model: channelBreaker.model,
      state: channelBreaker.state,
      openedAt: channelBreaker.openedAt,
      cooldownUntil: channelBreaker.cooldownUntil,
      tripCount: channelBreaker.tripCount,
      halfOpenSuccesses: channelBreaker.halfOpenSuccesses,
      lastTransitionAt: channelBreaker.lastTransitionAt,
    })
    .from(channelBreaker)
    .orderBy(channelBreaker.lastTransitionAt) as Promise<BreakerStatusRow[]>;
}
