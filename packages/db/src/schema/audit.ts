import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { subject, tenant } from './identity.js';

/**
 * The **audit log** (记录系统) — an append-only, actor-attributed trail of
 * money / governance / identity MUTATIONS (who changed what, when, with what
 * intent). It is the system-of-record moat: distinct from `ledger_txn` (which
 * records financial OUTCOMES), `audit_log` records the ACTION + actor.
 *
 * Append-only: no `updated_at`, never mutated. `tenant_id`/`subject_id` are the
 * scope (both nullable — a platform-level op has neither) and use
 * `ON DELETE SET NULL` so a record survives the deletion of the very row it
 * describes (the whole point of an audit trail). `actor_id` is free text (an
 * operator admin id, a tenant user id, or null for `system`) — intentionally
 * NOT an FK, so the actor reference outlives the actor row. `meta` carries
 * compact, non-secret context (amounts in µ, plan ids, before/after status,
 * cascade counts, reason) — NEVER credentials or plaintext.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // actor_type allowed values: operator | member | system
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    tenantId: uuid('tenant_id').references(() => tenant.id, { onDelete: 'set null' }),
    subjectId: uuid('subject_id').references(() => subject.id, { onDelete: 'set null' }),
    /** Dotted verb, e.g. `tenant.topup`, `limit_plan.update`, `subject.delete`. */
    action: text('action').notNull(),
    /** `tenant`|`account`|`api_key`|`limit_plan`|`subject`|`sub_account`|`model_grant`|`payment`|… */
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    meta: jsonb('meta')
      .notNull()
      .default(sql`'{}'::jsonb`),
    requestId: text('request_id'),
  },
  (t) => [
    index('audit_log_tenant_idx').on(t.tenantId, t.createdAt),
    index('audit_log_subject_idx').on(t.subjectId, t.createdAt),
    index('audit_log_action_idx').on(t.action),
    check('audit_log_actor_type_allowed', sql`${t.actorType} IN ('operator', 'member', 'system')`),
  ],
);
