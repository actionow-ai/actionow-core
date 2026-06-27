import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { faultPolicy } from './fault-policy.js';
import { tenant } from './identity.js';
import { providerPlugin } from './plugin.js';

export const resource = pgTable(
  'resource',
  {
    // NOTE: resource.id stays `text` (human-readable slug) — intentional, do not migrate to uuid.
    id: text('id').primaryKey(),
    // NULLABLE on purpose: a NULL `tenant_id` marks a GLOBAL platform resource
    // (the shared media/direct-chat relays) that ANY tenant may run — the engine
    // guard (`run.service.ts buildRequest`) treats NULL as "no owner = global".
    // A NON-NULL `tenant_id` stays tenant-private (isolated to its owner). The FK
    // is retained so a non-null value must reference a real tenant.
    tenantId: uuid('tenant_id').references(() => tenant.id),
    kind: text('kind').notNull(), // model | workflow
    modality: text('modality').notNull(), // text|image|video|audio|composite
    providerType: text('provider_type').notNull(),
    execModes: jsonb('exec_modes').$type<string[]>().notNull(),
    // status allowed values: active | disabled (createResource default + updateResourceStatus)
    status: text('status').notNull().default('active'),
    currentVersion: integer('current_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('resource_tenant_idx').on(t.tenantId),
    check('resource_status_allowed', sql`${t.status} IN ('active', 'disabled')`),
  ],
);

// immutable: no updated_at (a frozen version snapshot is never mutated)
export const resourceVersion = pgTable(
  'resource_version',
  {
    resourceId: text('resource_id')
      .notNull()
      .references(() => resource.id),
    version: integer('version').notNull(),
    // Untyped jsonb on purpose: the stored io_schema is broader than the
    // form-oriented contracts `IoSchema` — chat resources persist a synthetic
    // `{ key:'__ir', type:'json' }` output field outside the IoType enum.
    ioSchema: jsonb('io_schema').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('resource_version_pk').on(t.resourceId, t.version),
    index('resource_version_resource_idx').on(t.resourceId),
  ],
);

export const upstreamChannel = pgTable(
  'upstream_channel',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    resourceId: text('resource_id')
      .notNull()
      .references(() => resource.id),
    providerType: text('provider_type').notNull(),
    // A LOOSE secret locator (NOT an FK): `resolveSecretRef` resolves a uuid to a
    // secret_ref row, OR — uuid with no row — to a proxy/env value, so it must be
    // free to hold a non-secret_ref value (same posture as usage_log correlation ids).
    credentialRef: uuid('credential_ref'),
    /** Per-channel upstream base URL (e.g. https://api.deepseek.com/v1); null → adapter default. */
    endpoint: text('endpoint'),
    /** Per-channel model id (e.g. the upstream's model name); null → resource default. */
    model: text('model'),
    /** Locator (a secret_ref-style env key) for this channel's egress proxy URL; null → none. */
    proxyRef: text('proxy_ref'),
    /**
     * Generic relay protocol config (vendor specifics as DATA, not code): e.g.
     * `{ submitPath, pollPath, signatureHeader, timestampHeader }`; null → none.
     */
    config: jsonb('config').$type<Record<string, unknown>>(),
    /**
     * The operator's ACTUAL cost on THIS channel in µUSD per 1M INPUT tokens
     * (Track 5; spec §"Altered existing tables"). Direct-provider channels ≈ the
     * official catalog price; subscription channels (codex-oauth) ≈ 0. Drives
     * `usage_log.provider_cost` + margin analytics ONLY — NEVER the customer
     * price (that is `model.input_price × group_ratio`). Null → unknown cost (0).
     */
    inputCostPer1m: bigint('input_cost_per_1m', { mode: 'bigint' }),
    /** The operator's ACTUAL cost on this channel in µUSD per 1M OUTPUT tokens (Track 5). Null → 0. */
    outputCostPer1m: bigint('output_cost_per_1m', { mode: 'bigint' }),
    /**
     * Plugin binding (P2): when set, this channel is served by the generic plugin
     * adapter running this `provider_plugin` (vs the code adapter named by
     * `provider_type`). `plugin_version` pins the version for the freeze snapshot.
     */
    pluginId: uuid('plugin_id').references(() => providerPlugin.id),
    pluginVersion: integer('plugin_version'),
    /**
     * Fault-tolerance policy binding (调用容错): when set, the engine applies this
     * `fault_policy`'s same-channel retry + backoff + per-attempt timeouts to this
     * channel. Null → engine defaults (a single attempt + client-wide timeouts).
     */
    faultPolicyId: uuid('fault_policy_id').references(() => faultPolicy.id),
    /** Trust posture (spec §2 axis E): trusted (first-party) | untrusted (relay). */
    trust: text('trust').notNull().default('trusted'),
    /** Relay model-name remapping (untrusted relays): our model → upstream model. */
    modelMap: jsonb('model_map').$type<Record<string, string>>(),
    weight: integer('weight').notNull().default(1),
    // Free-form operator tags for routing (染色/标签路由) + faceting. Never gate-by-default.
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Selectable icon key (icon_asset.key); null → derive from plugin/provider/monogram.
    icon: text('icon'),
    // status allowed values: active | disabled (createUpstreamChannel default + admin update DTO)
    status: text('status').notNull().default('active'),
    // created_at backfills existing rows to "now" (additive); the uniform keyset
    // pagination (Track B) orders list endpoints on (created_at, id).
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('upstream_resource_idx').on(t.resourceId),
    check('upstream_channel_status_allowed', sql`${t.status} IN ('active', 'disabled')`),
  ],
);

