import { z } from 'zod';

import {
  modelParamProfileSchema,
  parameterRuleSchema,
  paramOverrideSchema,
} from './param-profile.js';

/**
 * Single source of truth for the catalog/pricing control-plane **wire views**
 * (resources, channels, models, model grants, pricebook, modifiers). Same
 * contract-first pattern as `admin-views.ts`: the backend `toView` mappers
 * `.parse()` against these schemas; the frontend imports the inferred TYPE only
 * (`import type`), so no zod ships to the browser. Money is always a µ-unit
 * decimal **string** (bigint serialized), never a JS number.
 */

/** A catalog resource as served by `GET /admin/resources[/:id]`. */
export const resourceViewSchema = z.object({
  id: z.string(),
  /** Owning tenant id, or `null` for a GLOBAL platform resource (any tenant may run it). */
  tenant_id: z.string().nullable(),
  kind: z.string(),
  modality: z.string(),
  provider_type: z.string(),
  exec_modes: z.array(z.string()),
  status: z.string(),
  current_version: z.number(),
  created_at: z.string(),
});
export type ResourceView = z.infer<typeof resourceViewSchema>;

/** An upstream channel under a resource (`GET /admin/resources/:id/channels`). */
export const channelViewSchema = z.object({
  id: z.string(),
  resource_id: z.string(),
  provider_type: z.string(),
  credential_ref: z.string().nullable(),
  endpoint: z.string().nullable(),
  model: z.string().nullable(),
  proxy_ref: z.string().nullable(),
  config: z.record(z.unknown()).nullable(),
  weight: z.number(),
  status: z.string(),
  /** Operator cost µUSD/1M INPUT tokens (decimal string), null when unset. */
  input_cost_per_1m: z.string().nullable(),
  /** Operator cost µUSD/1M OUTPUT tokens (decimal string), null when unset. */
  output_cost_per_1m: z.string().nullable(),
  /** Bound fault-tolerance policy id (调用容错), null when unbound. */
  fault_policy_id: z.string().nullable(),
  /** Count of models this channel serves (channel_model links; catalog supply-hierarchy). */
  model_count: z.number(),
  /** Selectable icon key (icon_asset.key); null → derived from plugin/provider. */
  icon: z.string().nullable(),
  /** Owning provider-plugin id (模型接入 3-pane grouping); null → unassigned. */
  plugin_id: z.string().nullable(),
  /** Free-form routing tags (染色/标签路由) — drive the X-Actionow-Route-Tag hard-pin + faceting. */
  tags: z.array(z.string()),
});
export type ChannelView = z.infer<typeof channelViewSchema>;

/** One selectable icon (`GET /admin/icons`) for the plugin/channel/model picker. */
export const iconAssetViewSchema = z.object({
  key: z.string(),
  label: z.string(),
  category: z.string(),
  /** Inline custom SVG markup; null → frontend renders via its brand registry/monogram. */
  svg: z.string().nullable(),
});
export type IconAssetView = z.infer<typeof iconAssetViewSchema>;

/** `POST /admin/resources/:id/channels/:channelId/models` body: link an existing model. */
export const channelModelLinkInputSchema = z.object({
  model_id: z.string(),
  /** Optional per-(model×channel) param override to attach at link time (mig 0062). */
  param_override: paramOverrideSchema.optional(),
});
export type ChannelModelLinkInput = z.infer<typeof channelModelLinkInputSchema>;

/**
 * One `channel_model` link row (`GET .../channels/:channelId/models` per-link
 * override view). `param_override` is the per-(model×channel) override bag (mig
 * 0062); null → no override (== today's behavior).
 */
export const channelModelViewSchema = z.object({
  channel_id: z.string(),
  model_id: z.string(),
  param_override: paramOverrideSchema.nullable(),
});
export type ChannelModelView = z.infer<typeof channelModelViewSchema>;

