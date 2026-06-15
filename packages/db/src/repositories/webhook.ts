import type { InferSelectModel } from 'drizzle-orm';
import { and, asc, eq, lte, sql } from 'drizzle-orm';

import { webhookOutbox } from '../schema/index.js';
import type { DbOrTx } from './types.js';

export type WebhookOutboxRow = InferSelectModel<typeof webhookOutbox>;

/**
 * Select due, undelivered webhook rows: `status='pending' AND
 * next_attempt_at <= now`, oldest-due first, capped at `limit`. The dispatcher
 * processes the batch; each row is advanced independently.
 */
export async function listDueWebhooks(
  db: DbOrTx,
  now: Date,
  limit = 50,
): Promise<WebhookOutboxRow[]> {
  return db
    .select()
    .from(webhookOutbox)
    .where(and(eq(webhookOutbox.status, 'pending'), lte(webhookOutbox.nextAttemptAt, now)))
    .orderBy(asc(webhookOutbox.nextAttemptAt))
    .limit(limit);
}

/** Mark a webhook row delivered (`status='sent'`, attempt count bumped). */
export async function markWebhookSent(db: DbOrTx, id: string, attempts: number): Promise<void> {
  await db.update(webhookOutbox).set({ status: 'sent', attempts }).where(eq(webhookOutbox.id, id));
}

/**
 * Reschedule a failed delivery: bump `attempts` and set the next backoff time
 * while keeping `status='pending'` (the dispatcher will retry it when due).
 */
export async function rescheduleWebhook(
  db: DbOrTx,
  id: string,
  attempts: number,
  nextAttemptAt: Date,
): Promise<void> {
  await db.update(webhookOutbox).set({ attempts, nextAttemptAt }).where(eq(webhookOutbox.id, id));
}

/** Dead-letter a webhook row after the retry budget is exhausted. */
export async function markWebhookDead(db: DbOrTx, id: string, attempts: number): Promise<void> {
  await db
    .update(webhookOutbox)
    .set({ status: 'dead', attempts, nextAttemptAt: sql`now()` })
    .where(eq(webhookOutbox.id, id));
}
