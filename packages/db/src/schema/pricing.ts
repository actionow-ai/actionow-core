import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// 批次6 D3 (旧世界删除): the `pricebook_entry` table DEFINITION is deleted —
// D4 ships the DROP migration. `modifier` + `gift_code` are KEPT assets.

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
  // created_at backfills existing rows to "now" (additive); Track B keysets list
  // endpoints on (created_at, id).
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
