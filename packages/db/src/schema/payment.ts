import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { subject, tenant } from './identity.js';

/**
 * A single payment attempt against one provider. `provider_ref` is the
 * provider's own handle (Stripe session id, Alipay/WeChat out_trade_no, …) and
 * is the join key inbound webhooks resolve against — hence the
 * `unique(provider, provider_ref)` so a (provider, ref) pair maps to at most one
 * intent.
 *
 * Money is integer minor units carried as `bigint`. `credit_amount` is the
 * µcredit amount a successful topup credits to the account; it is fixed at
 * intent creation (the currency→credit rate is captured then, never re-derived
 * at fulfillment).
 */
export const paymentIntent = pgTable(
  'payment_intent',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    // The subject (end-user) a topup is routed to (unified tenancy G-E); null → tenant pool.
    subjectId: uuid('subject_id').references(() => subject.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(), // stripe|alipay|wechat|crypto
    providerRef: text('provider_ref').notNull(),
    purpose: text('purpose').notNull(), // topup|order|subscription
    targetRef: text('target_ref'),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    creditAmount: bigint('credit_amount', { mode: 'bigint' }),
    // status allowed values: created (insert default) | pending | succeeded | failed |
    // expired | refunded (provider normalizers + setIntentStatus).
    status: text('status').notNull().default('created'),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_intent_provider_ref').on(t.provider, t.providerRef),
    index('payment_intent_tenant_idx').on(t.tenantId),
    index('payment_intent_subject_idx').on(t.subjectId),
    check(
      'payment_intent_status_allowed',
      sql`${t.status} IN ('created', 'pending', 'succeeded', 'failed', 'expired', 'refunded')`,
    ),
  ],
);

/**
 * A signature-verified webhook event from a provider. `unique(provider,
 * provider_event_id)` is the idempotency anchor: `insertEventIfNew` does
 * `ON CONFLICT DO NOTHING` against it, so a redelivered webhook never
 * double-processes (e.g. never double-credits a topup). `raw_payload` is the
 * verified body (kept for audit); `signature_ok` records that verification
 * passed; `processed_at` is set once fulfillment completes.
 */
// immutable: no updated_at (a verified webhook event is an append-only audit record)
export const paymentEvent = pgTable(
  'payment_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // FK to the intent this event fulfilled (P2-8). ON DELETE SET NULL keeps the
    // audit event even if the intent is pruned. Null for an event with no known
    // intent (still recorded for audit).
    paymentIntentId: uuid('payment_intent_id').references(() => paymentIntent.id, {
      onDelete: 'set null',
    }),
    // Scope snapshots (记录系统 M-2b): copied from the resolved intent at insert so the
    // payment audit event stays scopable even after the intent is pruned (the
    // payment_intent_id FK above is ON DELETE SET NULL). Nullable for an
    // unresolved event. ON DELETE SET NULL keeps the audit row past tenant/subject deletion.
    tenantId: uuid('tenant_id').references(() => tenant.id, { onDelete: 'set null' }),
    subjectId: uuid('subject_id').references(() => subject.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    type: text('type').notNull(),
    rawPayload: jsonb('raw_payload').notNull(),
    signatureOk: boolean('signature_ok').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_event_provider_event').on(t.provider, t.providerEventId),
    index('payment_event_intent_idx').on(t.paymentIntentId),
    index('payment_event_tenant_idx').on(t.tenantId),
  ],
);
