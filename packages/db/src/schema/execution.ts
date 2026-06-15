import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  jsonb,
  pgTable,
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
    resourceId: text('resource_id')
      .notNull()
      .references(() => resource.id),
    resourceVersion: bigint('resource_version', { mode: 'number' }).notNull(),
    status: text('status').notNull(), // queued|running|succeeded|failed|canceled
    execMode: text('exec_mode').notNull(),
    inputs: jsonb('inputs').notNull(),
    output: jsonb('output'),
    usage: jsonb('usage'),
    upstreamJobHandle: text('upstream_job_handle'),
    pricebookEntryId: uuid('pricebook_entry_id'),
    pricebookVersion: bigint('pricebook_version', { mode: 'number' }),
    modifiersSnapshot: jsonb('modifiers_snapshot'),
    quotedCredits: bigint('quoted_credits', { mode: 'bigint' }),
    costCredits: bigint('cost_credits', { mode: 'bigint' }),
    holdId: uuid('hold_id'),
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
    callbackUrl: text('callback_url'),
    idempotencyKey: text('idempotency_key'),
    endUser: text('end_user'),
    error: jsonb('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('job_status_idx').on(t.status), index('job_tenant_idx').on(t.tenantId)],
);

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
    jobId: uuid('job_id'),
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
  ],
);

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
  (t) => [uniqueIndex('idempotency_tenant_key').on(t.tenantId, t.key)],
);

export const webhookOutbox = pgTable(
  'webhook_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id').notNull(),
    url: text('url').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: bigint('attempts', { mode: 'number' }).notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('outbox_due_idx').on(t.status, t.nextAttemptAt)],
);
