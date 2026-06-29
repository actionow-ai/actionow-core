import type { PriceSpec } from '@actionow/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The global, admin-curated **official model price catalog** (Track 2; spec D7).
 * Each row is the operator's COST BASIS for one upstream model — the official
 * `$X/1M`-token list price stored as integer **µUSD per 1M tokens**
 * (`$X/1M → X×1e6`). The `sync-models` flow matches a discovered model's
 * `(provider, normalize(slug))` against this catalog and auto-assigns the model's
 * resale price; an UNMATCHED model is created `disabled` + `needs_pricing` so it
 * is NEVER billable at 0.
 *
 * `provider` is the catalog provider key (`openai` | `anthropic` | `google` |
 * …), distinct from a channel's `provider_type` (which the sync maps onto a
 * catalog provider). `model_slug` is the NORMALIZED canonical slug (lowercase,
 * date-suffix stripped, alias-mapped) that `matchOfficialPrice` looks up.
 */
export const officialModelPrice = pgTable(
  'official_model_price',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: text('provider').notNull(),
    modelSlug: text('model_slug').notNull(),
    displayName: text('display_name'),
    /** µUSD per 1M input tokens (official `$X/1M` × 1e6, exact integer). */
    inputPricePer1m: bigint('input_price_per_1m', { mode: 'bigint' }).notNull(),
    /** µUSD per 1M output tokens. */
    outputPricePer1m: bigint('output_price_per_1m', { mode: 'bigint' }).notNull(),
    /** Optional µUSD per 1M cached-input tokens (providers that price a cached read). */
    cachedInputPricePer1m: bigint('cached_input_price_per_1m', { mode: 'bigint' }),
    /**
     * When non-null, this row's price is the full `PriceSpec` (media/credits/
     * matrix); the per-1M columns are the denormalized fast-path for the common
     * per-token case. Nullable — a plain per-token catalog row leaves this null
     * and prices off the columns (see `officialPriceToSpec`). Rich (non-per-token)
     * models — Vidu/Kling credits, video matrix, image fixed — live in the
     * catalog as billable by storing their evaluator spec here.
     */
    scheme: jsonb('scheme').$type<PriceSpec>(),
    /** The source currency the official figure was quoted in (governance metadata). Defaults `USD`. */
    currency: text('currency').notNull().default('USD'),
    /**
     * Sourcing confidence of this cost basis. Defaults `firstparty` — the
     * matcher only ever auto-prices firstparty rows (see `billing_eligible`).
     */
    confidence: text('confidence').notNull().default('firstparty'),
    /**
     * Billing gate (defense-in-depth): `matchOfficialPrice` filters
     * `billing_eligible = true`, so a needs-review row can NEVER auto-price even
     * if it lives in the catalog. Defaults `true` (the existing admin-curated
     * rows are billable).
     */
    billingEligible: boolean('billing_eligible').notNull().default(true),
    /** Where the price was read (the provider's official pricing page). */
    sourceUrl: text('source_url'),
    /** The provider's stated effective date for this price. */
    effectiveAt: timestamp('effective_at', { withTimezone: true }),
    notes: text('notes'),
    /** Audit: the admin id/email that last wrote this row. */
    updatedBy: text('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // PARTIAL unique index (mirrors `model_name_idx`, migration 0018): only LIVE
    // rows reserve their `(provider, model_slug)`. A soft-deleted row frees the
    // pair so a fresh `createOfficialPrice` inserts a NEW live row, leaving the
    // old soft-deleted row intact for audit.
    uniqueIndex('official_model_price_provider_slug_idx')
      .on(t.provider, t.modelSlug)
      .where(sql`deleted_at IS NULL`),
  ],
);
