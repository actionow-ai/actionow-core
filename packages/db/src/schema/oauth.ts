import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { secretRef } from './catalog.js';

/**
 * A rotating OAuth session for a `provider='oauth'` secret_ref (P1a). Access +
 * refresh tokens are AES-256-GCM ciphertext (F0 crypto); never plaintext. 1:1
 * with its secret_ref. Mutable (rotated on refresh) — unlike the immutable
 * secret_material blob, hence its own table.
 */
export const oauthSession = pgTable('oauth_session', {
  secretRefId: uuid('secret_ref_id')
    .primaryKey()
    .references(() => secretRef.id),
  providerKind: text('provider_kind').notNull(),
  accountLabel: text('account_label'),
  accountId: text('account_id'),
  accessEnc: text('access_enc').notNull(),
  refreshEnc: text('refresh_enc').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  lastRefreshAt: timestamp('last_refresh_at', { withTimezone: true }),
  refreshLockAt: timestamp('refresh_lock_at', { withTimezone: true }),
  status: text('status').notNull().default('active'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
