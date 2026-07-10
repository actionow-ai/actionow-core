// packages/contracts/src/supply-requests.ts
//
// model-supply-greenfield 批次1 — the admin CRUD **request bodies** for the six
// frozen supply entities (supply-entities.ts §2). Same contract-first pattern
// as admin-requests/catalog-requests: the backend admin DTO re-exports these
// (ZodBody validates against them), the frontend imports the inferred TYPE
// only, and they flow into openapi.json → @actionow/sdk.
//
// Conventions:
// - snake_case field names, aligned 1:1 with the FROZEN entity view schemas
//   (the entity schema IS the response view; these are the write twins).
// - `.optional()` — NEVER `.default()` — on request fields (a `.default()`
//   makes `parse` emit extra keys, breaking exact-shape assertions downstream).
//   Nested SPEC objects reuse the frozen schemas verbatim (their internal
//   defaults are part of the frozen contract).
// - update schemas: every field optional; identity/immutable fields
//   (channel.provider_id, offering.(model_id, channel_id)) are NOT updatable.
// - price_card has NO update schema — a card is immutable once effective; a
//   price change goes through `POST …/price-cards/:id/versions`
//   ({@link createSupplyPriceCardVersionSchema}).
import { z } from 'zod';

import { PRICE_METHODS, priceSpecSchema } from './pricing.js';
import {
  artifactPolicySchema,
  AUTH_SCHEMES,
  CHANNEL_STATUSES,
  CREDENTIAL_STATUSES,
  credentialSecretSchema,
  dialectRefSchema,
  fetchProfileSchema,
  MODEL_STATUSES,
  MODEL_VISIBILITIES,
  modelOperationSchema,
  OFFERING_STATUSES,
  quotaMirrorSchema,
} from './supply-entities.js';
import { offeringParamDeclSchema } from './supply-params.js';

// --- provider (§2.2) ----------------------------------------------------------

/** `POST /admin/supply/providers` — register a 厂商 (brand + defaults). */
export const createSupplyProviderSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  icon: z.string().nullable().optional(),
  default_dialect: dialectRefSchema,
  callback_verification: z.record(z.string(), z.unknown()).nullable().optional(),
  default_fault_policy_id: z.string().uuid().nullable().optional(),
  region: z.string().nullable().optional(),
});
export type CreateSupplyProviderBody = z.infer<typeof createSupplyProviderSchema>;

/** `PATCH /admin/supply/providers/:id` — every field optional. */
export const updateSupplyProviderSchema = z.object({
  slug: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  icon: z.string().nullable().optional(),
  default_dialect: dialectRefSchema.optional(),
  callback_verification: z.record(z.string(), z.unknown()).nullable().optional(),
  default_fault_policy_id: z.string().uuid().nullable().optional(),
  region: z.string().nullable().optional(),
});
export type UpdateSupplyProviderBody = z.infer<typeof updateSupplyProviderSchema>;

// --- channel (§2.3) -------------------------------------------------------------

/** `POST /admin/supply/channels` — one callable upstream access point. */
export const createSupplyChannelSchema = z.object({
  provider_id: z.string().uuid(),
  name: z.string().min(1),
  auth_scheme: z.enum(AUTH_SCHEMES),
  /** Dialect override; null/omitted → inherit provider.default_dialect. */
  dialect: dialectRefSchema.nullable().optional(),
  base_url: z.string().nullable().optional(),
  proxy_ref: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  /** BYOK ownership: omitted/null = 平台自营. */
  tenant_id: z.string().uuid().nullable().optional(),
  route_group_id: z.string().uuid().nullable().optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(CHANNEL_STATUSES).optional(),
});
export type CreateSupplyChannelBody = z.infer<typeof createSupplyChannelSchema>;

/** `PATCH /admin/supply/channels/:id` — `provider_id` is immutable (identity). */
export const updateSupplyChannelSchema = z.object({
  name: z.string().min(1).optional(),
  auth_scheme: z.enum(AUTH_SCHEMES).optional(),
  dialect: dialectRefSchema.nullable().optional(),
  base_url: z.string().nullable().optional(),
  proxy_ref: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  tenant_id: z.string().uuid().nullable().optional(),
  route_group_id: z.string().uuid().nullable().optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(CHANNEL_STATUSES).optional(),
});
export type UpdateSupplyChannelBody = z.infer<typeof updateSupplyChannelSchema>;

// --- credential (§2.4) ----------------------------------------------------------

