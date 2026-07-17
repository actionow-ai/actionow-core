import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

// 批次6 D3 (旧世界删除): the resource three-layer (`resource` /
// `resource_version` / `upstream_channel`) and `dify_binding` table
// DEFINITIONS are deleted — D4 ships the DROP migration. Only the secret
// vault survives here: `secret_ref` + `secret_material` are KEPT assets (the
// new `supply_credential.secret_ref_id` FK depends on them).

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
    // Human name must be unique among LIVE credentials so it's a reliable pick key
    // in the channel editor's credential dropdown (partial: null names + tombstoned
    // rows are exempt, so an unnamed or revoked credential never blocks a name).
    uniqueIndex('secret_ref_name_idx')
      .on(t.name)
      .where(sql`${t.name} IS NOT NULL AND ${t.deletedAt} IS NULL`),
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
