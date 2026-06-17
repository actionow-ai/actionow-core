import type {
  AccountRow,
  Job,
  LedgerRow,
  ModelRow,
  ModifierRow,
  PricebookEntryRow,
  Resource,
  TenantRow,
  UpstreamChannelRow,
  UsageLogRow,
  UsageRollupRow,
} from '@actionow/db';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { engineInvalidInput } from '../common/errors.js';
import { ZodBody } from '../common/zod.pipe.js';
import { AdminService } from './admin.service.js';
import { AdminGuard } from './auth/admin.guard.js';
import { Roles } from './auth/roles.decorator.js';
import {
  type AnalyticsUsageQueryDto,
  analyticsUsageQuerySchema,
  type CodexLoginComplete,
  codexLoginCompleteSchema,
  type CodexLoginStart,
  codexLoginStartSchema,
  type CreateAccountDto,
  createAccountSchema,
  type CreateApiKeyDto,
  createApiKeySchema,
  type CreateChannelDto,
  createChannelSchema,
  type CreateModelDto,
  createModelSchema,
  type CreateModifierDto,
  createModifierSchema,
  type CreateOAuthSessionDto,
  createOAuthSessionSchema,
  type CreatePricebookDto,
  createPricebookSchema,
  type CreateResourceDto,
  createResourceSchema,
  type CreateSecretDto,
  createSecretSchema,
  type CreateTenantDto,
  createTenantSchema,
  type GenerateCodesDto,
  generateCodesSchema,
  type GrantModelDto,
  grantModelSchema,
  type SyncChannelModelsDto,
  syncChannelModelsSchema,
  type TopupDto,
  topupSchema,
  type UpdateChannelDto,
  updateChannelSchema,
} from './dto/admin.dto.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Clamp a `limit` query param to `[1, MAX_LIMIT]`, defaulting when absent/NaN. */
function parseLimit(limit: string | undefined): number {
  const parsed = limit === undefined ? DEFAULT_LIMIT : Number.parseInt(limit, 10);
  return Number.isNaN(parsed) ? DEFAULT_LIMIT : Math.min(Math.max(1, parsed), MAX_LIMIT);
}

// ----- JSON views (bigint money serialized as decimal µcredit strings) -----

interface TenantView {
  id: string;
  name: string;
  isolation_mode: string;
  created_at: string;
}

interface AccountView {
  id: string;
  tenant_id: string;
  credit_balance: string;
  credit_held: string;
  created_at: string;
}

interface ApiKeyCreatedView {
  id: string;
  /** Returned ONCE — only the hash is persisted. Never re-derivable. */
  plaintext: string;
}

interface ApiKeyView {
  id: string;
  tenant_id: string;
  resource_allowlist: string[];
  rate_limit: number | null;
  status: string;
  created_at: string;
}

/** A created encrypted secret. EXCLUDES the plaintext value by construction. */
interface SecretView {
  id: string;
  provider: string;
  created_at: string;
}

/**
 * A registered OAuth-subscription session. EXCLUDES the access/refresh tokens by
 * construction (they are encrypted at rest and never leave the service). `id` is
 * the `secret_ref` id usable as a channel `credentialRef`.
 */
interface OAuthSessionView {
  id: string;
  provider_kind: string;
  account_label: string | null;
  account_id: string | null;
}

/**
 * A row of the token-free OAuth-session listing. EXCLUDES the access/refresh
 * tokens by construction (they never leave the service); `id` is the
 * `secret_ref` id usable as a channel `credentialRef`. Timestamps are ISO-8601
 * strings (or `null` when unset).
 */
interface OAuthSessionListView {
  id: string;
  provider_kind: string;
  account_label: string | null;
  account_id: string | null;
  status: string;
  expires_at: string | null;
  last_refresh_at: string | null;
}

/**
 * The turnkey codex login-start response: the `authorize_url` the operator opens
 * and the sealed `state` (the PKCE verifier, encrypted) to echo back to
 * `.../complete`. Carries NO secret material in the clear.
 */
interface CodexLoginStartView {
  authorize_url: string;
  state: string;
}

