import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * A data-driven provider plugin (spec §3.2): a declarative `manifest` (axes,
 * protocol, auth strategy, credential-form schema) + a sandboxed JS `handler`
 * (mapRequest/mapResponse/mapPoll/mapCallback). Executed by the generic plugin
 * adapter so heterogeneous upstreams are config+handler, not bespoke code.
 * Soft-deleted + versioned (a `resource_version` freezes a snapshot).
 */
export const providerPlugin = pgTable(
  'provider_plugin',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable identity used for clone/seed reference, e.g. 'openai-chat'. */
    slug: text('slug').notNull().unique(),
    label: text('label').notNull(),
    modalities: text('modalities')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** sync | async-poll (webhook-only/ws-stream reserved). */
    protocol: text('protocol').notNull(),
    /** Named signer strategy applied OUTSIDE the sandbox (bearer/volcSignV4/…). */
    authStrategy: text('auth_strategy').notNull(),
    manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull(),
    handler: text('handler').notNull(),
    version: integer('version').notNull().default(1),
    builtin: boolean('builtin').notNull().default(false),
    // status allowed values: active | disabled
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('provider_plugin_slug_idx').on(t.slug)],
);

/**
 * An immutable snapshot of one plugin VERSION (spec §3.6 freeze). Written on every
 * create/update; a channel pins `(plugin_id, plugin_version)` so an in-flight job
 * keeps running the exact manifest+handler it bound to, even after the plugin is
 * edited. The mutable `provider_plugin` row always holds the latest.
 */
export const providerPluginVersion = pgTable(
  'provider_plugin_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pluginId: uuid('plugin_id')
      .notNull()
      .references(() => providerPlugin.id),
    version: integer('version').notNull(),
    manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull(),
    handler: text('handler').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('provider_plugin_version_uq').on(t.pluginId, t.version)],
);
