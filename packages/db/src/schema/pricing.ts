import {
  bigint,
  boolean,
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
    spec: jsonb('spec').notNull(), // dimensions|table|amount|formula
    markup: jsonb('markup'),
    active: boolean('active').notNull().default(true),
  },
  (t) => ({ resIdx: index('pricebook_resource_idx').on(t.resourceId, t.version) }),
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
});

export const giftCode = pgTable('gift_code', {
  code: text('code').primaryKey(),
  tenantScope: uuid('tenant_scope'),
  credits: bigint('credits', { mode: 'bigint' }).notNull(),
  kind: text('kind').notNull(), // grant | discount
  status: text('status').notNull().default('active'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
});
