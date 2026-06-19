export interface TenantView {
  id: string;
  name: string;
  isolation_mode: string;
  created_at: string;
}
export interface AccountView {
  id: string;
  tenant_id: string;
  credit_balance: string;
  credit_held: string;
  created_at: string;
}
export interface ApiKeyView {
  id: string;
  tenant_id: string;
  resource_allowlist: string[];
  rate_limit: number | null;
  status: string;
  /** The bound route group (also sets the customer price ratio). Null = `default`. */
  route_group_id: string | null;
  created_at: string;
}
export interface ApiKeyCreatedView {
  id: string;
  plaintext: string;
}
export interface ResourceView {
  id: string;
  tenant_id: string;
  kind: string;
  modality: string;
  provider_type: string;
  exec_modes: string[];
  status: string;
  current_version: number;
  created_at: string;
}
export interface JobView {
  job_id: string;
  tenant_id: string;
  resource_id: string;
  status: string;
  exec_mode: string;
  cost: string | null;
  created_at: string;
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
export interface PricebookView {
  id: string;
  resource_id: string;
  resource_version: number;
  version: number;
  method: string;
  timing: string;
  spec: unknown;
  markup: unknown;
  active: boolean;
}
export interface ModifierView {
  id: string;
  scope: string;
  when_expr: string | null;
  op: string;
  value: string | null;
  stackable: boolean;
  priority: number;
  version: number;
  active: boolean;
}
export interface ChannelView {
  id: string;
  resource_id: string;
  provider_type: string;
  credential_ref: string | null;
  endpoint: string | null;
  model: string | null;
  proxy_ref: string | null;
  config: Record<string, unknown> | null;
  weight: number;
  status: string;
  /** Operator cost, µUSD per 1M tokens (decimal string) — NOT the customer price. Null = unset. */
  input_cost_per_1m: string | null;
  output_cost_per_1m: string | null;
}
export interface DifyImportView {
  resource_id: string;
  version: number;
  io_schema: unknown;
  compat_report: unknown;
}

/** A created encrypted secret. Excludes the plaintext value by construction. */
export interface SecretView {
  id: string;
  provider: string;
  created_at: string;
}

export interface ModelView {
  id: string;
  name: string;
  display: string | null;
  modality: string;
  capabilities: Record<string, boolean>;
  visibility: string;
  resource_id: string;
  input_price: string;
  output_price: string;
  status: string;
  created_at: string;
}

/** A tenant grant on a `tenant`-visibility model (public models ignore grants). */
export interface ModelGrantView {
  id: string;
  model_id: string;
  tenant_id: string;
  created_at: string;
}

export interface UsageLogView {
  id: string;
  tenant_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost: string;
  latency_ms: number | null;
  status: string;
  created_at: string;
}

/** One aggregated usage bucket; token/cost sums are decimal strings. */
export interface UsageRollupView {
  bucket: string;
  requests: number;
  input_tokens: string;
  output_tokens: string;
  cost: string;
  /** Operator's upstream cost for the bucket (µUSD decimal string). */
  provider_cost: string;
  /** cost − provider_cost (µUSD decimal string; can be NEGATIVE). */
  margin: string;
  errors: number;
}

export interface LedgerView {
  id: string;
  tenant_id: string;
  account_id: string;
  type: string;
  credits_delta: string;
  balance_after: string;
  resource_id: string | null;
  job_id: string | null;
  created_at: string;
}

export interface PaymentIntentView {
  id: string;
  tenant_id: string;
  provider: string;
  provider_ref: string;
  purpose: string;
  target_ref: string | null;
  amount_minor: string;
  currency: string;
  credit_amount: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

// --- Billing & routing (mock skeleton) ------------------------------------
// These mirror the DESIGN-ONLY backend billing spec
// (actionow-core/docs/.../2026-06-17-actionow-billing-channel-routing-design.md);
// the backend is NOT built yet. Prices are integer µUSD per 1M tokens
// ($1 = 1,000,000 µUSD), distinct from the live µcredit/token registry — see
// `src/lib/api/mockBilling.ts`. Swap these for real `/admin/...` views when the
// billing backend track lands.

/** A reference ("official") published model price, in µUSD per 1M tokens. */
export interface OfficialModelPrice {
  id: string;
  provider: string;
  model_slug: string;
  display_name: string;
  /** µUSD per 1M input tokens (integer; $1 = 1,000,000 µUSD). */
  input_price_per_1m: number;
  /** µUSD per 1M output tokens (integer). */
  output_price_per_1m: number;
  /** µUSD per 1M cached-input tokens (integer), when the provider prices it. */
  cached_input_price_per_1m?: number;
  source_url?: string;
  /** ISO date (YYYY-MM-DD) the price takes effect. */
  effective_at?: string;
  notes?: string;
  updated_by?: string;
  created_at: string;
}

/** A routing group: a named channel pool with a global price ratio (basis points). */
export interface RouteGroup {
  id: string;
  name: string;
  /** Group price ratio in basis points — 10000 = ×1.00, 15000 = ×1.50. */
  group_ratio_bps: number;
  status: 'active' | 'disabled';
  description?: string;
  created_at: string;
}

/** Membership of a channel in a route group, with routing priority + weight. */
export interface RouteGroupChannel {
  group_id: string;
  channel_id: string;
  /** Higher priority is tried first. */
  priority: number;
  /** Relative share of traffic among same-priority channels. */
  weight: number;
}

// --- Billing & routing (REAL /admin/* wire types — LIVE on main) -----------
// These replace the mock skeleton above as each page de-mocks; the mock
// RouteGroup/RouteGroupChannel/OfficialModelPrice stay only until their last
// consumer (RouteGroupsPage / OfficialPricesPage) migrates.

/** A route group as served by GET /admin/route-groups (snake_case). */
export interface RouteGroupView {
  id: string;
  name: string;
  /** Group price ratio in basis points — 10000 = ×1.00 (integer, NOT a money string). */
  group_ratio_bps: number;
  status: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}
/** A channel's membership in a route group. */
export interface RouteGroupChannelView {
  group_id: string;
  channel_id: string;
  priority: number;
  weight: number;
  created_at: string;
}
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

/** An official price as served by GET /admin/official-prices (snake_case, µUSD/1M decimal strings). */
export interface OfficialPriceView {
  id: string;
  provider: string;
  model_slug: string;
  display_name: string | null;
  /** µUSD per 1M input tokens (decimal string — divide by 1e6 to show USD). */
  input_price_per_1m: string;
  output_price_per_1m: string;
  cached_input_price_per_1m: string | null;
  source_url: string | null;
  /** Full ISO-8601 timestamp the price takes effect. */
  effective_at: string | null;
  notes: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}
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

/** A tenant's own API key (no tenant_id/route_group — the token scopes it). */
export interface ConsoleApiKeyView {
  id: string;
  resource_allowlist: string[];
  rate_limit: number | null;
  status: string;
  created_at: string;
}
export interface ConsoleJobView {
  job_id: string;
  resource_id: string;
  status: string;
  exec_mode: string;
  cost: string | null;
  created_at: string;
}
export interface ConsoleLedgerView {
  id: string;
  type: string;
  credits_delta: string;
  balance_after: string;
  job_id: string | null;
  created_at: string;
}
export interface ConsoleModelView {
  name: string;
  display: string;
  modality: string;
  capabilities: unknown;
  visibility: string;
}
/** `GET /console/usage` — two independent keysets, each its own envelope. */
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
/** `POST /console/payments/intents` — a checkout handle (hosted redirect or QR). */
export interface ConsoleIntentView {
  intent_id: string;
  redirect_url?: string;
  qr?: string;
}
/** Tenant analytics query (no tenantId — the token scopes it; no `tenant` groupBy). */
export interface ConsoleAnalyticsQuery {
  groupBy: 'day' | 'model' | 'channel' | 'api_key';
  from?: string;
  to?: string;
}
/** One per-call usage-log row for the caller's tenant (tenant implicit). */
export interface ConsoleUsageLogView {
  id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost: string;
  latency_ms: number | null;
  status: string;
  created_at: string;
}
/** One payment intent in the caller-tenant's topup history. */
export interface ConsolePaymentView {
  id: string;
  provider: string;
  purpose: string;
  amount_minor: string;
  currency: string;
  credit_amount: string | null;
  status: string;
  created_at: string;
}
/** The caller's own profile (never the password hash). */
export interface ConsoleMeView {
  id: string;
  email: string;
  email_verified: boolean;
  role: string;
  status: string;
  tenant_id: string | null;
}
export interface ConsoleChangePasswordBody {
  currentPassword: string;
  newPassword: string;
}
