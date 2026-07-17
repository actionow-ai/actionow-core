import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { and, eq, isNull } from 'drizzle-orm';

import { apiKey, routeGroup, routeGroupChannel } from '../schema/index.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
import type { DbOrTx } from './types.js';

// 批次6 D3 (旧世界删除): the Track-4 router consumers over the deleted
// `upstream_channel` table (`listGroupChannelsForResource` /
// `listCandidateChannelsWithFallback` / `GroupChannelForResource`) are gone —
// route groups survive as the pricing/access tier entity (供给渠道 binds
// `route_group_id`); the old channel-membership rows are inert history.

export type RouteGroupRow = InferSelectModel<typeof routeGroup>;
export type RouteGroupChannelRow = InferSelectModel<typeof routeGroupChannel>;

// ----- route_group CRUD -----

/** Fields a caller supplies to {@link createRouteGroup}. */
export interface CreateRouteGroupInput {
  readonly name: string;
  /** Customer-price ratio in basis points (`10000 = 1.0×`); defaults to 10000. */
  readonly groupRatioBps?: number | undefined;
  /** Cross-group failover target (弹性2.0); another group's id, or null for none. */
  readonly fallbackGroupId?: string | null | undefined;
  /** `require_params` routing (模型参数绑定 Phase 2, D3); defaults FALSE (drop-and-forward). */
  readonly requireParams?: boolean | undefined;
  /** `active` (default) | `disabled`. */
  readonly status?: string | undefined;
  readonly description?: string | null | undefined;
}

/** Insert a `route_group` row and return it. */
export async function createRouteGroup(
  db: DbOrTx,
  input: CreateRouteGroupInput,
): Promise<RouteGroupRow> {
  const rows = await db
    .insert(routeGroup)
    .values({
      name: input.name,
      ...(input.groupRatioBps !== undefined ? { groupRatioBps: input.groupRatioBps } : {}),
      ...(input.fallbackGroupId !== undefined ? { fallbackGroupId: input.fallbackGroupId } : {}),
      ...(input.requireParams !== undefined ? { requireParams: input.requireParams } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createRouteGroup: insert returned no row');
  return row;
}

/** List live route groups (excludes soft-deleted), newest-first, keyset-paginated. */
export function listRouteGroups(
  db: DbOrTx,
  page: PageParams,
): Promise<KeysetResult<RouteGroupRow>> {
  return keysetPage<RouteGroupRow>(db, {
    table: routeGroup,
    createdAtCol: routeGroup.createdAt,
    idCol: routeGroup.id,
    where: isNull(routeGroup.deletedAt),
    page,
  });
}

/** Fetch a live route group by id (soft-deleted → `undefined`). */
export async function getRouteGroupById(
  db: DbOrTx,
  id: string,
): Promise<RouteGroupRow | undefined> {
  const rows = await db
    .select()
    .from(routeGroup)
    .where(and(eq(routeGroup.id, id), isNull(routeGroup.deletedAt)))
    .limit(1);
  return rows[0];
}

/** Fetch a live route group by its unique `name` (soft-deleted → `undefined`). */
export async function getRouteGroupByName(
  db: DbOrTx,
  name: string,
): Promise<RouteGroupRow | undefined> {
  const rows = await db
    .select()
    .from(routeGroup)
    .where(and(eq(routeGroup.name, name), isNull(routeGroup.deletedAt)))
    .limit(1);
  return rows[0];
}

/** Mutable fields of a {@link routeGroup} (admin PATCH); omitted keys are unchanged. */
export interface UpdateRouteGroupInput {
  readonly name?: string | undefined;
  readonly groupRatioBps?: number | undefined;
  /** Set / clear (null) the cross-group failover target (弹性2.0). */
  readonly fallbackGroupId?: string | null | undefined;
  /** Toggle `require_params` routing (模型参数绑定 Phase 2, D3). */
  readonly requireParams?: boolean | undefined;
  readonly status?: string | undefined;
  readonly description?: string | null | undefined;
}

/**
 * Patch a live route group (by id), returning the new row. Only the supplied
 * fields change; `updated_at` is bumped on any real write. An empty patch reads
 * back the current live row. Soft-deleted / unknown → `undefined`.
 */
export async function updateRouteGroup(
  db: DbOrTx,
  id: string,
  patch: UpdateRouteGroupInput,
): Promise<RouteGroupRow | undefined> {
  const set: Partial<InferInsertModel<typeof routeGroup>> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.groupRatioBps !== undefined) set.groupRatioBps = patch.groupRatioBps;
  if (patch.fallbackGroupId !== undefined) set.fallbackGroupId = patch.fallbackGroupId;
  if (patch.requireParams !== undefined) set.requireParams = patch.requireParams;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.description !== undefined) set.description = patch.description;
  if (Object.keys(set).length === 0) {
    return getRouteGroupById(db, id);
  }
  set.updatedAt = new Date();
  const rows = await db
    .update(routeGroup)
    .set(set)
    .where(and(eq(routeGroup.id, id), isNull(routeGroup.deletedAt)))
    .returning();
  return rows[0];
}

/**
 * Revoke a route group by SOFT-DELETING it (by id): stamps `deleted_at` (`now()`)
 * + bumps `updated_at`, only when the row is still live. `getRouteGroup*` /
 * `listRouteGroups` / `listGroupChannelsForResource` all filter `deleted_at IS
 * NULL`, so the group drops out, and the PARTIAL unique frees its `name` for a
 * fresh re-create. Returns the deleted id, or `undefined` when nothing matched
 * (already deleted / unknown) — idempotent.
 */
export async function softDeleteRouteGroup(db: DbOrTx, id: string): Promise<string | undefined> {
  const now = new Date();
  const rows = await db
    .update(routeGroup)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(routeGroup.id, id), isNull(routeGroup.deletedAt)))
    .returning({ id: routeGroup.id });
  return rows[0]?.id;
}

