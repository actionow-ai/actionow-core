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

import { routeGroup } from './route-group.js';

export const tenant = pgTable('tenant', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  isolationMode: text('isolation_mode').notNull().default('field'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
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
    // The route group (分组) this key is bound to (Track 3). NULLABLE → a null
    // means "use the well-known `default` group", resolved at routing time
    // (Track 4). The group scopes which channels the key may use + sets the
    // customer-price ratio. The `() =>` FK callback is lazy, so the cross-file
    // import does not run at module-init (no ESM cycle hazard).
    routeGroupId: uuid('route_group_id').references(() => routeGroup.id),
    rateLimit: bigint('rate_limit', { mode: 'number' }),
    // status allowed values: active | disabled (createApiKey default + disableApiKeyForTenant)
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('api_key_hash_idx').on(t.hash),
    index('api_key_tenant_idx').on(t.tenantId),
    check('api_key_status_allowed', sql`${t.status} IN ('active', 'disabled')`),
  ],
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
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('user_role_allowed', sql`${t.role} IN ('user', 'admin')`),
    index('user_tenant_idx').on(t.tenantId),
  ],
);

/**
 * A long-lived admin SERVICE TOKEN (M2M credential) — the machine equivalent of a
 * human admin's login JWT. An external developer's backend presents it as a Bearer
 * token to call the admin control plane (e.g. provision tenants/keys at customer
 * signup) without a human password or a short-lived JWT. Mirrors {@link apiKey}:
 * only the sha256 `hash` of the one-time plaintext (`at_<base64url>`) is stored,
 * and revocation is a soft-delete (`deleted_at`). Always full-admin — the guard
 * attaches `role='admin'` and the existing `@Roles` RBAC applies. `created_by`
 * attributes the token to the admin who minted it.
 */
export const adminToken = pgTable(
  'admin_token',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    hash: text('hash').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => user.id),
    // Optional expiry; NULL means the token never expires. Enforced by the guard.
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    // status allowed values: active | disabled
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('admin_token_hash_idx').on(t.hash),
    index('admin_token_created_by_idx').on(t.createdBy),
    check('admin_token_status_allowed', sql`${t.status} IN ('active', 'disabled')`),
  ],
);

/**
 * A federated identity linking a {@link user} to an external OAuth provider
 * (Phase 9). Keyed on `(provider, provider_user_id)` — the provider's stable
 * subject id, NEVER the email — so a provider account links to exactly one
 * user. Cascades on user deletion; indexed by `user_id` for "my identities".
 */
// immutable: no updated_at (a federated identity link is never mutated in place)
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
