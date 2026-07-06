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

/**
 * `POST /admin/tenants/:id/users` — create a subject (end-user) under a tenant
 * (unified tenancy G-A). At least one identifier is required: `externalId`
 * (Model B, app-owned) or `email` (Model A, member login). `external_id` is
 * immutable after creation (decision #6).
 */
export const createSubjectSchema = z
  .object({
    externalId: z.string().min(1).optional(),
    email: z.string().email().optional(),
    displayName: z.string().min(1).optional(),
    limitPlanId: z.string().uuid().optional(),
  })
  .refine((b) => b.externalId !== undefined || b.email !== undefined, {
    message: 'one of externalId or email is required',
  });
export type CreateSubjectBody = z.infer<typeof createSubjectSchema>;

/**
 * `PATCH /admin/tenants/:id/users/:sid` — update a subject. `external_id` is
 * intentionally absent (immutable, decision #6). A nullable field clears it.
 */
export const updateSubjectSchema = z.object({
  email: z.string().email().nullable().optional(),
  displayName: z.string().nullable().optional(),
  limitPlanId: z.string().uuid().nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
});
export type UpdateSubjectBody = z.infer<typeof updateSubjectSchema>;

/** `POST /admin/tenants/:id/users/:sid/sub-account` — open a HARD sub-wallet (optional opening balance in credits). */
export const createSubAccountSchema = z.object({
  credits: z.number().nonnegative().optional(),
});
export type CreateSubAccountBody = z.infer<typeof createSubAccountSchema>;

/** `POST /admin/tenants/:id/users/:sid/sub-account/topup` — credit a sub-wallet (amount in credits). */
export const topupSubAccountSchema = z.object({
  credits: z.number().positive(),
});
export type TopupSubAccountBody = z.infer<typeof topupSubAccountSchema>;

/**
 * `POST /admin/tenants/:id/users/:sid/sub-account/transfer` — move credits between
 * the tenant pool and the subject's sub-wallet (same tenant; immutable).
 */
export const transferCreditsSchema = z.object({
  credits: z.number().positive(),
  direction: z.enum(['to_subject', 'to_tenant']),
});
export type TransferCreditsBody = z.infer<typeof transferCreditsSchema>;

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

/** `POST /admin/jobs/:id/refund` — reverse a settled job's charge (amount in credits). */
export const refundJobSchema = z.object({
  /** HUMAN credits to refund; omit → the full remaining refundable (capped at the settled cost). */
  credits: z.number().positive().optional(),
});
export type RefundJobBody = z.infer<typeof refundJobSchema>;

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
  /**
   * The subject (end-user) to scope this key to (unified tenancy G-B); omitted →
   * a tenant-level key. The service validates the subject belongs to the tenant.
   */
  subjectId: z.string().uuid().optional(),
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
  /** HUMAN-credit grant per code, per redemption (converted to µcredits). */
  creditsPerCode: z.number().positive(),
  /** How many times EACH code may be redeemed (>=1; default 1 = single-use 卡密). */
  maxUsesPerCode: z.number().int().min(1).default(1),
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

/**
 * Bulk admin action request bodies (前端打磨 — true bulk endpoints). Each
 * `POST /admin/<entity>/bulk` takes a non-empty `ids[]` + an entity-specific
 * `action`, and returns a {@link bulkResultViewSchema} `{succeeded, failed}` —
 * PARTIAL SUCCESS: one bad id never aborts the whole batch. The action sets
 * differ per entity, so each gets its own schema (the controller validates the
 * action against the right route).
 *
 * `ids` semantics vary by entity:
 * - **models** — model NAMES (the admin identifier; `PATCH /admin/models/:name`).
 * - **channels** — channel IDS (global; the single-row route is nested but ids are flat).
 * - **oauth-sessions** — session (secret_ref) IDS.
 */

/** `POST /admin/models/bulk` — enable/disable/delete a batch of models (by name). */
export const bulkModelActionSchema = z.object({
  ids: z.array(z.string()).min(1),
  action: z.enum(['enable', 'disable', 'delete']),
});
export type BulkModelActionBody = z.infer<typeof bulkModelActionSchema>;

/** `POST /admin/channels/bulk` — enable/disable/delete a batch of channels (by id). */
export const bulkChannelActionSchema = z.object({
  ids: z.array(z.string()).min(1),
  action: z.enum(['enable', 'disable', 'delete']),
});
export type BulkChannelActionBody = z.infer<typeof bulkChannelActionSchema>;

/** `POST /admin/oauth-sessions/bulk` — revoke a batch of OAuth sessions (by id). */
export const bulkOAuthSessionActionSchema = z.object({
  ids: z.array(z.string()).min(1),
  action: z.enum(['revoke']),
});
export type BulkOAuthSessionActionBody = z.infer<typeof bulkOAuthSessionActionSchema>;

/**
 * `POST /admin/audit-log/latest` (前端打磨 — audit/version badges) — fetch the
 * newest `audit_log` row per target in ONE batch, for the `target_id`s visible
 * on an entity-list page. `target_type` scopes to one entity kind
 * (`channel`/`model`/`fault_policy`/`limit_plan`/`route_group`); `ids` is the
 * visible target ids (empty → empty result). Returns
 * {@link latestAuditViewSchema}[] — only ids that have an audit row.
 */
export const latestAuditRequestSchema = z.object({
  target_type: z.string(),
  ids: z.array(z.string()),
});
export type LatestAuditRequestBody = z.infer<typeof latestAuditRequestSchema>;

/**
 * `POST /admin/accounts/:id/file-ttl` — set/clear a tenant's opt-in file
 * lifecycle / TTL retention (per-tenant `account.config.file_ttl_days`). A
 * STRICTLY POSITIVE integer day count opts the tenant into the worker's
 * file-lifecycle sweep (files older than N days are soft-deleted + best-effort
 * removed from the bucket); `null` disables it (retain forever — the default).
 * Zero/negative is rejected by `.positive()` (0 would mean delete-everything-now,
 * a data-loss footgun — require `null` to disable instead).
 */
export const setFileTtlSchema = z.object({
  days: z.number().int().positive().nullable(),
});
export type SetFileTtlBody = z.infer<typeof setFileTtlSchema>;
