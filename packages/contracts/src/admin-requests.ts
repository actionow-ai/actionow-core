import { z } from 'zod';

/**
 * Single source of truth for the core admin control-plane **request bodies**
 * (tenants, accounts, topups, API keys, secrets, redemption codes). Same
 * contract-first pattern as the `*-views.ts` files, but for the write side: the
 * backend admin DTO re-exports these schemas (so `ZodBody` validates against
 * them) and the frontend imports the inferred TYPE only (`import type`), so no
 * zod ships to the browser. These schemas flow into `openapi.json` →
 * `@actionow/sdk` as request bodies.
 *
 * CREDIT CONVENTION (write side): every credit-denominated field is a HUMAN
 * credit amount (e.g. `100` = 100 credits); the controller converts it to
 * integer µcredits with `creditsToMicro` before persisting. Unlike RESPONSE
 * money (always a string), request credits stay a `number`.
 */

/** `POST /admin/tenants` — create a tenant. */
export const createTenantSchema = z.object({
  name: z.string().min(1),
  isolationMode: z.enum(['field', 'schema', 'db']).optional(),
});
export type CreateTenantBody = z.infer<typeof createTenantSchema>;

/**
 * `PATCH /admin/tenants/:id` — update a tenant. Only `isolationMode` is mutable
 * here (the tenant name/id are not). There is intentionally NO tenant DELETE —
 * cascading a tenant removal from an admin route is too destructive.
 */
export const updateTenantSchema = z.object({
  isolationMode: z.enum(['field', 'schema', 'db']).optional(),
});
export type UpdateTenantBody = z.infer<typeof updateTenantSchema>;

/** `POST /admin/accounts` — create an account (opening balance in credits). */
export const createAccountSchema = z.object({
  tenantId: z.string().uuid(),
  /** Opening balance in HUMAN credits (converted to µcredits). */
  credits: z.number().nonnegative().optional(),
});
export type CreateAccountBody = z.infer<typeof createAccountSchema>;

/** `POST /admin/accounts/:id/topup` — credit an account (amount in credits). */
export const topupSchema = z.object({
  /** Amount in HUMAN credits to add (converted to µcredits). */
  credits: z.number().positive(),
});
export type TopupBody = z.infer<typeof topupSchema>;

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
export type CreateApiKeyBody = z.infer<typeof createApiKeySchema>;

/**
 * `PATCH /admin/api-keys/:id/group` — (re)bind a key's route group (Track 3). The
 * `routeGroupId` is REQUIRED on the body but nullable: a uuid binds the key,
 * `null` unbinds it (→ the `default` group resolves at routing time). The
 * service validates a non-null group exists.
 */
export const updateApiKeyGroupSchema = z.object({
  routeGroupId: z.string().uuid().nullable(),
});
export type UpdateApiKeyGroupBody = z.infer<typeof updateApiKeyGroupSchema>;

/**
 * `POST /admin/tokens` — mint an admin SERVICE TOKEN (M2M credential). The
 * plaintext (`at_…`) is returned ONCE. Always full-admin (no scope field). The
 * `expiresAt` is an optional ISO-8601 instant; omitted → the token never expires.
 */
export const createAdminTokenSchema = z.object({
  /** Human label identifying the integration this token is for. */
  name: z.string().min(1),
  /** Optional ISO-8601 expiry; absent → never expires. */
  expiresAt: z.string().datetime().optional(),
});
export type CreateAdminTokenBody = z.infer<typeof createAdminTokenSchema>;

/**
 * `POST /admin/provision` — atomically create a tenant + account + API key in ONE
 * call (the embed-as-backend onboarding path; collapses the 3 separate POSTs). `name`
 * is the tenant name; `credits` is the account's HUMAN-credit opening balance
 * (converted to µcredits server-side); `resourceAllowlist`/`rateLimit` shape the
 * minted key. All but `name` are optional.
 */
export const provisionSchema = z.object({
  name: z.string().min(1),
  isolationMode: z.enum(['field', 'schema', 'db']).optional(),
  credits: z.number().nonnegative().optional(),
  resourceAllowlist: z.array(z.string()).optional(),
  rateLimit: z.number().int().positive().optional(),
});
export type ProvisionBody = z.infer<typeof provisionSchema>;

/** `POST /admin/secrets` — create an encrypted-at-rest credential. */
export const createSecretSchema = z.object({
  value: z.string().min(1),
  label: z.string().optional(),
});
export type CreateSecretBody = z.infer<typeof createSecretSchema>;

/** `POST /admin/redemption-codes` — batch-mint codes. */
export const generateCodesSchema = z.object({
  /** How many codes to mint (1..1000). */
  count: z.number().int().min(1).max(1000),
  /** HUMAN-credit grant per code (converted to µcredits). */
  creditsPerCode: z.number().positive(),
  /** Optional ISO-8601 expiry; absent → never expires. */
  expiresAt: z.string().datetime().optional(),
});
export type GenerateCodesBody = z.infer<typeof generateCodesSchema>;

/**
 * `POST /admin/oauth-sessions` — register an upstream OAuth subscription by pasting
 * the auth-json the operator exported after running the provider's OAuth on their
 * own machine. Gated by an explicit ToS ack (`acknowledgeUpstreamTos: true`). The
 * tokens are encrypted at rest and never returned; `.passthrough()` keeps extra
 * export fields without rejecting.
 */
export const createOAuthSessionSchema = z.object({
  providerKind: z.enum(['codex-oauth']),
  authJson: z
    .object({
      access_token: z.string().min(1),
      refresh_token: z.string().min(1),
      id_token: z.string().optional(),
      expires_in: z.number().optional(),
      expired: z.string().optional(),
      account_id: z.string().optional(),
      account_label: z.string().optional(),
      email: z.string().optional(),
    })
    .passthrough(),
  /** Must be exactly `true`: an explicit acknowledgement of the upstream ToS. */
  acknowledgeUpstreamTos: z.literal(true),
});
export type CreateOAuthSessionBody = z.infer<typeof createOAuthSessionSchema>;

/**
 * `POST /admin/oauth-sessions/codex/login/start` — begin the turnkey server-side
 * codex OAuth login. The server returns an `authorize_url` + sealed `state`; no
 * server-side state is stored between start and complete.
 */
export const codexLoginStartSchema = z.object({
  /** Must be exactly `true`: an explicit acknowledgement of the upstream ToS. */
  acknowledgeUpstreamTos: z.literal(true),
});
export type CodexLoginStartBody = z.infer<typeof codexLoginStartSchema>;

/**
 * `POST /admin/oauth-sessions/codex/login/complete` — finish the codex login by
 * exchanging the authorization `code` for tokens. `state` is the sealed value from
 * `.../start` (carries the PKCE verifier). The tokens are never returned.
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
export type CodexLoginCompleteBody = z.infer<typeof codexLoginCompleteSchema>;

/**
 * `PATCH /admin/oauth-sessions/:id` and `PATCH /admin/secrets/:id` — edit a
 * credential's operator metadata ONLY (never the token/secret material): a human
 * `name`, free-form `notes`, and a free-text `group` tag. Each field is optional
 * (absent = unchanged) and nullable (explicit `null` clears it).
 */
export const updateCredentialMetaSchema = z.object({
  name: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  group: z.string().nullable().optional(),
});
export type UpdateCredentialMetaBody = z.infer<typeof updateCredentialMetaSchema>;
