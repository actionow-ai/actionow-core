import { z } from 'zod';

/**
 * Single source of truth for the tenant self-service **console** wire views
 * (`/console/*`, scoped by the caller's JWT — the tenant is never in the body).
 * Same contract-first pattern as `admin-views.ts`: the backend `toView` mappers
 * `.parse()` against these schemas; the frontend imports the inferred TYPE only
 * (`import type`), so no zod ships to the browser. Money is always a µ-unit
 * decimal **string** (bigint serialized), never a JS number.
 *
 * The console views deliberately OMIT `tenant_id` / `route_group_id`: the token
 * already scopes every row to the caller's own tenant.
 */

/** A tenant's own API key (`GET /console/api-keys`; no hash, no tenant scope fields). */
export const consoleApiKeyViewSchema = z.object({
  id: z.string(),
  resource_allowlist: z.array(z.string()),
  rate_limit: z.number().nullable(),
  status: z.string(),
  /** The end-user (subject) this key is bound to (end-user data plane); `null` → tenant-level. */
  subject_id: z.string().nullable(),
  created_at: z.string(),
});
export type ConsoleApiKeyView = z.infer<typeof consoleApiKeyViewSchema>;

/** One of the caller-tenant's jobs (`GET /console/usage` → `jobs`). `cost` is a µcredit string. */
export const consoleJobViewSchema = z.object({
  job_id: z.string(),
  /** The end-user (subject) this job was attributed to (记录系统); `null` → tenant-level. */
  subject_id: z.string().nullable(),
  resource_id: z.string(),
  status: z.string(),
  exec_mode: z.string(),
  cost: z.string().nullable(),
  created_at: z.string(),
});
export type ConsoleJobView = z.infer<typeof consoleJobViewSchema>;

/** One of the caller-tenant's ledger rows (`GET /console/usage` → `ledger`). Money is µcredit strings. */
export const consoleLedgerViewSchema = z.object({
  id: z.string(),
  /** The end-user (subject) this money movement was attributed to (记录系统); `null` → pool. */
  subject_id: z.string().nullable(),
  type: z.string(),
  credits_delta: z.string(),
  balance_after: z.string(),
  job_id: z.string().nullable(),
  created_at: z.string(),
});
export type ConsoleLedgerView = z.infer<typeof consoleLedgerViewSchema>;

/** One model visible to the caller's tenant (`GET /console/models`). `capabilities` is free-form JSON. */
export const consoleModelViewSchema = z.object({
  name: z.string(),
  display: z.string(),
  modality: z.string(),
  capabilities: z.unknown(),
  visibility: z.string(),
  /** Catalog facets (catalog-tags-ia): free-form tags, maker, context window, reasoning mode. */
  tags: z.array(z.string()),
  maker: z.string().nullable(),
  context_length: z.number().nullable(),
  reasoning: z.string().nullable(),
});
export type ConsoleModelView = z.infer<typeof consoleModelViewSchema>;

