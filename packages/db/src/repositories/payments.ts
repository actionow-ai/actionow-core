import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { and, eq, sql } from 'drizzle-orm';

import { paymentEvent, paymentIntent } from '../schema/index.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
import type { DbOrTx } from './types.js';

export type PaymentIntentRow = InferSelectModel<typeof paymentIntent>;
export type PaymentEventRow = InferSelectModel<typeof paymentEvent>;

/**
 * Fields a caller supplies to {@link createIntent}. `id`/`createdAt`/`updatedAt`
 * are DB-managed; `status` defaults to `created` and is omitted here.
 */
export type CreateIntentInput = Omit<
  InferInsertModel<typeof paymentIntent>,
  'id' | 'status' | 'createdAt' | 'updatedAt'
>;

/** Insert a `payment_intent` in status `created`. */
export async function createIntent(
  db: DbOrTx,
  input: CreateIntentInput,
): Promise<PaymentIntentRow> {
  const rows = await db
    .insert(paymentIntent)
    .values({ ...input, status: 'created' })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createIntent: insert returned no row');
  return row;
}

/**
 * Look up an intent by its `(provider, provider_ref)` pair — the join key
 * webhooks resolve against. Returns `undefined` if no intent matches.
 */
export async function getIntentByProviderRef(
  db: DbOrTx,
  provider: string,
  providerRef: string,
): Promise<PaymentIntentRow | undefined> {
  const rows = await db
    .select()
    .from(paymentIntent)
    .where(and(eq(paymentIntent.provider, provider), eq(paymentIntent.providerRef, providerRef)))
    .limit(1);
  return rows[0];
}

/**
 * Transition an intent's status and bump `updated_at`. Returns the updated row,
 * or `undefined` if no intent with that id exists.
 */
export async function setIntentStatus(
  db: DbOrTx,
  id: string,
  status: string,
): Promise<PaymentIntentRow | undefined> {
  const rows = await db
    .update(paymentIntent)
    .set({ status, updatedAt: sql`now()` })
    .where(eq(paymentIntent.id, id))
    .returning();
  return rows[0];
}

/**
 * Fetch an intent by id, tenant-scoped: a row whose `tenant_id` does not match
 * is indistinguishable from a missing one (returns `undefined`), so a caller
 * cannot read another tenant's intent.
 */
export async function getIntentByIdForTenant(
  db: DbOrTx,
  id: string,
  tenantId: string,
): Promise<PaymentIntentRow | undefined> {
  const rows = await db
    .select()
    .from(paymentIntent)
    .where(and(eq(paymentIntent.id, id), eq(paymentIntent.tenantId, tenantId)))
    .limit(1);
  return rows[0];
}

/** List a tenant's payment intents, keyset-paginated newest-first on `(created_at, id)`. */
export async function listIntentsByTenant(
  db: DbOrTx,
  tenantId: string,
  page: PageParams,
): Promise<KeysetResult<PaymentIntentRow>> {
  return keysetPage<PaymentIntentRow>(db, {
    table: paymentIntent,
    createdAtCol: paymentIntent.createdAt,
    idCol: paymentIntent.id,
    where: eq(paymentIntent.tenantId, tenantId),
    page,
  });
}

/** What a caller supplies to {@link insertEventIfNew} (DB-managed fields aside). */
export type InsertEventInput = Omit<
  InferInsertModel<typeof paymentEvent>,
  'id' | 'processedAt' | 'receivedAt'
>;

/** Result of {@link insertEventIfNew}. */
export interface InsertEventResult {
  /** `true` iff this call inserted the row (i.e. the event is new). */
  inserted: boolean;
  /** The freshly-inserted row when `inserted` is `true`. */
  row?: PaymentEventRow;
  /** The pre-existing row when `inserted` is `false` (a duplicate delivery). */
  existing?: PaymentEventRow;
}

/**
 * Idempotently record a verified webhook event.
 *
 * `INSERT … ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING *` —
 * if a row was inserted, the event is new (`{inserted:true}`); otherwise it is a
 * redelivery and we return the original row (`{inserted:false, existing}`) so
 * the caller can no-op without re-fulfilling. This is the anchor that keeps
 * topup credits exactly-once across provider retries.
 */
export async function insertEventIfNew(
  db: DbOrTx,
  input: InsertEventInput,
): Promise<InsertEventResult> {
  const inserted = await db
    .insert(paymentEvent)
    .values(input)
    .onConflictDoNothing({ target: [paymentEvent.provider, paymentEvent.providerEventId] })
    .returning();

  const insertedRow = inserted[0];
  if (insertedRow) return { inserted: true, row: insertedRow };

  const existing = await db
    .select()
    .from(paymentEvent)
    .where(
      and(
        eq(paymentEvent.provider, input.provider),
        eq(paymentEvent.providerEventId, input.providerEventId),
      ),
    )
    .limit(1);

  const row = existing[0];
  if (!row) {
    // The conflicting row vanished between INSERT and SELECT (e.g. a concurrent
    // delete). Surface it rather than returning a misleading result.
    throw new Error(
      `insertEventIfNew: conflict on (${input.provider}, ${input.providerEventId}) but no existing row`,
    );
  }
  return { inserted: false, existing: row };
}

/**
 * Mark an event processed (set `processed_at = now()`). Returns the updated row,
 * or `undefined` if no event with that id exists.
 */
export async function markEventProcessed(
  db: DbOrTx,
  id: string,
): Promise<PaymentEventRow | undefined> {
  const rows = await db
    .update(paymentEvent)
    .set({ processedAt: sql`now()` })
    .where(eq(paymentEvent.id, id))
    .returning();
  return rows[0];
}
