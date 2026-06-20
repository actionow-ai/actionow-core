// View AND request-body types are defined ONCE as zod schemas in the shared
// @actionow/contracts package (the single source of truth with the backend) and
// re-exported here type-only — the inferred types are erased at build, so no zod
// reaches the browser bundle. Adding/changing a field happens in one place.
import type { ConsoleJobView, ConsoleLedgerView } from '@actionow/contracts';

export type {
  AccountView,
  // --- request bodies (admin-requests) ---
  AddGroupChannelBody,
  ApiKeyView,
  ChannelView,
  ConsoleApiKeyView,
  ConsoleBalanceView,
  // --- console request bodies (console-requests) ---
  ConsoleChangePasswordBody,
  ConsoleCreateApiKeyBody,
  ConsoleIntentView,
  ConsoleJobView,
  ConsoleLedgerView,
  ConsoleMeView,
  ConsoleModelView,
  ConsolePaymentView,
  ConsoleUsageLogView,
  CreateAccountBody,
  CreateApiKeyBody,
  // --- catalog request bodies (catalog-requests) ---
  CreateChannelBody,
  CreateModelBody,
  CreateModifierBody,
  CreateOfficialPriceBody,
  CreatePricebookBody,
  CreateResourceBody,
  // --- billing request bodies (billing-requests) ---
  CreateRouteGroupBody,
  CreateSecretBody,
  CreateTenantBody,
  DifyImportBody,
  DifyImportView,
  GenerateCodesBody,
  JobView,
  LedgerView,
  ModelGrantView,
  ModelView,
  ModifierView,
  OfficialPriceView,
  PaymentIntentView,
  PricebookView,
  ResourceView,
  RouteGroupChannelView,
  RouteGroupView,
  SecretView,
  SyncChannelModelsBody,
  TenantView,
  TopupBody,
  UpdateApiKeyGroupBody,
  UpdateChannelBody,
  UpdateModelBody,
  UpdateOfficialPriceBody,
  UpdateResourceBody,
  UpdateRouteGroupBody,
  UsageLogView,
  UsageRollupView,
} from '@actionow/contracts';

// ApiKeyView / JobView now come from @actionow/contracts (ops-views) — see the
// type-only re-export at the top of this file.
export interface ApiKeyCreatedView {
  id: string;
  plaintext: string;
}
export interface Page<T> {
  rows: T[];
  nextCursor: string | null;
}

// CreateTenantBody / CreateAccountBody / TopupBody / CreateApiKeyBody /
// UpdateApiKeyGroupBody now come from @actionow/contracts (admin-requests) — see
// the type-only re-export at the top of this file.

// --- Catalog (operator) ---
// ResourceView / ChannelView / PricebookView / ModifierView / ModelView /
// ModelGrantView now come from @actionow/contracts (catalog-views), and the
// matching Create*/Update* request bodies from catalog-requests — see the
// type-only re-export at the top of this file.
// DifyImportView / SecretView / UsageLogView / UsageRollupView / LedgerView /
// PaymentIntentView now come from @actionow/contracts (ops-views) — see the
// type-only re-export at the top of this file.

// --- Billing & routing (REAL /admin/* wire types) --------------------------
// Live wire types served by the billing/routing backend. Prices are integer
// µUSD per 1M tokens ($1 = 1,000,000 µUSD), distinct from the live µcredit/token
// registry. RouteGroupView / RouteGroupChannelView / OfficialPriceView come from
// @actionow/contracts (billing-views), and the matching Create*/Update* request
// bodies from billing-requests — see the type-only re-export at the top.

export type Modality = 'text' | 'image' | 'video' | 'audio' | 'composite';
export type PricebookMethod = 'unit' | 'matrix' | 'fixed' | 'formula' | 'passthrough';
export type PricebookTiming = 'pre' | 'post';
export type ModifierOp = 'override_rate' | 'percent_off' | 'flat_off' | 'percent_add';
export type DifyPricingModel = 'fixed' | 'matrix' | 'metered';
export type ChannelStatus = 'active' | 'disabled';

/** Result of a channel sync-models run: the model names created/updated. */
export interface SyncChannelModelsResult {
  resource_id: string;
  created: string[];
  updated: string[];
  total: number;
}

export interface AnalyticsUsageQuery {
  groupBy: 'day' | 'model' | 'tenant' | 'channel' | 'api_key';
  tenantId?: string;
  from?: string;
  to?: string;
}

/** One upstream relay audit trace (token-redacted, bodies may be truncated). */
export interface RelayTraceView {
  id: string;
  created_at: string;
  tenant_id: string | null;
  job_id: string | null;
  channel_id: string | null;
  provider_type: string | null;
  method: string;
  url: string;
  request_headers: Record<string, string> | null;
  request_body: string | null;
  response_status: number | null;
  response_body: string | null;
  is_stream: boolean;
  latency_ms: number | null;
  error: string | null;
  truncated: boolean;
}
export interface RelayTraceQuery {
  tenantId?: string;
  jobId?: string;
  providerType?: string;
  channelId?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

// ----- Tenant self-service console plane (`/console/*`, scoped by the token) -----

// ConsoleApiKeyView / ConsoleJobView / ConsoleLedgerView / ConsoleModelView /
// ConsoleUsageLogView / ConsolePaymentView / ConsoleMeView / ConsoleBalanceView
// / ConsoleIntentView now come from @actionow/contracts (console-views); the
// ConsoleCreateApiKeyBody / ConsoleChangePasswordBody request bodies come from
// console-requests — see the type-only re-export at the top of this file.

/**
 * `GET /console/usage` — two independent keysets, each its own envelope. This is
 * a FRONTEND-ONLY composite: the wire serves two `PageEnvelope`s and `consoleApi`
 * remaps them into the FE `Page` shape, so it has no backend wire-view twin and
 * stays a local interface (NOT migrated into @actionow/contracts).
 */
export interface ConsoleUsageView {
  jobs: Page<ConsoleJobView>;
  ledger: Page<ConsoleLedgerView>;
}
/**
 * `POST /console/payments/topup` body. NOT migrated to @actionow/contracts: the
 * contract `consoleCreateIntentSchema` narrows `provider` to the
 * `paymentProviderSchema` enum, but the FE topup form holds `provider` as a plain
 * `string` (a `SegmentedControl` whose `onChange` yields `string`). Reconciling
 * that narrowing across the form/control wiring is non-obvious, so this body
 * stays hand-written as the wider `provider: string` (see the migration report).
 */
export interface ConsoleTopupBody {
  provider: string;
  amount_minor: number;
  currency: string;
}
/** Tenant analytics query (no tenantId — the token scopes it; no `tenant` groupBy). */
export interface ConsoleAnalyticsQuery {
  groupBy: 'day' | 'model' | 'channel' | 'api_key';
  from?: string;
  to?: string;
}