/** A relay model as served by `GET /admin/models[/:name]`. Prices are µcredit strings. */
export const modelViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  display: z.string().nullable(),
  modality: z.string(),
  capabilities: z.record(z.boolean()),
  visibility: z.string(),
  resource_id: z.string(),
  input_price: z.string(),
  output_price: z.string(),
  /** µUSD per 1M cached-input tokens (用拆分计费); null when no cached rate. */
  cached_input_price: z.string().nullable(),
  /** Per-model rate limit (requests/min); null when no model-specific cap. */
  rate_limit: z.number().nullable(),
  /** Ordered model-degradation chain (模型降级链); null when none. */
  fallback_models: z.array(z.string()).nullable(),
  /** Channel ids that serve this model (inverse channel_model links; popup 服务通道). */
  served_channel_ids: z.array(z.string()),
  /**
   * The per-(model×channel) param override for the link this row was fetched
   * THROUGH (mig 0062). Only populated by `GET .../channels/:channelId/models`
   * (where a channel context exists); null when unset or when the model was
   * fetched channel-free (flat `/admin/models`). Drives the col-3 「已覆盖」 chip.
   */
  param_override: paramOverrideSchema.nullable(),
  /** Free-form catalog tags for faceting (catalog-tags-ia). */
  tags: z.array(z.string()),
  /** Developer/maker (开发者 facet); null when unset. */
  maker: z.string().nullable(),
  /** Max context window in tokens (上下文 facet); null when unknown. */
  context_length: z.number().nullable(),
  /** Reasoning mode (推理): none | optional | always; null when unset. */
  reasoning: z.string().nullable(),
  /**
   * Frozen model-level parameter profile (D1, mig 0064); default-empty, never
   * null (the `toView` mapper `.parse({})`s an absent column into the empty
   * profile). Drives the 参数档案 editor + engine defaults/clamp/gate/drop.
   */
  param_profile: modelParamProfileSchema,
  /** Selectable icon key (icon_asset.key); null → inherit channel/plugin icon. */
  icon: z.string().nullable(),
  status: z.string(),
  created_at: z.string(),
});
export type ModelView = z.infer<typeof modelViewSchema>;

/** A tenant grant on a `tenant`-visibility model (`GET /admin/models/:name/grants`). */
export const modelGrantViewSchema = z.object({
  id: z.string(),
  model_id: z.string(),
  tenant_id: z.string(),
  created_at: z.string(),
});
export type ModelGrantView = z.infer<typeof modelGrantViewSchema>;

/** A pricebook entry (`GET /admin/pricebook`). `spec`/`markup` are free-form JSON. */
export const pricebookViewSchema = z.object({
  id: z.string(),
  resource_id: z.string(),
  resource_version: z.number(),
  version: z.number(),
  method: z.string(),
  timing: z.string(),
  spec: z.unknown(),
  markup: z.unknown(),
  active: z.boolean(),
});
export type PricebookView = z.infer<typeof pricebookViewSchema>;

/** A pricing modifier (`GET /admin/modifiers`). */
export const modifierViewSchema = z.object({
  id: z.string(),
  scope: z.string(),
  when_expr: z.string().nullable(),
  op: z.string(),
  /** µcredits for credit ops / whole-percent for percent ops, as a string. */
  value: z.string().nullable(),
  stackable: z.boolean(),
  priority: z.number(),
  version: z.number(),
  active: z.boolean(),
});
export type ModifierView = z.infer<typeof modifierViewSchema>;

/**
 * One BYO Dify binding (`GET /admin/dify`, the PATCH response). The metadata
 * view — EXCLUDES the dsl/compat-report blobs. `service_key_ref` is the bound
 * stored-secret id or null.
 */
export const difyBindingViewSchema = z.object({
  resource_id: z.string(),
  resource_version: z.number(),
  mode: z.string(),
  endpoint: z.string(),
  service_key_ref: z.string().nullable(),
  pricing_model: z.string(),
  provision_mode: z.string(),
  created_at: z.string(),
});
export type DifyBindingView = z.infer<typeof difyBindingViewSchema>;

/**
 * One row of the official **model spec catalog** (规格库; `GET /admin/model-specs`),
 * the admin-maintained reference description of an upstream model — what it IS
 * (modalities/context/key params/intro/sources), independent of channel wiring.
 * `confidence` (firstparty|secondary|reconstructed) + `billing_eligible` gate
 * which rows become a billable cost basis (mirrored into `official_model_price`).
 * Pure catalog metadata — carries NO prices, so no money fields here.
 */
export const modelSpecViewSchema = z.object({
  id: z.string(),
  vendor: z.string(),
  model_id: z.string(),
  display_name: z.string().nullable(),
  family: z.string().nullable(),
  type: z.string(),
  input_modalities: z.array(z.string()).nullable(),
  output_modalities: z.array(z.string()).nullable(),
  /** Free-form media option descriptors (resolutions/durations/modes); shape varies by vendor. */
  media_options: z.unknown().nullable(),
  key_params: z.array(z.string()).nullable(),
  /** Fine-grained capability features (规格库 → model.param_profile.features on sync). */
  features: z.array(z.string()).nullable(),
  /** Structured parameter rules (Dify parameter_rules); frozen into model.param_profile on sync. */
  parameter_rules: z.array(parameterRuleSchema).nullable(),
  sources: z.array(z.string()).nullable(),
  status: z.string().nullable(),
  context_window: z.string().nullable(),
  max_output: z.string().nullable(),
  intro: z.string().nullable(),
  confidence: z.string(),
  billing_eligible: z.boolean(),
  as_of: z.string().nullable(),
  source_url: z.string().nullable(),
  notes: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ModelSpecView = z.infer<typeof modelSpecViewSchema>;
