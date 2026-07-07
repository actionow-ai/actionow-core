import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { secretRef } from './catalog.js';

/**
 * A rotating OAuth session for a `provider='oauth'` secret_ref (P1a). Access +
 * refresh tokens are AES-256-GCM ciphertext (F0 crypto); never plaintext. 1:1
 * with its secret_ref. Mutable (rotated on refresh) — unlike the immutable
 * secret_material blob, hence its own table.
 */
export const oauthSession = pgTable(
  'oauth_session',
  {
    secretRefId: uuid('secret_ref_id')
      .primaryKey()
      .references(() => secretRef.id),
    providerKind: text('provider_kind').notNull(),
    accountLabel: text('account_label'),
    accountId: text('account_id'),
    // Operator-editable metadata (catalog redesign): human name, free-form notes,
    // and a free-text group tag for organizing/filtering credentials. All nullable.
    name: text('name'),
    notes: text('notes'),
    groupTag: text('group_tag'),
    accessEnc: text('access_enc').notNull(),
    refreshEnc: text('refresh_enc').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastRefreshAt: timestamp('last_refresh_at', { withTimezone: true }),
    refreshLockAt: timestamp('refresh_lock_at', { withTimezone: true }),
    // status allowed values: active | needs_reauth (insert default + markNeedsReauth)
    status: text('status').notNull().default('active'),
    // defaultNow backfills existing rows to "now" (acceptable).
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    check('oauth_session_status_allowed', sql`${t.status} IN ('active', 'needs_reauth')`),
    // Human name unique among LIVE sessions (partial: null names + revoked rows
    // exempt) — same pick-key reliability as secret_ref.name.
    uniqueIndex('oauth_session_name_idx')
      .on(t.name)
      .where(sql`${t.name} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ],
);
