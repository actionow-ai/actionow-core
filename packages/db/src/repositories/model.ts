import type { InferSelectModel } from 'drizzle-orm';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';

import { model, modelGrant } from '../schema/index.js';
import { matchOfficialPrice } from './official-price.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
import type { DbOrTx } from './types.js';

export type ModelRow = InferSelectModel<typeof model>;

/** Fields a caller supplies to {@link createModel}. */
export interface CreateModelInput {
  readonly name: string;
  readonly resourceId: string;
  readonly display?: string | null | undefined;
  readonly modality?: string | undefined;
  /** Feature flags (tools/vision/audio/json/stream) read by Track A. */
  readonly capabilities?: Record<string, boolean> | undefined;
  /** `public` | `tenant`. Defaults to `public` (db default). */
  readonly visibility?: string | undefined;
  /** µUSD per 1M input tokens integer (resale price; `$X/1M → X×1e6`). Defaults to 0. */
  readonly inputPrice?: bigint | undefined;
  /** µUSD per 1M output tokens integer. Defaults to 0. */
  readonly outputPrice?: bigint | undefined;
  /** Per-model rate limit (requests/min); null/omitted → no model-specific cap. */
  readonly rateLimit?: number | null | undefined;
  /** Ordered model-degradation chain (模型降级链); null/omitted → no fallback. */
  readonly fallbackModels?: string[] | null | undefined;
  readonly status?: string | undefined;
}

