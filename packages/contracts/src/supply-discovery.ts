// packages/contracts/src/supply-discovery.ts
//
// model-supply-greenfield 批次5 slice2 — 发现与批建 (§10 Major A5): the admin
// views for the channel onboarding wizard's middle three steps:
//
//   1. `POST /admin/supply/channels/:id/discover` — list the upstream's models
//      (the dialect's discovery endpoint when its DSL pack declares one, else
//      the official catalog by provider slug — §10 「方言 discovery 端点或目录
//      勾选」二选一), flagging which are already offerings on the channel;
//   2. `POST /admin/supply/channels/:id/offerings/batch` — batch-create the
//      picked offerings, ALWAYS `draft` (enable only via the slice-1 gate
//      stack), minting each model's missing SALE card from the official
//      catalog (needs_pricing when unmatched — 永不 0 价上架);
//   3. `POST /admin/supply/channels/:id/offerings/probe-and-enable` — run each
//      draft offering through the FULL slice-1 enable stack (config gates +
//      golden probe), reporting per-offering verdicts.
//
// NOT a frozen batch-0 file — ordinary evolving admin views (snake_case per
// the supply-view convention).
import { z } from 'zod';

import { enableGateViolationSchema, probeSupplyOfferingResponseSchema } from './golden-probe.js';
import { fetchProfileSchema, modelOperationSchema, offeringSchema } from './supply-entities.js';

// --- discovery (§10 发现模型) ---------------------------------------------------

/**
 * Where a discovered model came from: the dialect's own discovery endpoint
 * (DSL packs with a `discovery` declaration) or the official catalog
 * (`model_spec` by provider slug — the path for code-aspect dialects and packs
 * without a discovery endpoint).
 */
export const DISCOVERED_MODEL_SOURCES = ['dialect_discovery', 'catalog'] as const;
export type DiscoveredModelSource = (typeof DISCOVERED_MODEL_SOURCES)[number];

/** One upstream model candidate the operator can pick into an offering. */
export const discoveredSupplyModelSchema = z.object({
  /** The upstream's own model id/slug — becomes `offering.upstream_model_name` when picked. */
  upstream_model_name: z.string().min(1),
  display_name: z.string().optional(),
  source: z.enum(DISCOVERED_MODEL_SOURCES),
  /** True when THIS channel already has a live offering with this upstream name (re-picking would 400). */
  exists_as_offering: z.boolean(),
});
export type DiscoveredSupplyModel = z.infer<typeof discoveredSupplyModelSchema>;

/** `POST /admin/supply/channels/:id/discover` response. */
export const discoverSupplyModelsResponseSchema = z.object({
  source: z.enum(DISCOVERED_MODEL_SOURCES),
  models: z.array(discoveredSupplyModelSchema),
});
export type DiscoverSupplyModelsResponse = z.infer<typeof discoverSupplyModelsResponseSchema>;

// --- batch offering creation (§10 批量生成 offering draft) -------------------------

/**
 * One picked upstream model → one offering. EXACTLY ONE of `model_id` (bind to
 * an existing product model) / `new_model` (register a fresh DRAFT model
 * inline) must be present. An inline model is born `draft` with conservative
 * defaults (chat.completions sync+stream, modality `text`) — the canonical
 * contract is the catalog author's to refine before enable.
 */
export const batchSupplyOfferingItemSchema = z
  .object({
    upstream_model_name: z.string().min(1),
    model_id: z.string().uuid().optional(),
    new_model: z
      .object({
        /** External unique name (对外唯一名); defaults are NOT derived from the upstream name — be explicit. */
        name: z.string().min(1),
        display_name: z.string().min(1).optional(),
        modality: z.string().min(1).optional(),
        operations: z.array(modelOperationSchema).min(1).optional(),
      })
      .optional(),
  })
  .superRefine((item, ctx) => {
    if ((item.model_id === undefined) === (item.new_model === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'exactly one of model_id / new_model is required',
        path: ['model_id'],
      });
    }
  });
export type BatchSupplyOfferingItem = z.infer<typeof batchSupplyOfferingItemSchema>;

