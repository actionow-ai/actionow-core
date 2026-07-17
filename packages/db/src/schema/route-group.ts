import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * A **route group (分组)** — an operator-defined access + pricing + fallback tier
 * (Track 3; spec §"New: `route_group`"). An API key binds to ONE group
 * (`api_key.route_group_id`); the group scopes which channels the key may use and
 * sets the customer-price ratio. (Table named `route_group` to avoid the `GROUP`
 * reserved word; referred to as "group" in UI/prose.)
 *
 * `group_ratio_bps` is the per-group customer-price knob in integer BASIS POINTS
 * (`10000 = 1.0×`; spec D3) — no floats for money, ever. The well-known seed
 * group `default` (ratio 10000) always exists; a key with no group falls back to
 * it at routing time (Track 4).
 *
 * NOTE: this track is SCHEMA + CRUD + seed ONLY — the engine does NOT yet consume
 * groups for routing (Track 4) or pricing (Track 5). The table is purely additive.
 */
export const routeGroup = pgTable(
  'route_group',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** The per-group customer-price ratio in basis points (`10000 = 1.0×`; spec D3). */
    groupRatioBps: integer('group_ratio_bps').notNull().default(10000),
    /** Cross-group failover (弹性2.0): when this group's channels are exhausted, cascade to this group. Self-ref; resolver walks the chain with cycle+depth guards. */
    fallbackGroupId: uuid('fallback_group_id').references((): AnyPgColumn => routeGroup.id),
    /**
     * `require_params` routing (模型参数绑定 Phase 2, D3). When TRUE, the router
     * SKIPS a candidate channel whose effective (model,channel) profile/override
     * would drop a param the request carries (falling to a supporting channel or
     * 404), instead of the default drop-and-forward. Default FALSE == today's
     * behavior byte-for-byte (candidates unchanged, OpenRouter-default drop).
     */
    requireParams: boolean('require_params').notNull().default(false),
    // status allowed values: active | disabled (create default + admin DTO)
    status: text('status').notNull().default('active'),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // PARTIAL unique index (mirrors `model_name_idx`, migration 0018): only LIVE
    // rows reserve their `name`. A soft-deleted group frees its name so a fresh
    // `createRouteGroup` inserts a NEW live row, leaving the old one for audit.
    uniqueIndex('route_group_name_idx')
      .on(t.name)
      .where(sql`deleted_at IS NULL`),
    check('route_group_status_allowed', sql`${t.status} IN ('active', 'disabled')`),
  ],
);

/**
 * Channel MEMBERSHIP in a {@link routeGroup} plus the per-`(group, channel)`
 * routing knobs (Track 3; spec §"New: `route_group_channel`"). A channel can be
 * primary in group A and a fallback in group B because `priority`/`weight` live
 * on the membership row, not the channel.
 *
 * - `priority` — HIGHER is tried FIRST (the fallback tier; Track 4 cascades to
 *   the next-lower tier on a retryable error).
 * - `weight` — weighted-random within a single priority tier.
 *
 * No soft-delete: removing a channel from a group is simply DELETING this row.
 * The composite PK `(group_id, channel_id)` makes an add idempotent (upsert).
 */
export const routeGroupChannel = pgTable(
  'route_group_channel',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => routeGroup.id),
    // 批次6 D3: plain uuid — the FK to the deleted `upstream_channel` table is
    // dropped (D4: DROP CONSTRAINT route_group_channel_channel_id_upstream_channel_id_fk).
    channelId: uuid('channel_id').notNull(),
    /** HIGHER = tried first (fallback tier). */
    priority: integer('priority').notNull().default(0),
    /** Weighted-random pick within a priority tier. */
    weight: integer('weight').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.channelId] }),
    index('route_group_channel_group_idx').on(t.groupId),
    index('route_group_channel_channel_idx').on(t.channelId),
  ],
);
