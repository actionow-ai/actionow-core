import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const tenant = pgTable('tenant', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  isolationMode: text('isolation_mode').notNull().default('field'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiKey = pgTable(
  'api_key',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    hash: text('hash').notNull(),
    resourceAllowlist: jsonb('resource_allowlist')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    rateLimit: bigint('rate_limit', { mode: 'number' }),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('api_key_hash_idx').on(t.hash), index('api_key_tenant_idx').on(t.tenantId)],
);

export const adminUser = pgTable('admin_user', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('admin'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
