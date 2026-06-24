import { z } from 'zod';

/**
 * Single source of truth for the admin **operational** control-plane wire views
 * (api keys, jobs, ledger, per-call usage log, usage rollups, payment intents,
 * created secrets, dify import). Same contract-first pattern as `admin-views.ts`:
 * the backend `toView` mappers `.parse()` against these schemas (a drifting
 * mapper fails loudly); the frontend imports the inferred TYPE only
 * (`import type`), so no zod ships to the browser. Money is always a µ-unit
 * decimal **string** (bigint serialized), never a JS number.
 */

/** A tenant API key as served by `GET /admin/api-keys` (no hash). */
export const apiKeyViewSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  resource_allowlist: z.array(z.string()),
  rate_limit: z.number().nullable(),
  status: z.string(),
  /** The bound route group (Track 3); `null` → the `default` group at routing time. */
  route_group_id: z.string().nullable(),
  /** The bound limit plan (额度套餐); `null` → no per-key governance plan. */
  limit_plan_id: z.string().nullable(),
  created_at: z.string(),
});
export type ApiKeyView = z.infer<typeof apiKeyViewSchema>;

/** A job as served by `GET /admin/jobs`. `cost` is a µcredit decimal string. */
export const jobViewSchema = z.object({
  job_id: z.string(),
  tenant_id: z.string(),
  resource_id: z.string(),
  status: z.string(),
  exec_mode: z.string(),
  cost: z.string().nullable(),
  created_at: z.string(),
});
export type JobView = z.infer<typeof jobViewSchema>;

/** A ledger transaction (`GET /admin/ledger`). Money fields are µcredit strings. */
export const ledgerViewSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  account_id: z.string(),
  type: z.string(),
  credits_delta: z.string(),
  balance_after: z.string(),
  resource_id: z.string().nullable(),
  job_id: z.string().nullable(),
  created_at: z.string(),
});
export type LedgerView = z.infer<typeof ledgerViewSchema>;

/** One per-call usage-log row (`GET /admin/usage`). `cost` is a µcredit string. */
export const usageLogViewSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  model: z.string(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cost: z.string(),
  latency_ms: z.number().nullable(),
  status: z.string(),
  created_at: z.string(),
});
export type UsageLogView = z.infer<typeof usageLogViewSchema>;

/**
 * One aggregated usage bucket (`GET /admin/analytics/usage`). Token/cost/margin
 * sums are bigint → decimal strings; `margin` can be NEGATIVE (still a string).
 */
export const usageRollupViewSchema = z.object({
  bucket: z.string(),
  requests: z.number(),
  input_tokens: z.string(),
  output_tokens: z.string(),
  cost: z.string(),
  /** sum(provider_cost) µUSD — the served channels' actual cost (Track 5). */
  provider_cost: z.string(),
  /** sum(cost) − sum(provider_cost) µUSD — the operator margin (Track 5). */
  margin: z.string(),
  errors: z.number(),
  /** avg(latency_ms) over the bucket's non-null latencies; `null` when none recorded. */
  avg_latency_ms: z.number().nullable(),
  /** percentile_cont(0.95) of latency_ms over the bucket; `null` when none recorded. */
  p95_latency_ms: z.number().nullable(),
});
export type UsageRollupView = z.infer<typeof usageRollupViewSchema>;

/**
 * A payment intent as served by `GET /admin/payments` (and `/v1/payments`).
 * Money (`amount_minor`, `credit_amount`) is a decimal **string**.
 */
export const paymentIntentViewSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  provider: z.string(),
  provider_ref: z.string(),
  purpose: z.string(),
  target_ref: z.string().nullable(),
  amount_minor: z.string(),
  currency: z.string(),
  credit_amount: z.string().nullable(),
  status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type PaymentIntentView = z.infer<typeof paymentIntentViewSchema>;

/** A created encrypted secret (`POST /admin/secrets`). EXCLUDES the plaintext value. */
export const secretViewSchema = z.object({
  id: z.string(),
  provider: z.string(),
  /** Operator-editable credential metadata (catalog redesign). */
  name: z.string().nullable(),
  notes: z.string().nullable(),
  group: z.string().nullable(),
  created_at: z.string(),
});
export type SecretView = z.infer<typeof secretViewSchema>;

/**
 * The `POST /admin/dify/import` response: the registered resource's schema.
 * `io_schema`/`compat_report` are free-form JSON blobs (unknown) on the wire.
 */
export const difyImportViewSchema = z.object({
  resource_id: z.string(),
  version: z.number(),
  io_schema: z.unknown(),
  compat_report: z.unknown(),
});
export type DifyImportView = z.infer<typeof difyImportViewSchema>;

/**
 * One upstream relay audit trace (`GET /admin/relay-traces`). Tokens are redacted
 * by the writer and re-redacted on read; bodies may be byte-truncated. Most fields
 * are nullable — an aborted/early request fills only part of the row.
 */
export const relayTraceViewSchema = z.object({
  id: z.string(),
  created_at: z.string(),
  tenant_id: z.string().nullable(),
  job_id: z.string().nullable(),
  channel_id: z.string().nullable(),
  provider_type: z.string().nullable(),
  method: z.string(),
  url: z.string(),
  request_headers: z.record(z.string()).nullable(),
  request_body: z.string().nullable(),
  response_status: z.number().nullable(),
  response_body: z.string().nullable(),
  is_stream: z.boolean(),
  latency_ms: z.number().nullable(),
  error: z.string().nullable(),
  truncated: z.boolean(),
});
export type RelayTraceView = z.infer<typeof relayTraceViewSchema>;

/**
 * A minted redemption (gift) code as served by `GET /admin/redemption-codes`. The
 * `code` value IS the row identity on this admin-only surface. `credit_amount` is
 * the bigint µcredit grant as a decimal string; `redeemed_*`/`expires_at` are ISO
 * strings or `null`.
 */
