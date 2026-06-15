import type {
  AccountRow,
  Job,
  LedgerRow,
  ModifierRow,
  PricebookEntryRow,
  Resource,
  TenantRow,
  UpstreamChannelRow,
} from '@actionow/db';
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ZodBody } from '../common/zod.pipe.js';
import { AdminService } from './admin.service.js';
import { AdminGuard } from './auth/admin.guard.js';
import { Roles } from './auth/roles.decorator.js';
import {
  type CreateAccountDto,
  createAccountSchema,
  type CreateApiKeyDto,
  createApiKeySchema,
  type CreateChannelDto,
  createChannelSchema,
  type CreateModifierDto,
  createModifierSchema,
  type CreatePricebookDto,
  createPricebookSchema,
  type CreateResourceDto,
  createResourceSchema,
  type CreateTenantDto,
  createTenantSchema,
  type TopupDto,
  topupSchema,
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

/**
 * Admin CRUD over the catalog/pricing/tenants/keys (Phase 5, Task 4). Every
 * route requires an admin JWT with the `admin` role (the {@link AdminGuard} +
 * `@Roles`). Money is entered as HUMAN credits and converted to µcredits in the
 * {@link AdminService}; responses serialize stored µcredits as decimal strings
 * so JSON never coerces money through a float.
 */
@ApiTags('admin')
@ApiBearerAuth()
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
