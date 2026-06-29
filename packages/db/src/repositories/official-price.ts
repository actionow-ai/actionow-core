import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { and, eq, isNull } from 'drizzle-orm';

import { officialModelPrice } from '../schema/index.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
import type { DbOrTx } from './types.js';

export type OfficialModelPriceRow = InferSelectModel<typeof officialModelPrice>;

/**
 * The extendable canonical-slug alias map (Track 2 matcher). Maps a raw upstream
 * slug (AFTER lowercasing + date-suffix strip) onto the official catalog slug.
 * Starts (near-)empty by design — identity is the default — so adding an alias
 * later is ONE line here (e.g. a codex `gpt-5.5` → its official counterpart, or
 * an OpenAI `chatgpt-4o-latest` rolling alias → `gpt-4o`). Keys MUST already be
 * normalized (lowercase, dateless).
 */
const SLUG_ALIASES: Readonly<Record<string, string>> = {
  'chatgpt-4o-latest': 'gpt-4o',
};

/** A trailing `-YYYY-MM-DD` provider date/snapshot suffix (e.g. `gpt-4o-2024-05-13`). */
const DATE_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;

/**
 * Normalize an upstream model slug to the catalog's canonical form for matching:
 * lowercase, strip a trailing `-YYYY-MM-DD` snapshot/date suffix, then apply the
 * extendable {@link SLUG_ALIASES} map (identity when absent). Pure — no db. Only
 * a FULL `-YYYY-MM-DD` suffix is stripped (a bare year / partial date is kept).
 */
export function normalizeModelSlug(slug: string): string {
  const base = slug.toLowerCase().replace(DATE_SUFFIX, '');
  return SLUG_ALIASES[base] ?? base;
}

/** Fields a caller supplies to {@link createOfficialPrice}. Money is integer µUSD/1M. */
export interface CreateOfficialPriceInput {
  readonly provider: string;
  /** The canonical (normalized) slug; callers should pass `normalizeModelSlug(raw)`. */
  readonly modelSlug: string;
  readonly displayName?: string | null | undefined;
  /** µUSD per 1M input tokens (`$X/1M × 1e6`). */
  readonly inputPricePer1m: bigint;
  /** µUSD per 1M output tokens. */
  readonly outputPricePer1m: bigint;
  /** Optional µUSD per 1M cached-input tokens. */
  readonly cachedInputPricePer1m?: bigint | null | undefined;
  /** Source currency of the official figure (governance metadata); defaults `USD`. */
  readonly currency?: string | undefined;
  /** Sourcing confidence (`firstparty` | `secondary` | `reconstructed`); defaults `firstparty`. */
  readonly confidence?: string | undefined;
  /** Billing gate; defaults `true`. A `false` row is catalog-only and never auto-prices. */
  readonly billingEligible?: boolean | undefined;
  readonly sourceUrl?: string | null | undefined;
  readonly effectiveAt?: Date | null | undefined;
  readonly notes?: string | null | undefined;
  readonly updatedBy?: string | null | undefined;
}

