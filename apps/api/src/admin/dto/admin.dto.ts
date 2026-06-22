import {
  addGroupChannelSchema,
  codexLoginCompleteSchema,
  codexLoginStartSchema,
  createAccountSchema,
  createAdminTokenSchema,
  createApiKeySchema,
  createChannelSchema,
  createModelSchema,
  createModifierSchema,
  createOAuthSessionSchema,
  createOfficialPriceSchema,
  createPluginRequestSchema,
  createPricebookSchema,
  createResourceSchema,
  createRouteGroupSchema,
  createSecretSchema,
  createTenantSchema,
  difyImportSchema,
  generateCodesSchema,
  grantModelSchema,
  provisionSchema,
  syncChannelModelsSchema,
  testPluginRequestSchema,
  topupSchema,
  updateApiKeyGroupSchema,
  updateChannelSchema,
  updateCredentialMetaSchema,
  updateDifySchema,
  updateModelSchema,
  updateModifierSchema,
  updateOfficialPriceSchema,
  updatePluginRequestSchema,
  updatePricebookSchema,
  updateResourceSchema,
  updateRouteGroupSchema,
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
  codexLoginCompleteSchema,
  codexLoginStartSchema,
  createAccountSchema,
  createAdminTokenSchema,
  createApiKeySchema,
  createChannelSchema,
  createModelSchema,
  createModifierSchema,
  createOAuthSessionSchema,
  createOfficialPriceSchema,
  createPluginRequestSchema,
  createPricebookSchema,
  createResourceSchema,
  createRouteGroupSchema,
  createSecretSchema,
  createTenantSchema,
  difyImportSchema,
  generateCodesSchema,
  grantModelSchema,
  provisionSchema,
  syncChannelModelsSchema,
  testPluginRequestSchema,
  topupSchema,
  updateApiKeyGroupSchema,
  updateChannelSchema,
  updateCredentialMetaSchema,
  updateDifySchema,
  updateModelSchema,
  updateModifierSchema,
  updateOfficialPriceSchema,
  updatePluginRequestSchema,
  updatePricebookSchema,
  updateResourceSchema,
  updateRouteGroupSchema,
  updateTenantSchema,
};
export type UpdateCredentialMetaDto = z.infer<typeof updateCredentialMetaSchema>;
export type CreatePluginDto = z.infer<typeof createPluginRequestSchema>;
export type UpdatePluginDto = z.infer<typeof updatePluginRequestSchema>;
export type TestPluginDto = z.infer<typeof testPluginRequestSchema>;

export type CreateTenantDto = z.infer<typeof createTenantSchema>;
export type UpdateTenantDto = z.infer<typeof updateTenantSchema>;
export type CreateAccountDto = z.infer<typeof createAccountSchema>;
export type TopupDto = z.infer<typeof topupSchema>;
export type CreateApiKeyDto = z.infer<typeof createApiKeySchema>;
export type CreateAdminTokenDto = z.infer<typeof createAdminTokenSchema>;
export type UpdateApiKeyGroupDto = z.infer<typeof updateApiKeyGroupSchema>;
export type CreateResourceDto = z.infer<typeof createResourceSchema>;
export type UpdateResourceDto = z.infer<typeof updateResourceSchema>;
export type CreateChannelDto = z.infer<typeof createChannelSchema>;
export type UpdateChannelDto = z.infer<typeof updateChannelSchema>;
export type SyncChannelModelsDto = z.infer<typeof syncChannelModelsSchema>;
export type CreatePricebookDto = z.infer<typeof createPricebookSchema>;
export type UpdatePricebookDto = z.infer<typeof updatePricebookSchema>;
export type CreateModifierDto = z.infer<typeof createModifierSchema>;
export type UpdateModifierDto = z.infer<typeof updateModifierSchema>;
export type DifyImportDto = z.infer<typeof difyImportSchema>;
export type UpdateDifyDto = z.infer<typeof updateDifySchema>;
export type CreateModelDto = z.infer<typeof createModelSchema>;
export type UpdateModelDto = z.infer<typeof updateModelSchema>;
export type GrantModelDto = z.infer<typeof grantModelSchema>;
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
