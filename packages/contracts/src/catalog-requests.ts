import { z } from 'zod';

/**
 * Single source of truth for the catalog/pricing control-plane **request bodies**
 * (resources, channels, models, model grants, pricebook, modifiers, dify, channel
 * model-sync). Same contract-first pattern as the `*-views.ts` files, but for the
 * write side: the backend admin DTO re-exports these schemas (so `ZodBody`
 * validates against them) and the frontend imports the inferred TYPE only
 * (`import type`), so no zod ships to the browser. These schemas flow into
 * `openapi.json` → `@actionow/sdk` as request bodies.
 *
 * CREDIT/MONEY CONVENTION (write side): credit-denominated fields are HUMAN
 * amounts here (numbers), NOT µcredits — the controller converts at the boundary
 * (`creditsToMicro`). Token-price fields documented as µ-per-token / µUSD-per-1M
 * are entered directly as those integers. Unlike RESPONSE money (always a
 * string), request money stays a `number`.
 */

/** `POST /admin/resources` — register a catalog resource (+ its io_schema). */
export const createResourceSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().uuid(),
  kind: z.enum(['model', 'workflow']),
  modality: z.enum(['text', 'image', 'video', 'audio', 'composite']),
  providerType: z.string().min(1),
  execModes: z.array(z.string().min(1)).min(1),
  /** The frozen io_schema snapshot (stored as jsonb). */
  ioSchema: z.unknown(),
  version: z.number().int().positive().optional(),
});
export type CreateResourceBody = z.infer<typeof createResourceSchema>;

/**
 * `PATCH /admin/resources/:id` — update a resource. Limited to SAFE fields:
 * only `status` (`active`/`disabled`) is mutable. The key fields
 * (`id`/`kind`/`modality`/`providerType`) are immutable here — changing them
 * would silently corrupt the routing/pricing a frozen resource version assumes.
 */
export const updateResourceSchema = z.object({
  status: z.enum(['active', 'disabled']).optional(),
});
export type UpdateResourceBody = z.infer<typeof updateResourceSchema>;

/** `POST /admin/resources/:id/channels` — add an upstream routing channel. */
export const createChannelSchema = z.object({
  providerType: z.string().min(1),
  credentialRef: z.string().uuid().optional(),
  /** Per-channel upstream base URL (e.g. https://api.deepseek.com/v1). */
  endpoint: z.string().min(1).optional(),
  /** Per-channel upstream model id (overrides the resource default). */
  model: z.string().min(1).optional(),
  /** Env-key locator for this channel's egress proxy URL. */
  proxyRef: z.string().min(1).optional(),
  /** Generic relay protocol config forwarded verbatim to the adapter. */
  config: z.record(z.unknown()).optional(),
  weight: z.number().int().positive().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  /**
   * The operator's ACTUAL cost on this channel in HUMAN USD per 1M INPUT tokens
   * (e.g. `0.5` = $0.50/1M) → integer µUSD/1M in the service (Track 5). Drives
   * `usage_log.provider_cost`/margin ONLY — never the customer price. Omitted →
   * null (unknown cost; subscription channels ≈ 0). Non-negative (a free channel
   * is 0).
   */
  inputCostUsdPer1m: z.number().nonnegative().optional(),
  /** The operator's cost in HUMAN USD per 1M OUTPUT tokens → µUSD/1M (Track 5). */
  outputCostUsdPer1m: z.number().nonnegative().optional(),
  /** Bind a fault-tolerance policy (调用容错) — a `fault_policy` id; omitted → engine defaults. */
  faultPolicyId: z.string().uuid().optional(),
  /** Selectable icon key (icon_asset.key). */
  icon: z.string().optional(),
  /** Owning provider-plugin id (模型接入 3-pane grouping). */
  pluginId: z.string().uuid().optional(),
});
export type CreateChannelBody = z.infer<typeof createChannelSchema>;

/**
 * `PATCH /admin/resources/:id/channels/:channelId` — patch a channel. Every
 * field is optional (omitted = unchanged); a nullable field may be set to `null`
 * to clear it.
 */
export const updateChannelSchema = z.object({
  credentialRef: z.string().uuid().nullable().optional(),
  endpoint: z.string().min(1).nullable().optional(),
  model: z.string().min(1).nullable().optional(),
  proxyRef: z.string().min(1).nullable().optional(),
  config: z.record(z.unknown()).nullable().optional(),
  weight: z.number().int().positive().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  /** Operator cost in HUMAN USD/1M INPUT tokens → µUSD/1M (Track 5); `null` clears it. */
  inputCostUsdPer1m: z.number().nonnegative().nullable().optional(),
  /** Operator cost in HUMAN USD/1M OUTPUT tokens → µUSD/1M (Track 5); `null` clears it. */
  outputCostUsdPer1m: z.number().nonnegative().nullable().optional(),
  /** Bind/unbind a fault-tolerance policy (调用容错); a `fault_policy` id, or `null` to unbind. */
  faultPolicyId: z.string().uuid().nullable().optional(),
  /** Selectable icon key (icon_asset.key); `null` clears it. */
  icon: z.string().nullable().optional(),
  /** Owning provider-plugin id (模型接入 3-pane grouping); `null` unassigns. */
  pluginId: z.string().uuid().nullable().optional(),
});
export type UpdateChannelBody = z.infer<typeof updateChannelSchema>;