/** Insert a `model` row and return it. */
export async function createModel(db: DbOrTx, input: CreateModelInput): Promise<ModelRow> {
  const rows = await db
    .insert(model)
    .values({
      name: input.name,
      resourceId: input.resourceId,
      ...(input.display !== undefined ? { display: input.display } : {}),
      ...(input.modality !== undefined ? { modality: input.modality } : {}),
      ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.inputPrice !== undefined ? { inputPrice: input.inputPrice } : {}),
      ...(input.outputPrice !== undefined ? { outputPrice: input.outputPrice } : {}),
      ...(input.rateLimit !== undefined ? { rateLimit: input.rateLimit } : {}),
      ...(input.fallbackModels !== undefined ? { fallbackModels: input.fallbackModels } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('createModel: insert returned no row');
  return row;
}

/** One upstream model in a {@link upsertModelsFromSync} batch (from an adapter's `listModels`). */
export interface SyncModelInput {
  /** The upstream slug — the public model `name` the relay routes on (the unique key). */
  readonly name: string;
  /** Optional human display name (refreshed on an existing model). */
  readonly display?: string | undefined;
  /** Optional feature-flag map (refreshed on an existing model). */
  readonly capabilities?: Record<string, boolean> | undefined;
}

/** Inputs for {@link upsertModelsFromSync}. */
export interface UpsertModelsFromSyncInput {
  /** The chat resource every synced model points at (the codex resource). */
  readonly resourceId: string;
  /**
   * The official-catalog provider key the discovered slugs are matched against
   * (`openai` | `anthropic` | `google` | …; mapped from the channel's
   * `providerType` by the caller). Drives {@link matchOfficialPrice}.
   */
  readonly provider: string;
  readonly models: readonly SyncModelInput[];
  /**
   * OPTIONAL explicit fallback for an UNMATCHED slug (µUSD per 1M input tokens).
   * When supplied (with {@link defaultOutputPrice}), an unmatched model is created
   * `active` with this price instead of `needs_pricing`+disabled. Default
   * (omitted) = `needs_pricing` (never bill 0).
   */
  readonly defaultInputPrice?: bigint | undefined;
  /** OPTIONAL explicit fallback for an unmatched slug (µUSD per 1M output tokens). */
  readonly defaultOutputPrice?: bigint | undefined;
}

/** How {@link upsertModelsFromSync} priced one synced model. */
export type SyncPricedKind =
  /** Matched the official catalog → priced from it, active. */
  | 'official'
  /** Unmatched but the request supplied explicit default prices → active. */
  | 'default'
  /** Unmatched, no default → created `disabled` + `needs_pricing` (never bill 0). */
  | 'needs_pricing'
  /** Already existed → price/status preserved (only discovery fields refreshed). */
  | 'existing';

/** Per-model outcome of a sync batch. */
export interface SyncModelSummary {
  readonly name: string;
  readonly priced: SyncPricedKind;
}

/** Names partitioned by what {@link upsertModelsFromSync} did to each, plus a per-model summary. */
export interface UpsertModelsFromSyncResult {
  /** Names that did not exist and were inserted. */
  readonly created: string[];
  /** Names that already existed and were refreshed (display/capabilities/resource). */
  readonly updated: string[];
  /** One {@link SyncModelSummary} per model in the batch (matched/default/needs_pricing/existing). */
  readonly summary: SyncModelSummary[];
}

/**
 * Sync a provider's catalog into `model` rows (one row per upstream slug, all
 * pointing at `resourceId`), AUTO-PRICING from the official catalog (Track 2;
 * spec D7). Matched by the unique `name`:
 * - EXISTING name → UPDATE `display`/`capabilities`/`resourceId` ONLY. The price
 *   (`input_price`/`output_price`), `status`, `needs_pricing`, and `visibility`
 *   are PRESERVED — sync never downgrades an operator-priced model (`existing`).
 * - NEW name, MATCHED against `official_model_price` (`(provider, normalize(slug))`)
 *   → INSERT `active` with the official µUSD/1M prices, `needs_pricing=false`
 *   (`official`).
 * - NEW name, UNMATCHED, request supplied `default{Input,Output}Price` → INSERT
 *   `active` with those prices, `needs_pricing=false` (`default` — an explicit
 *   operator override).
 * - NEW name, UNMATCHED, NO defaults → INSERT `disabled` with `needs_pricing=true`
 *   and prices 0 (`needs_pricing`). NEVER active-with-0 — such a model stays out
 *   of routing until an admin prices it.
 *
 * Returns the created/updated names + a per-model {@link SyncModelSummary}. Money
 * is bigint µUSD/1M throughout.
 */
export async function upsertModelsFromSync(
  db: DbOrTx,
  input: UpsertModelsFromSyncInput,
): Promise<UpsertModelsFromSyncResult> {
  const created: string[] = [];
  const updated: string[] = [];
  const summary: SyncModelSummary[] = [];
  // Capture into locals so TS narrows `undefined` away inside the loop branch
  // (an explicit operator override applies the SAME default price to every
  // unmatched slug in the batch).
  const defInput = input.defaultInputPrice;
  const defOutput = input.defaultOutputPrice;
  for (const m of input.models) {
    // deletedAt-agnostic probe: a soft-deleted model still occupies the unique name,
    // so re-syncing it must UPDATE (not INSERT a duplicate-name row).
    const existingRows = await db
      .select({ id: model.id })
      .from(model)
      .where(eq(model.name, m.name))
      .limit(1);
    const existing = existingRows[0];
    if (existing !== undefined) {
      // Refresh discovery fields only; price/status/needs_pricing/visibility preserved.
      await db
        .update(model)
        .set({
          resourceId: input.resourceId,
          ...(m.display !== undefined ? { display: m.display } : {}),
          ...(m.capabilities !== undefined ? { capabilities: m.capabilities } : {}),
        })
        .where(eq(model.id, existing.id));
      updated.push(m.name);
      summary.push({ name: m.name, priced: 'existing' });
      continue;
    }

    // NEW model: try the official catalog (auto-price), else default/needs_pricing.
    const official = await matchOfficialPrice(db, input.provider, m.name);
    let inputPrice: bigint;
    let outputPrice: bigint;
    let status: string;
    let needsPricing: boolean;
    let priced: SyncPricedKind;
    if (official !== undefined) {
      inputPrice = official.inputPricePer1m;
      outputPrice = official.outputPricePer1m;
      status = 'active';
      needsPricing = false;
      priced = 'official';
    } else if (defInput !== undefined && defOutput !== undefined) {
      // An explicit operator override: create the unmatched model active at the
      // supplied default prices (rather than needs_pricing).
      inputPrice = defInput;
      outputPrice = defOutput;
      status = 'active';
      needsPricing = false;
      priced = 'default';
    } else {
      // NEVER bill 0: created disabled + needs_pricing until an admin prices it.
      inputPrice = 0n;
      outputPrice = 0n;
      status = 'disabled';
      needsPricing = true;
      priced = 'needs_pricing';
    }
    await db.insert(model).values({
      name: m.name,
      resourceId: input.resourceId,
      ...(m.display !== undefined ? { display: m.display } : {}),
      ...(m.capabilities !== undefined ? { capabilities: m.capabilities } : {}),
      visibility: 'public',
      status,
      needsPricing,
      inputPrice,
      outputPrice,
    });
    created.push(m.name);
    summary.push({ name: m.name, priced });
  }
  return { created, updated, summary };
}

/** The shape Track A's relay needs to route + price a resolved model. */
export interface ResolvedModel {
  readonly modelId: string;
  readonly resourceId: string;
  readonly inputPrice: bigint;
  readonly outputPrice: bigint;
  readonly capabilities: Record<string, boolean>;
}

/**
 * Resolve a model `name` for `tenantId` (§C.1 visibility gate). Returns the
 * routing + pricing handle when the model is `active` AND either `public` or
 * `tenant`-visible WITH a `model_grant` for this tenant; otherwise `undefined`
 * (an ungranted tenant model is indistinguishable from a missing one). The
 * tenant predicate is in the SQL `WHERE`, never a read-then-check.
 */
export async function resolveModelForTenant(
  db: DbOrTx,
  modelName: string,
  tenantId: string,
): Promise<ResolvedModel | undefined> {
  const rows = await db
    .select({
      id: model.id,
      resourceId: model.resourceId,
      inputPrice: model.inputPrice,
      outputPrice: model.outputPrice,
      capabilities: model.capabilities,
      visibility: model.visibility,
      grantTenant: modelGrant.tenantId,
    })
    .from(model)
    .leftJoin(modelGrant, and(eq(modelGrant.modelId, model.id), eq(modelGrant.tenantId, tenantId)))
    .where(and(eq(model.name, modelName), eq(model.status, 'active'), isNull(model.deletedAt)))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return undefined;
  if (row.visibility !== 'public' && row.grantTenant === null) return undefined;

  return {
    modelId: row.id,
    resourceId: row.resourceId,
    inputPrice: row.inputPrice,
    outputPrice: row.outputPrice,
    capabilities: row.capabilities,
  };
}

/** A model as seen by a tenant (console `GET /console/models` / discovery). */
export interface ModelView {
  readonly id: string;
  readonly name: string;
  readonly display: string | null;
  readonly modality: string;
  readonly capabilities: Record<string, boolean>;
  readonly visibility: string;
  readonly inputPrice: bigint;
  readonly outputPrice: bigint;
}

/**
 * List the models visible to `tenantId` (§C.1): every `active` `public` model,
 * plus every `active` `tenant` model this tenant has a `model_grant` for. The
 * visibility predicate is in the SQL `WHERE` (public OR id ∈ granted ids), never
 * a fetch-all-then-filter. Consumed by Track B's `GET /console/models`.
 */
export async function listVisibleModels(db: DbOrTx, tenantId: string): Promise<ModelView[]> {
  const granted = await db
    .select({ modelId: modelGrant.modelId })
    .from(modelGrant)
    .where(eq(modelGrant.tenantId, tenantId));
  const grantedIds = granted.map((g) => g.modelId);

  const visibility =
    grantedIds.length === 0
      ? eq(model.visibility, 'public')
      : or(eq(model.visibility, 'public'), inArray(model.id, grantedIds));

  const rows = await db
    .select({
      id: model.id,
      name: model.name,
      display: model.display,
      modality: model.modality,
      capabilities: model.capabilities,
      visibility: model.visibility,
      inputPrice: model.inputPrice,
      outputPrice: model.outputPrice,
    })
    .from(model)
    .where(and(eq(model.status, 'active'), visibility, isNull(model.deletedAt)))
    .orderBy(desc(model.createdAt));

  return rows;
}

/**
 * List EVERY live model (admin catalog view, incl. disabled; excludes
 * soft-deleted), keyset-paginated newest-first on `(created_at, id)`.
 */
export async function listModels(db: DbOrTx, page: PageParams): Promise<KeysetResult<ModelRow>> {
  return keysetPage<ModelRow>(db, {
    table: model,
    createdAtCol: model.createdAt,
    idCol: model.id,
    where: isNull(model.deletedAt),
    page,
  });
}

/** Fetch a live model by `name` (soft-deleted → `undefined`; admin lookups by the unique name). */
export async function getModelByName(db: DbOrTx, name: string): Promise<ModelRow | undefined> {
  const rows = await db
    .select()
    .from(model)
    .where(and(eq(model.name, name), isNull(model.deletedAt)))
    .limit(1);
  return rows[0];
}

/**
 * The per-model rate limit (requests/min) for a LIVE, ACTIVE model by name, or
 * `null` when the model has no cap / is absent / disabled. A focused projection
 * (not the whole row) for the relay's RateLimitGuard hot path.
 */
export async function getModelRateLimit(db: DbOrTx, name: string): Promise<number | null> {
  const rows = await db
    .select({ rateLimit: model.rateLimit })
    .from(model)
    .where(and(eq(model.name, name), isNull(model.deletedAt), eq(model.status, 'active')))
    .limit(1);
  return rows[0]?.rateLimit ?? null;
}

/**
 * The ordered model-degradation chain (模型降级链) for a LIVE, ACTIVE model by
 * name, or `[]` when none / absent / disabled. A focused projection for the
 * relay's blocking-chat fallback loop.
 */
export async function getModelFallbacks(db: DbOrTx, name: string): Promise<string[]> {
  const rows = await db
    .select({ fallbackModels: model.fallbackModels })
    .from(model)
    .where(and(eq(model.name, name), isNull(model.deletedAt), eq(model.status, 'active')))
    .limit(1);
  return rows[0]?.fallbackModels ?? [];
}

/** Mutable fields of a {@link model} (admin PATCH); omitted keys are unchanged. */
export interface UpdateModelInput {
  readonly display?: string | null | undefined;
  readonly capabilities?: Record<string, boolean> | undefined;
  /** µUSD per 1M input tokens integer (resale price). */
  readonly inputPrice?: bigint | undefined;
  /** µUSD per 1M output tokens integer. */
  readonly outputPrice?: bigint | undefined;
  /** `public` | `tenant`. */
  readonly visibility?: string | undefined;
  /** Per-model rate limit (requests/min); `null` clears it. */
  readonly rateLimit?: number | null | undefined;
  /** Ordered model-degradation chain; `null` clears it. */
  readonly fallbackModels?: string[] | null | undefined;
  /** `active` | `disabled`. */
  readonly status?: string | undefined;
}

/**
 * Patch a live `model` (looked up by the unique `name`), returning the new row.
 * Only the supplied fields change; the µcredit prices stay integers (`bigint`).
 * The `model` table has NO `updated_at` column (it carries only `created_at` +
 * `deleted_at`), so nothing is stamped. Soft-deleted / unknown → `undefined`. An
 * empty patch is a read-back of the current live row.
 */
export async function updateModel(
  db: DbOrTx,
  name: string,
  patch: UpdateModelInput,
): Promise<ModelRow | undefined> {
  const set: Partial<InferSelectModel<typeof model>> = {};
  if (patch.display !== undefined) set.display = patch.display;
  if (patch.capabilities !== undefined) set.capabilities = patch.capabilities;
  if (patch.inputPrice !== undefined) set.inputPrice = patch.inputPrice;
  if (patch.outputPrice !== undefined) set.outputPrice = patch.outputPrice;
  if (patch.visibility !== undefined) set.visibility = patch.visibility;
  if (patch.rateLimit !== undefined) set.rateLimit = patch.rateLimit;
  if (patch.fallbackModels !== undefined) set.fallbackModels = patch.fallbackModels;
  if (patch.status !== undefined) set.status = patch.status;
  if (Object.keys(set).length === 0) {
    return getModelByName(db, name);
  }
  const rows = await db
    .update(model)
    .set(set)
    .where(and(eq(model.name, name), isNull(model.deletedAt)))
    .returning();
  return rows[0];
}

/**
 * Revoke a model by SOFT-DELETING it (looked up by the unique `name`): stamps
 * `deleted_at` (`now()`) only when the row is still live — the `model` table has
 * no `updated_at`, so only `deleted_at` is set. `getModelByName` /
 * `listModels` / `resolveModelForTenant` all filter `deleted_at IS NULL`, so the
 * model drops out of routing + every listing. Returns the deleted name, or
 * `undefined` when nothing matched (not found / already deleted) — idempotent.
 */
export async function softDeleteModel(db: DbOrTx, name: string): Promise<string | undefined> {
  const rows = await db
    .update(model)
    .set({ deletedAt: new Date() })
    .where(and(eq(model.name, name), isNull(model.deletedAt)))
    .returning({ name: model.name });
  return rows[0]?.name;
}

/** One tenant grant of a {@link model} (admin grant-listing view). */
export interface ModelGrantRow {
  readonly id: string;
  readonly modelId: string;
  readonly tenantId: string;
  readonly createdAt: Date;
}

/** Columns selected for a {@link ModelGrantRow}. */
const MODEL_GRANT_COLUMNS = {
  id: modelGrant.id,
  modelId: modelGrant.modelId,
  tenantId: modelGrant.tenantId,
  createdAt: modelGrant.createdAt,
} as const;

/**
 * List the tenant grants of a model (looked up by the unique `name`),
 * keyset-paginated newest-first on `(created_at, id)`. Returns an empty page when
 * the model is unknown / soft-deleted (the grant `model_id` filter resolves to a
 * non-matching id). `model_grant` has NO `deleted_at` — grants are hard-deleted.
 */
export async function listModelGrants(
  db: DbOrTx,
  modelName: string,
  page: PageParams,
): Promise<KeysetResult<ModelGrantRow>> {
  const m = await getModelByName(db, modelName);
  // An absent model yields an impossible filter so the keyset returns an empty
  // page (rather than every grant) — the controller maps that to a 404 separately.
  const modelIdFilter = m === undefined ? '00000000-0000-0000-0000-000000000000' : m.id;
  return keysetPage<ModelGrantRow>(db, {
    table: modelGrant,
    createdAtCol: modelGrant.createdAt,
    idCol: modelGrant.id,
    selection: MODEL_GRANT_COLUMNS,
    where: eq(modelGrant.modelId, modelIdFilter),
    page,
  });
}

/**
 * Revoke a tenant's grant of a model: HARD-deletes the `model_grant` row for
 * `(model.name, tenantId)`. `model_grant` has no `deleted_at`, so this is a true
 * DELETE (an ungranted tenant is indistinguishable from one whose grant never
 * existed — `resolveModelForTenant` left-joins on the live grant). Returns the
 * deleted grant id, or `undefined` when nothing matched (model unknown / no such
 * grant) — idempotent revoke, never a throw.
 */
export async function deleteModelGrant(
  db: DbOrTx,
  modelName: string,
  tenantId: string,
): Promise<string | undefined> {
  const m = await getModelByName(db, modelName);
  if (m === undefined) return undefined;
  const rows = await db
    .delete(modelGrant)
    .where(and(eq(modelGrant.modelId, m.id), eq(modelGrant.tenantId, tenantId)))
    .returning({ id: modelGrant.id });
  return rows[0]?.id;
}

/**
 * Grant a `tenant`-visibility model (looked up by `name`) to `tenantId`.
 * Idempotent on `(model_id, tenant_id)` (a duplicate grant is a no-op). Throws
 * when the model name is unknown.
 */
export async function grantModel(db: DbOrTx, modelName: string, tenantId: string): Promise<void> {
  const m = await getModelByName(db, modelName);
  if (m === undefined) throw new Error(`grantModel: model ${modelName} not found`);
  await db
    .insert(modelGrant)
    .values({ modelId: m.id, tenantId })
    .onConflictDoNothing({ target: [modelGrant.modelId, modelGrant.tenantId] });
}
