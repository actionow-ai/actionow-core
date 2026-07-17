import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { account } from './accounts.js';
import { subject, tenant } from './identity.js';

// 批次6 D3/D4 (旧世界删除): the `job` + `webhook_outbox` table DEFINITIONS are
// deleted and mig 0072 (D4) DROPs the tables. `ledger_txn` + `idempotency_key` +
// `request_idempotency` are KEPT assets; `ledger_txn.job_id` keeps its COLUMN
// (historical settle attribution) but lost the FK to the dead `job` table
// (mig 0072: ALTER TABLE ledger_txn DROP CONSTRAINT ledger_txn_job_id_job_id_fk).

// immutable: no updated_at (an append-only money ledger row is never mutated)
export const ledgerTxn = pgTable(
  'ledger_txn',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id),
    type: text('type').notNull(), // topup|giftcode|hold|settle|refund
    creditsDelta: bigint('credits_delta', { mode: 'bigint' }).notNull(),
    balanceAfter: bigint('balance_after', { mode: 'bigint' }).notNull(),
    resourceId: text('resource_id'),
    // Historical settle attribution to the OLD job world (dropped in D3/D4).
    // Plain uuid — NO FK: the `job` table definition is deleted; the column is
    // kept so pre-cutover ledger rows stay attributable. Null for non-job rows.
    jobId: uuid('job_id'),
    // Subject (end-user) financial attribution (unified tenancy G-B); survives
    // subject deletion (ON DELETE SET NULL). NULL → tenant-level. Ledger = SoT.
    subjectId: uuid('subject_id').references(() => subject.id, { onDelete: 'set null' }),
    pricebookVersion: bigint('pricebook_version', { mode: 'number' }),
    modifiersApplied: jsonb('modifiers_applied'),
    usageVector: jsonb('usage_vector'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // review #11: at most one settle per job
    uniqueIndex('ledger_settle_per_job')
      .on(t.jobId)
      .where(sql`type = 'settle'`),
    index('ledger_job_idx').on(t.jobId),
    index('ledger_txn_tenant_idx').on(t.tenantId),
    index('ledger_txn_account_idx').on(t.accountId),
    index('ledger_txn_subject_idx').on(t.subjectId),
    // The settle-once backstop (ledger_settle_per_job) keys off the literal
    // 'settle'; guard the discriminator so a typo can't silently bypass it. Set =
    // every value appendLedger writes (topup/settle/transfer_*) + reserved
    // lifecycle types (hold/refund/giftcode).
    check(
      'ledger_txn_type_allowed',
      sql`${t.type} IN ('topup', 'settle', 'hold', 'refund', 'giftcode', 'transfer_in', 'transfer_out')`,
    ),
  ],
);

// immutable: no updated_at (an idempotency claim row is write-once)
export const idempotencyKey = pgTable(
  'idempotency_key',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    key: text('key').notNull(),
    jobId: uuid('job_id').notNull(),
    // Per-subject idempotency window (unified tenancy G-B); NULL → tenant-level
    // (today's behavior, unchanged). The unique index is split so a NULL subject
    // keeps the exact `(tenant_id, key)` constraint while a subject-scoped claim
    // is unique per `(tenant_id, subject_id, key)`.
    subjectId: uuid('subject_id').references(() => subject.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idempotency_tenant_key')
      .on(t.tenantId, t.key)
      .where(sql`subject_id IS NULL`),
    uniqueIndex('idempotency_tenant_subject_key')
      .on(t.tenantId, t.subjectId, t.key)
      .where(sql`subject_id IS NOT NULL`),
  ],
);

/**
 * Track D5 — admin POST idempotency replay store. One row per
 * `(Idempotency-Key, scope)` where `scope` is the `METHOD path` of the route
 * (e.g. `POST /admin/tenants`). The interceptor persists the first successful
 * response `{status, body}` here and, on a duplicate POST carrying the SAME
 * key+scope, replays it verbatim instead of re-running the handler. The
 * composite PK makes the same key on a DIFFERENT route independent, and the
 * `INSERT … ON CONFLICT DO NOTHING` write makes a concurrent in-flight
 * duplicate safe (the racing writer just keeps its own freshly-computed result).
 *
 * SECURITY: this table caches response BODIES at rest, so it is ONLY ever
 * written for an ALLOWLIST of NON-secret-returning admin POSTs (gated by the
 * `@Idempotent()` decorator). Endpoints that return one-time secrets
 * (`POST /admin/api-keys`, `/secrets`, `/oauth-sessions(+codex login)`,
 * `/redemption-codes`) are deliberately NOT decorated, so no plaintext secret
 * is ever stored here.
 */
// immutable: no updated_at (a captured response is replayed verbatim, never mutated)
export const requestIdempotency = pgTable(
  'request_idempotency',
  {
    idKey: text('id_key').notNull(),
    /** The `METHOD path` of the route the key was used against. */
    scope: text('scope').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body'),
    /**
     * Fingerprint (sha256 hex) of the ORIGINAL request body (P3). On a replay the
     * interceptor rejects a reused key whose body differs, instead of returning
     * the wrong cached response. Nullable for pre-P3 rows (skip the check).
     */
    requestFingerprint: text('request_fingerprint'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.idKey, t.scope] })],
);
