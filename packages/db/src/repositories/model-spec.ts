import type { InferSelectModel } from 'drizzle-orm';
import { and, eq, isNull } from 'drizzle-orm';

import { modelSpec } from '../schema/index.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
import type { DbOrTx } from './types.js';

export type ModelSpecRow = InferSelectModel<typeof modelSpec>;

/** Fields a caller supplies to {@link upsertModelSpec}. */
export interface UpsertModelSpecInput {
  /** Catalog provider key (`openai`|`anthropic`|…); the conflict arbiter with `modelId`. */
  readonly vendor: string;
  /** The raw upstream model id (the provider's own id). */
  readonly modelId: string;
  readonly displayName?: string | null | undefined;
  readonly family?: string | null | undefined;
  /** `text` | `image` | `video` | `audio` | `multimodal` (CHECKed in mig 0059). */
  readonly type: string;
  readonly inputModalities?: string[] | null | undefined;
  readonly outputModalities?: string[] | null | undefined;
  readonly mediaOptions?: unknown;
  readonly keyParams?: string[] | null | undefined;
  readonly sources?: string[] | null | undefined;
  readonly status?: string | null | undefined;
  readonly contextWindow?: string | null | undefined;
  readonly maxOutput?: string | null | undefined;
  readonly intro?: string | null | undefined;
  /** `firstparty` | `secondary` | `reconstructed` (CHECKed); defaults `secondary`. */
  readonly confidence?: string | undefined;
  /** Billing gate; defaults `false` (catalog-only). */
  readonly billingEligible?: boolean | undefined;
  readonly asOf?: string | null | undefined;
  readonly sourceUrl?: string | null | undefined;
  readonly notes?: string | null | undefined;
}

/**
 * Insert-or-update a `model_spec` row keyed on the LIVE `(vendor, model_id)`.
 *
 * `model_spec_vendor_model_idx` is a PARTIAL unique index
 * (`(vendor, model_id) WHERE deleted_at IS NULL`), so the ON CONFLICT arbiter
 * MUST carry `targetWhere: deleted_at IS NULL` — omitting it makes Postgres
 * unable to infer the index (42P10), a known seed-breaker. On conflict every
 * descriptive field is refreshed and `updated_at` is bumped; re-running the
 * importer is therefore idempotent (UPDATE, never a duplicate).
 */
export async function upsertModelSpec(
  db: DbOrTx,
  input: UpsertModelSpecInput,
): Promise<ModelSpecRow> {
  // The full descriptive payload, shared by the INSERT values and the UPDATE set
  // so a re-import overwrites stale facets with the latest catalog snapshot.
  const fields = {
    displayName: input.displayName ?? null,
    family: input.family ?? null,
    type: input.type,
    inputModalities: input.inputModalities ?? null,
    outputModalities: input.outputModalities ?? null,
    mediaOptions: input.mediaOptions ?? null,
    keyParams: input.keyParams ?? null,
    sources: input.sources ?? null,
    status: input.status ?? null,
    contextWindow: input.contextWindow ?? null,
    maxOutput: input.maxOutput ?? null,
    intro: input.intro ?? null,
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.billingEligible !== undefined ? { billingEligible: input.billingEligible } : {}),
    asOf: input.asOf ?? null,
    sourceUrl: input.sourceUrl ?? null,
    notes: input.notes ?? null,
  };

  const rows = await db
    .insert(modelSpec)
    .values({ vendor: input.vendor, modelId: input.modelId, ...fields })
    .onConflictDoUpdate({
      target: [modelSpec.vendor, modelSpec.modelId],
      // Partial-unique arbiter predicate — see the doc comment (42P10 otherwise).
      targetWhere: isNull(modelSpec.deletedAt),
      set: { ...fields, updatedAt: new Date() },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('upsertModelSpec: upsert returned no row');
  return row;
}

/** Optional filters for {@link listModelSpecs}. */
export interface ListModelSpecsFilter {
  readonly vendor?: string | undefined;
  readonly type?: string | undefined;
}

/**
 * List live model specs (excludes soft-deleted), keyset-paginated newest-first
 * on `(created_at, id)`. The optional `vendor` / `type` filters compose with the
 * keyset IN SQL.
 */
export function listModelSpecs(
  db: DbOrTx,
  filter: ListModelSpecsFilter,
  page: PageParams,
): Promise<KeysetResult<ModelSpecRow>> {
  const vendorFilter =
    filter.vendor !== undefined ? eq(modelSpec.vendor, filter.vendor) : undefined;
  const typeFilter = filter.type !== undefined ? eq(modelSpec.type, filter.type) : undefined;
  return keysetPage<ModelSpecRow>(db, {
    table: modelSpec,
    createdAtCol: modelSpec.createdAt,
    idCol: modelSpec.id,
    where: and(isNull(modelSpec.deletedAt), vendorFilter, typeFilter),
    page,
  });
}

/** Fetch a live model spec by its `(vendor, model_id)`; soft-deleted / unknown → `undefined`. */
export async function getModelSpec(
  db: DbOrTx,
  vendor: string,
  modelId: string,
): Promise<ModelSpecRow | undefined> {
  const rows = await db
    .select()
    .from(modelSpec)
    .where(
      and(
        eq(modelSpec.vendor, vendor),
        eq(modelSpec.modelId, modelId),
        isNull(modelSpec.deletedAt),
      ),
    )
    .limit(1);
  return rows[0];
}
