import type { InferSelectModel } from 'drizzle-orm';
import { and, desc, eq, inArray, or } from 'drizzle-orm';

import { model, modelGrant } from '../schema/index.js';
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
  /** µcredit-per-input-token integer (resale price). Defaults to 0. */
  readonly inputPrice?: bigint | undefined;
  /** µcredit-per-output-token integer. Defaults to 0. */
  readonly outputPrice?: bigint | undefined;
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
  readonly models: readonly SyncModelInput[];
  /** µcredit-per-input-token applied ONLY to newly-inserted models. */
  readonly defaultInputPrice: bigint;
  /** µcredit-per-output-token applied ONLY to newly-inserted models. */
  readonly defaultOutputPrice: bigint;
}

/** Names partitioned by what {@link upsertModelsFromSync} did to each. */
export interface UpsertModelsFromSyncResult {
  /** Names that did not exist and were inserted with the default prices. */
  readonly created: string[];
  /** Names that already existed and were refreshed (display/capabilities/resource). */
  readonly updated: string[];
}

/**
 * Sync a provider's catalog into `model` rows (one row per upstream slug, all
 * pointing at `resourceId`). Matched by the unique `name`:
 * - EXISTING name → UPDATE `display`/`capabilities`/`resourceId` ONLY. The price
 *   (`input_price`/`output_price`), `status`, and `visibility` are PRESERVED —
 *   sync never overwrites an operator's resale price.
 * - NEW name → INSERT with `resourceId`, `display`, `capabilities`,
 *   `visibility='public'`, `status='active'`, and the batch's
 *   `defaultInputPrice`/`defaultOutputPrice`.
 *
 * Returns the created/updated names. Money is bigint µcredits throughout.
 */
export async function upsertModelsFromSync(
  db: DbOrTx,
  input: UpsertModelsFromSyncInput,
): Promise<UpsertModelsFromSyncResult> {
  const created: string[] = [];
  const updated: string[] = [];
  for (const m of input.models) {
    const existing = await getModelByName(db, m.name);
    if (existing !== undefined) {
      // Refresh discovery fields only; the price/status/visibility are preserved.
      await db
        .update(model)
        .set({
          resourceId: input.resourceId,
          ...(m.display !== undefined ? { display: m.display } : {}),
          ...(m.capabilities !== undefined ? { capabilities: m.capabilities } : {}),
        })
        .where(eq(model.id, existing.id));
      updated.push(m.name);
    } else {
      await db.insert(model).values({
        name: m.name,
        resourceId: input.resourceId,
        ...(m.display !== undefined ? { display: m.display } : {}),
        ...(m.capabilities !== undefined ? { capabilities: m.capabilities } : {}),
        visibility: 'public',
        status: 'active',
        inputPrice: input.defaultInputPrice,
        outputPrice: input.defaultOutputPrice,
      });
      created.push(m.name);
    }
  }
  return { created, updated };
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
    .where(and(eq(model.name, modelName), eq(model.status, 'active')))
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
    .where(and(eq(model.status, 'active'), visibility))
    .orderBy(desc(model.createdAt));

  return rows;
}

/** List EVERY model newest-first (admin catalog view, incl. disabled). */
export async function listModels(db: DbOrTx): Promise<ModelRow[]> {
  return db.select().from(model).orderBy(desc(model.createdAt));
}

/** Fetch a model by `name`, or `undefined` (admin lookups by the unique name). */
export async function getModelByName(db: DbOrTx, name: string): Promise<ModelRow | undefined> {
  const rows = await db.select().from(model).where(eq(model.name, name)).limit(1);
  return rows[0];
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
