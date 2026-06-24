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
  created_at: z.string(),
});
export type ConsoleApiKeyView = z.infer<typeof consoleApiKeyViewSchema>;

/** One of the caller-tenant's jobs (`GET /console/usage` → `jobs`). `cost` is a µcredit string. */
export const consoleJobViewSchema = z.object({
  job_id: z.string(),
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
});
export type ConsoleMeView = z.infer<typeof consoleMeViewSchema>;

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
