import {
  addGroupChannelSchema,
  createAccountSchema,
  createApiKeySchema,
  createChannelSchema,
  createModelSchema,
  createModifierSchema,
  createOfficialPriceSchema,
  createPricebookSchema,
  createResourceSchema,
  createRouteGroupSchema,
  createSecretSchema,
  createTenantSchema,
  difyImportSchema,
  generateCodesSchema,
  grantModelSchema,
  syncChannelModelsSchema,
  topupSchema,
  updateApiKeyGroupSchema,
  updateChannelSchema,
  updateDifySchema,
  updateModelSchema,
  updateModifierSchema,
  updateOfficialPriceSchema,
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
 * inferred-type aliases. The **query** schemas (GET; `z.coerce`) and the
 * **oauth/codex** schemas have no frontend body twin and stay defined locally.
 *
 * CREDIT CONVENTION: every credit-denominated field is a HUMAN credit amount
 * (e.g. `100` = 100 credits). The controller converts it to integer µcredits
 * with `creditsToMicro` before persisting; responses serialize the stored
 * µcredits as decimal strings. Schemas never carry µcredits.
 */

// --- Request-body schemas (single source of truth in @actionow/contracts) ---
export {
  addGroupChannelSchema,
  createAccountSchema,
  createApiKeySchema,
  createChannelSchema,
  createModelSchema,
  createModifierSchema,
  createOfficialPriceSchema,
  createPricebookSchema,
  createResourceSchema,
  createRouteGroupSchema,
  createSecretSchema,
  createTenantSchema,
  difyImportSchema,
  generateCodesSchema,
  grantModelSchema,
  syncChannelModelsSchema,
  topupSchema,
  updateApiKeyGroupSchema,
  updateChannelSchema,
  updateDifySchema,
  updateModelSchema,
  updateModifierSchema,
  updateOfficialPriceSchema,
  updatePricebookSchema,
  updateResourceSchema,
  updateRouteGroupSchema,
  updateTenantSchema,
};

export type CreateTenantDto = z.infer<typeof createTenantSchema>;
export type UpdateTenantDto = z.infer<typeof updateTenantSchema>;
export type CreateAccountDto = z.infer<typeof createAccountSchema>;
export type TopupDto = z.infer<typeof topupSchema>;
export type CreateApiKeyDto = z.infer<typeof createApiKeySchema>;
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
export type CreateOfficialPriceDto = z.infer<typeof createOfficialPriceSchema>;
export type UpdateOfficialPriceDto = z.infer<typeof updateOfficialPriceSchema>;
export type CreateRouteGroupDto = z.infer<typeof createRouteGroupSchema>;
export type UpdateRouteGroupDto = z.infer<typeof updateRouteGroupSchema>;
export type AddGroupChannelDto = z.infer<typeof addGroupChannelSchema>;

// --- OAuth / codex schemas (no frontend body twin — stay local) -------------

/**
 * `POST /admin/oauth-sessions` — register a BYO OAuth-subscription session by
 * pasting the auth-json the operator exported after running the provider's OAuth
 * on their own machine. Gated by `ENABLE_OAUTH_CHANNELS` + an explicit ToS ack
 * (`acknowledgeUpstreamTos: true`). The tokens are encrypted at rest and never
 * returned. `.passthrough()` keeps any extra export fields without rejecting.
 */
export const createOAuthSessionSchema = z.object({
  providerKind: z.enum(['codex-oauth']),
  authJson: z
    .object({
      access_token: z.string().min(1),
      refresh_token: z.string().min(1),
      id_token: z.string().optional(),
      expires_in: z.number().optional(),
      expired: z.string().optional(), // some exports store an RFC3339 expiry string
      account_id: z.string().optional(),
      account_label: z.string().optional(),
      email: z.string().optional(),
    })
    .passthrough(),
  /** Must be exactly `true`: an explicit acknowledgement of the upstream ToS. */
  acknowledgeUpstreamTos: z.literal(true),
});
export type CreateOAuthSessionDto = z.infer<typeof createOAuthSessionSchema>;

/**
 * `POST /admin/oauth-sessions/codex/login/start` — begin the turnkey server-side
 * codex OAuth login. Gated by `ENABLE_OAUTH_CHANNELS` + an explicit ToS ack. The
 * server generates a PKCE pair and returns an `authorize_url` the operator opens
 * plus the sealed `state` (the PKCE verifier encrypted into it) to echo back to
 * `.../complete`. No server-side state is stored between the two calls.
 */
export const codexLoginStartSchema = z.object({
  /** Must be exactly `true`: an explicit acknowledgement of the upstream ToS. */
  acknowledgeUpstreamTos: z.literal(true),
});
export type CodexLoginStart = z.infer<typeof codexLoginStartSchema>;

/**
 * `POST /admin/oauth-sessions/codex/login/complete` — finish the codex login by
 * exchanging the authorization `code` for tokens. `state` is the sealed value
 * returned by `.../start` (carries the PKCE verifier); an optional `accountLabel`
 * overrides the label derived from the id_token. The tokens are encrypted at
 * rest and never returned.
 */
export const codexLoginCompleteSchema = z.object({
  /** Must be exactly `true`: an explicit acknowledgement of the upstream ToS. */
  acknowledgeUpstreamTos: z.literal(true),
  /** The authorization code the operator pasted back from the callback. */
  code: z.string().min(1),
  /** The sealed state from `.../start` (the PKCE verifier, encrypted). */
  state: z.string().min(1),
  /** Optional label override (falls back to the id_token email/account). */
  accountLabel: z.string().min(1).optional(),
});
export type CodexLoginComplete = z.infer<typeof codexLoginCompleteSchema>;

// --- Query schemas (GET; `z.coerce`/query-params — no body twin, stay local) -

/** `GET /admin/analytics/usage` — usage rollup query. */
export const analyticsUsageQuerySchema = z.object({
  groupBy: z.enum(['day', 'model', 'tenant', 'channel', 'api_key']),
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
