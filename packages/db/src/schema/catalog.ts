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

import { tenant } from './identity.js';

export const resource = pgTable(
  'resource',
  {
    // NOTE: resource.id stays `text` (human-readable slug) — intentional, do not migrate to uuid.
    id: text('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
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
    weight: integer('weight').notNull().default(1),
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

/**
 * Per-channel routing health (P0a): a failing `upstream_channel` is cooled down
 * until `cooldown_until` so the weighted router skips it. Persisted (not
 * in-memory) so cooldown is consistent across replicas via the shared DB. Only
 * written on a failure; `consecutive_failures` drives exponential backoff and
 * resets when the last failure is older than the reset window (so no per-success
 * write is needed). A row's absence ⇒ the channel is healthy.
 */
export const channelHealth = pgTable('channel_health', {
  channelId: uuid('channel_id')
    .primaryKey()
    .references(() => upstreamChannel.id),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
  lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
  // defaultNow backfills existing rows to "now"; channel_health rows are short-lived (acceptable).
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const difyBinding = pgTable(
  'dify_binding',
  {
    resourceId: text('resource_id')
      .notNull()
      .references(() => resource.id),
    resourceVersion: integer('resource_version').notNull(),
    mode: text('mode').notNull(), // workflow | advanced-chat
    difyAppEndpoint: text('dify_app_endpoint').notNull(),
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
  (t) => [index('dify_binding_resource_idx').on(t.resourceId)],
);

export const secretRef = pgTable('secret_ref', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull(), // env | enc | oauth | vault
  locator: text('locator').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

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