/**
 * `POST /admin/supply/credentials` — add a key to a channel's pool. `secret`
 * is WRITE-ONLY: it is encrypted into the vault and the response is ALWAYS the
 * redacted `credentialSchema` view (secret_hint only — never the secret). The
 * secret's `scheme` must equal the channel's `auth_scheme` (enforced server-side).
 */
export const createSupplyCredentialSchema = z.object({
  channel_id: z.string().uuid(),
  name: z.string().min(1),
  secret: credentialSecretSchema,
  quota: quotaMirrorSchema.optional(),
});
export type CreateSupplyCredentialBody = z.infer<typeof createSupplyCredentialSchema>;

/**
 * `PATCH /admin/supply/credentials/:id` — metadata + runtime cooldown only.
 * Rotating the secret material is NOT an update: create a new credential and
 * retire this one. `cooldown_until: null` clears an active cooldown.
 */
export const updateSupplyCredentialSchema = z.object({
  name: z.string().min(1).optional(),
  quota: quotaMirrorSchema.optional(),
  status: z.enum(CREDENTIAL_STATUSES).optional(),
  cooldown_until: z.string().datetime().nullable().optional(),
});
export type UpdateSupplyCredentialBody = z.infer<typeof updateSupplyCredentialSchema>;

// --- model (§2.1) ---------------------------------------------------------------

/**
 * `POST /admin/supply/models` — register the PRODUCT face. The needs_pricing
 * gate applies from birth: a model cannot be `active` while `price_card_id`
 * is null (never 0-priced on the shelf, §10) — enforced server-side.
 */
export const createSupplyModelSchema = z.object({
  name: z.string().min(1),
  display_name: z.string().min(1),
  modality: z.string().min(1),
  operations: z.array(modelOperationSchema).min(1),
  icon: z.string().nullable().optional(),
  status: z.enum(MODEL_STATUSES).optional(),
  capabilities: z.array(z.string()).optional(),
  price_card_id: z.string().uuid().nullable().optional(),
  modifier_group_id: z.string().uuid().nullable().optional(),
  max_run_time_seconds: z.number().int().positive().nullable().optional(),
  artifact: artifactPolicySchema.optional(),
  fallback_model_ids: z.array(z.string()).optional(),
  limit_plan_id: z.string().uuid().nullable().optional(),
  visibility: z.enum(MODEL_VISIBILITIES).optional(),
});
export type CreateSupplyModelBody = z.infer<typeof createSupplyModelSchema>;

/** `PATCH /admin/supply/models/:id` — every field optional (needs_pricing gate server-side). */
export const updateSupplyModelSchema = z.object({
  name: z.string().min(1).optional(),
  display_name: z.string().min(1).optional(),
  modality: z.string().min(1).optional(),
  operations: z.array(modelOperationSchema).min(1).optional(),
  icon: z.string().nullable().optional(),
  status: z.enum(MODEL_STATUSES).optional(),
  capabilities: z.array(z.string()).optional(),
  price_card_id: z.string().uuid().nullable().optional(),
  modifier_group_id: z.string().uuid().nullable().optional(),
  max_run_time_seconds: z.number().int().positive().nullable().optional(),
  artifact: artifactPolicySchema.optional(),
  fallback_model_ids: z.array(z.string()).optional(),
  limit_plan_id: z.string().uuid().nullable().optional(),
  visibility: z.enum(MODEL_VISIBILITIES).optional(),
});
export type UpdateSupplyModelBody = z.infer<typeof updateSupplyModelSchema>;

/** `POST /admin/supply/models/:id/grants` — grant a `granted`-visibility model to a tenant. */
export const grantSupplyModelSchema = z.object({
  tenant_id: z.string().uuid(),
});
export type GrantSupplyModelBody = z.infer<typeof grantSupplyModelSchema>;

/**
 * `POST /admin/supply/models/:id/price-card/from-official` — mint the model's
 * SALE price card off the official catalog (`matchOfficialPrice(provider,
 * model.name)`); no live billable match → 400 `needs_pricing`.
 */
export const supplyPriceCardFromOfficialSchema = z.object({
  provider: z.string().min(1),
});
export type SupplyPriceCardFromOfficialBody = z.infer<typeof supplyPriceCardFromOfficialSchema>;

// --- offering (§2.5) ------------------------------------------------------------

