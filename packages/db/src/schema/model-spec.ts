import { sql } from 'drizzle-orm';
import {
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

/**
 * The official **model spec catalog** (接入与供给; the trustworthy-pricing track).
 * One row per upstream model discovered from each provider's OFFICIAL docs —
 * the canonical, admin-curated description of what a model IS (modalities,
 * context window, key params, intro, sources) independent of any channel wiring.
 *
 * `confidence` records HOW the row was sourced:
 *   - `firstparty`   — read off the provider's own pricing/docs page (trusted).
 *   - `secondary`    — from a credible aggregator / second-party source.
 *   - `reconstructed`— assembled / inferred (least trusted; needs review).
 *
 * `billing_eligible` is the GATE: only the firstparty per-token rows become a
 * billable COST BASIS (mirrored into `official_model_price`). Every other row is
 * catalog-only — it enriches browsing/onboarding but is NEVER billable. Pairing
 * the two columns lets the operator surface the full vendor catalog while
 * keeping only the trustworthy prices in the billing path.
 *
 * `vendor` is the catalog provider KEY (`openai` | `anthropic` | `google` |
 * `xai` | `deepseek` | …), the same namespace as `official_model_price.provider`
 * (NOT a channel's `provider_type`). `model_id` is the raw upstream model id
 * (e.g. `gpt-5.5`); the partial-unique `(vendor, model_id)` reserves it for the
 * one LIVE row, so an `upsertModelSpec` re-run UPDATES instead of duplicating.
 */
export const modelSpec = pgTable(
  'model_spec',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Catalog provider key (`openai`|`anthropic`|…); same namespace as `official_model_price.provider`. */
    vendor: text('vendor').notNull(),
    /** The raw upstream model id (`gpt-5.5`, `claude-opus-4-8`, …), as the provider names it. */
    modelId: text('model_id').notNull(),
    displayName: text('display_name'),
    /** Optional model family / series grouping (`gpt-5`, `claude-4`, …). */
    family: text('family'),
    /** Coarse type: `text` | `image` | `video` | `audio` | `multimodal` (CHECKed in mig 0059). */
    type: text('type').notNull(),
    /** Accepted input modalities, e.g. `["text","image"]`. */
    inputModalities: jsonb('input_modalities').$type<string[]>(),
    /** Produced output modalities, e.g. `["text"]`. */
    outputModalities: jsonb('output_modalities').$type<string[]>(),
    /** Free-form media option descriptors (resolutions/durations/modes); shape varies by vendor. */
    mediaOptions: jsonb('media_options').$type<unknown>(),
    /** Notable request parameters (`reasoning_effort`, `temperature`, …). */
    keyParams: jsonb('key_params').$type<string[]>(),
    /** Cited source URLs the spec was assembled from. */
    sources: jsonb('sources').$type<string[]>(),
    /** Lifecycle status string as the provider states it (`GA`, `preview`, …). */
    status: text('status'),
    /** Context window as stated (kept TEXT — providers phrase it inconsistently). */
    contextWindow: text('context_window'),
    /** Max output tokens as stated (TEXT for the same reason). */
    maxOutput: text('max_output'),
    /** Short marketing/positioning blurb. */
    intro: text('intro'),
    /** Sourcing confidence: `firstparty` | `secondary` | `reconstructed` (CHECKed in mig 0059). */
    confidence: text('confidence').notNull().default('secondary'),
    /** Billing gate: true only for firstparty per-token rows mirrored into `official_model_price`. */
    billingEligible: boolean('billing_eligible').notNull().default(false),
    /** The pricing snapshot date this spec reflects (`2026-06`). */
    asOf: text('as_of'),
    /** The primary source URL (the provider's pricing page). */
    sourceUrl: text('source_url'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // PARTIAL unique index: only LIVE rows reserve their `(vendor, model_id)` so a
    // re-imported spec UPDATES the live row (via `upsertModelSpec`'s ON CONFLICT
    // … `targetWhere: deleted_at IS NULL`) instead of duplicating; a soft-deleted
    // row frees the pair for a fresh re-create.
    uniqueIndex('model_spec_vendor_model_idx')
      .on(t.vendor, t.modelId)
      .where(sql`deleted_at IS NULL`),
    index('model_spec_vendor_idx').on(t.vendor),
    index('model_spec_type_idx').on(t.type),
    index('model_spec_confidence_idx').on(t.confidence),
    check(
      'model_spec_type_allowed',
      sql`${t.type} IN ('text', 'image', 'video', 'audio', 'multimodal')`,
    ),
    check(
      'model_spec_confidence_allowed',
      sql`${t.confidence} IN ('firstparty', 'secondary', 'reconstructed')`,
    ),
  ],
);