interface ResourceView {
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

interface ChannelView {
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
}

interface PricebookView {
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

interface ModifierView {
  id: string;
  scope: string;
  when_expr: string | null;
  op: string;
  /** µcredits for credit ops / whole-percent for percent ops, as a string. */
  value: string | null;
  stackable: boolean;
  priority: number;
  version: number;
  active: boolean;
}

interface LedgerView {
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

interface JobView {
  job_id: string;
  tenant_id: string;
  resource_id: string;
  status: string;
  exec_mode: string;
  cost: string | null;
  created_at: string;
}

interface ModelView {
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

interface UsageLogView {
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

/** One aggregated usage bucket. Token/cost sums are bigint → decimal strings. */
interface UsageRollupView {
  bucket: string;
  requests: number;
  input_tokens: string;
  output_tokens: string;
  cost: string;
  errors: number;
}

/**
 * Admin CRUD over the catalog/pricing/tenants/keys (Phase 5, Task 4). Every
 * route requires an admin JWT with the `admin` role (the {@link AdminGuard} +
 * `@Roles`). Money is entered as HUMAN credits and converted to µcredits in the
 * {@link AdminService}; responses serialize stored µcredits as decimal strings
 * so JSON never coerces money through a float.
 */
@ApiTags('admin')
@ApiBearerAuth('jwt')
@UseGuards(AdminGuard)
@Roles('admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  // ----- tenants -----

  @Post('tenants')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a tenant' })
  async createTenant(
    @Body(new ZodBody(createTenantSchema)) dto: CreateTenantDto,
  ): Promise<TenantView> {
    return toTenantView(await this.admin.createTenant(dto));
  }

  @Get('tenants')
  @ApiOperation({ summary: 'List tenants' })
  async listTenants(): Promise<TenantView[]> {
    return (await this.admin.listTenants()).map(toTenantView);
  }

  // ----- accounts -----

  @Post('accounts')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create an account (opening balance in credits)' })
  async createAccount(
    @Body(new ZodBody(createAccountSchema)) dto: CreateAccountDto,
  ): Promise<AccountView> {
    return toAccountView(await this.admin.createAccount(dto));
  }

  @Post('accounts/:id/topup')
  @HttpCode(200)
  @ApiOperation({ summary: 'Top up an account (amount in credits → µcredits)' })
  async topup(
    @Param('id') id: string,
    @Body(new ZodBody(topupSchema)) dto: TopupDto,
  ): Promise<{ account_id: string; balance: string }> {
    const { balanceMicro } = await this.admin.topup(id, dto);
    return { account_id: id, balance: balanceMicro };
  }

  // ----- api keys -----

  @Post('api-keys')
  @HttpCode(201)
  @ApiOperation({ summary: 'Mint an API key (plaintext returned once)' })
  async createApiKey(
    @Body(new ZodBody(createApiKeySchema)) dto: CreateApiKeyDto,
  ): Promise<ApiKeyCreatedView> {
    const created = await this.admin.createApiKey(dto);
    return { id: created.id, plaintext: created.plaintext };
  }

  @Get('api-keys')
  @ApiOperation({ summary: 'List a tenant’s API keys (no hashes)' })
  async listApiKeys(@Query('tenantId') tenantId: string): Promise<ApiKeyView[]> {
    const rows = await this.admin.listApiKeys(tenantId);
    return rows.map((r) => ({
      id: r.id,
      tenant_id: r.tenantId,
      resource_allowlist: r.resourceAllowlist,
      rate_limit: r.rateLimit,
      status: r.status,
      created_at: r.createdAt.toISOString(),
    }));
  }

  // ----- secrets -----

  @Post('secrets')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create an encrypted-at-rest credential (returns its ref id)' })
  async createSecret(
    @Body(new ZodBody(createSecretSchema)) dto: CreateSecretDto,
  ): Promise<SecretView> {
    const row = await this.admin.createSecret(dto);
    return { id: row.id, provider: row.provider, created_at: row.createdAt.toISOString() };
  }

  // ----- oauth sessions (BYO subscription) -----

  @Post('oauth-sessions')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Register an OAuth subscription session (paste-auth; operator BYO, ToS-acknowledged)',
  })
  async createOAuthSession(
    @Body(new ZodBody(createOAuthSessionSchema)) dto: CreateOAuthSessionDto,
  ): Promise<OAuthSessionView> {
    const session = await this.admin.createOAuthSession(dto);
    return {
      id: session.id,
      provider_kind: session.providerKind,
      account_label: session.accountLabel ?? null,
      account_id: session.accountId ?? null,
    };
  }

