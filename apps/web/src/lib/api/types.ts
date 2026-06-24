// View AND request-body types are defined ONCE as zod schemas in the shared
// @actionow/contracts package (the single source of truth with the backend) and
// re-exported here type-only — the inferred types are erased at build, so no zod
// reaches the browser bundle. Adding/changing a field happens in one place.
import type { ConsoleJobView, ConsoleLedgerView } from '@actionow/contracts';

export type {
  AccountView,
  // --- request bodies (admin-requests) ---
  AddGroupChannelBody,
  AdminTokenView,
  ApiKeyView,
  // --- records (记录系统) ---
  AuditLogView,
  ChannelHealthView,
  ChannelView,
  CodexLoginCompleteBody,
  CodexLoginStartBody,
  CodexLoginStartView,
  ConsoleApiKeyView,
  ConsoleBalanceView,
  // --- console request bodies (console-requests) ---
  ConsoleChangePasswordBody,
  ConsoleCreateApiKeyBody,
  ConsoleCreateIntentBody,
  ConsoleFileView,
  ConsoleIntentView,
  ConsoleJobView,
  ConsoleLedgerView,
  ConsoleLimitAlertView,
  ConsoleLimitRuleView,
  ConsoleLimitStatusView,
  ConsoleMeView,
  ConsoleModelView,
  ConsolePaymentView,
  ConsoleUsageLogView,
  ConsoleUsageRollupView,
  CreateAccountBody,
  CreateAdminTokenBody,
  CreateApiKeyBody,
  // --- catalog request bodies (catalog-requests) ---
  CreateChannelBody,
  CreateFaultPolicyBody,
  // --- governance limits (额度套餐) ---
  CreateLimitPlanRequest,
  CreateModelBody,
  CreateModifierBody,
  CreateOAuthSessionBody,
  CreateOfficialPriceBody,
  CreatePluginRequest,
  CreatePricebookBody,
  CreateProxyBody,
  CreateResourceBody,
  // --- billing request bodies (billing-requests) ---
  CreateRouteGroupBody,
  CreateSecretBody,
  CreateSubjectBody,
  CreateTenantBody,
  DifyBindingView,
  DifyImportBody,
  DifyImportView,
  FaultPolicyView,
  FileView,
  GenerateCodesBody,
  IconAssetView,
  JobView,
  LedgerView,
  LimitAlertView,
  LimitPlanView,
  LimitRuleInput,
  LimitRuleStatusView,
  LimitRuleView,
  LimitUsageView,
  ModelGrantView,
  ModelHealthView,
  ModelTestRequest,
  ModelTestResult,
  ModelView,
  ModifierView,
  OAuthSessionListView,
  OAuthSessionView,
  OfficialPriceView,
  OpsHealthView,
  OpsSummaryView,
  PaymentIntentView,
  PresignUploadBody,
  PresignUploadResult,
  PricebookView,
  ProviderPluginView,
  ProvisionBody,
  ProvisionView,
  ProxyProbeBody,
  ProxyView,
  ReconcileRowView,
  RedemptionCodeView,
  RelayTraceView,
  ResourceView,
  RouteGroupChannelView,
  RouteGroupView,
  SecretView,
  SubjectView,
  SyncChannelModelsBody,
  TenantView,
  TestPluginRequest,
  TestPluginResponse,
  TopupBody,
  UpdateApiKeyGroupBody,
  UpdateChannelBody,
  UpdateCredentialMetaBody,
  UpdateDifyBody,
  UpdateFaultPolicyBody,
  UpdateLimitPlanRequest,
  UpdateModelBody,
  UpdateModifierBody,
  UpdateOfficialPriceBody,
  UpdatePluginRequest,
  UpdatePricebookBody,
  UpdateProxyBody,
  UpdateResourceBody,
  UpdateRouteGroupBody,
  UpdateSubjectBody,
  UpdateTenantBody,
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
  groupBy: 'minute' | 'hour' | 'day' | 'model' | 'tenant' | 'channel' | 'api_key';
  tenantId?: string;
  from?: string;
  to?: string;
}

// RelayTraceView now comes from @actionow/contracts (ops-views) — see the
// type-only re-export at the top of this file.
export interface RelayTraceQuery {
  tenantId?: string;
  jobId?: string;
  providerType?: string;
  channelId?: string;
  from?: string;
  to?: string;
  /** Exact upstream status code. */
  responseStatus?: number;
  /** `true` → only failures (status >= 400 or a captured error). */
  errorsOnly?: boolean;
  isStream?: boolean;
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
// ConsoleTopupBody is now the contract `ConsoleCreateIntentBody` — the topup form
// narrows `provider` to the payment-provider enum (see the re-export at the top).
/** Tenant analytics query (no tenantId — the token scopes it; no `tenant` groupBy). */
export interface ConsoleAnalyticsQuery {
  groupBy: 'minute' | 'hour' | 'day' | 'model' | 'channel' | 'api_key';
  from?: string;
  to?: string;
}
