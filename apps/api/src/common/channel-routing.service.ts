import {
  type Database,
  type FaultPolicyRow,
  getChannelModelOverrides,
  getFaultPoliciesByIds,
  getRouteGroupById,
  getRouteGroupByName,
  type GroupChannelForResource,
  listCandidateChannelsWithFallback,
  listChannels,
  listModelChannels,
  type UpstreamChannelRow,
} from '@actionow/db';
import type { FaultPolicy, RunChannel } from '@actionow/engine';
import { Inject, Injectable } from '@nestjs/common';

import { engineInvalidInput } from './errors.js';
import { DB } from './tokens.js';

/** The well-known fallback group an unbound key resolves to (Track 3/4 seed). */
export const DEFAULT_ROUTE_GROUP_NAME = 'default';

/**
 * The neutral customer-price ratio in basis points (`10000 = 1.0×`; Track 5,
 * spec D3/D4). Used when neither the key's group NOR a `default` group resolves
 * a ratio — so an un-grouped, pre-Track-5 setup prices at exactly the base
 * (×1.0), preserving every existing cost assertion (the regression invariant).
 */
export const NEUTRAL_GROUP_RATIO_BPS = 10000;

/**
 * Catalog supply-hierarchy: channels NOT linked to the requested model are pushed
 * to this far-lower priority tier, so the engine's priority-tiered failover tries
 * a model's LINKED channels first and only falls back to the platform's other
 * channels when the linked ones are exhausted/cooling. A no-op when the model has
 * no links (or none of the candidates is linked) → full platform fallback.
 */
