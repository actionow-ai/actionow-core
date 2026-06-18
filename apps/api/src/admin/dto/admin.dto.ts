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

/**
 * `PATCH /admin/tenants/:id` — update a tenant. Only `isolationMode` is mutable
 * here (the tenant name/id are not). There is intentionally NO tenant DELETE —
 * cascading a tenant removal from an admin route is too destructive.
 */
export const updateTenantSchema = z.object({
  isolationMode: z.enum(['field', 'schema', 'db']).optional(),
});
export type UpdateTenantDto = z.infer<typeof updateTenantSchema>;

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
  /**
   * The route group (分组; Track 3) to bind this key to; omitted → null (the key
   * falls back to the `default` group at routing time). The service validates
   * the group exists.
   */
  routeGroupId: z.string().uuid().optional(),
});
export type CreateApiKeyDto = z.infer<typeof createApiKeySchema>;

/**
 * `PATCH /admin/api-keys/:id/group` — (re)bind a key's route group (Track 3). The
 * `routeGroupId` is REQUIRED on the body but nullable: a uuid binds the key,
 * `null` unbinds it (→ the `default` group resolves at routing time). The
 * service validates a non-null group exists.
 */
export const updateApiKeyGroupSchema = z.object({
  routeGroupId: z.string().uuid().nullable(),
});
export type UpdateApiKeyGroupDto = z.infer<typeof updateApiKeyGroupSchema>;

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

/**
 * `PATCH /admin/resources/:id` — update a resource. Limited to SAFE fields:
 * only `status` (`active`/`disabled`) is mutable. The key fields
 * (`id`/`kind`/`modality`/`providerType`) are immutable here — changing them
 * would silently corrupt the routing/pricing a frozen resource version assumes.
 */
export const updateResourceSchema = z.object({
  status: z.enum(['active', 'disabled']).optional(),
});
export type UpdateResourceDto = z.infer<typeof updateResourceSchema>;

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
  /** Operator cost in HUMAN USD/1M INPUT tokens → µUSD/1M (Track 5); `null` clears it. */
  inputCostUsdPer1m: z.number().nonnegative().nullable().optional(),
  /** Operator cost in HUMAN USD/1M OUTPUT tokens → µUSD/1M (Track 5); `null` clears it. */
  outputCostUsdPer1m: z.number().nonnegative().nullable().optional(),
});
export type UpdateChannelDto = z.infer<typeof updateChannelSchema>;

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
export type SyncChannelModelsDto = z.infer<typeof syncChannelModelsSchema>;

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
export type UpdatePricebookDto = z.infer<typeof updatePricebookSchema>;

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
export type UpdateModifierDto = z.infer<typeof updateModifierSchema>;

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
export type UpdateDifyDto = z.infer<typeof updateDifySchema>;

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
  status: z.enum(['active', 'disabled']).optional(),
});
export type UpdateModelDto = z.infer<typeof updateModelSchema>;

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
 * `POST /admin/official-prices` — add a row to the official model price catalog
 * (Track 2; spec D7). The three price fields are HUMAN USD-per-1M-tokens (e.g.
 * `1.25` = $1.25 per 1M tokens, like the provider's published list price); the
 * service converts each to integer µUSD/1M = `round(usd × 1_000_000)` before
 * persisting (the boundary conversion mirrors `creditsToMicro`). `modelSlug` is
 * normalized to the catalog's canonical form by the service. `provider` is the
 * catalog provider key (`openai`/`anthropic`/`google`/…).
 */
export const createOfficialPriceSchema = z.object({
  provider: z.string().min(1),
  modelSlug: z.string().min(1),
  displayName: z.string().min(1).optional(),
  /** HUMAN USD per 1M input tokens (e.g. 1.25) → µUSD/1M in the service. */
  inputUsdPer1m: z.number().positive(),
  /** HUMAN USD per 1M output tokens. */
  outputUsdPer1m: z.number().positive(),
  /** Optional HUMAN USD per 1M cached-input tokens. */
  cachedInputUsdPer1m: z.number().positive().optional(),
  sourceUrl: z.string().url().optional(),
  effectiveAt: z.string().datetime().optional(), // ISO 8601
  notes: z.string().optional(),
});
export type CreateOfficialPriceDto = z.infer<typeof createOfficialPriceSchema>;

/**
 * `PATCH /admin/official-prices/:id` — update a catalog row. Every field is
 * optional (omitted = unchanged). The USD-per-1M price fields are converted to
 * µUSD/1M by the service (same convention as create). `cachedInputUsdPer1m` /
 * `displayName` / `sourceUrl` / `effectiveAt` / `notes` may be cleared with
 * `null`. `provider`/`modelSlug` are NOT patchable (a re-slug is a new row).
 */
export const updateOfficialPriceSchema = z.object({
  displayName: z.string().min(1).nullable().optional(),
  inputUsdPer1m: z.number().positive().optional(),
  outputUsdPer1m: z.number().positive().optional(),
  cachedInputUsdPer1m: z.number().positive().nullable().optional(),
  sourceUrl: z.string().url().nullable().optional(),
  effectiveAt: z.string().datetime().nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type UpdateOfficialPriceDto = z.infer<typeof updateOfficialPriceSchema>;

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
 * `POST /admin/route-groups` — create a route group (分组; Track 3). `groupRatioBps`
 * is the customer-price ratio in integer BASIS POINTS (`10000 = 1.0×`); entered
 * directly as bps (NOT a float), defaults to 10000. `(name)` is unique among LIVE
 * groups (the service maps a collision to a clean 400).
 */
export const createRouteGroupSchema = z.object({
  name: z.string().min(1),
  /** Customer-price ratio in basis points (`10000 = 1.0×`). Defaults to 10000. */
  groupRatioBps: z.number().int().positive().optional(),
  description: z.string().optional(),
  status: z.enum(['active', 'disabled']).optional(),
});
export type CreateRouteGroupDto = z.infer<typeof createRouteGroupSchema>;

/**
 * `PATCH /admin/route-groups/:id` — update a route group. Every field is optional
 * (omitted = unchanged). `groupRatioBps` stays integer basis points (same
 * convention as create). `description` may be set to `null` to clear it.
 */
export const updateRouteGroupSchema = z.object({
  name: z.string().min(1).optional(),
  groupRatioBps: z.number().int().positive().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  description: z.string().nullable().optional(),
});
export type UpdateRouteGroupDto = z.infer<typeof updateRouteGroupSchema>;

/**
 * `PUT /admin/route-groups/:id/channels/:channelId` — add (or update) a channel's
 * membership in a group with its per-(group,channel) routing knobs. The `:id`
 * (group) and `:channelId` come from the PATH; the BODY carries only `priority`
 * (HIGHER = tried first) and `weight` (weighted-random within a tier), which
 * default to 0/1. A PUT for an already-member channel upserts (updates
 * priority/weight) — the PUT verb makes the upsert idempotent on the membership
 * URL.
 */
export const addGroupChannelSchema = z.object({
  /** HIGHER = tried first (fallback tier). Defaults to 0. */
  priority: z.number().int().optional(),
  /** Weighted-random weight within a priority tier. Defaults to 1. */
  weight: z.number().int().positive().optional(),
});
export type AddGroupChannelDto = z.infer<typeof addGroupChannelSchema>;
