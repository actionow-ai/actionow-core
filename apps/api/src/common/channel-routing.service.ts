import {
  type Database,
  getRouteGroupByName,
  type GroupChannelForResource,
  listChannels,
  listGroupChannelsForResource,
  type UpstreamChannelRow,
} from '@actionow/db';
import type { RunChannel } from '@actionow/engine';
import { Inject, Injectable } from '@nestjs/common';

import { DB } from './tokens.js';

/** The well-known fallback group an unbound key resolves to (Track 3/4 seed). */
export const DEFAULT_ROUTE_GROUP_NAME = 'default';

/**
 * Resolves the GROUP-SCOPED channel candidate set for a relay/run request
 * (Track 4). Given the resource and the authenticating key's bound
 * `routeGroupId` (nullable), it produces the ordered {@link RunChannel}s the
 * engine routes over, each carrying its per-`(group, channel)` `priority` +
 * `weight` so the engine's priority-tiered fallback chain (兜底链) can cascade
 * across tiers.
 *
 * ## v1 routing rule (BACKWARD-COMPATIBLE)
 *
 * 1. `groupId = routeGroupId ?? <the 'default' group id>`. The default group id
 *    is resolved once via `getRouteGroupByName(db, 'default')` and cached (it is
 *    stable). A bare test db with no `default` group tolerates this by falling
 *    through to step 3.
 * 2. `candidates = listGroupChannelsForResource(db, resourceId, groupId)` — the
 *    active, non-soft-deleted channels of the resource that are MEMBERS of the
 *    group, annotated with the membership `priority`/`weight`.
 * 3. **Ungrouped fallback (compat):** when the group has NO members for this
 *    resource (`candidates` is empty), fall back to `listChannels(db,
 *    resourceId)` — ALL active channels at priority 0 / `channel.weight`. This
 *    keeps every pre-group setup working; a group only becomes RESTRICTIVE once
 *    it has members for the resource. (Strict gating — empty group ⇒ forbidden —
 *    can be a future flag.)
 *
 * Returns an EMPTY array only when the resource has no active channels at all;
 * the caller maps that to `engineNotFound('no active upstream channel …')`.
 */
@Injectable()
export class ChannelRoutingService {
  /**
   * The cached `default` group id (`undefined` = not yet resolved; `null` = a
   * bare db with no default group). Resolved lazily once and reused — the
   * default group's id is stable for the process lifetime.
   */
  private defaultGroupId: string | null | undefined;

  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Build the engine candidate channel set for `(resourceId, routeGroupId)` per
   * the v1 rule above. `routeGroupId` is the authenticating key's bound group
   * (`null`/`undefined` → the cached `default` group).
   */
  async candidatesFor(
    resourceId: string,
    routeGroupId: string | null | undefined,
  ): Promise<RunChannel[]> {
    // `routeGroupId` (string|null|undefined) ?? default (string|null) → string|null.
    const groupId = routeGroupId ?? (await this.resolveDefaultGroupId());

    if (groupId !== null) {
      const grouped = await listGroupChannelsForResource(this.db, resourceId, groupId);
      if (grouped.length > 0) return grouped.map(toRunChannelFromGroup);
    }

    // Ungrouped fallback (compat): the group has no members for this resource
    // (or no group resolved at all) → route over ALL active channels at the
    // degenerate single tier (priority 0, channel.weight).
    const all = await listChannels(this.db, resourceId);
    return all.map(toRunChannelFromChannel);
  }

  /** Resolve + cache the well-known `default` group id (`null` when absent). */
  private async resolveDefaultGroupId(): Promise<string | null> {
    if (this.defaultGroupId !== undefined) return this.defaultGroupId;
    const group = await getRouteGroupByName(this.db, DEFAULT_ROUTE_GROUP_NAME);
    this.defaultGroupId = group?.id ?? null;
    return this.defaultGroupId;
  }
}

/**
 * Map a group-membership channel row to a {@link RunChannel}, carrying the
 * per-`(group, channel)` `priority`/`weight` from the join (drives the engine's
 * priority-tiered failover).
 */
function toRunChannelFromGroup(row: GroupChannelForResource): RunChannel {
  return {
    id: row.id,
    weight: row.weight,
    priority: row.priority,
    providerType: row.providerType,
    credentialRef: row.credentialRef ?? undefined,
    endpoint: row.endpoint ?? undefined,
    model: row.model ?? undefined,
    proxyRef: row.proxyRef ?? undefined,
    config: row.config ?? undefined,
  };
}

/**
 * Map a plain resource-level channel row to a {@link RunChannel} for the
 * ungrouped fallback: a single tier (priority 0, `channel.weight`).
 */
function toRunChannelFromChannel(row: UpstreamChannelRow): RunChannel {
  return {
    id: row.id,
    weight: row.weight,
    priority: 0,
    providerType: row.providerType,
    credentialRef: row.credentialRef ?? undefined,
    endpoint: row.endpoint ?? undefined,
    model: row.model ?? undefined,
    proxyRef: row.proxyRef ?? undefined,
    config: row.config ?? undefined,
  };
}