/** One per-call usage-log row for the caller's tenant (`GET /console/usage-log`; tenant implicit). */
export const consoleUsageLogViewSchema = z.object({
  id: z.string(),
  /** The end-user (subject) this call was attributed to (记录系统); `null` → tenant-level. */
  subject_id: z.string().nullable(),
  model: z.string(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cost: z.string(),
  latency_ms: z.number().nullable(),
  status: z.string(),
  created_at: z.string(),
});
export type ConsoleUsageLogView = z.infer<typeof consoleUsageLogViewSchema>;

/**
 * One aggregated usage bucket for the caller's tenant (`GET /console/analytics/usage`).
 * Deliberately a SUBSET of the operator's `UsageRollupView`: it OMITS `provider_cost`
 * and `margin`, which reveal the platform's per-tenant markup and must never reach a
 * tenant. zod strips unknown keys, so even if the DB row carries them the mapper drops
 * them. Token/cost sums are bigint → decimal strings.
 */
export const consoleUsageRollupViewSchema = z.object({
  bucket: z.string(),
  requests: z.number(),
  input_tokens: z.string(),
  output_tokens: z.string(),
  cost: z.string(),
  errors: z.number(),
  /** avg(latency_ms) over the bucket; `null` when none recorded. (provider_cost/margin still stripped.) */
  avg_latency_ms: z.number().nullable(),
  /** percentile_cont(0.95) of latency_ms over the bucket; `null` when none recorded. */
  p95_latency_ms: z.number().nullable(),
});
export type ConsoleUsageRollupView = z.infer<typeof consoleUsageRollupViewSchema>;

/** One payment intent in the caller-tenant's topup history (`GET /console/payments`). Money as decimal strings. */
export const consolePaymentViewSchema = z.object({
  id: z.string(),
  provider: z.string(),
  purpose: z.string(),
  amount_minor: z.string(),
  currency: z.string(),
  credit_amount: z.string().nullable(),
  status: z.string(),
  created_at: z.string(),
});
export type ConsolePaymentView = z.infer<typeof consolePaymentViewSchema>;

/** The caller's own profile (`GET /console/me`) — never the password hash. */
export const consoleMeViewSchema = z.object({
  id: z.string(),
  email: z.string(),
  email_verified: z.boolean(),
  role: z.string(),
  status: z.string(),
  tenant_id: z.string().nullable(),
  /**
   * The caller's tenant-org seat (RBAC v1): `'admin'` | `'member'` for tenant
   * users, `null` for a system operator. Resolved from the DB (not the JWT), so
   * the `/app` console gates its admin-only writes off this (NOT the synthetic
   * `member` JWT role, which is for end-user subjects).
   */
  tenant_role: z.string().nullable(),
});
export type ConsoleMeView = z.infer<typeof consoleMeViewSchema>;

/**
 * One operator user in the caller's tenant-org (`GET /console/users`, RBAC v1) —
 * a normal USER row (`role='user'`), never a `subject`/end-user. `tenant_role` is
 * the org seat (`'admin'` | `'member'`); the tenant scope is implicit in the JWT
 * so `tenant_id` is omitted like the other console views. Never carries the
 * password hash.
 */
export const consoleUserViewSchema = z.object({
  id: z.string(),
  email: z.string(),
  status: z.string(),
  tenant_role: z.string(),
  created_at: z.string(),
});
export type ConsoleUserView = z.infer<typeof consoleUserViewSchema>;

/** The caller-tenant's credit balance + held (`GET /console/balance`; µcredit decimal strings). */
export const consoleBalanceViewSchema = z.object({
  balance: z.string(),
  held: z.string(),
});
export type ConsoleBalanceView = z.infer<typeof consoleBalanceViewSchema>;

/**
 * The `POST /console/payments/intents` checkout handle (hosted redirect or QR).
 * `redirect_url`/`qr` are optional (omitted when the provider doesn't supply one).
 */
export const consoleIntentViewSchema = z.object({
  intent_id: z.string(),
  redirect_url: z.string().optional(),
  qr: z.string().optional(),
});
export type ConsoleIntentView = z.infer<typeof consoleIntentViewSchema>;

/**
 * One of the caller-tenant's stored media files (`GET /console/files`) — both
 * uploaded assets and generated images/videos persisted to object storage. `url`
 * is a directly-viewable link (the storage public base + object key) for
 * thumbnails/preview, or `null` when no public base is configured. Tenant scope
 * is implicit (the JWT), so `tenant_id` is omitted like the other console views.
 */
export const consoleFileViewSchema = z.object({
  id: z.string(),
  status: z.string(),
  content_type: z.string().nullable(),
  size: z.number().nullable(),
  url: z.string().nullable(),
  created_at: z.string(),
});
export type ConsoleFileView = z.infer<typeof consoleFileViewSchema>;

/**
 * The caller-tenant's object-storage usage + effective quota (`GET
 * /console/files/usage`) — drives the asset-gallery usage/quota bar. `bytes`/
 * `count` are the live totals; `quota_bytes` is the effective per-tenant cap
 * (`null` → no cap); `effective_ttl_days` is the opt-in file-lifecycle TTL in
 * days (`null` → retain forever). Mirrors the data-plane `GET /v1/files/usage`.
 */
export const storageUsageViewSchema = z.object({
  bytes: z.number(),
  count: z.number(),
  quota_bytes: z.number().nullable(),
  effective_ttl_days: z.number().nullable(),
});
export type StorageUsageView = z.infer<typeof storageUsageViewSchema>;

/**
 * One saved playground conversation in the caller-tenant's list (`GET
 * /console/conversations`). `model` is the last-used model name (`null` until a
 * turn runs). Tenant scope is implicit (the JWT), so `tenant_id` is omitted.
 */
export const conversationViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  model: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ConversationView = z.infer<typeof conversationViewSchema>;

/**
 * One persisted turn of a conversation (`GET /console/conversations/:id` →
 * `messages`). `reasoning` is the assistant chain-of-thought (DeepSeek-style),
 * `usage` the `{ input, output }` token counts, `latency_ms` the client-measured
 * total — all `null` for a user/system turn. `seq` is the turn order.
 */
export const messageViewSchema = z.object({
  id: z.string(),
  seq: z.number(),
  role: z.string(),
  content: z.string(),
  reasoning: z.string().nullable(),
  usage: z.object({ input: z.number(), output: z.number() }).nullable(),
  latency_ms: z.number().nullable(),
  model: z.string().nullable(),
  created_at: z.string(),
});
export type MessageView = z.infer<typeof messageViewSchema>;

/**
 * A conversation with its full ordered transcript (`GET /console/conversations/:id`)
 * — the list view fields plus the `message` rows in `seq` order.
 */
export const conversationDetailViewSchema = conversationViewSchema.extend({
  messages: z.array(messageViewSchema),
});
export type ConversationDetailView = z.infer<typeof conversationDetailViewSchema>;

/**
 * One effective governance rule for the caller-tenant's bound plan paired with
 * its current usage (`GET /console/limits` → `rules`). `cap`/`used` are decimal
 * **strings** (bigint: µUSD for `spend`, else a count); `rpm`/`concurrency` are
 * live rate limits with no stored total so `used` is `"0"`. The plan name is
 * surfaced (read-only) so the tenant knows which 额度套餐 applies.
 */
export const consoleLimitRuleViewSchema = z.object({
  dimension: z.string(),
  period: z.string().nullable(),
  cap: z.string(),
  used: z.string(),
  model_scope: z.string().nullable(),
  alert_pct: z.number().nullable(),
  enforce: z.string(),
});
export type ConsoleLimitRuleView = z.infer<typeof consoleLimitRuleViewSchema>;

/** One recent threshold alert for the caller-tenant (`GET /console/limits` → `alerts`). */
export const consoleLimitAlertViewSchema = z.object({
  dimension: z.string(),
  period_key: z.string(),
  used: z.string(),
  cap: z.string(),
  pct: z.number(),
  created_at: z.string(),
});
export type ConsoleLimitAlertView = z.infer<typeof consoleLimitAlertViewSchema>;

/**
 * The caller-tenant's governance status (`GET /console/limits`): the tenant-level
 * (account-bound) plan name, its rules-with-usage, and recent alerts. `plan` is
 * `null` when no plan is bound (the `/app` budget view then shows "unlimited").
 */
export const consoleLimitStatusViewSchema = z.object({
  plan: z.object({ id: z.string(), name: z.string() }).nullable(),
  rules: z.array(consoleLimitRuleViewSchema),
  alerts: z.array(consoleLimitAlertViewSchema),
});
export type ConsoleLimitStatusView = z.infer<typeof consoleLimitStatusViewSchema>;
