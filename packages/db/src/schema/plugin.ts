import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
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