  @Get('oauth-sessions')
  @ApiOperation({ summary: 'List registered OAuth subscription sessions (token-free)' })
  async listOAuthSessions(): Promise<OAuthSessionListView[]> {
    return this.admin.listOAuthSessions();
  }

  @Post('oauth-sessions/codex/login/start')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Begin a turnkey server-side codex OAuth login (returns authorize_url + sealed state)',
  })
  startCodexLogin(
    // The `@Body` pipe validates the explicit ToS ack (`z.literal(true)`); the
    // start path needs no field from the validated body, so the pipe is the
    // sole consumer of `dto` (kept for the route's request contract + swagger).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    @Body(new ZodBody(codexLoginStartSchema)) dto: CodexLoginStart,
  ): CodexLoginStartView {
    return this.admin.startCodexLogin();
  }

  @Post('oauth-sessions/codex/login/complete')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Complete a turnkey codex OAuth login (exchange the code; tokens never returned)',
  })
  async completeCodexLogin(
    @Body(new ZodBody(codexLoginCompleteSchema)) dto: CodexLoginComplete,
  ): Promise<OAuthSessionView> {
    const session = await this.admin.completeCodexLogin(dto);
    return {
      id: session.id,
      provider_kind: session.providerKind,
      account_label: session.accountLabel ?? null,
      account_id: session.accountId ?? null,
    };
  }

  // ----- resources -----

  @Post('resources')
  @HttpCode(201)
  @ApiOperation({ summary: 'Register a catalog resource (+ io_schema)' })
  async createResource(
    @Body(new ZodBody(createResourceSchema)) dto: CreateResourceDto,
  ): Promise<ResourceView> {
    return toResourceView(await this.admin.createResource(dto));
  }

  @Get('resources')
  @ApiOperation({ summary: 'List catalog resources' })
  async listResources(): Promise<ResourceView[]> {
    return (await this.admin.listResources()).map(toResourceView);
  }

  @Post('resources/:id/channels')
  @HttpCode(201)
  @ApiOperation({ summary: 'Add an upstream channel to a resource' })
  async createChannel(
    @Param('id') id: string,
    @Body(new ZodBody(createChannelSchema)) dto: CreateChannelDto,
  ): Promise<ChannelView> {
    return toChannelView(await this.admin.createChannel(id, dto));
  }

  @Get('resources/:id/channels')
  @ApiOperation({ summary: "List a resource's upstream channels (incl. disabled)" })
  async listChannels(@Param('id') id: string): Promise<ChannelView[]> {
    return (await this.admin.listResourceChannels(id)).map(toChannelView);
  }

  @Patch('resources/:id/channels/:channelId')
  @ApiOperation({ summary: 'Update an upstream channel (weight/status/endpoint/model/...)' })
  async updateChannel(
    @Param('channelId') channelId: string,
    @Body(new ZodBody(updateChannelSchema)) dto: UpdateChannelDto,
  ): Promise<ChannelView> {
    return toChannelView(await this.admin.updateChannel(channelId, dto));
  }

  @Post('resources/:id/channels/:channelId/sync-models')
  @HttpCode(200)
  @ApiOperation({
    summary: "Sync a channel provider's available models into model rows (multi-model routing)",
  })
  async syncChannelModels(
    @Param('id') id: string,
    @Param('channelId') channelId: string,
    @Body(new ZodBody(syncChannelModelsSchema)) dto: SyncChannelModelsDto,
  ): Promise<{ resource_id: string; created: string[]; updated: string[]; total: number }> {
    return this.admin.syncChannelModels(id, channelId, dto);
  }

  // ----- pricebook -----

  @Post('pricebook')
  @HttpCode(201)
  @ApiOperation({ summary: 'Add a pricebook entry (fixed amount in credits)' })
  async createPricebook(
    @Body(new ZodBody(createPricebookSchema)) dto: CreatePricebookDto,
  ): Promise<PricebookView> {
    return toPricebookView(await this.admin.createPricebook(dto));
  }

  @Get('pricebook')
  @ApiOperation({ summary: 'List a resource’s pricebook entries' })
  async listPricebook(@Query('resourceId') resourceId: string): Promise<PricebookView[]> {
    return (await this.admin.listPricebook(resourceId)).map(toPricebookView);
  }

  // ----- modifiers -----

  @Post('modifiers')
  @HttpCode(201)
  @ApiOperation({ summary: 'Add a pricing modifier (scope-aware, §9.2)' })
  async createModifier(
    @Body(new ZodBody(createModifierSchema)) dto: CreateModifierDto,
  ): Promise<ModifierView> {
    return toModifierView(await this.admin.createModifier(dto));
  }

  @Get('modifiers')
  @ApiOperation({ summary: 'List pricing modifiers' })
  async listModifiers(): Promise<ModifierView[]> {
    return (await this.admin.listModifiers()).map(toModifierView);
  }

  // ----- models -----

  @Post('models')
  @HttpCode(201)
  @ApiOperation({ summary: 'Register a relay model (name → chat resource)' })
  async createModel(@Body(new ZodBody(createModelSchema)) dto: CreateModelDto): Promise<ModelView> {
    return toModelView(await this.admin.createModel(dto));
  }

  @Get('models')
  @ApiOperation({ summary: 'List the relay model catalog' })
  async listModels(): Promise<ModelView[]> {
    return (await this.admin.listModels()).map(toModelView);
  }

  @Post('models/:name/grants')
  @HttpCode(201)
  @ApiOperation({ summary: 'Grant a tenant-visibility model to a tenant' })
  async grantModel(
    @Param('name') name: string,
    @Body(new ZodBody(grantModelSchema)) dto: GrantModelDto,
  ): Promise<{ ok: true }> {
    await this.admin.grantModel(name, dto);
    return { ok: true };
  }

  // ----- jobs -----

  @Get('jobs')
  @ApiOperation({ summary: 'List a tenant’s jobs (keyset)' })
  async listJobs(
    @Query('tenantId') tenantId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<{ jobs: JobView[]; next_cursor: string | null }> {
    const effective = parseLimit(limit);
    const rows = await this.admin.listJobs(tenantId, cursor, effective);
    const last = rows.at(-1);
    return {
      jobs: rows.map(toJobView),
      next_cursor:
        rows.length === effective && last !== undefined ? last.createdAt.toISOString() : null,
    };
  }

  // ----- ledger -----

  @Get('ledger')
  @ApiOperation({ summary: 'List a tenant’s ledger transactions (keyset)' })
  async listLedger(
    @Query('tenantId') tenantId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<{ transactions: LedgerView[]; next_cursor: string | null }> {
    const effective = parseLimit(limit);
    const rows = await this.admin.listLedger(tenantId, cursor, effective);
    const last = rows.at(-1);
    return {
      transactions: rows.map(toLedgerView),
      next_cursor:
        rows.length === effective && last !== undefined ? last.createdAt.toISOString() : null,
    };
  }

  // ----- redemption codes -----

  @Post('redemption-codes')
  @HttpCode(201)
  @ApiOperation({ summary: 'Batch-mint redemption codes (credits → µcredits)' })
  async generateCodes(
    @Body(new ZodBody(generateCodesSchema)) dto: GenerateCodesDto,
  ): Promise<{ codes: string[]; credit_amount: string }> {
    const { codes, creditAmount } = await this.admin.generateCodes(dto);
    return { codes, credit_amount: creditAmount.toString() };
  }

  // ----- usage stats -----

  @Get('usage')
  @ApiOperation({ summary: 'Global per-call usage log (all tenants)' })
  async listUsage(@Query('limit') limit?: string): Promise<{ logs: UsageLogView[] }> {
    const rows = await this.admin.listUsageGlobal(parseLimit(limit));
    return { logs: rows.map(toUsageLogView) };
  }

  // ----- analytics -----

  @Get('analytics/usage')
  @ApiOperation({ summary: 'Usage rollups by day/model/tenant/channel/api-key' })
  async analyticsUsage(@Query() raw: Record<string, string>): Promise<UsageRollupView[]> {
    const q = parseAnalyticsUsageQuery(raw);
    const rows = await this.admin.analyticsUsage(q);
    return rows.map(toUsageRollupView);
  }
}

/**
 * Validate the analytics-usage query against its zod schema. Query params arrive
 * as strings; on failure we throw an `invalid_input` engine error so the global
 * filter renders the §4.7 envelope (400) — mirroring the {@link ZodBody} pipe,
 * since query params aren't routed through it.
 */
function parseAnalyticsUsageQuery(raw: Record<string, string>): AnalyticsUsageQueryDto {
  const result = analyticsUsageQuerySchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join('.') ?? '';
    const detail = first === undefined ? 'invalid query' : `${path}: ${first.message}`;
    throw engineInvalidInput(detail);
  }
  return result.data;
}

