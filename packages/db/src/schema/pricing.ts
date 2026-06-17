import type { Markup, PriceSpec } from '@actionow/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { resource } from './catalog.js';

export const pricebookEntry = pgTable(
  'pricebook_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    resourceId: text('resource_id')
      .notNull()
      .references(() => resource.id),
    resourceVersion: integer('resource_version').notNull(),
    version: integer('version').notNull(),
    method: text('method').notNull(), // unit|matrix|fixed|formula|passthrough
    timing: text('timing').notNull(), // pre|post
    spec: jsonb('spec').$type<PriceSpec>().notNull(), // dimensions|table|amount|formula
    markup: jsonb('markup').$type<Markup>(),
    active: boolean('active').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  // `pricebook_resource_idx` on (resource_id, version) also serves as the FK index on resource_id.
  (t) => [index('pricebook_resource_idx').on(t.resourceId, t.version)],
);

export const modifier = pgTable('modifier', {
  id: uuid('id').primaryKey().defaultRandom(),
  scope: text('scope').notNull(),
  whenExpr: text('when_expr'),
  op: text('op').notNull(),
  value: bigint('value', { mode: 'bigint' }),
  stackable: boolean('stackable').notNull().default(true),
  priority: integer('priority').notNull().default(0),
  version: integer('version').notNull().default(1),
  active: boolean('active').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const giftCode = pgTable(
  'gift_code',
  {
    // NOTE: gift_code.code stays `text` (immutable human-readable token) — intentional.
    code: text('code').primaryKey(),
    tenantScope: uuid('tenant_scope'),
    credits: bigint('credits', { mode: 'bigint' }).notNull(),
    kind: text('kind').notNull(), // grant | discount
    // status allowed values: active (the only value any code writes; default) plus the
    // documented lifecycle states (redeemed | expired | disabled) a future code path may set.
    status: text('status').notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    // defaultNow backfills existing rows to "now" (acceptable).
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'gift_code_status_allowed',
      sql`${t.status} IN ('active', 'redeemed', 'expired', 'disabled')`,
    ),
  ],
);
