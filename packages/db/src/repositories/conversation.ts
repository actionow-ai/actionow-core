import type { InferSelectModel, SQL } from 'drizzle-orm';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';

import { conversation, message } from '../schema/index.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
import type { DbOrTx } from './types.js';

export type Conversation = InferSelectModel<typeof conversation>;
export type Message = InferSelectModel<typeof message>;

/**
 * Read-path subject isolation (mirrors {@link fileSubjectScope}): a subject-scoped
 * caller sees its own conversations plus tenant-shared (`subject_id IS NULL`)
 * ones; a `null` subject (tenant-level caller) imposes no filter.
 */
function conversationSubjectScope(subjectId: string | null): SQL | undefined {
  return subjectId === null
    ? undefined
    : or(eq(conversation.subjectId, subjectId), isNull(conversation.subjectId));
}

/** Fields a caller supplies to {@link createConversation}. */
export interface CreateConversationInput {
  readonly tenantId: string;
  readonly subjectId?: string | null;
  readonly title?: string;
  readonly model?: string | null;
}

/** Insert a conversation row (title defaults at the DB layer when omitted). */
export async function createConversation(
  db: DbOrTx,
  input: CreateConversationInput,
): Promise<Conversation> {
  const rows = await db
    .insert(conversation)
    .values({
      tenantId: input.tenantId,
      ...(input.subjectId != null ? { subjectId: input.subjectId } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createConversation: insert returned no row');
  return row;
}

/**
 * Keyset-paginate a tenant's LIVE conversations, most-recent-activity first
 * (`updated_at DESC`). Tenant isolation is the leading predicate; soft-deleted
 * rows are excluded.
 */
export function listConversations(
  db: DbOrTx,
  tenantId: string,
  page: PageParams,
  subjectId: string | null = null,
): Promise<KeysetResult<Conversation>> {
  const predicates: SQL[] = [eq(conversation.tenantId, tenantId), isNull(conversation.deletedAt)];
  const scope = conversationSubjectScope(subjectId);
  if (scope !== undefined) predicates.push(scope);

  // The keyset sort key is `updated_at` (recency), not `created_at` — the generic
  // `createdAtCol` slot just names the order column + cursor field.
  return keysetPage<Conversation>(db, {
    table: conversation,
    createdAtCol: conversation.updatedAt,
    idCol: conversation.id,
    where: and(...predicates),
    page,
  });
}

/**
 * Fetch a LIVE conversation by id, tenant-scoped (returns `undefined` for another
 * tenant's or a soft-deleted conversation) so callers enforce isolation.
 */
export async function getConversation(
  db: DbOrTx,
  id: string,
  tenantId: string,
  subjectId: string | null = null,
): Promise<Conversation | undefined> {
  const rows = await db
    .select()
    .from(conversation)
    .where(
      and(
        eq(conversation.id, id),
        eq(conversation.tenantId, tenantId),
        isNull(conversation.deletedAt),
        conversationSubjectScope(subjectId),
      ),
    )
    .limit(1);
  return rows[0];
}

/** All messages of a conversation in turn order (`seq ASC`). */
export function listMessages(db: DbOrTx, conversationId: string): Promise<Message[]> {
  return db
    .select()
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.seq));
}

/** Mutable conversation fields (title / last-used model). */
export interface UpdateConversationInput {
  readonly title?: string;
  readonly model?: string | null;
}

/**
 * Rename / re-model a tenant-owned LIVE conversation. Returns the updated row, or
 * `undefined` when no matching live conversation exists. Always bumps `updated_at`.
 */
export async function updateConversation(
  db: DbOrTx,
  id: string,
  tenantId: string,
  patch: UpdateConversationInput,
  subjectId: string | null = null,
): Promise<Conversation | undefined> {
  const rows = await db
    .update(conversation)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(conversation.id, id),
        eq(conversation.tenantId, tenantId),
        isNull(conversation.deletedAt),
        conversationSubjectScope(subjectId),
      ),
    )
    .returning();
  return rows[0];
}

/**
 * Soft-delete a tenant-owned conversation: stamp `deleted_at` (idempotent — only a
 * still-LIVE row moves). The `message` rows stay (cascade only fires on a hard
 * delete). Returns the row or `undefined` when none matched.
 */
export async function softDeleteConversation(
  db: DbOrTx,
  id: string,
  tenantId: string,
  subjectId: string | null = null,
): Promise<Conversation | undefined> {
  const now = new Date();
  const rows = await db
    .update(conversation)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(conversation.id, id),
        eq(conversation.tenantId, tenantId),
        isNull(conversation.deletedAt),
        conversationSubjectScope(subjectId),
      ),
    )
    .returning();
  return rows[0];
}

/** Fields a caller supplies to {@link appendMessage} (`seq` is server-assigned). */
export interface AppendMessageInput {
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly reasoning?: string | null;
  readonly usage?: { input: number; output: number } | null;
  readonly latencyMs?: number | null;
  readonly model?: string | null;
}

/**
 * Append one turn to a conversation. `seq` is assigned atomically from the current
 * max via an `INSERT … SELECT` subquery (no read-modify-write race for the common
 * sequential-turn case), and the parent conversation's `updated_at` is bumped so
 * the list re-sorts it to the top. The caller MUST have already verified tenant
 * ownership of `conversationId` (e.g. via {@link getConversation}).
 */
export async function appendMessage(
  db: DbOrTx,
  conversationId: string,
  input: AppendMessageInput,
): Promise<Message> {
  const nextSeq = sql<number>`(SELECT coalesce(max(${message.seq}), -1) + 1 FROM ${message} WHERE ${message.conversationId} = ${conversationId})`;
  const rows = await db
    .insert(message)
    .values({
      conversationId,
      seq: nextSeq,
      role: input.role,
      content: input.content,
      ...(input.reasoning != null ? { reasoning: input.reasoning } : {}),
      ...(input.usage != null ? { usage: input.usage } : {}),
      ...(input.latencyMs != null ? { latencyMs: input.latencyMs } : {}),
      ...(input.model != null ? { model: input.model } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('appendMessage: insert returned no row');
  await db
    .update(conversation)
    .set({ updatedAt: new Date() })
    .where(eq(conversation.id, conversationId));
  return row;
}
