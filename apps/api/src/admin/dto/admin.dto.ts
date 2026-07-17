import {
  addGroupChannelSchema,
  batchCreateSupplyOfferingsSchema,
  batchProbeEnableSupplyOfferingsSchema,
  bulkChannelActionSchema,
  bulkModelActionSchema,
  bulkOAuthSessionActionSchema,
  codexLoginCompleteSchema,
  codexLoginStartSchema,
  createAccountSchema,
  createAdminTokenSchema,
  createApiKeySchema,
  createChannelSchema,
  createFaultPolicySchema,
  createLimitPlanRequestSchema,
  createModelSchema,
  createModelSpecSchema,
  createModifierSchema,
  createOAuthSessionSchema,
  createOfficialPriceSchema,
  createPluginRequestSchema,
  createPricebookSchema,
  createProxySchema,
  createResourceSchema,
  createRouteGroupSchema,
  createSecretSchema,
  createSubAccountSchema,
  createSubjectSchema,
  createSupplyChannelSchema,
  createSupplyCredentialSchema,
  createSupplyModelSchema,
  createSupplyOfferingSchema,
  createSupplyPriceCardSchema,
  createSupplyPriceCardVersionSchema,
  createSupplyProviderSchema,
  createTenantSchema,
  ensureResourceSchema,
  generateCodesSchema,
  grantModelSchema,
  grantSupplyModelSchema,
  latestAuditRequestSchema,
  modelTestRequestSchema,
  provisionSchema,
  proxyProbeRequestSchema,
  refundJobSchema,
  setFileTtlSchema,
  setLimitPlanRequestSchema,
  supplyPriceCardFromOfficialSchema,
  syncChannelModelsSchema,
  topupSchema,
  topupSubAccountSchema,
  transferCreditsSchema,
  updateApiKeyGroupSchema,
  updateApiKeyModelAllowlistSchema,
  updateChannelModelParamOverrideSchema,
  updateChannelSchema,
  updateCredentialMetaSchema,
  updateFaultPolicySchema,
  updateLimitPlanRequestSchema,
  updateModelSchema,
  updateModelSpecSchema,
  updateModifierSchema,
  updateOfficialPriceSchema,
  updatePluginRequestSchema,
  updatePricebookSchema,
  updateProxySchema,
  updateResourceSchema,
  updateRouteGroupSchema,
  updateSubjectSchema,
  updateSupplyChannelSchema,
  updateSupplyCredentialSchema,
  updateSupplyModelSchema,
  updateSupplyOfferingSchema,
  updateSupplyProviderSchema,
  updateTenantSchema,
} from '@actionow/contracts';
import { z } from 'zod';

/**
 * Zod request schemas for the admin CRUD surface. The contracts/domain packages
 * use zod, so the admin boundary does too (validated via the `ZodBody` pipe).
 *
 * CONTRACT-FIRST (request bodies): every POST/PATCH/PUT **body** schema now lives
 * ONCE in `@actionow/contracts` (`admin-requests.ts` / `catalog-requests.ts` /
 * `billing-requests.ts`) — the single source of truth the frontend imports
 * (`import type`) and that flows into `openapi.json` → `@actionow/sdk`. This
 * module re-exports them (so the controller's `import { createTenantSchema }
 * from './dto/admin.dto.js'` still resolves) and keeps the `CreateXxxDto`
 * inferred-type aliases. This now includes the **oauth/codex** body schemas
 * (their credential-management page consumes the typed SDK). Only the **query**
 * schemas (GET; `z.coerce`) have no frontend body twin and stay defined locally.
 *
 * CREDIT CONVENTION: every credit-denominated field is a HUMAN credit amount
 * (e.g. `100` = 100 credits). The controller converts it to integer µcredits
 * with `creditsToMicro` before persisting; responses serialize the stored
 * µcredits as decimal strings. Schemas never carry µcredits.
 */