/**
 * `POST /admin/supply/channels/:id/offerings/batch` — transactional batch
 * create. Every offering is born `draft` (§10 双门: status `enabled` is
 * unreachable here — only `POST …/offerings/:id/enable` may set it).
 */
export const batchCreateSupplyOfferingsSchema = z.object({
  items: z.array(batchSupplyOfferingItemSchema).min(1).max(100),
  /**
   * Fetch profile applied to every created offering; omitted → dialect-informed
   * default (the dialect's declared fetch mode for the model's primary
   * operation, else `direct`).
   */
  fetch_profile: fetchProfileSchema.optional(),
});
export type BatchCreateSupplyOfferingsBody = z.infer<typeof batchCreateSupplyOfferingsSchema>;

/**
 * The default-minting outcome for one created offering's model (§10 售价卡默认
 * 由官方价目生成):
 * - `existing` — the model already carried a SALE card (nothing minted);
 * - `minted` — a card was minted from the official catalog match on the
 *   upstream model name, with the channel route group's `group_ratio_bps`
 *   folded into the synthesized per-token spec;
 * - `needs_pricing` — no live billable official match; the model stays
 *   card-less and the enable gate will refuse it until priced manually
 *   (永不 0 价上架).
 */
export const OFFERING_PRICING_STATUSES = ['existing', 'minted', 'needs_pricing'] as const;
export type OfferingPricingStatus = (typeof OFFERING_PRICING_STATUSES)[number];

export const offeringPricingOutcomeSchema = z.object({
  status: z.enum(OFFERING_PRICING_STATUSES),
  /** The SALE card now bound to the model (present for `existing` / `minted`). */
  price_card_id: z.string().optional(),
  /** Operator-facing detail (which match failed, which catalog row minted). */
  message: z.string().optional(),
});
export type OfferingPricingOutcome = z.infer<typeof offeringPricingOutcomeSchema>;

export const batchCreatedSupplyOfferingSchema = z.object({
  offering: offeringSchema,
  model_id: z.string(),
  upstream_model_name: z.string(),
  pricing: offeringPricingOutcomeSchema,
});
export type BatchCreatedSupplyOffering = z.infer<typeof batchCreatedSupplyOfferingSchema>;

export const batchCreateSupplyOfferingsResponseSchema = z.object({
  offerings: z.array(batchCreatedSupplyOfferingSchema),
  /** How many created offerings still need manual pricing before they can enable. */
  needs_pricing_count: z.number().int().nonnegative(),
});
export type BatchCreateSupplyOfferingsResponse = z.infer<
  typeof batchCreateSupplyOfferingsResponseSchema
>;

// --- batch probe-and-enable (§10 批量 golden probe → 通过才可 enable) ---------------

/**
 * `POST /admin/supply/channels/:id/offerings/probe-and-enable` — run offerings
 * through the FULL slice-1 enable stack, one at a time (the shared R5 probe
 * budget + min-interval gate paces the batch naturally). Omitted
 * `offering_ids` → every `draft`/`probing` offering on the channel.
 */
export const batchProbeEnableSupplyOfferingsSchema = z.object({
  offering_ids: z.array(z.string().uuid()).min(1).max(100).optional(),
});
export type BatchProbeEnableSupplyOfferingsBody = z.infer<
  typeof batchProbeEnableSupplyOfferingsSchema
>;

/** One offering's verdict — the slice-1 enable response plus its identity. */
export const batchProbeEnableResultSchema = z.object({
  offering_id: z.string(),
  upstream_model_name: z.string(),
  enabled: z.boolean(),
  offering_status: z.string(),
  violations: z.array(enableGateViolationSchema),
  probe: probeSupplyOfferingResponseSchema.optional(),
});
export type BatchProbeEnableResult = z.infer<typeof batchProbeEnableResultSchema>;

export const batchProbeEnableSupplyOfferingsResponseSchema = z.object({
  results: z.array(batchProbeEnableResultSchema),
  enabled_count: z.number().int().nonnegative(),
});
export type BatchProbeEnableSupplyOfferingsResponse = z.infer<
  typeof batchProbeEnableSupplyOfferingsResponseSchema
>;