/**
 * `POST /admin/resources/:id/channels/:channelId/sync-models` — sync a provider's
 * available models into `model` rows, auto-priced against the official catalog
 * (Track 2). The two prices are µUSD-per-1M-token integers (NOT human credits —
 * the same convention as the model catalog), applied ONLY to a NEWLY-discovered
 * model that found NO official price: an explicit OPERATOR OVERRIDE that creates
 * the unmatched model `active` at these prices. When BOTH are omitted, an
 * unmatched model is created `disabled` + `needs_pricing` (never billed at 0).
 * Existing models always keep their price.
 */
export const syncChannelModelsSchema = z.object({
  defaultInputPrice: z.number().int().nonnegative().optional(),
  defaultOutputPrice: z.number().int().nonnegative().optional(),
});
export type SyncChannelModelsBody = z.infer<typeof syncChannelModelsSchema>;

/** `POST /admin/pricebook` — add a pricebook entry. */
export const createPricebookSchema = z.object({
  resourceId: z.string().min(1),
  resourceVersion: z.number().int().positive(),
  version: z.number().int().positive(),
  method: z.enum(['unit', 'matrix', 'fixed', 'formula', 'passthrough']),
  timing: z.enum(['pre', 'post']),
  /**
   * The pricing spec (stored as jsonb). When `method` is `fixed`, `fixedCredits`
   * (below) is the HUMAN-credit amount; the controller converts it to a
   * µcredit `amount` inside the persisted spec. For metered/unit/matrix methods
   * the rate dimensions are already in the canonical unit the engine expects.
   */
  spec: z.unknown(),
  /**
   * Convenience for `method: 'fixed'`: a HUMAN-credit amount the controller
   * converts to µcredits and writes as `spec.amount`. Mutually informs `spec`.
   */
  fixedCredits: z.number().nonnegative().optional(),
  markup: z.unknown().optional(),
  active: z.boolean().optional(),
});
export type CreatePricebookBody = z.infer<typeof createPricebookSchema>;

/**
 * `PATCH /admin/pricebook/:id` — update a pricebook entry. Every field is
 * optional (omitted = unchanged). `fixedCredits` mirrors the create path: a
 * HUMAN-credit amount the controller converts to a µcredit `spec.amount` (only
 * valid when the effective `method` is `fixed`).
 */
export const updatePricebookSchema = z.object({
  method: z.enum(['unit', 'matrix', 'fixed', 'formula', 'passthrough']).optional(),
  timing: z.enum(['pre', 'post']).optional(),
  spec: z.unknown().optional(),
  /** HUMAN-credit amount → µcredit `spec.amount` (only for `method: 'fixed'`). */
  fixedCredits: z.number().nonnegative().optional(),
  markup: z.unknown().optional(),
  active: z.boolean().optional(),
});
export type UpdatePricebookBody = z.infer<typeof updatePricebookSchema>;

/** `POST /admin/modifiers` — add a pricing modifier (§9.2 scope). */
export const createModifierSchema = z.object({
  /** `global` | `tenant:<id>` | `capability:<id>` | `resource:<id>`. */
  scope: z.string().min(1),
  whenExpr: z.string().optional(),
  op: z.enum(['override_rate', 'percent_off', 'flat_off', 'percent_add']),
  /**
   * REQUIRED — every op needs a value: percent ops (`percent_off`/`percent_add`)
   * take a whole-percent int; credit ops (`flat_off`/`override_rate`) take a
   * HUMAN-credit amount the controller converts to µcredits. (A value-less
   * modifier would throw `invalid_pricing` on EVERY settle — a pricing footgun.)
   */
  value: z.number(),
  stackable: z.boolean().optional(),
  priority: z.number().int().optional(),
  version: z.number().int().positive().optional(),
  active: z.boolean().optional(),
});
export type CreateModifierBody = z.infer<typeof createModifierSchema>;

/**
 * `PATCH /admin/modifiers/:id` — update a pricing modifier. Every field is
 * optional (omitted = unchanged). `value` mirrors create: a whole-percent int
 * for percent ops, a HUMAN-credit amount the controller converts to µcredits for
 * credit ops (`flat_off`/`override_rate`). The conversion uses the EFFECTIVE op
 * (the patched `op` if present, else the stored one). `whenExpr` may be cleared
 * with `null`. `scope` is NOT patchable (a re-scope is a new modifier).
 */
export const updateModifierSchema = z.object({
  whenExpr: z.string().nullable().optional(),
  op: z.enum(['override_rate', 'percent_off', 'flat_off', 'percent_add']).optional(),
  value: z.number().optional(),
  stackable: z.boolean().optional(),
  priority: z.number().int().optional(),
  active: z.boolean().optional(),
});
export type UpdateModifierBody = z.infer<typeof updateModifierSchema>;

