import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { subject, tenant } from './identity.js';

/**
 * A saved playground chat conversation (tenant-scoped). The transcript lives in
 * {@link message} rows; this row holds the title + the last-used model + ordering
 * timestamps. Generation itself runs through the data-plane relay (API key →
 * `/v1/chat/completions`); only the saved transcript is persisted here, like any
 * other `/console` resource.
 *
 * Soft-delete: `DELETE /console/conversations/:id` stamps `deleted_at`; reads and
 * the list exclude deleted rows (the messages stay as a tombstone).
 */
export const conversation = pgTable(
  'conversation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenant.id),
    // The subject (end-user) this conversation is attributed to; null → tenant-level.
    subjectId: uuid('subject_id').references(() => subject.id, { onDelete: 'set null' }),
    title: text('title').notNull().default('新对话'),
    // The model name last used in this conversation (drives the picker's restore).
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // List hot path: a tenant's live conversations, newest-activity first.
    index('conversation_tenant_idx').on(t.tenantId, t.deletedAt, t.updatedAt),
    index('conversation_subject_idx').on(t.subjectId),
  ],
);

/**
 * One turn in a {@link conversation}. Append-only in spirit — a row is written
 * once per user/assistant turn and never business-updated. `reasoning` holds the
 * model's chain-of-thought (DeepSeek-style `reasoning_content`) when present;
 * `usage` is the `{ input, output }` token counts; `latency_ms` is the client-
 * measured total for an assistant turn.
 */
export const message = pgTable(
  'message',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    // Per-conversation monotonic order (server-assigned on append).
    seq: integer('seq').notNull(),
    // role allowed values: user | assistant | system
    role: text('role').notNull(),
    content: text('content').notNull(),
    // Assistant chain-of-thought (reasoning_content), null for user/system + non-reasoning models.
    reasoning: text('reasoning'),
    // Token usage `{ input: number, output: number }` for an assistant turn; null otherwise.
    usage: jsonb('usage'),
    // Client-measured total latency (ms) for an assistant turn; null otherwise.
    latencyMs: integer('latency_ms'),
    // The model that produced an assistant turn (the conversation model may change between turns).
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('message_conversation_idx').on(t.conversationId, t.seq),
    check('message_role_allowed', sql`${t.role} IN ('user', 'assistant', 'system')`),
  ],
);