/**
 * `POST /admin/supply/offerings` — the first-class (model × channel) binding.
 * Born `draft` (the enable path is the golden-probe lifecycle, later batch);
 * `model_id`/`channel_id` must reference LIVE rows (enforced server-side) and
 * are immutable afterwards — re-binding is a new offering.
 */
export const createSupplyOfferingSchema = z.object({
  model_id: z.string().uuid(),
  channel_id: z.string().uuid(),
  upstream_model_name: z.string().min(1),
  fetch_profile: fetchProfileSchema,
  param_declarations: z.array(offeringParamDeclSchema).optional(),
  timeout_budget_seconds: z.number().int().positive().nullable().optional(),
  cost_price_card_id: z.string().uuid().nullable().optional(),
  max_concurrency: z.number().int().positive().nullable().optional(),
  weight: z.number().int().nonnegative().optional(),
  tier: z.number().int().optional(),
});
export type CreateSupplyOfferingBody = z.infer<typeof createSupplyOfferingSchema>;

/** `PATCH /admin/supply/offerings/:id` — the (model, channel) identity is immutable. */
export const updateSupplyOfferingSchema = z.object({
  status: z.enum(OFFERING_STATUSES).optional(),
  upstream_model_name: z.string().min(1).optional(),
  fetch_profile: fetchProfileSchema.optional(),
  param_declarations: z.array(offeringParamDeclSchema).optional(),
  timeout_budget_seconds: z.number().int().positive().nullable().optional(),
  cost_price_card_id: z.string().uuid().nullable().optional(),
  max_concurrency: z.number().int().positive().nullable().optional(),
  weight: z.number().int().nonnegative().optional(),
  tier: z.number().int().optional(),
});
export type UpdateSupplyOfferingBody = z.infer<typeof updateSupplyOfferingSchema>;

// --- price_card (§2.7 / §9.2 — immutable, versioned) ------------------------------

/**
 * `POST /admin/supply/price-cards` — mint a NEW card (a fresh version lineage,
 * `version` defaults to 1). There is deliberately NO update schema: a card is
 * immutable once effective; changes mint a new version (below) and re-point
 * the referencing model/offering.
 */
export const createSupplyPriceCardSchema = z
  .object({
    name: z.string().min(1),
    method: z.enum(PRICE_METHODS),
    unit: z.string().min(1),
    spec: priceSpecSchema,
    /** ISO instant this card takes effect. */
    effective_at: z.string().datetime(),
    tier_dims: z.array(z.string()).optional(),
    currency: z.string().min(1).optional(),
    version: z.number().int().positive().optional(),
  })
  .superRefine((card, ctx) => {
    if (card.method !== card.spec.method) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'method must equal spec.method',
        path: ['spec', 'method'],
      });
    }
  });
export type CreateSupplyPriceCardBody = z.infer<typeof createSupplyPriceCardSchema>;

/**
 * `POST /admin/supply/price-cards/:id/versions` — the ONLY price-change path:
 * inserts a NEW row (new id, `base.version + 1`) carrying the base fields
 * overridden by this patch; the caller then re-points the referencing
 * model/offering. `method === spec.method` is re-checked against the EFFECTIVE
 * (base ∪ patch) pair server-side; the refine here catches the both-supplied case.
 */
export const createSupplyPriceCardVersionSchema = z
  .object({
    name: z.string().min(1).optional(),
    method: z.enum(PRICE_METHODS).optional(),
    unit: z.string().min(1).optional(),
    spec: priceSpecSchema.optional(),
    effective_at: z.string().datetime().optional(),
    tier_dims: z.array(z.string()).optional(),
    currency: z.string().min(1).optional(),
  })
  .superRefine((patch, ctx) => {
    if (
      patch.method !== undefined &&
      patch.spec !== undefined &&
      patch.method !== patch.spec.method
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'method must equal spec.method',
        path: ['spec', 'method'],
      });
    }
  });
export type CreateSupplyPriceCardVersionBody = z.infer<typeof createSupplyPriceCardVersionSchema>;

// --- api_key model allowlist (§2.6) -----------------------------------------------

/**
 * `PATCH /admin/api-keys/:id/model-allowlist` — replace the key's NEW-WORLD
 * model whitelist (supply_model external `name`s). `[]` = allow ALL models
 * (mirrors the `resource_allowlist` semantics).
 */
export const updateApiKeyModelAllowlistSchema = z.object({
  models: z.array(z.string()),
});
export type UpdateApiKeyModelAllowlistBody = z.infer<typeof updateApiKeyModelAllowlistSchema>;