export const UNLINKED_PRIORITY_OFFSET = 1_000_000;

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
 * 2. `candidates = listCandidateChannelsWithFallback(db, resourceId, groupId)` —
 *    the active, non-soft-deleted channels of the resource that are MEMBERS of
 *    the group, annotated with the membership `priority`/`weight`; PLUS, per
 *    弹性2.0, the channels of the group's `fallback_group_id` chain demoted to
 *    strictly lower tiers (cycle + depth guarded), so an exhausted group cascades
 *    to its fallback group.
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

  /**
   * The cached `default` group's `group_ratio_bps` (Track 5), resolved alongside
   * {@link defaultGroupId} (`undefined` = unresolved; `null` = no default group →
   * the neutral ×1.0 ratio). The default group's ratio is stable for the process.
   */
  private defaultGroupRatioBps: number | null | undefined;

  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Build the engine candidate channel set for `(resourceId, routeGroupId)` per
   * the v1 rule above. `routeGroupId` is the authenticating key's bound group
   * (`null`/`undefined` → the cached `default` group).
   *
   * ## 染色/标签路由 (route tagging)
   *
   * `routeTag` (the per-request `X-Actionow-Route-Tag` canary header) is applied
   * to the ALREADY-resolved candidate ROWS via {@link filterByRouteTag} — BEFORE
   * mapping to {@link RunChannel} — so it can only NARROW the set, never widen or
   * escalate beyond the key's resolved candidates. A blank/absent tag is a no-op
   * (header-less requests are byte-for-byte unchanged); a tag matching none of the
   * resolved candidates throws a hard 400 (`invalid_input`) rather than leaking to
   * non-tagged channels. Crucially the grouped branch's tag-miss throws inside the
   * `grouped.length > 0` arm, so it never falls through to the (widening) ungrouped
   * fallback.
   */
  async candidatesFor(
    resourceId: string,
    routeGroupId: string | null | undefined,
    modelId?: string,
    routeTag?: string,
  ): Promise<RunChannel[]> {
    // `routeGroupId` (string|null|undefined) ?? default (string|null) → string|null.
    const groupId = routeGroupId ?? (await this.resolveDefaultGroupId());

    let base: RunChannel[];
    // 弹性2.0: walk the group's `fallback_group_id` chain so an exhausted group
    // cascades to lower-tier groups (cycle + depth guarded). With no fallback set
    // this is exactly `listGroupChannelsForResource`.
    const grouped =
      groupId !== null ? await listCandidateChannelsWithFallback(this.db, resourceId, groupId) : [];
    if (grouped.length > 0) {
      const rows = filterByRouteTag(grouped, routeTag);
      base = await this.attachFaultPolicies(rows.map(toRunChannelFromGroup), rows);
    } else {
      // Ungrouped fallback (compat): the group has no members for this resource
      // (or no group resolved at all) → route over ALL active channels at the
      // degenerate single tier (priority 0, channel.weight).
      const all = await listChannels(this.db, resourceId);
      const rows = filterByRouteTag(all, routeTag);
      base = await this.attachFaultPolicies(rows.map(toRunChannelFromChannel), rows);
    }

    // Stage ② data source: batch-load per-(model,channel) param overrides for the
    // resolved model across the candidate set and stamp them onto each RunChannel
    // (mig 0062). One query (same cost tier as listModelChannels), no N+1; an
    // empty result → no channel carries an override → byte-for-byte identical to
    // today. The engine applies them per-attempt in executeChat.
    if (modelId !== undefined && base.length > 0) {
      const overrides = await getChannelModelOverrides(
        this.db,
        modelId,
        base.map((c) => c.id),
      );
      if (overrides.size > 0) {
        for (const c of base) {
          const ov = overrides.get(c.id);
          if (ov !== undefined) c.paramOverride = ov;
        }
      }
    }

    return this.preferLinkedChannels(base, modelId);
  }

  /**
   * Catalog supply-hierarchy (模型服务): demote channels NOT linked to `modelId`
   * to a lower priority tier so the engine prefers a model's linked channels and
   * falls back to the platform's others only when the linked ones are exhausted.
   * No-op when `modelId` is absent, the model has no links, or NONE of the current
   * candidates is linked (then every candidate stays at its tier — full fallback,
   * preserving the pre-link behaviour for un-synced/un-curated platforms).
   */
  private async preferLinkedChannels(
    channels: RunChannel[],
    modelId?: string,
  ): Promise<RunChannel[]> {
    if (modelId === undefined || channels.length === 0) return channels;
    const linked = new Set(await listModelChannels(this.db, modelId));
    if (linked.size === 0 || !channels.some((c) => linked.has(c.id))) return channels;
    for (const c of channels) {
      if (!linked.has(c.id)) c.priority = (c.priority ?? 0) + UNLINKED_PRIORITY_OFFSET;
    }
    return channels;
  }

  /**
   * Resolve each channel's bound `fault_policy` (调用容错) and attach it to the
   * {@link RunChannel} the engine consumes. Batch-loaded by id (no N+1); a
   * soft-deleted OR disabled policy is treated as ABSENT → the engine applies its
   * defaults (single attempt + client-wide timeouts). `rows[i].id` aligns with
   * `channels[i].id` (same source rows), so the bind is by channel id.
   */
  private async attachFaultPolicies(
    channels: RunChannel[],
    rows: readonly { id: string; faultPolicyId: string | null }[],
  ): Promise<RunChannel[]> {
    const ids = rows.map((r) => r.faultPolicyId).filter((x): x is string => x !== null);
    if (ids.length === 0) return channels;
    const policies = await getFaultPoliciesByIds(this.db, ids);
    const byChannel = new Map(rows.map((r) => [r.id, r.faultPolicyId]));
    for (const ch of channels) {
      const pid = byChannel.get(ch.id);
      if (pid === undefined || pid === null) continue;
      const row = policies.get(pid);
      if (row?.status !== 'active') continue;
      ch.faultPolicy = toFaultPolicy(row);
    }
    return channels;
  }

  /**
   * Resolve the CUSTOMER-PRICE ratio (basis points, `10000 = 1.0×`; Track 5) for
   * the authenticating key's bound group. The price is fully determined
   * pre-routing (spec D6): it depends only on `(model, group)`, NOT the served
   * channel — so the hold is deterministic.
   *
   * 1. `routeGroupId` set → that group's `group_ratio_bps` (a soft-deleted /
   *    unknown group → fall through to the default, so a stale binding never
   *    throws).
   * 2. unbound (`null`/`undefined`) → the well-known `default` group's ratio
   *    (resolved + cached once; its id/ratio are stable for the process life).
   * 3. no `default` group → {@link NEUTRAL_GROUP_RATIO_BPS} (×1.0) — the
   *    regression invariant for pre-Track-5 / un-grouped setups.
   */
  async groupRatioBpsFor(routeGroupId: string | null | undefined): Promise<number> {
    if (routeGroupId !== null && routeGroupId !== undefined) {
      const group = await getRouteGroupById(this.db, routeGroupId);
      if (group !== undefined) return group.groupRatioBps;
      // A stale binding to a deleted/unknown group → fall back to the default.
    }
    return this.resolveDefaultGroupRatioBps();
  }

  /** Resolve + cache the well-known `default` group id (`null` when absent). */
  private async resolveDefaultGroupId(): Promise<string | null> {
    await this.ensureDefaultResolved();
    return this.defaultGroupId ?? null;
  }

  /** The cached `default` group's ratio, or {@link NEUTRAL_GROUP_RATIO_BPS} when absent. */
  private async resolveDefaultGroupRatioBps(): Promise<number> {
    await this.ensureDefaultResolved();
    return this.defaultGroupRatioBps ?? NEUTRAL_GROUP_RATIO_BPS;
  }

  /**
   * Resolve the `default` group ONCE (its id + ratio), caching both. A bare test
   * db with no `default` group leaves the id `null` + the ratio `null` (→ the
   * neutral ×1.0 ratio). The default group is stable for the process lifetime.
   */
  private async ensureDefaultResolved(): Promise<void> {
    if (this.defaultGroupId !== undefined) return;
    const group = await getRouteGroupByName(this.db, DEFAULT_ROUTE_GROUP_NAME);
    this.defaultGroupId = group?.id ?? null;
    this.defaultGroupRatioBps = group?.groupRatioBps ?? null;
  }
}

