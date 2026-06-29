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

import { limitPlan } from './limit.js';
import { routeGroup } from './route-group.js';

export const tenant = pgTable('tenant', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  isolationMode: text('isolation_mode').notNull().default('field'),
  // Per-tenant config bag (unified tenancy M-X). Holds e.g.
  // `jit_provisioning_enabled` (decision #1: Model-B auto-create a subject for an
  // unknown external_id). Additive; `{}` default = today's behavior (JIT off).
  config: jsonb('config')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
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
    // The limit plan (额度套餐) bound to this key (governance-limits). NULLABLE →
    // null means no per-key limits; the tenant's plan (if any) still applies.
    limitPlanId: uuid('limit_plan_id').references(() => limitPlan.id),
    // The subject (end-user) this key is scoped to (unified tenancy G-B). NULL →
    // a tenant-level key (today's behavior). Lazy `() =>` FK avoids any ESM cycle.
    subjectId: uuid('subject_id').references(() => subject.id, { onDelete: 'set null' }),
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
    index('api_key_subject_idx').on(t.subjectId),
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
    // Tenant-org seat level (RBAC v1). NULL for a system admin (`role='admin'`);
    // an operator inside a tenant (`role='user'`) is `'admin'` (full control of
    // their tenant) or `'member'` (read-mostly seat). DB-resolved in ConsoleGuard,
    // never signed into the JWT. The paired CHECK ties it to `role`.
    tenantRole: text('tenant_role'),
    status: text('status').notNull().default('active'),
    tenantId: uuid('tenant_id').references(() => tenant.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('user_role_allowed', sql`${t.role} IN ('user', 'admin')`),
    // NULL-safe: the `tenant_role IS NOT NULL AND ...` guard keeps the predicate
    // strictly TRUE/FALSE. Without it, a `role='user'` row with NULL tenant_role
    // makes the expression evaluate to NULL (unknown), which Postgres treats as a
    // PASS — so the bad combo would slip through. See migration 0046 + the
    // schema-constraints test that pins this.
    check(
      'user_tenant_role_allowed',
      sql`(${t.role} = 'admin' AND ${t.tenantRole} IS NULL) OR (${t.role} = 'user' AND ${t.tenantRole} IS NOT NULL AND ${t.tenantRole} IN ('admin','member'))`,
    ),
    index('user_tenant_idx').on(t.tenantId),
    index('user_tenant_role_idx').on(t.tenantId, t.tenantRole),
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
 * A **subject** — the END-USER of a third-party app (tenant), the single new
 * principal of the unified A+B tenancy. Distinct from {@link user} (operators):
 * subjects are tenant-scoped, soft-deletable, and their auth fields are all
 * nullable. Model A populates `email`/`password_hash` (a member login); Model B
 * populates `external_id` (the app-owned handle). `limit_plan_id` binds a
 * per-subject governance plan (lives HERE, not on the sub-wallet, so a SHARED
 * subject without a wallet can still have caps). Email is unique PER TENANT (not
 * global like {@link user}) so the same human is a separate subject per product.
 */
export const subject = pgTable(
  'subject',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    // Model-B handle (app-owned identity); NULL for a pure Model-A subject.
    externalId: text('external_id'),
    // Model-A login; NULL for a pure Model-B subject. Per-tenant unique (live).
    email: text('email'),
    passwordHash: text('password_hash'),
    displayName: text('display_name'),
    // Per-subject governance plan (额度套餐). NULL → inherit tenant/key caps only.
    limitPlanId: uuid('limit_plan_id').references(() => limitPlan.id),
    // status allowed values: active | disabled
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('subject_tenant_idx').on(t.tenantId),
    uniqueIndex('subject_tenant_external_id_idx')
      .on(t.tenantId, t.externalId)
      .where(sql`external_id IS NOT NULL AND deleted_at IS NULL`),
    uniqueIndex('subject_tenant_email_idx')
      .on(t.tenantId, t.email)
      .where(sql`email IS NOT NULL AND deleted_at IS NULL`),
    check('subject_status_allowed', sql`${t.status} IN ('active', 'disabled')`),
    // A subject must be addressable by ≥1 identity (Model-A email or Model-B
    // external_id); neither-set is an unreachable orphan.
    check('subject_addressable', sql`${t.externalId} IS NOT NULL OR ${t.email} IS NOT NULL`),
  ],
);

/**
 * A platform LOGIN SESSION — the persistence behind refresh-token rotation
 * (auth-sessions slice). One row is minted per successful login (operator, admin,
 * OR member/subject), and it owns the LIVE refresh token: only the sha256 hex
 * `refresh_hash` of the one-time `rt_<base64url>` plaintext is stored, mirroring
 * {@link adminToken}. On refresh the row is ROTATED in place — the old row is
 * stamped `revoked_at` + `replaced_by`, and a fresh row is inserted in the SAME
 * `family_id`. A refresh whose hash matches an already-revoked row is reuse/theft:
 * the whole family is revoked. Unlike {@link adminToken} this table is NOT
 * append-only — `revoked_at`/`last_used_at`/`replaced_by` are mutated operationally;
 * the correctness boundary is `findLiveSessionByHash` filtering revoked/expired.
 *
 * `principal_kind` (`user`|`subject`|`admin`) records which token kind to re-mint;
 * exactly one of `user_id`/`subject_id` is set for `user`/`subject`, and `admin`
 * carries neither (the admin login is a `user` row with `role='admin'`, attributed
 * via the claims re-minted from the session, not a FK here).
 */
export const session = pgTable(
  'session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Which token kind this session re-mints on refresh.
    principalKind: text('principal_kind').notNull(),
    // The operator/admin user this session belongs to (NULL for a subject session).
    userId: uuid('user_id').references(() => user.id, { onDelete: 'cascade' }),
    // The end-user (subject) this session belongs to (NULL for a user/admin session).
    subjectId: uuid('subject_id').references(() => subject.id, { onDelete: 'cascade' }),
    // The tenant scope re-minted into a subject token; informational for a user.
    tenantId: uuid('tenant_id').references(() => tenant.id),
    // sha256 hex of the one-time `rt_<base64url>` refresh plaintext (UNIQUE). The
    // plaintext is never stored — a session is found ONLY by hashing a presented token.
    refreshHash: text('refresh_hash').notNull().unique(),
    // Stable across a rotation chain — all rotations of one login share this id, so
    // reuse-detection revokes the entire lineage in one shot.
    familyId: uuid('family_id').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    // Hard expiry of the refresh token (JWT_REFRESH_TTL from issuance).
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // Stamped when the row is rotated/revoked/logged-out — a non-null value reads as absent.
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    // The id of the row that superseded this one on rotation (audit lineage).
    replacedBy: uuid('replaced_by'),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('session_family_idx').on(t.familyId),
    index('session_user_idx').on(t.userId),
    index('session_subject_idx').on(t.subjectId),
    index('session_expires_idx').on(t.expiresAt),
    check(
      'session_principal_kind_allowed',
      sql`${t.principalKind} IN ('user', 'subject', 'admin')`,
    ),
    // Linkage: a `user` session has user_id (no subject_id); a `subject` session has
    // subject_id (no user_id); an `admin` session carries neither FK.
    check(
      'session_linkage',
      sql`(${t.principalKind} = 'user' AND ${t.userId} IS NOT NULL AND ${t.subjectId} IS NULL) OR (${t.principalKind} = 'subject' AND ${t.subjectId} IS NOT NULL AND ${t.userId} IS NULL) OR (${t.principalKind} = 'admin')`,
    ),
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

/**
 * A federated identity linking a {@link subject} (end-user) to an external
 * provider (unified tenancy G-F, M-Y), mirroring {@link userIdentity}. Two
 * subjects in DIFFERENT tenants are the SAME human iff they share
 * `(provider, provider_user_id)` — the cross-tenant federation key (resolve-only;
 * never a wallet/permission merge). When a `userIdentity` and a `subjectIdentity`
 * share `(provider, provider_user_id)`, the operator and the end-user are the
 * same person (the user↔subject link). Cascades on subject deletion.
 */
// immutable: no updated_at (a federated identity link is never mutated in place)
export const subjectIdentity = pgTable(
  'subject_identity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => subject.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerUserId: text('provider_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One link per (provider identity, subject); the same identity MAY map to
    // several subjects (one per tenant) — that's exactly cross-tenant federation.
    uniqueIndex('subject_identity_provider_sub_subject_idx').on(
      t.provider,
      t.providerUserId,
      t.subjectId,
    ),
    index('subject_identity_provider_user_idx').on(t.provider, t.providerUserId),
    index('subject_identity_subject_idx').on(t.subjectId),
  ],
);