/** `POST /admin/dify/import` — register a BYO Dify workflow. */
export const difyImportSchema = z.object({
  tenantId: z.string().uuid(),
  resourceId: z.string().min(1),
  yaml: z.string().min(1),
  endpoint: z.string().url(),
  serviceKeyRef: z.string().uuid().nullable().optional(),
  pricingModel: z.enum(['fixed', 'matrix', 'metered']),
  allowBlockers: z.boolean().optional(),
});
export type DifyImportBody = z.infer<typeof difyImportSchema>;

/**
 * `PATCH /admin/dify/:resourceId` — update the current dify binding. Every field
 * is optional (omitted = unchanged). `serviceKeyRef` may be set to `null` to
 * clear it. Operates on the resource's highest-version live binding.
 */
export const updateDifySchema = z.object({
  endpoint: z.string().url().optional(),
  serviceKeyRef: z.string().uuid().nullable().optional(),
  pricingModel: z.enum(['fixed', 'matrix', 'metered']).optional(),
});
export type UpdateDifyBody = z.infer<typeof updateDifySchema>;

/** `POST /admin/models` — register a relay model (name → chat resource). */
export const createModelSchema = z.object({
  name: z.string().min(1),
  /** The chat `resource` id this model routes to (carries channels/creds). */
  resourceId: z.string().min(1),
  display: z.string().optional(),
  /** Defaults to `chat`. */
  modality: z.string().optional(),
  /** Feature flags read by the relay (tools/vision/audio/json/stream). */
  capabilities: z.record(z.string(), z.boolean()).optional(),
  visibility: z.enum(['public', 'tenant']).optional(),
  /**
   * µcredit-per-INPUT-token (integer). Entered directly as µcredits (token
   * prices are sub-credit fractions), NOT human credits. Defaults to 0.
   */
  inputPrice: z.number().int().nonnegative().optional(),
  /** µcredit-per-OUTPUT-token (integer). Same convention. Defaults to 0. */
  outputPrice: z.number().int().nonnegative().optional(),
  /** Per-model rate limit in requests/minute (模型限流); omitted → no model-specific cap. */
  rateLimit: z.number().int().positive().max(1_000_000).optional(),
  /** Ordered model-degradation chain (模型降级链): fallback model names, tried in order on failure. */
  fallbackModels: z.array(z.string().min(1)).max(10).optional(),
  /** Free-form catalog tags for faceting (推荐/便宜/长上下文…). */
  tags: z.array(z.string().min(1)).max(20).optional(),
  /** Developer/maker (anthropic/alibaba/z-ai…); the catalog 开发者 axis (distinct from provider_type). */
  maker: z.string().optional(),
  /** Max context window in tokens (上下文 facet). */
  contextLength: z.number().int().positive().optional(),
  /** Reasoning mode (推理): none | optional | always. */
  reasoning: z.enum(['none', 'optional', 'always']).optional(),
  /** Selectable icon key (icon_asset.key). */
  icon: z.string().optional(),
  status: z.enum(['active', 'disabled']).optional(),
});
export type CreateModelBody = z.infer<typeof createModelSchema>;

/**
 * `PATCH /admin/models/:name` — update a relay model. Every field is optional
 * (omitted = unchanged). `inputPrice`/`outputPrice` stay µUSD per 1M tokens
 * integers (NOT human credits, same convention as create). `display` may be set
 * to `null` to clear it.
 */
export const updateModelSchema = z.object({
  display: z.string().nullable().optional(),
  capabilities: z.record(z.string(), z.boolean()).optional(),
  inputPrice: z.number().int().nonnegative().optional(),
  outputPrice: z.number().int().nonnegative().optional(),
  visibility: z.enum(['public', 'tenant']).optional(),
  /** Per-model rate limit in requests/minute (模型限流); `null` clears it. */
  rateLimit: z.number().int().positive().max(1_000_000).nullable().optional(),
  /** Ordered model-degradation chain (模型降级链); `null`/[] clears it. */
  fallbackModels: z.array(z.string().min(1)).max(10).nullable().optional(),
  /** Free-form catalog tags; replaces the set. */
  tags: z.array(z.string().min(1)).max(20).optional(),
  /** Developer/maker; `null` clears it. */
  maker: z.string().nullable().optional(),
  /** Max context window in tokens; `null` clears it. */
  contextLength: z.number().int().positive().nullable().optional(),
  /** Reasoning mode (推理): none | optional | always; `null` clears it. */
  reasoning: z.enum(['none', 'optional', 'always']).nullable().optional(),
  /** Selectable icon key (icon_asset.key); `null` clears it. */
  icon: z.string().nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
});
export type UpdateModelBody = z.infer<typeof updateModelSchema>;

/** `POST /admin/models/:name/grants` — grant a tenant-visibility model. */
export const grantModelSchema = z.object({
  tenantId: z.string().uuid(),
});
export type GrantModelBody = z.infer<typeof grantModelSchema>;
