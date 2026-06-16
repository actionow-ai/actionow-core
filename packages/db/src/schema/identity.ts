import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
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

/**
 * A unified principal: admin + regular users share one auth model (Phase 9).
 * `email` is stored lowercase-normalized by the repos and is globally unique.
 * `password_hash` is NULLABLE — an OAuth-only account (no local password) has
 * `null` here. `role` (`user` | `admin`) drives the admin RBAC guard; an
 * existing `admin_user` row migrates in with `role='admin'`. `tenant_id` is the
 * tenant a self-registered user provisioned (null for the seeded admin).
 */
export const user = pgTable(
  'user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    emailVerified: boolean('email_verified').notNull().default(false),
    passwordHash: text('password_hash'),
    role: text('role').notNull().default('user'),
    status: text('status').notNull().default('active'),
    tenantId: uuid('tenant_id').references(() => tenant.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('user_role_allowed', sql`${t.role} IN ('user', 'admin')`)],
);

/**
 * A federated identity linking a {@link user} to an external OAuth provider
 * (Phase 9). Keyed on `(provider, provider_user_id)` — the provider's stable
 * subject id, NEVER the email — so a provider account links to exactly one
 * user. Cascades on user deletion; indexed by `user_id` for "my identities".
 */
export const userIdentity = pgTable(
  'user_identity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerUserId: text('provider_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('user_identity_provider_sub_idx').on(t.provider, t.providerUserId),
    index('user_identity_user_idx').on(t.userId),
  ],
);