function toTenantView(row: TenantRow): TenantView {
  return {
    id: row.id,
    name: row.name,
    isolation_mode: row.isolationMode,
    created_at: row.createdAt.toISOString(),
  };
}

function toAccountView(row: AccountRow): AccountView {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    credit_balance: row.creditBalance.toString(),
    credit_held: row.creditHeld.toString(),
    created_at: row.createdAt.toISOString(),
  };
}

function toResourceView(row: Resource): ResourceView {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    kind: row.kind,
    modality: row.modality,
    provider_type: row.providerType,
    exec_modes: row.execModes,
    status: row.status,
    current_version: row.currentVersion,
    created_at: row.createdAt.toISOString(),
  };
}

function toChannelView(row: UpstreamChannelRow): ChannelView {
  return {
    id: row.id,
    resource_id: row.resourceId,
    provider_type: row.providerType,
    credential_ref: row.credentialRef,
    endpoint: row.endpoint,
    model: row.model,
    proxy_ref: row.proxyRef,
    config: row.config,
    weight: row.weight,
    status: row.status,
  };
}

function toPricebookView(row: PricebookEntryRow): PricebookView {
  return {
    id: row.id,
    resource_id: row.resourceId,
    resource_version: row.resourceVersion,
    version: row.version,
    method: row.method,
    timing: row.timing,
    spec: row.spec,
    markup: row.markup,
    active: row.active,
  };
}