// --- Request-body schemas (single source of truth in @actionow/contracts) ---
export {
  addGroupChannelSchema,
  batchCreateSupplyOfferingsSchema,
  batchProbeEnableSupplyOfferingsSchema,
  bulkChannelActionSchema,
  bulkModelActionSchema,
  bulkOAuthSessionActionSchema,
  codexLoginCompleteSchema,
  codexLoginStartSchema,
  createAccountSchema,
  createAdminTokenSchema,
  createApiKeySchema,
  createChannelSchema,
  createFaultPolicySchema,
  createLimitPlanRequestSchema,
  createModelSchema,
  createModelSpecSchema,
  createModifierSchema,
  createOAuthSessionSchema,
  createOfficialPriceSchema,
  createPluginRequestSchema,
  createPricebookSchema,
  createProxySchema,
  createResourceSchema,
  createRouteGroupSchema,
  createSecretSchema,
  createSubAccountSchema,
  createSubjectSchema,
  createSupplyChannelSchema,
  createSupplyCredentialSchema,
  createSupplyModelSchema,
  createSupplyOfferingSchema,
  createSupplyPriceCardSchema,
  createSupplyPriceCardVersionSchema,
  createSupplyProviderSchema,
  createTenantSchema,
  ensureResourceSchema,
  generateCodesSchema,
  grantModelSchema,
  grantSupplyModelSchema,
  latestAuditRequestSchema,
  modelTestRequestSchema,
  provisionSchema,
  proxyProbeRequestSchema,
  refundJobSchema,
  setFileTtlSchema,
  setLimitPlanRequestSchema,
  supplyPriceCardFromOfficialSchema,
  syncChannelModelsSchema,
  topupSchema,
  topupSubAccountSchema,
  transferCreditsSchema,
  updateApiKeyGroupSchema,
  updateApiKeyModelAllowlistSchema,
  updateChannelModelParamOverrideSchema,
  updateChannelSchema,
  updateCredentialMetaSchema,
  updateFaultPolicySchema,
  updateLimitPlanRequestSchema,
  updateModelSchema,
  updateModelSpecSchema,
  updateModifierSchema,
  updateOfficialPriceSchema,
  updatePluginRequestSchema,
  updatePricebookSchema,
  updateProxySchema,
  updateResourceSchema,
  updateRouteGroupSchema,
  updateSubjectSchema,
  updateSupplyChannelSchema,
  updateSupplyCredentialSchema,
  updateSupplyModelSchema,
  updateSupplyOfferingSchema,
  updateSupplyProviderSchema,
  updateTenantSchema,
};
export type UpdateCredentialMetaDto = z.infer<typeof updateCredentialMetaSchema>;
export type BulkModelActionDto = z.infer<typeof bulkModelActionSchema>;
export type BulkChannelActionDto = z.infer<typeof bulkChannelActionSchema>;
export type BulkOAuthSessionActionDto = z.infer<typeof bulkOAuthSessionActionSchema>;
export type LatestAuditRequestDto = z.infer<typeof latestAuditRequestSchema>;
export type CreatePluginDto = z.infer<typeof createPluginRequestSchema>;
export type UpdatePluginDto = z.infer<typeof updatePluginRequestSchema>;

export type CreateTenantDto = z.infer<typeof createTenantSchema>;
export type UpdateTenantDto = z.infer<typeof updateTenantSchema>;
export type CreateSubjectDto = z.infer<typeof createSubjectSchema>;
export type UpdateSubjectDto = z.infer<typeof updateSubjectSchema>;
export type CreateSubAccountDto = z.infer<typeof createSubAccountSchema>;
export type TopupSubAccountDto = z.infer<typeof topupSubAccountSchema>;
export type TransferCreditsDto = z.infer<typeof transferCreditsSchema>;
// (dto type aliases above are consumed by admin.service + admin.controller)
export type CreateAccountDto = z.infer<typeof createAccountSchema>;
export type TopupDto = z.infer<typeof topupSchema>;
export type SetFileTtlDto = z.infer<typeof setFileTtlSchema>;
export type RefundJobDto = z.infer<typeof refundJobSchema>;
export type CreateApiKeyDto = z.infer<typeof createApiKeySchema>;
export type CreateAdminTokenDto = z.infer<typeof createAdminTokenSchema>;
export type UpdateApiKeyGroupDto = z.infer<typeof updateApiKeyGroupSchema>;
export type CreateResourceDto = z.infer<typeof createResourceSchema>;
export type UpdateResourceDto = z.infer<typeof updateResourceSchema>;
export type EnsureResourceDto = z.infer<typeof ensureResourceSchema>;
export type CreateLimitPlanDto = z.infer<typeof createLimitPlanRequestSchema>;
export type UpdateLimitPlanDto = z.infer<typeof updateLimitPlanRequestSchema>;
export type SetLimitPlanDto = z.infer<typeof setLimitPlanRequestSchema>;
export type CreateChannelDto = z.infer<typeof createChannelSchema>;
export type UpdateChannelDto = z.infer<typeof updateChannelSchema>;
export type UpdateChannelModelParamOverrideDto = z.infer<
  typeof updateChannelModelParamOverrideSchema