/**
 * 染色: when a per-request route tag is set, keep only the candidate channels
 * carrying it. Applied to the ALREADY-resolved candidate rows (before they are
 * mapped to {@link RunChannel}), so it can only NARROW the set — never escalate
 * beyond the key's resolved candidates. A blank/absent tag is a no-op (header-less
 * requests are unchanged). Empty after filtering → a hard 400 (`invalid_input`):
 * no silent leak to non-tagged channels, and (in the grouped branch) no fall-
 * through to the widening ungrouped fallback. `routeTag` never reaches a URL or
 * an auth decision — it is purely a candidate-set predicate here.
 */
function filterByRouteTag<T extends { tags: string[] }>(rows: T[], routeTag?: string): T[] {
  const tag = routeTag?.trim();
  if (tag === undefined || tag === '') return rows;
  const matched = rows.filter((r) => r.tags.includes(tag));
  if (matched.length === 0) {
    throw engineInvalidInput(`no channel matches route tag "${tag}"`);
  }
  return matched;
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
    // Track 5: the channel's operator-cost rates (µUSD/1M) → provider_cost/margin.
    inputCostPer1m: row.inputCostPer1m,
    outputCostPer1m: row.outputCostPer1m,
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
    // Track 5: the channel's operator-cost rates (µUSD/1M) → provider_cost/margin.
    inputCostPer1m: row.inputCostPer1m,
    outputCostPer1m: row.outputCostPer1m,
  };
}

/** Map a `fault_policy` row → the engine-facing {@link FaultPolicy} (nulls → omitted). */
function toFaultPolicy(row: FaultPolicyRow): FaultPolicy {
  const policy: FaultPolicy = {
    fastFail: row.fastFail,
    retryCount: row.retryCount,
    backoffType: row.backoffType === 'exponential' ? 'exponential' : 'fixed',
    backoffMs: row.backoffMs,
  };
  if (row.connectTimeoutMs !== null) policy.connectTimeoutMs = row.connectTimeoutMs;
  if (row.ttftTimeoutMs !== null) policy.ttftTimeoutMs = row.ttftTimeoutMs;
  if (row.totalTimeoutMs !== null) policy.totalTimeoutMs = row.totalTimeoutMs;
  if (row.idleTimeoutMs !== null) policy.idleTimeoutMs = row.idleTimeoutMs;
  if (row.retryCodes !== null) policy.retryCodes = row.retryCodes;
  if (row.retryMessages !== null) policy.retryMessages = row.retryMessages;
  return policy;
}
