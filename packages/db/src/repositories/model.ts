import type { ModelParamProfile, ParameterRule, ParamOverride } from '@actionow/contracts';
import type { InferSelectModel } from 'drizzle-orm';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { channelModel, model, modelGrant } from '../schema/index.js';
import { getModelSpec } from './model-spec.js';
import { matchOfficialPrice } from './official-price.js';
import { keysetPage, type KeysetResult, type PageParams } from './pagination.js';
import type { DbOrTx } from './types.js';

/**
 * Build the frozen `param_profile` snapshot from a matched `model_spec` (D1),
 * mirroring how `input_price` is frozen from `official_model_price` at sync.
 * Returns null when the spec is absent or contributes no features/rules, so the
 * model bills/gates exactly as today (empty profile == passthrough).
 */
export function freezeParamProfile(
  spec: { features: string[] | null; parameterRules: ParameterRule[] | null } | undefined,
): ModelParamProfile | null {
  if (spec === undefined) return null;
  const features = spec.features ?? [];
  const parameterRules = spec.parameterRules ?? [];
  if (features.length === 0 && parameterRules.length === 0) return null;
  return { features, parameterRules, dropPolicy: 'passthrough' };
}

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
  /** Optional µUSD per 1M cached-input tokens (用拆分计费); null/omitted → no cached rate. */
  readonly cachedInputPrice?: bigint | null | undefined;
  /** Per-model rate limit (requests/min); null/omitted → no model-specific cap. */
  readonly rateLimit?: number | null | undefined;
  /** Ordered model-degradation chain (模型降级链); null/omitted → no fallback. */
  readonly fallbackModels?: string[] | null | undefined;
  /** Free-form catalog tags (推荐/便宜/长上下文…); omitted → `[]`. */
  readonly tags?: string[] | undefined;
  /** Developer/maker (anthropic/alibaba/z-ai…); omitted/null → unset. */
  readonly maker?: string | null | undefined;
  /** Max context window (tokens); omitted/null → unset. */
  readonly contextLength?: number | null | undefined;
  /** Reasoning mode: none | optional | always; omitted/null → unset. */
  readonly reasoning?: string | null | undefined;
  /** Frozen model-level param profile (D1); omitted → unset (null → empty/passthrough). */
  readonly paramProfile?: ModelParamProfile | null | undefined;
  /** Selectable icon key (icon_asset.key); omitted/null → unset. */
  readonly icon?: string | null | undefined;
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
      ...(input.cachedInputPrice !== undefined ? { cachedInputPrice: input.cachedInputPrice } : {}),
      ...(input.rateLimit !== undefined ? { rateLimit: input.rateLimit } : {}),
      ...(input.fallbackModels !== undefined ? { fallbackModels: input.fallbackModels } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.maker !== undefined ? { maker: input.maker } : {}),
      ...(input.contextLength !== undefined ? { contextLength: input.contextLength } : {}),
      ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
      ...(input.paramProfile !== undefined ? { paramProfile: input.paramProfile } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
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
    // 用拆分计费: carry the matched official cached-input rate (µUSD/1M) onto the
    // model so `priceModelToken` bills prompt-cached input cheaper. Null when the
    // official row has no cached price OR the model is priced from a default /
    // needs_pricing (no cached basis to inherit).
    let cachedInputPrice: bigint | null = null;
    let status: string;
    let needsPricing: boolean;
    let priced: SyncPricedKind;
    if (official !== undefined) {
      inputPrice = official.inputPricePer1m;
      outputPrice = official.outputPricePer1m;
      cachedInputPrice = official.cachedInputPricePer1m ?? null;
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
    // Freeze the param profile from the matched 规格库 spec (D1), the same way
    // input_price freezes from official_model_price above. The `model_spec` vendor
    // namespace == the provider key used for pricing; absent/empty spec → null
    // (passthrough == today's behavior). Only on the NEW-model insert branch —
    // the existing-model UPDATE preserves an operator-tuned profile (below).
    const spec = await getModelSpec(db, input.provider, m.name);
    const paramProfile = freezeParamProfile(spec);
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
      cachedInputPrice,
      ...(paramProfile !== null ? { paramProfile } : {}),
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
  /** Optional µUSD per 1M cached-input tokens (用拆分计费); null → no cached rate. */
  readonly cachedInputPrice: bigint | null;
  readonly capabilities: Record<string, boolean>;
  /** Frozen model-level param profile (features/parameterRules/dropPolicy, mig 0064); null → passthrough (today's behavior). */
  readonly paramProfile: ModelParamProfile | null;
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
      cachedInputPrice: model.cachedInputPrice,
      capabilities: model.capabilities,
      paramProfile: model.paramProfile,
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
    cachedInputPrice: row.cachedInputPrice,
    capabilities: row.capabilities,
    // Frozen shape trusted, but null-coalesced so a never-set column → passthrough.
    paramProfile: row.paramProfile ?? null,
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
  readonly tags: string[];
  readonly maker: string | null;
  readonly contextLength: number | null;
  readonly reasoning: string | null;
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
      tags: model.tags,
      maker: model.maker,
      contextLength: model.contextLength,
      reasoning: model.reasoning,
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

/** Fetch a live model by `id` (soft-deleted → `undefined`); used to validate a link request. */
export async function getModelById(db: DbOrTx, id: string): Promise<ModelRow | undefined> {
  const rows = await db
    .select()
    .from(model)
    .where(and(eq(model.id, id), isNull(model.deletedAt)))
    .limit(1);
  return rows[0];
}

// --- channel↔model links (catalog supply-hierarchy) -----------------------

/** Link a channel to a model (idempotent on the composite PK). */
export async function linkChannelModel(
  db: DbOrTx,
  channelId: string,
  modelId: string,
): Promise<void> {
  await db.insert(channelModel).values({ channelId, modelId }).onConflictDoNothing();
}

/** Remove one channel↔model link (idempotent). */
export async function unlinkChannelModel(
  db: DbOrTx,
  channelId: string,
  modelId: string,
): Promise<void> {
  await db
    .delete(channelModel)
    .where(and(eq(channelModel.channelId, channelId), eq(channelModel.modelId, modelId)));
}

/** Remove ALL links for a channel (called when a channel is deleted). */
export async function unlinkAllForChannel(db: DbOrTx, channelId: string): Promise<void> {
  await db.delete(channelModel).where(eq(channelModel.channelId, channelId));
}

/**
 * Set (or clear with `null`) the per-(channel,model) param override (mig 0062).
 * Idempotent; UPSERTS the link if missing so an operator can attach an override
 * before a model is explicitly linked. The `channel_model` PK is
 * `(channelId, modelId)` (no soft-delete), so the composite PK is the conflict
 * target — no partial-unique `targetWhere` needed.
 */
export async function setChannelModelOverride(
  db: DbOrTx,
  channelId: string,
  modelId: string,
  override: ParamOverride | null,
): Promise<void> {
  await db
    .insert(channelModel)
    .values({ channelId, modelId, paramOverride: override })
    .onConflictDoUpdate({
      target: [channelModel.channelId, channelModel.modelId],
      set: { paramOverride: override },
    });
}

/** The param override for one (channel, model), or `null` when unset / unlinked. */
export async function getChannelModelOverride(
  db: DbOrTx,
  channelId: string,
  modelId: string,
): Promise<ParamOverride | null> {
  const rows = await db
    .select({ paramOverride: channelModel.paramOverride })
    .from(channelModel)
    .where(and(eq(channelModel.channelId, channelId), eq(channelModel.modelId, modelId)))
    .limit(1);
  return rows[0]?.paramOverride ?? null;
}

/**
 * Batch-load channelId → param_override for one model across a candidate channel
 * set (stage ② data source in `candidatesFor`). Only rows WITH an override are
 * returned, so an empty map == every candidate is byte-for-byte today. One query,
 * no N+1.
 */
export async function getChannelModelOverrides(
  db: DbOrTx,
  modelId: string,
  channelIds: string[],
): Promise<Map<string, ParamOverride>> {
  if (channelIds.length === 0) return new Map();
  const rows = await db
    .select({ channelId: channelModel.channelId, paramOverride: channelModel.paramOverride })
    .from(channelModel)
    .where(
      and(
        eq(channelModel.modelId, modelId),
        inArray(channelModel.channelId, channelIds),
        sql`${channelModel.paramOverride} IS NOT NULL`,
      ),
    );
  const out = new Map<string, ParamOverride>();
  for (const r of rows) {
    if (r.paramOverride !== null) out.set(r.channelId, r.paramOverride);
  }
  return out;
}

/** A model served by a channel, carrying that link's per-(model×channel) override (mig 0062). */
export type ChannelModelRow = ModelRow & { readonly paramOverride: ParamOverride | null };

/** The LIVE models a channel serves (right-panel grid), newest link first. */
export async function listChannelModels(db: DbOrTx, channelId: string): Promise<ChannelModelRow[]> {
  return db
    .select({
      id: model.id,
      name: model.name,
      display: model.display,
      modality: model.modality,
      capabilities: model.capabilities,
      visibility: model.visibility,
      resourceId: model.resourceId,
      inputPrice: model.inputPrice,
      outputPrice: model.outputPrice,
      cachedInputPrice: model.cachedInputPrice,
      needsPricing: model.needsPricing,
      rateLimit: model.rateLimit,
      fallbackModels: model.fallbackModels,
      tags: model.tags,
      maker: model.maker,
      contextLength: model.contextLength,
      reasoning: model.reasoning,
      paramProfile: model.paramProfile,
      icon: model.icon,
      status: model.status,
      createdAt: model.createdAt,
      deletedAt: model.deletedAt,
      paramOverride: channelModel.paramOverride,
    })
    .from(model)
    .innerJoin(channelModel, eq(channelModel.modelId, model.id))
    .where(and(eq(channelModel.channelId, channelId), isNull(model.deletedAt)))
    .orderBy(desc(channelModel.createdAt));
}

/** The channel ids that serve a model (inverse — routing + the popup's 服务通道). */
export async function listModelChannels(db: DbOrTx, modelId: string): Promise<string[]> {
  const rows = await db
    .select({ channelId: channelModel.channelId })
    .from(channelModel)
    .where(eq(channelModel.modelId, modelId));
  return rows.map((r) => r.channelId);
}

/** Per-channel link counts for a set of channels (batch — `model_count` in channel views). */
export async function countModelsByChannelIds(
  db: DbOrTx,
  channelIds: string[],
): Promise<Map<string, number>> {
  if (channelIds.length === 0) return new Map();
  const rows = await db
    .select({ channelId: channelModel.channelId, n: sql<number>`count(*)::int` })
    .from(channelModel)
    .innerJoin(model, and(eq(model.id, channelModel.modelId), isNull(model.deletedAt)))
    .where(inArray(channelModel.channelId, channelIds))
    .groupBy(channelModel.channelId);
  return new Map(rows.map((r) => [r.channelId, r.n]));
}

/** Served-channel ids for a set of models (batch — `served_channel_ids` in model views). */
export async function channelIdsByModelIds(
  db: DbOrTx,
  modelIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (modelIds.length === 0) return out;
  const rows = await db
    .select({ modelId: channelModel.modelId, channelId: channelModel.channelId })
    .from(channelModel)
    .where(inArray(channelModel.modelId, modelIds));
  for (const r of rows) {
    const list = out.get(r.modelId) ?? [];
    list.push(r.channelId);
    out.set(r.modelId, list);
  }
  return out;
}

/** Link a channel to every LIVE model named in `names` (batch — used by sync). */
export async function linkChannelModelsByNames(
  db: DbOrTx,
  channelId: string,
  names: string[],
): Promise<void> {
  if (names.length === 0) return;
  const ids = await db
    .select({ id: model.id })
    .from(model)
    .where(and(inArray(model.name, names), isNull(model.deletedAt)));
  if (ids.length === 0) return;
  await db
    .insert(channelModel)
    .values(ids.map((r) => ({ channelId, modelId: r.id })))
    .onConflictDoNothing();
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
  /** µUSD per 1M cached-input tokens (用拆分计费); `null` clears the cached rate. */
  readonly cachedInputPrice?: bigint | null | undefined;
  /** `public` | `tenant`. */
  readonly visibility?: string | undefined;
  /** Per-model rate limit (requests/min); `null` clears it. */
  readonly rateLimit?: number | null | undefined;
  /** Ordered model-degradation chain; `null` clears it. */
  readonly fallbackModels?: string[] | null | undefined;
  /** Free-form catalog tags; replaces the set. */
  readonly tags?: string[] | undefined;
  /** Developer/maker; `null` clears it. */
  readonly maker?: string | null | undefined;
  /** Max context window (tokens); `null` clears it. */
  readonly contextLength?: number | null | undefined;
  /** Reasoning mode; `null` clears it. */
  readonly reasoning?: string | null | undefined;
  /** Replace the frozen model-level param profile (D1); `null` clears it to empty/passthrough. */
  readonly paramProfile?: ModelParamProfile | null | undefined;
  /** Selectable icon key (icon_asset.key); `null` clears it. */
  readonly icon?: string | null | undefined;
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
  if (patch.cachedInputPrice !== undefined) set.cachedInputPrice = patch.cachedInputPrice;
  if (patch.visibility !== undefined) set.visibility = patch.visibility;
  if (patch.rateLimit !== undefined) set.rateLimit = patch.rateLimit;
  if (patch.fallbackModels !== undefined) set.fallbackModels = patch.fallbackModels;
  if (patch.tags !== undefined) set.tags = patch.tags;
  if (patch.maker !== undefined) set.maker = patch.maker;
  if (patch.contextLength !== undefined) set.contextLength = patch.contextLength;
  if (patch.reasoning !== undefined) set.reasoning = patch.reasoning;
  if (patch.paramProfile !== undefined) set.paramProfile = patch.paramProfile;
  if (patch.icon !== undefined) set.icon = patch.icon;
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