>;
export type SyncChannelModelsDto = z.infer<typeof syncChannelModelsSchema>;
export type CreatePricebookDto = z.infer<typeof createPricebookSchema>;
export type UpdatePricebookDto = z.infer<typeof updatePricebookSchema>;
export type CreateModifierDto = z.infer<typeof createModifierSchema>;
export type UpdateModifierDto = z.infer<typeof updateModifierSchema>;
export type CreateModelDto = z.infer<typeof createModelSchema>;
export type UpdateModelDto = z.infer<typeof updateModelSchema>;
export type CreateModelSpecDto = z.infer<typeof createModelSpecSchema>;
export type UpdateModelSpecDto = z.infer<typeof updateModelSpecSchema>;
export type GrantModelDto = z.infer<typeof grantModelSchema>;
export type ModelTestDto = z.infer<typeof modelTestRequestSchema>;
export type CreateFaultPolicyDto = z.infer<typeof createFaultPolicySchema>;
export type UpdateFaultPolicyDto = z.infer<typeof updateFaultPolicySchema>;
export type CreateProxyDto = z.infer<typeof createProxySchema>;
export type UpdateProxyDto = z.infer<typeof updateProxySchema>;
export type ProxyProbeDto = z.infer<typeof proxyProbeRequestSchema>;
export type CreateSecretDto = z.infer<typeof createSecretSchema>;
export type GenerateCodesDto = z.infer<typeof generateCodesSchema>;
export type ProvisionDto = z.infer<typeof provisionSchema>;
export type CreateOfficialPriceDto = z.infer<typeof createOfficialPriceSchema>;
export type UpdateOfficialPriceDto = z.infer<typeof updateOfficialPriceSchema>;
export type CreateRouteGroupDto = z.infer<typeof createRouteGroupSchema>;
export type UpdateRouteGroupDto = z.infer<typeof updateRouteGroupSchema>;
export type AddGroupChannelDto = z.infer<typeof addGroupChannelSchema>;

// --- OAuth / codex schemas (now single-sourced in @actionow/contracts) ------
// Re-exported above; the inferred-type aliases keep the controller's existing
// `CreateOAuthSessionDto` / `CodexLoginStart` / `CodexLoginComplete` names.
export type CreateOAuthSessionDto = z.infer<typeof createOAuthSessionSchema>;
export type CodexLoginStart = z.infer<typeof codexLoginStartSchema>;
export type CodexLoginComplete = z.infer<typeof codexLoginCompleteSchema>;

// --- supply skeleton (model-supply greenfield 批次1) --------------------------
// Bodies single-sourced in @actionow/contracts (supply-requests.ts) and
// re-exported above; consumed by supply.controller / supply.service.
export type CreateSupplyProviderDto = z.infer<typeof createSupplyProviderSchema>;
export type UpdateSupplyProviderDto = z.infer<typeof updateSupplyProviderSchema>;
export type CreateSupplyChannelDto = z.infer<typeof createSupplyChannelSchema>;
export type UpdateSupplyChannelDto = z.infer<typeof updateSupplyChannelSchema>;
export type CreateSupplyCredentialDto = z.infer<typeof createSupplyCredentialSchema>;
export type UpdateSupplyCredentialDto = z.infer<typeof updateSupplyCredentialSchema>;
export type CreateSupplyModelDto = z.infer<typeof createSupplyModelSchema>;
export type UpdateSupplyModelDto = z.infer<typeof updateSupplyModelSchema>;
export type GrantSupplyModelDto = z.infer<typeof grantSupplyModelSchema>;
export type SupplyPriceCardFromOfficialDto = z.infer<typeof supplyPriceCardFromOfficialSchema>;
export type CreateSupplyOfferingDto = z.infer<typeof createSupplyOfferingSchema>;
export type UpdateSupplyOfferingDto = z.infer<typeof updateSupplyOfferingSchema>;
export type CreateSupplyPriceCardDto = z.infer<typeof createSupplyPriceCardSchema>;
export type CreateSupplyPriceCardVersionDto = z.infer<typeof createSupplyPriceCardVersionSchema>;
export type UpdateApiKeyModelAllowlistDto = z.infer<typeof updateApiKeyModelAllowlistSchema>;
// 批次5 slice2: 发现与批建 (supply-discovery.ts) — consumed by
// supply.controller / supply-onboarding.service.
export type BatchCreateSupplyOfferingsDto = z.infer<typeof batchCreateSupplyOfferingsSchema>;
export type BatchProbeEnableSupplyOfferingsDto = z.infer<
  typeof batchProbeEnableSupplyOfferingsSchema
