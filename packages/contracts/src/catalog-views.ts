import { z } from 'zod';

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
});
export type ChannelModelLinkInput = z.infer<typeof channelModelLinkInputSchema>;

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
  /** Per-model rate limit (requests/min); null when no model-specific cap. */
  rate_limit: z.number().nullable(),
  /** Ordered model-degradation chain (模型降级链); null when none. */
  fallback_models: z.array(z.string()).nullable(),
  /** Channel ids that serve this model (inverse channel_model links; popup 服务通道). */
  served_channel_ids: z.array(z.string()),
  /** Free-form catalog tags for faceting (catalog-tags-ia). */
  tags: z.array(z.string()),
  /** Developer/maker (开发者 facet); null when unset. */
  maker: z.string().nullable(),
  /** Max context window in tokens (上下文 facet); null when unknown. */
  context_length: z.number().nullable(),
  /** Reasoning mode (推理): none | optional | always; null when unset. */
  reasoning: z.string().nullable(),
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
