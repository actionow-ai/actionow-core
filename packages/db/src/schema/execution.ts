import type { UnifiedError, UsageVector } from '@actionow/contracts';
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
import { resource } from './catalog.js';
import { tenant } from './identity.js';

export const job = pgTable(
  'job',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    accountId: uuid('account_id').references(() => account.id),
    resourceId: text('resource_id')
      .notNull()
      .references(() => resource.id),
    resourceVersion: bigint('resource_version', { mode: 'number' }).notNull(),
    // status allowed values: queued | running | succeeded | failed | canceled (JOB_STATUSES)
    status: text('status').notNull(),
    execMode: text('exec_mode').notNull(),
    inputs: jsonb('inputs').$type<Record<string, unknown>>().notNull(),
    output: jsonb('output').$type<Record<string, unknown>>(),
    usage: jsonb('usage').$type<UsageVector>(),
    upstreamJobHandle: text('upstream_job_handle'),
    pricebookEntryId: uuid('pricebook_entry_id'),
    pricebookVersion: bigint('pricebook_version', { mode: 'number' }),
    // dynamic shape (per-run snapshot of applied modifiers); left untyped intentionally.
    modifiersSnapshot: jsonb('modifiers_snapshot'),
    quotedCredits: bigint('quoted_credits', { mode: 'bigint' }),
    costCredits: bigint('cost_credits', { mode: 'bigint' }),
    holdId: uuid('hold_id'),
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
    callbackUrl: text('callback_url'),
    idempotencyKey: text('idempotency_key'),
    endUser: text('end_user'),
    error: jsonb('error').$type<UnifiedError>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('job_status_idx').on(t.status),
    index('job_tenant_idx').on(t.tenantId),
    check(
      'job_status_allowed',
      sql`${t.status} IN ('queued', 'running', 'succeeded', 'failed', 'canceled')`,
    ),
  ],
);

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
    // FK to the originating job (P2-8): referential integrity for the financial
    // audit trail. ON DELETE SET NULL keeps the ledger row (money history is
    // append-only) even if a job is ever pruned. Null for non-job rows (topup).
    jobId: uuid('job_id').references(() => job.id, { onDelete: 'set null' }),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // `idempotency_tenant_key` on (tenant_id, key) also serves as the FK index on tenant_id.
  (t) => [uniqueIndex('idempotency_tenant_key').on(t.tenantId, t.key)],
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.idKey, t.scope] })],
);

// immutable: no updated_at (status moves pending→sent/dead but the row is otherwise append-only)
export const webhookOutbox = pgTable(
  'webhook_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id').notNull(),
    url: text('url').notNull(),
    payload: jsonb('payload').notNull(),
    // status allowed values: pending (default) | sent (markWebhookSent) | dead (markWebhookDead)
    status: text('status').notNull().default('pending'),
    attempts: bigint('attempts', { mode: 'number' }).notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('outbox_due_idx').on(t.status, t.nextAttemptAt),
    index('webhook_outbox_job_idx').on(t.jobId),
    check('webhook_outbox_status_allowed', sql`${t.status} IN ('pending', 'sent', 'dead')`),
  ],
);