/** Insert an `official_model_price` row and return it. */
export async function createOfficialPrice(
  db: DbOrTx,
  input: CreateOfficialPriceInput,
): Promise<OfficialModelPriceRow> {
  const rows = await db
    .insert(officialModelPrice)
    .values({
      provider: input.provider,
      modelSlug: input.modelSlug,
      inputPricePer1m: input.inputPricePer1m,
      outputPricePer1m: input.outputPricePer1m,
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.cachedInputPricePer1m !== undefined
        ? { cachedInputPricePer1m: input.cachedInputPricePer1m }
        : {}),
      ...(input.currency !== undefined ? { currency: input.currency } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      ...(input.billingEligible !== undefined ? { billingEligible: input.billingEligible } : {}),
      ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
      ...(input.effectiveAt !== undefined ? { effectiveAt: input.effectiveAt } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.updatedBy !== undefined ? { updatedBy: input.updatedBy } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createOfficialPrice: insert returned no row');
  return row;
}

/** Optional filters for {@link listOfficialPrices}. */
export interface ListOfficialPricesFilter {
  readonly provider?: string | undefined;
}

/**
 * List live official prices (admin catalog view; excludes soft-deleted),
 * keyset-paginated newest-first on `(created_at, id)`. An optional `provider`
 * filter composes with the keyset IN SQL.
 */
export function listOfficialPrices(
  db: DbOrTx,
  filter: ListOfficialPricesFilter,
  page: PageParams,
): Promise<KeysetResult<OfficialModelPriceRow>> {
  const providerFilter =
    filter.provider !== undefined ? eq(officialModelPrice.provider, filter.provider) : undefined;
  return keysetPage<OfficialModelPriceRow>(db, {
    table: officialModelPrice,
    createdAtCol: officialModelPrice.createdAt,
    idCol: officialModelPrice.id,
    where: and(isNull(officialModelPrice.deletedAt), providerFilter),
    page,
  });
}

/** Fetch a live official price by id (soft-deleted → `undefined`; admin get-by-id). */
export async function getOfficialPriceById(
  db: DbOrTx,
  id: string,
): Promise<OfficialModelPriceRow | undefined> {
  const rows = await db
    .select()
    .from(officialModelPrice)
    .where(and(eq(officialModelPrice.id, id), isNull(officialModelPrice.deletedAt)))
    .limit(1);
  return rows[0];
}

/**
 * Matcher lookup: fetch the LIVE, BILLABLE official price for
 * `(provider, normalizedSlug)`. Filters `deleted_at IS NULL` AND
 * `billing_eligible = true` — defense-in-depth so a needs-review (catalog-only)
 * row can NEVER auto-price even if it exists in the catalog. The caller passes
 * the ALREADY-normalized slug (see {@link matchOfficialPrice}, which normalizes
 * for you).
 */
export async function getOfficialPrice(
  db: DbOrTx,
  provider: string,
  normalizedSlug: string,
): Promise<OfficialModelPriceRow | undefined> {
  const rows = await db
    .select()
    .from(officialModelPrice)
    .where(
      and(
        eq(officialModelPrice.provider, provider),
        eq(officialModelPrice.modelSlug, normalizedSlug),
        eq(officialModelPrice.billingEligible, true),
        isNull(officialModelPrice.deletedAt),
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * Match a RAW upstream slug against the official catalog for `provider`:
 * `getOfficialPrice(db, provider, normalizeModelSlug(rawSlug))`. Returns the
 * catalog row, or `undefined` when no live row matches (the sync treats that as
 * `needs_pricing`).
 */
export function matchOfficialPrice(
  db: DbOrTx,
  provider: string,
  rawSlug: string,
): Promise<OfficialModelPriceRow | undefined> {
  return getOfficialPrice(db, provider, normalizeModelSlug(rawSlug));
}

/** Mutable fields of an {@link officialModelPrice} (admin PATCH); omitted keys are unchanged. */
export interface UpdateOfficialPriceInput {
  readonly displayName?: string | null | undefined;
  readonly inputPricePer1m?: bigint | undefined;
  readonly outputPricePer1m?: bigint | undefined;
  readonly cachedInputPricePer1m?: bigint | null | undefined;
  readonly sourceUrl?: string | null | undefined;
  readonly effectiveAt?: Date | null | undefined;
  readonly notes?: string | null | undefined;
  readonly updatedBy?: string | null | undefined;
}

/**
 * Patch a live official price (by id), returning the new row. Only the supplied
 * fields change; `updated_at` is bumped on any real write. An empty patch is a
 * read-back of the current live row. Soft-deleted / unknown → `undefined`.
 */
export async function updateOfficialPrice(
  db: DbOrTx,
  id: string,
  patch: UpdateOfficialPriceInput,
): Promise<OfficialModelPriceRow | undefined> {
  const set: Partial<InferInsertModel<typeof officialModelPrice>> = {};
  if (patch.displayName !== undefined) set.displayName = patch.displayName;
  if (patch.inputPricePer1m !== undefined) set.inputPricePer1m = patch.inputPricePer1m;
  if (patch.outputPricePer1m !== undefined) set.outputPricePer1m = patch.outputPricePer1m;
  if (patch.cachedInputPricePer1m !== undefined)
    set.cachedInputPricePer1m = patch.cachedInputPricePer1m;
  if (patch.sourceUrl !== undefined) set.sourceUrl = patch.sourceUrl;
  if (patch.effectiveAt !== undefined) set.effectiveAt = patch.effectiveAt;
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (patch.updatedBy !== undefined) set.updatedBy = patch.updatedBy;
  if (Object.keys(set).length === 0) {
    return getOfficialPriceById(db, id);
  }
  set.updatedAt = new Date();
  const rows = await db
    .update(officialModelPrice)
    .set(set)
    .where(and(eq(officialModelPrice.id, id), isNull(officialModelPrice.deletedAt)))
    .returning();
  return rows[0];
}

/**
 * Revoke an official price by SOFT-DELETING it (by id): stamps `deleted_at`
 * (`now()`) + bumps `updated_at`, only when the row is still live. `getOfficialPrice*`
 * / `listOfficialPrices` / `matchOfficialPrice` all filter `deleted_at IS NULL`,
 * so the row drops out of the catalog + matching, and the PARTIAL unique frees
 * its `(provider, slug)` pair for a fresh re-create. Returns the deleted id, or
 * `undefined` when nothing matched (already deleted / unknown) — idempotent.
 */
export async function softDeleteOfficialPrice(db: DbOrTx, id: string): Promise<string | undefined> {
  const now = new Date();
  const rows = await db
    .update(officialModelPrice)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(officialModelPrice.id, id), isNull(officialModelPrice.deletedAt)))
    .returning({ id: officialModelPrice.id });
  return rows[0]?.id;
}
