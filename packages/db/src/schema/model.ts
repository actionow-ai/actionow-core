import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { resource } from './catalog.js';
import { tenant } from './identity.js';

/**
 * The relay model catalog (§支柱C C.1). Each row maps a public model `name`
 * (the string a caller sends in the OpenAI/Anthropic/Gemini request body) to
 * one chat `resource` (which carries the upstream channels / routing /
 * credentials). `visibility` is `public` (every tenant) or `tenant` (only
 * tenants with a `model_grant` row). `input_price`/`output_price` are
 * µcredit-per-token integers (the operator's resale price). `capabilities`
 * is a jsonb feature flag map (tools/vision/audio/json/stream) read by Track A.
 */
export const model = pgTable(
  'model',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    display: text('display'),
    modality: text('modality').notNull().default('chat'),
    capabilities: jsonb('capabilities')
      .$type<Record<string, boolean>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    visibility: text('visibility').notNull().default('public'), // public | tenant
    resourceId: text('resource_id')
      .notNull()
      .references(() => resource.id),
    inputPrice: bigint('input_price', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    outputPrice: bigint('output_price', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    // status allowed values: active | disabled (create default + admin DTO + sync insert)
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('model_name_idx').on(t.name),
    index('model_resource_idx').on(t.resourceId),
    check('model_status_allowed', sql`${t.status} IN ('active', 'disabled')`),
  ],
);

/**
 * Grants a `tenant`-visibility {@link model} to one tenant. `public` models
 * need no grant. Unique on `(model_id, tenant_id)` so a duplicate grant is a
 * no-op-safe upsert target.
 */
export const modelGrant = pgTable(
  'model_grant',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelId: uuid('model_id')
      .notNull()
      .references(() => model.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('model_grant_model_tenant_idx').on(t.modelId, t.tenantId)],
);
