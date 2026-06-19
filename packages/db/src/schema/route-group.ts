import { sql } from 'drizzle-orm';
import {
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

import { upstreamChannel } from './catalog.js';

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
    channelId: uuid('channel_id')
      .notNull()
      .references(() => upstreamChannel.id),
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