// ----- route_group_channel membership -----

/** Fields a caller supplies to {@link addChannelToGroup}. */
export interface AddChannelToGroupInput {
  readonly groupId: string;
  readonly channelId: string;
  /** HIGHER = tried first (fallback tier); defaults to 0. */
  readonly priority?: number | undefined;
  /** Weighted-random weight within a tier; defaults to 1. */
  readonly weight?: number | undefined;
}

/**
 * Add a channel to a route group (UPSERT on the `(group_id, channel_id)` PK): a
 * re-add of the same pair UPDATES its `priority`/`weight` instead of erroring.
 * The membership row carries no soft-delete — removal is a hard delete
 * ({@link removeChannelFromGroup}). Returns the resulting membership row.
 */
export async function addChannelToGroup(
  db: DbOrTx,
  input: AddChannelToGroupInput,
): Promise<RouteGroupChannelRow> {
  const priority = input.priority ?? 0;
  const weight = input.weight ?? 1;
  const rows = await db
    .insert(routeGroupChannel)
    .values({ groupId: input.groupId, channelId: input.channelId, priority, weight })
    .onConflictDoUpdate({
      target: [routeGroupChannel.groupId, routeGroupChannel.channelId],
      set: { priority, weight },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('addChannelToGroup: upsert returned no row');
  return row;
}

/**
 * Remove a channel from a route group: HARD-deletes the membership row (no
 * soft-delete on `route_group_channel`). Returns `true` when a row was removed,
 * `false` when the pair was not a member — a second remove is an idempotent no-op.
 */
export async function removeChannelFromGroup(
  db: DbOrTx,
  groupId: string,
  channelId: string,
): Promise<boolean> {
  const rows = await db
    .delete(routeGroupChannel)
    .where(and(eq(routeGroupChannel.groupId, groupId), eq(routeGroupChannel.channelId, channelId)))
    .returning({ channelId: routeGroupChannel.channelId });
  return rows.length === 1;
}

/**
 * List a group's channel MEMBERSHIPS (the `route_group_channel` rows with their
 * `priority`/`weight`), keyset-paginated newest-first on `(created_at,
 * channel_id)`. This is the membership listing — NOT joined to the channel —
 * used by the admin "channels in this group" view.
 */
export function listGroupChannels(
  db: DbOrTx,
  groupId: string,
  page: PageParams,
): Promise<KeysetResult<RouteGroupChannelRow>> {
  return keysetPage<RouteGroupChannelRow>(db, {
    table: routeGroupChannel,
    createdAtCol: routeGroupChannel.createdAt,
    idCol: routeGroupChannel.channelId,
    where: eq(routeGroupChannel.groupId, groupId),
    page,
  });
}

/** Max number of groups walked in a `fallback_group_id` chain (incl. the start). */
export const FALLBACK_MAX_DEPTH = 5;

/**
 * The reason a proposed `fallback_group_id` is rejected, returned by
 * {@link checkFallbackChain} (弹性2.0):
 * - `'cycle'` — following the proposed chain would revisit `sourceId` (a loop,
 *   incl. a direct self-reference A→A).
 * - `'too-deep'` — the resulting chain would exceed {@link FALLBACK_MAX_DEPTH}
 *   groups (incl. the source), i.e. failover would cascade too far.
 *
 * Pure, DB-agnostic walk: the caller supplies a `resolveFallback(id)` that yields
 * a group's current `fallback_group_id` (or `null`/`undefined` when the group has
 * none / no longer exists). Returns `null` when the proposed target is safe.
 *
 * The walk treats `sourceId → proposedTarget` as hop 1 and then follows each
 * group's EXISTING fallback. `seen` starts with `sourceId` so any path back to it
 * is a cycle. Depth counts groups in the chain starting at the source: the source
 * itself is depth 1, the proposed target depth 2, etc.; > {@link FALLBACK_MAX_DEPTH}
 * is `'too-deep'`.
 */
export async function checkFallbackChain(
  sourceId: string,
  proposedTarget: string,
  resolveFallback: (id: string) => Promise<string | null | undefined>,
): Promise<'cycle' | 'too-deep' | null> {
  const seen = new Set<string>([sourceId]);
  let current: string | null = proposedTarget;
  // `sourceId` is depth 1; the proposed target is the second group in the chain.
  let depth = 1;
  while (current !== null) {
    depth += 1;
    if (seen.has(current)) return 'cycle';
    if (depth > FALLBACK_MAX_DEPTH) return 'too-deep';
    seen.add(current);
    current = (await resolveFallback(current)) ?? null;
  }
  return null;
}

// ----- api_key ↔ route_group binding -----

/**
 * (Re)bind an API key to a route group, or unbind it. Passing a `routeGroupId`
 * sets `api_key.route_group_id`; passing `null` clears it (the key then falls
 * back to the well-known `default` group at routing time). Bumps `updated_at`.
 * Operates on LIVE keys only (`deleted_at IS NULL`). Returns `true` when a row
 * was updated, `false` when the id matched no live key (the caller maps that to
 * a 404). NOTE: the caller is responsible for validating that `routeGroupId`
 * refers to an existing group.
 */
export async function setApiKeyGroup(
  db: DbOrTx,
  apiKeyId: string,
  routeGroupId: string | null,
): Promise<boolean> {
  const rows = await db
    .update(apiKey)
    .set({ routeGroupId, updatedAt: new Date() })
    .where(and(eq(apiKey.id, apiKeyId), isNull(apiKey.deletedAt)))
    .returning({ id: apiKey.id });
  return rows.length === 1;
}