export const redemptionCodeViewSchema = z.object({
  code: z.string(),
  credit_amount: z.string(),
  status: z.string(),
  redeemed_by_tenant: z.string().nullable(),
  redeemed_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  created_at: z.string(),
});
export type RedemptionCodeView = z.infer<typeof redemptionCodeViewSchema>;

/** `POST /admin/redemption-codes` response: the minted plaintext codes + per-code grant. */
export const redeemCodesResultSchema = z.object({
  codes: z.array(z.string()),
  credit_amount: z.string(),
});
export type RedeemCodesResult = z.infer<typeof redeemCodesResultSchema>;

/**
 * A registered upstream OAuth subscription session (the `POST /admin/oauth-sessions`
 * + codex `.../complete` response). EXCLUDES the access/refresh tokens by construction
 * — they are encrypted at rest and never leave the service. `id` is the `secret_ref`
 * id usable as a channel `credentialRef`.
 */
export const oauthSessionViewSchema = z.object({
  id: z.string(),
  provider_kind: z.string(),
  account_label: z.string().nullable(),
  account_id: z.string().nullable(),
});
export type OAuthSessionView = z.infer<typeof oauthSessionViewSchema>;

/** A row of the token-free OAuth-session listing (`GET /admin/oauth-sessions`). */
export const oauthSessionListViewSchema = z.object({
  id: z.string(),
  provider_kind: z.string(),
  account_label: z.string().nullable(),
  account_id: z.string().nullable(),
  /** Operator-editable credential metadata (catalog redesign). */
  name: z.string().nullable(),
  notes: z.string().nullable(),
  group: z.string().nullable(),
  status: z.string(),
  expires_at: z.string().nullable(),
  last_refresh_at: z.string().nullable(),
});
export type OAuthSessionListView = z.infer<typeof oauthSessionListViewSchema>;

/**
 * The turnkey codex login-start response (`POST /admin/oauth-sessions/codex/login/start`):
 * the `authorize_url` the operator opens + the sealed `state` (the PKCE verifier,
 * encrypted) to echo back to `.../complete`. Carries NO secret material in the clear.
 */
export const codexLoginStartViewSchema = z.object({
  authorize_url: z.string(),
  state: z.string(),
});
export type CodexLoginStartView = z.infer<typeof codexLoginStartViewSchema>;

/**
 * One upstream channel's live operational health (`GET /admin/health`). Sourced
 * from the authoritative `channel_health` circuit-breaker joined to
 * `upstream_channel` — NOT derived from rates. The frontend derives the display
 * status: `status='disabled'` → 已停用; `cooldown_until > now` → 熔断中 (with the
 * countdown + `consecutive_failures`); a missing/expired cooldown → 健康. For
 * subscription channels the FE may overlay `credential_ref` against the
 * OAuth-session listing to surface 需重新授权.
 */
export const channelHealthViewSchema = z.object({
  channel_id: z.string(),
  resource_id: z.string(),
  provider_type: z.string(),
  /** Operator-set lifecycle status: `active` | `disabled`. */
  status: z.string(),
  /** The bound credential (secret_ref / oauth-session id), for FE re-auth overlay; `null` → none. */
  credential_ref: z.string().nullable(),
  /** `cooldown_until > now` ⇒ currently cooling (circuit open). ISO string or `null`. */
  cooldown_until: z.string().nullable(),
  consecutive_failures: z.number(),
  last_failure_at: z.string().nullable(),
});
export type ChannelHealthView = z.infer<typeof channelHealthViewSchema>;

/**
 * The ops health snapshot (`GET /admin/health`): a "right now" view of upstream
 * channel health plus billable throughput over a rolling window. Read-only
 * assembly — introduces no new metric aggregates beyond the circuit-breaker join
 * and a windowed `count(*)`.
 */
export const opsHealthViewSchema = z.object({
  /** The rolling window (seconds) `rpm_billable` is counted over. */
  window_seconds: z.number(),
  /** Billable `usage_log` requests in the last `window_seconds`, normalized to req/min. */
  rpm_billable: z.number(),
  channels: z.array(channelHealthViewSchema),
});
export type OpsHealthView = z.infer<typeof opsHealthViewSchema>;

/** One daily uptime bucket for a model's status-page sparkline. */
export const modelHealthBucketSchema = z.object({
  /** `YYYY-MM-DD` (UTC). */
  day: z.string(),
  total: z.number(),
  errors: z.number(),
});

/**
 * Per-model health for the status page (`GET /admin/health/models`), derived
 * from real `usage_log` traffic over the requested window. `availability_pct`
 * is `(total - errors) / total × 100` (100 when no traffic). `history` is the
 * per-day uptime series (oldest→newest) for the sparkline.
 */
export const modelHealthViewSchema = z.object({
  model: z.string(),
  total: z.number(),
  errors: z.number(),
  availability_pct: z.number(),
  avg_latency_ms: z.number().nullable(),
  p95_latency_ms: z.number().nullable(),
  last_status: z.string().nullable(),
  last_seen_at: z.string().nullable(),
  history: z.array(modelHealthBucketSchema),
});
export type ModelHealthView = z.infer<typeof modelHealthViewSchema>;

/**
 * Authoritative platform counts (`GET /admin/summary`) for the overview KPI band.
 * These are true `count(*)` totals — the FE must use these, never the length of a
 * single page of `GET /admin/tenants`/`/admin/resources`.
 */
export const opsSummaryViewSchema = z.object({
  tenants: z.number(),
  resources: z.number(),
  accounts: z.number(),
});
export type OpsSummaryView = z.infer<typeof opsSummaryViewSchema>;
