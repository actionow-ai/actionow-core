// TenantView / AccountView are defined ONCE as zod schemas in the shared
// @actionow/contracts package (the single source of truth with the backend) and
// re-exported here type-only — the inferred types are erased at build, so no zod
// reaches the browser bundle. Adding/changing a field happens in one place.
import type { ConsoleJobView, ConsoleLedgerView } from '@actionow/contracts';

export type {
  AccountView,
  ApiKeyView,
  ChannelView,
  ConsoleApiKeyView,
  ConsoleBalanceView,
  ConsoleIntentView,
  ConsoleJobView,
  ConsoleLedgerView,
  ConsoleMeView,
  ConsoleModelView,
  ConsolePaymentView,
  ConsoleUsageLogView,
  DifyImportView,
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
  TenantView,
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

export interface CreateTenantBody {
  name: string;
  isolationMode?: 'field' | 'schema' | 'db';
}
export interface CreateAccountBody {
  tenantId: string;
  credits?: number;
}
export interface TopupBody {
  credits: number;
}
export interface CreateApiKeyBody {
  tenantId: string;
  resourceAllowlist?: string[];
  rateLimit?: number;
  /** Bind the key to a route group at creation (omit for the `default` group). */
  routeGroupId?: string;
}
/** PATCH an api-key's route-group binding. `null` unbinds → the `default` group. */
export interface UpdateApiKeyGroupBody {
  routeGroupId: string | null;
}

// --- Catalog (operator) ---
// ResourceView / ChannelView / PricebookView / ModifierView / ModelView /
// ModelGrantView now come from @actionow/contracts (catalog-views) — see the
// type-only re-export at the top of this file.
// DifyImportView / SecretView / UsageLogView / UsageRollupView / LedgerView /
// PaymentIntentView now come from @actionow/contracts (ops-views) — see the
// type-only re-export at the top of this file.

// --- Billing & routing (REAL /admin/* wire types) --------------------------
// Live wire types served by the billing/routing backend. Prices are integer
// µUSD per 1M tokens ($1 = 1,000,000 µUSD), distinct from the live µcredit/token
// registry. (The earlier mock skeleton + `mockBilling.ts` were removed once
// RouteGroupsPage / OfficialPricesPage moved onto the real endpoints.)

// RouteGroupView / RouteGroupChannelView now come from @actionow/contracts
// (billing-views) — see the type-only re-export at the top of this file.
export interface CreateRouteGroupBody {
  name: string;
  groupRatioBps?: number;
  description?: string;
  status?: 'active' | 'disabled';
}
/** PATCH a route group: omitted = unchanged; `description: null` clears it. */
export interface UpdateRouteGroupBody {
  name?: string;
  groupRatioBps?: number;
  status?: 'active' | 'disabled';
  description?: string | null;
}
/** PUT membership upsert body (defaults priority=0, weight=1). */
export interface AddGroupChannelBody {
  priority?: number;
  weight?: number;
}

// OfficialPriceView now comes from @actionow/contracts (billing-views) — see
// the type-only re-export at the top of this file.
/** POST /admin/official-prices — camelCase, HUMAN USD per 1M (the server multiplies to µUSD). */
export interface CreateOfficialPriceBody {
  provider: string;
  modelSlug: string;
  displayName?: string;
  inputUsdPer1m: number;
  outputUsdPer1m: number;
  cachedInputUsdPer1m?: number;
  sourceUrl?: string;
  /** Full ISO-8601 timestamp (append T00:00:00Z to a yyyy-mm-dd date). */
  effectiveAt?: string;
  notes?: string;
}
/** PATCH /admin/official-prices/:id — provider/modelSlug NOT patchable; null clears a nullable field. */
export interface UpdateOfficialPriceBody {
  displayName?: string | null;
  inputUsdPer1m?: number;
  outputUsdPer1m?: number;
  cachedInputUsdPer1m?: number | null;
  sourceUrl?: string | null;
  effectiveAt?: string | null;
  notes?: string | null;
}

export type Modality = 'text' | 'image' | 'video' | 'audio' | 'composite';
export type PricebookMethod = 'unit' | 'matrix' | 'fixed' | 'formula' | 'passthrough';
export type PricebookTiming = 'pre' | 'post';
export type ModifierOp = 'override_rate' | 'percent_off' | 'flat_off' | 'percent_add';
export type DifyPricingModel = 'fixed' | 'matrix' | 'metered';
export type ChannelStatus = 'active' | 'disabled';

/** PATCH a resource — only `status` is mutable (key fields are immutable). */
export interface UpdateResourceBody {
  status?: 'active' | 'disabled';
}
/**
 * POST channel sync-models body. Prices are µcredit-PER-TOKEN integers (same
 * convention as the model catalog), applied only to newly-created models.
 */
export interface SyncChannelModelsBody {
  defaultInputPrice?: number;
  defaultOutputPrice?: number;
}
/** Result of a channel sync-models run: the model names created/updated. */
export interface SyncChannelModelsResult {
  resource_id: string;
  created: string[];
  updated: string[];
  total: number;
}

export interface CreateResourceBody {
  id: string;
  tenantId: string;
  kind: 'model' | 'workflow';
  modality: Modality;
  providerType: string;
  execModes: string[];
  ioSchema: unknown;
  version?: number;
}
export interface CreateChannelBody {
  providerType: string;
  credentialRef?: string;
  endpoint?: string;
  model?: string;
  proxyRef?: string;
  config?: Record<string, unknown>;
  weight?: number;
  status?: ChannelStatus;
  /** Operator cost in HUMAN USD per 1M tokens (server stores as µUSD). */
  inputCostUsdPer1m?: number;
  outputCostUsdPer1m?: number;
}
/** PATCH a channel: omitted = unchanged; `null` clears a nullable field. */
export interface UpdateChannelBody {
  credentialRef?: string | null;
  endpoint?: string | null;
  model?: string | null;
  proxyRef?: string | null;
  config?: Record<string, unknown> | null;
  weight?: number;
  status?: ChannelStatus;
  /** HUMAN USD per 1M tokens; `null` clears the cost. */
  inputCostUsdPer1m?: number | null;
  outputCostUsdPer1m?: number | null;
}
export interface CreatePricebookBody {
  resourceId: string;
  resourceVersion: number;
  version: number;
  method: PricebookMethod;
  timing: PricebookTiming;
  spec: unknown;
  /** Convenience for `method: 'fixed'` — a HUMAN-credit amount (→ spec.amount). */
  fixedCredits?: number;
  markup?: unknown;
  active?: boolean;
}
export interface CreateModifierBody {
  scope: string;
  whenExpr?: string;
  op: ModifierOp;
  value?: number;
  stackable?: boolean;
  priority?: number;
  version?: number;
  active?: boolean;
}
export interface DifyImportBody {
  tenantId: string;
  resourceId: string;
  yaml: string;
  endpoint: string;
  serviceKeyRef?: string;
  pricingModel: DifyPricingModel;
  allowBlockers?: boolean;
}
export interface CreateSecretBody {
  value: string;
  label?: string;
}
export interface CreateModelBody {
  name: string;
  resourceId: string;
  display?: string;
  modality?: string;
  capabilities?: Record<string, boolean>;
  visibility?: 'public' | 'tenant';
  /** µcredit-per-INPUT-token (integer). */
  inputPrice?: number;
  /** µcredit-per-OUTPUT-token (integer). */
  outputPrice?: number;
  status?: 'active' | 'disabled';
}
/**
 * PATCH a model: omitted = unchanged; `display: null` clears the label. `name`,
 * `resourceId` and `modality` are immutable post-create (backend strips them).
 */
export interface UpdateModelBody {
  display?: string | null;
  capabilities?: Record<string, boolean>;
  /** µcredit-per-INPUT-token (integer). */
  inputPrice?: number;
  /** µcredit-per-OUTPUT-token (integer). */
  outputPrice?: number;
  visibility?: 'public' | 'tenant';
  status?: 'active' | 'disabled';
}
export interface GenerateCodesBody {
  count: number;
  creditsPerCode: number;
  expiresAt?: string;
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
// / ConsoleIntentView now come from @actionow/contracts (console-views) — see
// the type-only re-export at the top of this file.

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
export interface ConsoleCreateApiKeyBody {
  resourceAllowlist?: string[];
  rateLimit?: number;
}
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
export interface ConsoleChangePasswordBody {
  currentPassword: string;
  newPassword: string;
}
