import {
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

export const resource = pgTable('resource', {
  id: text('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenant.id),
  kind: text('kind').notNull(), // model | workflow
  modality: text('modality').notNull(), // text|image|video|audio|composite
  providerType: text('provider_type').notNull(),
  execModes: jsonb('exec_modes').$type<string[]>().notNull(),
  status: text('status').notNull().default('active'),
  currentVersion: integer('current_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const resourceVersion = pgTable(
  'resource_version',
  {
    resourceId: text('resource_id')
      .notNull()
      .references(() => resource.id),
    version: integer('version').notNull(),
    ioSchema: jsonb('io_schema').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('resource_version_pk').on(t.resourceId, t.version)],
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
    weight: integer('weight').notNull().default(1),
    status: text('status').notNull().default('active'),
  },
  (t) => [index('upstream_resource_idx').on(t.resourceId)],
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
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const difyBinding = pgTable('dify_binding', {
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
});

export const secretRef = pgTable('secret_ref', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull(), // env | vault
  locator: text('locator').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