// `channel_health` (P0a binary cooldown) is dropped in resilience-v2 (migration
// 0048), superseded by the stateful per-(channel,model) circuit breaker
// (`./channel-breaker.js`). Its routing-cooldown role + the ops `degraded`
// rollup are now driven by `channel_breaker`.

export const difyBinding = pgTable(
  'dify_binding',
  {
    resourceId: text('resource_id')
      .notNull()
      .references(() => resource.id),
    resourceVersion: integer('resource_version').notNull(),
    mode: text('mode').notNull(), // workflow | advanced-chat
    difyAppEndpoint: text('dify_app_endpoint').notNull(),
    // A LOOSE secret locator (NOT an FK; resolved via resolveSecretRef like credentialRef).
    difyServiceKeyRef: uuid('dify_service_key_ref'),
    dslHash: text('dsl_hash').notNull(),
    pricingModel: text('pricing_model').notNull(), // metered | fixed | matrix
    provisionMode: text('provision_mode').notNull().default('byo'), // byo | hosted
    requiredSecrets: jsonb('required_secrets').$type<string[]>().notNull().default([]),
    compatReport: jsonb('compat_report'),
    // defaultNow backfills existing rows to "now" (acceptable).
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('dify_binding_resource_idx').on(t.resourceId),
    // One live binding per (resource, version) so "get THE binding" is deterministic.
    uniqueIndex('dify_binding_resource_version_uq')
      .on(t.resourceId, t.resourceVersion)
      .where(sql`deleted_at IS NULL`),
    check('dify_binding_mode_allowed', sql`${t.mode} IN ('workflow', 'advanced-chat')`),
    check(
      'dify_binding_pricing_model_allowed',
      sql`${t.pricingModel} IN ('metered', 'fixed', 'matrix')`,
    ),
    check('dify_binding_provision_mode_allowed', sql`${t.provisionMode} IN ('byo', 'hosted')`),
  ],
);

export const secretRef = pgTable(
  'secret_ref',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(), // env | enc | oauth | vault
    locator: text('locator').notNull(),
    // Operator-editable metadata (catalog redesign): human name, free-form notes, and
    // a free-text group tag for organizing/filtering credentials. All nullable.
    name: text('name'),
    notes: text('notes'),
    groupTag: text('group_tag'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    check('secret_ref_provider_allowed', sql`${t.provider} IN ('env', 'enc', 'oauth', 'vault')`),
    // (provider, locator) resolution/dedup was a full scan (no secondary index).
    // Non-unique on purpose: the same env locator may back several named refs.
    index('secret_ref_provider_locator_idx').on(t.provider, t.locator),
  ],
);

/**
 * AES-256-GCM ciphertext for a `provider='enc'` {@link secretRef}. Stored as the
 * `iv.tag.ciphertext` string produced by `encryptSecret`; decrypted on resolve
 * with the env master key. 1:1 with its `secret_ref`.
 */
// immutable: no updated_at (the AES-GCM ciphertext blob is write-once per secret_ref)
export const secretMaterial = pgTable('secret_material', {
  secretRefId: uuid('secret_ref_id')
    .primaryKey()
    .references(() => secretRef.id),
  material: text('material').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