function toModifierView(row: ModifierRow): ModifierView {
  return {
    id: row.id,
    scope: row.scope,
    when_expr: row.whenExpr,
    op: row.op,
    value: row.value === null ? null : row.value.toString(),
    stackable: row.stackable,
    priority: row.priority,
    version: row.version,
    active: row.active,
  };
}

function toLedgerView(row: LedgerRow): LedgerView {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    account_id: row.accountId,
    type: row.type,
    credits_delta: row.creditsDelta.toString(),
    balance_after: row.balanceAfter.toString(),
    resource_id: row.resourceId,
    job_id: row.jobId,
    created_at: row.createdAt.toISOString(),
  };
}

function toJobView(row: Job): JobView {
  return {
    job_id: row.id,
    tenant_id: row.tenantId,
    resource_id: row.resourceId,
    status: row.status,
    exec_mode: row.execMode,
    cost: row.costCredits === null ? null : row.costCredits.toString(),
    created_at: row.createdAt.toISOString(),
  };
}

function toModelView(row: ModelRow): ModelView {
  return {
    id: row.id,
    name: row.name,
    display: row.display,
    modality: row.modality,
    capabilities: row.capabilities,
    visibility: row.visibility,
    resource_id: row.resourceId,
    input_price: row.inputPrice.toString(),
    output_price: row.outputPrice.toString(),
    status: row.status,
    created_at: row.createdAt.toISOString(),
  };
}

function toUsageLogView(row: UsageLogRow): UsageLogView {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    model: row.model,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cost: row.cost.toString(),
    latency_ms: row.latencyMs,
    status: row.status,
    created_at: row.createdAt.toISOString(),
  };
}

function toUsageRollupView(row: UsageRollupRow): UsageRollupView {
  return {
    bucket: row.bucket,
    requests: row.requests,
    input_tokens: row.inputTokens.toString(),
    output_tokens: row.outputTokens.toString(),
    cost: row.cost.toString(),
    errors: row.errors,
  };
}