>;

// --- Query schemas (GET; `z.coerce`/query-params — no body twin, stay local) -

/** `GET /admin/analytics/usage` — usage rollup query. */
export const analyticsUsageQuerySchema = z.object({
  groupBy: z.enum(['minute', 'hour', 'day', 'model', 'tenant', 'channel', 'api_key']),
  tenantId: z.string().uuid().optional(),
  from: z.string().datetime().optional(), // ISO 8601
  to: z.string().datetime().optional(),
});
export type AnalyticsUsageQueryDto = z.infer<typeof analyticsUsageQuerySchema>;

/**
 * `GET /admin/relay-traces` — filter + paginate the upstream audit trace. Every
 * filter is optional (absent → unconstrained); `from`/`to` are an inclusive
 * `created_at` range. `limit` is coerced from the query string to an int (the
 * keyset helper clamps it to `[1,200]`); `cursor` is the opaque keyset token.
 */
export const relayTraceQuerySchema = z.object({
  jobId: z.string().uuid().optional(),
  tenantId: z.string().uuid().optional(),
  providerType: z.string().optional(),
  channelId: z.string().uuid().optional(),
  from: z.string().datetime().optional(), // ISO 8601
  to: z.string().datetime().optional(),
  /** Exact upstream status code (e.g. 503). */
  responseStatus: z.coerce.number().int().optional(),
  /** `true` → only failures (status >= 400 or a captured error). */
  errorsOnly: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  /** Restrict to streaming / non-streaming calls. */
  isStream: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  /** 染色: narrow to the route tag (canary) the call was pinned to (exact match). */
  routeTag: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
  cursor: z.string().optional(),
});
export type RelayTraceQueryDto = z.infer<typeof relayTraceQuerySchema>;

/**
 * `GET /admin/redemption-codes` — list minted codes. Optional `status`
 * (`unused`/`redeemed`) filter; `limit`/`cursor` are the keyset paging params.
 *
 * NOTE: `redemption_code` has no `resource_id` — codes are tenant-agnostic credit
 * grants — so the plan's `resourceId` filter has no column to bind to and is not
 * accepted (an unknown query field is silently ignored by the schema).
 */
export const redemptionCodesQuerySchema = z.object({
  status: z.enum(['unused', 'redeemed']).optional(),
  limit: z.coerce.number().int().positive().optional(),
  cursor: z.string().optional(),
});
export type RedemptionCodesQueryDto = z.infer<typeof redemptionCodesQuerySchema>;

/**
 * `GET /admin/official-prices` — list catalog rows. Optional `provider` filter;
 * `limit`/`cursor` are the keyset paging params.
 */
export const officialPricesQuerySchema = z.object({
  provider: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().optional(),
  cursor: z.string().optional(),
});
export type OfficialPricesQueryDto = z.infer<typeof officialPricesQuerySchema>;

/**
 * `GET /admin/model-specs` — list the model spec catalog (规格库). Optional
 * `vendor` / `type` filters; `limit`/`cursor` are the keyset paging params.
 */
export const modelSpecsQuerySchema = z.object({
  vendor: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().optional(),
  cursor: z.string().optional(),
});
export type ModelSpecsQueryDto = z.infer<typeof modelSpecsQuerySchema>;
