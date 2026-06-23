import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * A **managed egress proxy (代理)** — a named, reusable proxy an operator binds
 * to an upstream channel (`upstream_channel.proxy_ref = proxy.id`). First-class
 * vs the legacy path of stashing a proxy URL in a generic secret: the full URL
 * (incl. any `user:pass@`) is AES-GCM encrypted at rest, with `scheme`/`host`
 * kept in the clear for display, an operator `status` toggle, and health fields
 * populated by the probe endpoint.
 *
 * RESOLUTION: `resolveSecretRef` resolves a `proxy.id` (when no `secret_ref`
 * matches) to the DECRYPTED URL — so binding a channel works with ZERO engine
 * changes (the engine already resolves `proxyRef` → URL → undici/curl egress).
 * A non-`active` proxy resolves to nothing → the channel falls back to the
 * global `UPSTREAM_PROXY_URL` (or none).
 */
export const proxy = pgTable(
  'proxy',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Protocol for display/filter: http | https | socks5 | socks5h (derived from the URL). */
    scheme: text('scheme').notNull(),
    /** `host:port` for display — NEVER the credentials. */
    host: text('host').notNull(),
    /** AES-256-GCM ciphertext of the FULL proxy URL (incl. credentials); never returned to clients. */
    encryptedUrl: text('encrypted_url').notNull(),
    // status allowed values: active | disabled
    status: text('status').notNull().default('active'),
    /** Last probe verdict: null = never probed, true = reachable, false = failing. */
    healthy: boolean('healthy'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    /** Latency (ms) measured on the last successful probe. */
    lastLatencyMs: integer('last_latency_ms'),
    /** Sanitized error from the last failing probe (credentials redacted). */
    lastError: text('last_error'),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // PARTIAL unique (mirrors route_group/fault_policy): only LIVE rows reserve the name.
    uniqueIndex('proxy_name_idx')
      .on(t.name)
      .where(sql`deleted_at IS NULL`),
    check('proxy_status_allowed', sql`${t.status} IN ('active', 'disabled')`),
  ],
);
