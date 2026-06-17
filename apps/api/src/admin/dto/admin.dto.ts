import { z } from 'zod';

/**
 * Zod request schemas for the admin CRUD surface. The contracts/domain packages
 * use zod, so the admin boundary does too (validated via the `ZodBody` pipe).
 *
 * CREDIT CONVENTION: every credit-denominated field below is a HUMAN credit
 * amount (e.g. `100` = 100 credits). The controller converts it to integer
 * µcredits with `creditsToMicro` before persisting; responses serialize the
 * stored µcredits as decimal strings. Schemas never carry µcredits.
 */

/** `POST /admin/tenants` — create a tenant. */
export const createTenantSchema = z.object({
  name: z.string().min(1),
  isolationMode: z.enum(['field', 'schema', 'db']).optional(),
});
export type CreateTenantDto = z.infer<typeof createTenantSchema>;

/** `POST /admin/accounts` — create an account (opening balance in credits). */
export const createAccountSchema = z.object({
  tenantId: z.string().uuid(),
  /** Opening balance in HUMAN credits (converted to µcredits). */
  credits: z.number().nonnegative().optional(),
});
export type CreateAccountDto = z.infer<typeof createAccountSchema>;

/** `POST /admin/accounts/:id/topup` — credit an account (amount in credits). */
export const topupSchema = z.object({
  /** Amount in HUMAN credits to add (converted to µcredits). */
  credits: z.number().positive(),
});
export type TopupDto = z.infer<typeof topupSchema>;

/** `POST /admin/api-keys` — mint a key (plaintext returned once). */
export const createApiKeySchema = z.object({
  tenantId: z.string().uuid(),
  resourceAllowlist: z.array(z.string()).optional(),
  /** Per-(tenant,resource) requests-per-minute cap; omitted → default. */
  rateLimit: z.number().int().positive().optional(),
});
export type CreateApiKeyDto = z.infer<typeof createApiKeySchema>;

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
export type CreateResourceDto = z.infer<typeof createResourceSchema>;

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
});
export type CreateChannelDto = z.infer<typeof createChannelSchema>;

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
});
export type UpdateChannelDto = z.infer<typeof updateChannelSchema>;

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
export type CreatePricebookDto = z.infer<typeof createPricebookSchema>;

/** `POST /admin/modifiers` — add a pricing modifier (§9.2 scope). */
export const createModifierSchema = z.object({
  /** `global` | `tenant:<id>` | `capability:<id>` | `resource:<id>`. */
  scope: z.string().min(1),
  whenExpr: z.string().optional(),
  op: z.enum(['override_rate', 'percent_off', 'flat_off', 'percent_add']),
  /**
   * For percent ops (`percent_off`/`percent_add`) this is a whole-percent int.
   * For credit ops (`flat_off`/`override_rate`) this is a HUMAN-credit amount
   * the controller converts to µcredits.
   */
  value: z.number().optional(),
  stackable: z.boolean().optional(),
  priority: z.number().int().optional(),
  version: z.number().int().positive().optional(),
  active: z.boolean().optional(),
});
export type CreateModifierDto = z.infer<typeof createModifierSchema>;

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
export type DifyImportDto = z.infer<typeof difyImportSchema>;

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
  status: z.enum(['active', 'disabled']).optional(),
});
export type CreateModelDto = z.infer<typeof createModelSchema>;

/** `POST /admin/models/:name/grants` — grant a tenant-visibility model. */
export const grantModelSchema = z.object({
  tenantId: z.string().uuid(),
});
export type GrantModelDto = z.infer<typeof grantModelSchema>;

/** `POST /admin/secrets` — create an encrypted-at-rest credential. */
export const createSecretSchema = z.object({
  value: z.string().min(1),
  label: z.string().optional(),
});
export type CreateSecretDto = z.infer<typeof createSecretSchema>;

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

/** `GET /admin/analytics/usage` — usage rollup query. */
export const analyticsUsageQuerySchema = z.object({
  groupBy: z.enum(['day', 'model', 'tenant', 'channel', 'api_key']),
  tenantId: z.string().uuid().optional(),
  from: z.string().datetime().optional(), // ISO 8601
  to: z.string().datetime().optional(),
});
export type AnalyticsUsageQueryDto = z.infer<typeof analyticsUsageQuerySchema>;

/** `POST /admin/redemption-codes` — batch-mint codes. */
export const generateCodesSchema = z.object({
  /** How many codes to mint (1..1000). */
  count: z.number().int().min(1).max(1000),
  /** HUMAN-credit grant per code (converted to µcredits). */
  creditsPerCode: z.number().positive(),
  /** Optional ISO-8601 expiry; absent → never expires. */
  expiresAt: z.string().datetime().optional(),
});
export type GenerateCodesDto = z.infer<typeof generateCodesSchema>;
