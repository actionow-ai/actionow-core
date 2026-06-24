import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * The selectable icon catalog (catalog icons): a seeded library of brand/provider
 * icon keys an operator can attach to a plugin / channel / model. `key` is the
 * stable identity stored on those entities' `icon` column (e.g. `openai`,
 * `volcengine`). `svg` is optional inline markup for a custom-uploaded icon; when
 * null the frontend `BrandIcon` renders the key via its built-in registry
 * (provider brand images) or a colored monogram fallback.
 */
export const iconAsset = pgTable('icon_asset', {
  key: text('key').primaryKey(),
  label: text('label').notNull(),
  /** Grouping for the picker, e.g. `provider` | `protocol` | `generic`. */
  category: text('category').notNull().default('provider'),
  /** Optional inline SVG markup (custom icons); null → frontend registry/monogram. */
  svg: text('svg'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
