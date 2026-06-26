import {
  type AccountView,
  accountViewSchema,
  type AdminTokenView,
  adminTokenViewSchema,
  type ApiKeyView,
  apiKeyViewSchema,
  type AuditLogView,
  auditLogViewSchema,
  type BreakerView,
  breakerViewSchema,
  type BulkResultView,
  type ChannelHealthView,
  channelHealthViewSchema,
  type ChannelModelLinkInput,
  channelModelLinkInputSchema,
  type ChannelView,
  channelViewSchema,
  type CodexLoginStartView,
  codexLoginStartViewSchema,
  type FaultPolicyView,
  faultPolicyViewSchema,
  type IconAssetView,
  iconAssetViewSchema,
  type JobView,
  jobViewSchema,
  type LedgerView,
  ledgerViewSchema,
  type LimitAlertView,
  limitAlertViewSchema,
  type LimitPlanView,
  limitPlanViewSchema,
  type LimitRuleStatusView,
  limitRuleStatusViewSchema,
  type LimitRuleView,
  limitRuleViewSchema,
  type LimitUsageView,
  limitUsageViewSchema,
  type ModelGrantView,
  modelGrantViewSchema,
  type ModelHealthView,
  modelHealthViewSchema,
  type ModelTestResult,
  type ModelView,
  modelViewSchema,
  type ModifierView,
  modifierViewSchema,
  type OAuthSessionListView,
  oauthSessionListViewSchema,
  type OAuthSessionView,
  oauthSessionViewSchema,
  type OfficialPriceView,
  officialPriceViewSchema,
  type OpsHealthView,
  opsHealthViewSchema,
  type OpsSummaryView,
  opsSummaryViewSchema,
  type PricebookView,
  pricebookViewSchema,
  type ProviderPluginView,
  providerPluginViewSchema,
  type ProvisionView,
  provisionViewSchema,
  type ProxyView,
  proxyViewSchema,
  type ReconcileRowView,
  reconcileRowViewSchema,
  type RedemptionCodeView,
  redemptionCodeViewSchema,
  type ResourceView,
  resourceViewSchema,
  type RouteGroupChannelView,
  routeGroupChannelViewSchema,
  type RouteGroupView,
  routeGroupViewSchema,
  type SecretView,
  secretViewSchema,
  type SubAccountView,
  subAccountViewSchema,
  type SubjectView,
  subjectViewSchema,
  type TenantView,
  tenantViewSchema,
  type TestPluginResponse,
  type UsageLogView,
  usageLogViewSchema,
  type UsageRollupView,
  usageRollupViewSchema,
} from '@actionow/contracts';
import type {
  AccountRow,
  AdminTokenView as AdminTokenRow,
  ApiKeyRow,
  AuditLogRow,
  ChannelHealthRow,
  FaultPolicyRow,
  IconAssetRow,
  Job,
  LedgerRow,
  LimitAlertRow,
  LimitPlanRow,
  LimitRuleRow,
  LimitRuleStatus,
  LimitUsageRow,
  ModelGrantRow,
  ModelHealthBucket,
  ModelHealthRow,
  ModelRow,
  ModifierRow,
  OAuthSessionListRow,
  OfficialModelPriceRow,
  PricebookEntryRow,
  ProviderPluginRow,
  ProxyRow,
  ReconcileRow,
  RedemptionCodeRow,
  Resource,
  RouteGroupChannelRow,
  RouteGroupRow,
  SecretRefView,
  SubAccountRow,
  SubjectRow,
  TenantRow,
  UpstreamChannelRow,
  UsageLogRow,
  UsageRollupRow,
} from '@actionow/db';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Audit } from '../audit/audit.decorator.js';
import { AuditInterceptor } from '../audit/audit.interceptor.js';
import { engineInvalidInput, engineUnauthorized } from '../common/errors.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { Idempotent } from '../common/idempotent.decorator.js';
import { mapPageEnvelope, type PageEnvelope, toPageParams } from '../common/pagination.js';
import { ZodBody } from '../common/zod.pipe.js';
import {
  AdminService,
  type BreakerStatusWithRate,
  type ProvisionResult,
  type RelayTraceView,
  toRelayTraceView,
} from './admin.service.js';
import { AdminTokenService } from './admin-token.service.js';
import { AdminGuard, type AdminRequest } from './auth/admin.guard.js';
import { Roles } from './auth/roles.decorator.js';
import {
  type AddGroupChannelDto,
  addGroupChannelSchema,
  type AnalyticsUsageQueryDto,
  analyticsUsageQuerySchema,
  type BulkChannelActionDto,
  bulkChannelActionSchema,
  type BulkModelActionDto,
  bulkModelActionSchema,
  type BulkOAuthSessionActionDto,
  bulkOAuthSessionActionSchema,
  type CodexLoginComplete,
  codexLoginCompleteSchema,
  type CodexLoginStart,
  codexLoginStartSchema,
  type CreateAccountDto,
  createAccountSchema,
  type CreateAdminTokenDto,
  createAdminTokenSchema,
  type CreateApiKeyDto,
  createApiKeySchema,
  type CreateChannelDto,
  createChannelSchema,
  type CreateFaultPolicyDto,
  createFaultPolicySchema,
  type CreateLimitPlanDto,
  createLimitPlanRequestSchema,
  type CreateModelDto,
  createModelSchema,
  type CreateModifierDto,
  createModifierSchema,
  type CreateOAuthSessionDto,
  createOAuthSessionSchema,
  type CreateOfficialPriceDto,
  createOfficialPriceSchema,
  type CreatePluginDto,
  createPluginRequestSchema,
  type CreatePricebookDto,
  createPricebookSchema,
  type CreateProxyDto,
  createProxySchema,
  type CreateResourceDto,
  createResourceSchema,
  type CreateRouteGroupDto,
  createRouteGroupSchema,
  type CreateSecretDto,
  createSecretSchema,
  type CreateSubAccountDto,
  createSubAccountSchema,
  type CreateSubjectDto,
  createSubjectSchema,
  type CreateTenantDto,
  createTenantSchema,
  type EnsureResourceDto,
  ensureResourceSchema,
  type GenerateCodesDto,
  generateCodesSchema,
  type GrantModelDto,
  grantModelSchema,
  type ModelTestDto,
  modelTestRequestSchema,
  type OfficialPricesQueryDto,
  officialPricesQuerySchema,
  type ProvisionDto,
  provisionSchema,
  type ProxyProbeDto,
  proxyProbeRequestSchema,
  type RedemptionCodesQueryDto,
  redemptionCodesQuerySchema,
  type RelayTraceQueryDto,
  relayTraceQuerySchema,
  type SetLimitPlanDto,
  setLimitPlanRequestSchema,
  type SyncChannelModelsDto,
  syncChannelModelsSchema,
  type TestPluginDto,
  testPluginRequestSchema,
  type TopupDto,
  topupSchema,
  type TopupSubAccountDto,
  topupSubAccountSchema,
  type TransferCreditsDto,
  transferCreditsSchema,
  type UpdateApiKeyGroupDto,
  updateApiKeyGroupSchema,
  type UpdateChannelDto,
  updateChannelSchema,
  type UpdateCredentialMetaDto,
  updateCredentialMetaSchema,
  type UpdateFaultPolicyDto,
  updateFaultPolicySchema,
  type UpdateLimitPlanDto,
  updateLimitPlanRequestSchema,
  type UpdateModelDto,
  updateModelSchema,
  type UpdateModifierDto,
  updateModifierSchema,
  type UpdateOfficialPriceDto,
  updateOfficialPriceSchema,
  type UpdatePluginDto,
  updatePluginRequestSchema,
  type UpdatePricebookDto,
  updatePricebookSchema,
  type UpdateProxyDto,
  updateProxySchema,
  type UpdateResourceDto,
  updateResourceSchema,
  type UpdateRouteGroupDto,
  updateRouteGroupSchema,
  type UpdateSubjectDto,
  updateSubjectSchema,
  type UpdateTenantDto,
  updateTenantSchema,
} from './dto/admin.dto.js';
import { ModelTestService } from './model-test.service.js';

// ----- JSON views (bigint money serialized as decimal µcredit strings) -----
// TenantView / AccountView are defined ONCE as zod schemas in
// @actionow/contracts — the single source of truth shared with the frontend
// (contract-first). The `toView` mappers below `.parse()` against them so a
// drifting mapper fails loudly instead of shipping bad JSON.

interface ApiKeyCreatedView {
  id: string;
  /** Returned ONCE — only the hash is persisted. Never re-derivable. */
  plaintext: string;
}

// ApiKeyView now lives in @actionow/contracts (ops-views) — single source of
// truth shared with the frontend; toApiKeyView() `.parse()`s against it.

// SecretView (the created-secret view: id/provider/created_at) now lives in
// @actionow/contracts (ops-views); it is built inline in createSecret() below.

/**
 * A credential's metadata for the list/get-by-id surface. EXCLUDES the secret
 * material by construction: only the locator/provider/timestamps are projected
 * (the `enc` ciphertext lives in `secret_material` and is never selected). `id`
 * is usable as a channel `credentialRef`.
 */
interface SecretMetadataView {
  id: string;
  provider: string;
  locator: string;
  created_at: string;
  updated_at: string;
}

// OAuthSessionView / OAuthSessionListView / CodexLoginStartView now live in
// @actionow/contracts (ops-views) — single source of truth shared with the
// credential-management page; their toView mappers `.parse()` against the schemas.

// ResourceView / ChannelView / PricebookView / ModifierView / ModelView /
// ModelGrantView now live in @actionow/contracts (catalog-views) — single
// source of truth shared with the frontend; their toView mappers `.parse()`.

// LedgerView / JobView / UsageLogView / UsageRollupView / OfficialPriceView /
// RouteGroupView / RouteGroupChannelView now live in @actionow/contracts
// (ops-views + billing-views) — single source of truth shared with the
// frontend; their toView mappers `.parse()` against the schemas.

// RedemptionCodeView now lives in @actionow/contracts (ops-views) — single source
// of truth shared with the frontend; toRedemptionCodeView() `.parse()`s against it.

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
// Track D5: `Idempotency-Key` replay. The interceptor acts ONLY on POSTs marked
// with `@Idempotent()` (the non-secret allowlist below); every other route is
// untouched. Secret-returning POSTs are deliberately left undecorated.
@UseInterceptors(IdempotencyInterceptor)
// 记录系统: `@Audit(...)`-decorated mutation handlers emit an audit_log row after
// success (actor = req.admin operator). Undecorated routes are untouched.
@UseInterceptors(AuditInterceptor)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly tokens: AdminTokenService,
    private readonly modelTest: ModelTestService,
  ) {}

  // ----- tenants -----

  @Post('tenants')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({ summary: 'Create a tenant' })
  @Audit({
    action: 'tenant.create',
    target: 'tenant',
    resolve: ({ result }) => {
      const r = result as { id?: string; name?: string };
      return { tenantId: r.id ?? null, targetId: r.id ?? null, meta: { name: r.name } };
    },
  })
  async createTenant(
    @Body(new ZodBody(createTenantSchema)) dto: CreateTenantDto,
  ): Promise<TenantView> {
    return toTenantView(await this.admin.createTenant(dto));
  }

  @Post('provision')
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Provision a customer atomically — tenant + account + API key in one call (plaintext key returned once)',
  })
  @Audit({
    action: 'tenant.provision',
    target: 'tenant',
    resolve: ({ result }) => {
      const r = result as { tenant?: { id?: string }; account?: { id?: string } };
      return {
        tenantId: r.tenant?.id ?? null,
        targetId: r.tenant?.id ?? null,
        meta: { accountId: r.account?.id },
      };
    },
  })
  async provision(@Body(new ZodBody(provisionSchema)) dto: ProvisionDto): Promise<ProvisionView> {
    return toProvisionView(await this.admin.provision(dto));
  }

  @Get('tenants')
  @ApiOperation({ summary: 'List tenants (paginated)' })
  async listTenants(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<TenantView>> {
    const result = await this.admin.listTenants(toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toTenantView);
  }

  @Get('tenants/:id')
  @ApiOperation({ summary: 'Get one tenant by id or 404' })
  async getTenant(@Param('id') id: string): Promise<TenantView> {
    return toTenantView(await this.admin.getTenant(id));
  }

  @Patch('tenants/:id')
  @ApiOperation({ summary: 'Update a tenant (isolation mode)' })
  @Audit({
    action: 'tenant.update',
    target: 'tenant',
    resolve: ({ params, body }) => ({
      tenantId: params.id ?? null,
      targetId: params.id ?? null,
      meta: { ...(body as Record<string, unknown>) },
    }),
  })
  async updateTenant(
    @Param('id') id: string,
    @Body(new ZodBody(updateTenantSchema)) dto: UpdateTenantDto,
  ): Promise<TenantView> {
    return toTenantView(await this.admin.updateTenant(id, dto));
  }

  // ----- tenant subjects (end-users; unified tenancy G-A) -----

  @Post('tenants/:id/users')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({ summary: 'Create a subject (end-user) under a tenant' })
  @Audit({
    action: 'subject.create',
    target: 'subject',
    resolve: ({ params, result }) => {
      const r = result as { id?: string };
      return { tenantId: params.id ?? null, subjectId: r.id ?? null, targetId: r.id ?? null };
    },
  })
  async createSubject(
    @Param('id') tenantId: string,
    @Body(new ZodBody(createSubjectSchema)) dto: CreateSubjectDto,
  ): Promise<SubjectView> {
    return toSubjectView(await this.admin.createSubject(tenantId, dto));
  }

  @Get('tenants/:id/users')
  @ApiOperation({ summary: "List a tenant's subjects (paginated)" })
  async listSubjects(
    @Param('id') tenantId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<SubjectView>> {
    const result = await this.admin.listSubjects(tenantId, toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toSubjectView);
  }

  @Get('tenants/:id/users/:sid')
  @ApiOperation({ summary: 'Get one subject by id (tenant-scoped) or 404' })
  async getSubject(@Param('id') tenantId: string, @Param('sid') sid: string): Promise<SubjectView> {
    return toSubjectView(await this.admin.getSubject(tenantId, sid));
  }

  @Patch('tenants/:id/users/:sid')
  @ApiOperation({ summary: 'Update a subject (display name / status / plan / email)' })
  @Audit({
    action: 'subject.update',
    target: 'subject',
    resolve: ({ params, body }) => ({
      tenantId: params.id ?? null,
      subjectId: params.sid ?? null,
      targetId: params.sid ?? null,
      meta: { ...(body as Record<string, unknown>) },
    }),
  })
  async updateSubject(
    @Param('id') tenantId: string,
    @Param('sid') sid: string,
    @Body(new ZodBody(updateSubjectSchema)) dto: UpdateSubjectDto,
  ): Promise<SubjectView> {
    return toSubjectView(await this.admin.updateSubject(tenantId, sid, dto));
  }

  @Delete('tenants/:id/users/:sid')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete a subject (frees its external_id/email)' })
  @Audit({
    action: 'subject.delete',
    target: 'subject',
    resolve: ({ params, req }) => ({
      tenantId: params.id ?? null,
      subjectId: params.sid ?? null,
      targetId: params.sid ?? null,
      meta: (req as { auditMeta?: Record<string, unknown> }).auditMeta,
    }),
  })
  async deleteSubject(
    @Param('id') tenantId: string,
    @Param('sid') sid: string,
    @Req() req: AdminRequest,
  ): Promise<void> {
    const cascade = await this.admin.deleteSubject(tenantId, sid);
    // Stash the cascade summary so the audit interceptor records it as meta.
    (req as AdminRequest & { auditMeta?: Record<string, unknown> }).auditMeta = {
      sweptMicro: cascade.sweptMicro.toString(),
      disabledKeys: cascade.disabledKeys,
    };
  }

  // ----- subject sub-wallets (HARD mode; unified tenancy G-E) -----

  @Post('tenants/:id/users/:sid/sub-account')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({ summary: 'Open a HARD sub-wallet for a subject (optional opening balance)' })
  @Audit({
    action: 'sub_account.open',
    target: 'sub_account',
    resolve: ({ params, result, body }) => {
      const r = result as { id?: string };
      return {
        tenantId: params.id ?? null,
        subjectId: params.sid ?? null,
        targetId: r.id ?? null,
        meta: { ...(body as Record<string, unknown>) },
      };
    },
  })
  async createSubAccount(
    @Param('id') tenantId: string,
    @Param('sid') sid: string,
    @Body(new ZodBody(createSubAccountSchema)) dto: CreateSubAccountDto,
  ): Promise<SubAccountView> {
    return toSubAccountView(await this.admin.createSubAccount(tenantId, sid, dto));
  }

  @Get('tenants/:id/users/:sid/sub-account')
  @ApiOperation({ summary: "Get a subject's sub-wallet (balance/held) or 404" })
  async getSubAccount(
    @Param('id') tenantId: string,
    @Param('sid') sid: string,
  ): Promise<SubAccountView> {
    return toSubAccountView(await this.admin.getSubAccount(tenantId, sid));
  }

  @Post('tenants/:id/users/:sid/sub-account/topup')
  @HttpCode(200)
  @Idempotent()
  @ApiOperation({ summary: "Credit a subject's sub-wallet (credits → µcredits)" })
  @Audit({
    action: 'sub_account.topup',
    target: 'sub_account',
    resolve: ({ params, body }) => ({
      tenantId: params.id ?? null,
      subjectId: params.sid ?? null,
      targetId: params.sid ?? null,
      meta: { ...(body as Record<string, unknown>) },
    }),
  })
  async topupSubAccount(
    @Param('id') tenantId: string,
    @Param('sid') sid: string,
    @Body(new ZodBody(topupSubAccountSchema)) dto: TopupSubAccountDto,
  ): Promise<SubAccountView> {
    await this.admin.topupSubAccount(tenantId, sid, dto);
    return toSubAccountView(await this.admin.getSubAccount(tenantId, sid));
  }

  @Post('tenants/:id/users/:sid/sub-account/transfer')
  @HttpCode(200)
  @ApiOperation({ summary: 'Transfer credits between the tenant pool and a sub-wallet' })
  @Audit({
    action: 'sub_account.transfer',
    target: 'sub_account',
    resolve: ({ params, body }) => ({
      tenantId: params.id ?? null,
      subjectId: params.sid ?? null,
      targetId: params.sid ?? null,
      meta: { ...(body as Record<string, unknown>) },
    }),
  })
  async transferCredits(
    @Param('id') tenantId: string,
    @Param('sid') sid: string,
    @Body(new ZodBody(transferCreditsSchema)) dto: TransferCreditsDto,
  ): Promise<SubAccountView> {
    await this.admin.transferCredits(tenantId, sid, dto);
    return toSubAccountView(await this.admin.getSubAccount(tenantId, sid));
  }

  // ----- accounts -----

  @Post('accounts')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({ summary: 'Create an account (opening balance in credits)' })
  @Audit({
    action: 'account.create',
    target: 'account',
    resolve: ({ result }) => {
      const r = result as { id?: string; tenant_id?: string };
      return { tenantId: r.tenant_id ?? null, targetId: r.id ?? null };
    },
  })
  async createAccount(
    @Body(new ZodBody(createAccountSchema)) dto: CreateAccountDto,
  ): Promise<AccountView> {
    return toAccountView(await this.admin.createAccount(dto));
  }

  @Post('accounts/:id/topup')
  @HttpCode(200)
  @Idempotent()
  @ApiOperation({ summary: 'Top up an account (amount in credits → µcredits)' })
  @Audit({
    action: 'account.topup',
    target: 'account',
    resolve: ({ params, body }) => ({
      targetId: params.id ?? null,
      meta: { ...(body as Record<string, unknown>) },
    }),
  })
  async topup(
    @Param('id') id: string,
    @Body(new ZodBody(topupSchema)) dto: TopupDto,
  ): Promise<{ account_id: string; balance: string }> {
    const { balanceMicro } = await this.admin.topup(id, dto);
    return { account_id: id, balance: balanceMicro };
  }

  @Get('accounts')
  @ApiOperation({ summary: 'List accounts (balance/held view, paginated)' })
  async listAccounts(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<AccountView>> {
    const result = await this.admin.listAccounts(toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toAccountView);
  }

  @Get('accounts/:id')
  @ApiOperation({
    summary: 'Get one account (balance/held view) or 404 — balance moves only via topup/ledger',
  })
  async getAccount(@Param('id') id: string): Promise<AccountView> {
    // No PATCH/DELETE for accounts: the balance/held are ledger-owned and only
    // move through topup + the settle/hold paths, never a direct admin write.
    return toAccountView(await this.admin.getAccountById(id));
  }

  // ----- api keys -----

  @Post('api-keys')
  @HttpCode(201)
  @ApiOperation({ summary: 'Mint an API key (plaintext returned once)' })
  @Audit({
    action: 'api_key.create',
    target: 'api_key',
    // NEVER record the plaintext — only the id + scope.
    resolve: ({ result, body }) => {
      const r = result as { id?: string };
      const b = body as { tenantId?: string; subjectId?: string };
      return {
        tenantId: b.tenantId ?? null,
        subjectId: b.subjectId ?? null,
        targetId: r.id ?? null,
      };
    },
  })
  async createApiKey(
    @Body(new ZodBody(createApiKeySchema)) dto: CreateApiKeyDto,
  ): Promise<ApiKeyCreatedView> {
    const created = await this.admin.createApiKey(dto);
    return { id: created.id, plaintext: created.plaintext };
  }

  @Get('api-keys')
  @ApiOperation({ summary: 'List a tenant’s API keys (no hashes, paginated)' })
  async listApiKeys(
    @Query('tenantId') tenantId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<ApiKeyView>> {
    const result = await this.admin.listApiKeys(tenantId, toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toApiKeyView);
  }

  @Patch('api-keys/:id/group')
  @ApiOperation({ summary: "(Re)bind an API key's route group (routeGroupId: uuid | null)" })
  @Audit({
    action: 'api_key.group_bind',
    target: 'api_key',
    resolve: ({ params, body }) => ({
      targetId: params.id ?? null,
      meta: { ...(body as Record<string, unknown>) },
    }),
  })
  async bindApiKeyGroup(
    @Param('id') id: string,
    @Body(new ZodBody(updateApiKeyGroupSchema)) dto: UpdateApiKeyGroupDto,
  ): Promise<{ id: string; route_group_id: string | null }> {
    await this.admin.setApiKeyGroup(id, dto);
    return { id, route_group_id: dto.routeGroupId };
  }

  @Delete('api-keys/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke (soft-delete) an API key — the key is rejected with 401 after' })
  @Audit({
    action: 'api_key.revoke',
    target: 'api_key',
    resolve: ({ params }) => ({ targetId: params.id ?? null }),
  })
  async revokeApiKey(@Param('id') id: string): Promise<void> {
    await this.admin.revokeApiKey(id);
  }

  // ----- service tokens (M2M admin credentials) -----

  @Post('tokens')
  @HttpCode(201)
  @ApiOperation({ summary: 'Mint an admin service token (M2M; plaintext returned once)' })
  async createAdminToken(
    @Req() req: AdminRequest,
    @Body(new ZodBody(createAdminTokenSchema)) dto: CreateAdminTokenDto,
  ): Promise<ApiKeyCreatedView> {
    // AdminGuard populates req.admin before any handler runs; attribute the token
    // to that admin (its id is the `created_by` FK). The fallback is unreachable.
    const createdBy = req.admin?.adminId;
    if (createdBy === undefined) throw engineUnauthorized('missing admin context');
    const created = await this.tokens.mint(dto, createdBy);
    return { id: created.id, plaintext: created.plaintext };
  }

  @Get('tokens')
  @ApiOperation({ summary: 'List admin service tokens (metadata only, no hash, paginated)' })
  async listAdminTokens(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<AdminTokenView>> {
    const result = await this.tokens.list(toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toAdminTokenView);
  }

  @Delete('tokens/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke (soft-delete) a service token — rejected with 401 after' })
  async revokeAdminToken(@Param('id') id: string): Promise<void> {
    await this.tokens.revoke(id);
  }

  // ----- secrets -----

  @Post('secrets')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create an encrypted-at-rest credential (returns its ref id)' })
  async createSecret(
    @Body(new ZodBody(createSecretSchema)) dto: CreateSecretDto,
  ): Promise<SecretView> {
    const row = await this.admin.createSecret(dto);
    return secretViewSchema.parse({
      id: row.id,
      provider: row.provider,
      name: row.name,
      notes: row.notes,
      group: row.groupTag,
      created_at: row.createdAt.toISOString(),
    });
  }

  @Get('secrets')
  @ApiOperation({ summary: 'List credentials (metadata only, NO material, paginated)' })
  async listSecrets(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<SecretMetadataView>> {
    const result = await this.admin.listSecrets(toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toSecretMetadataView);
  }

  @Get('secrets/:id')
  @ApiOperation({ summary: 'Get one credential (metadata only, NO material) or 404' })
  async getSecret(@Param('id') id: string): Promise<SecretMetadataView> {
    return toSecretMetadataView(await this.admin.getSecret(id));
  }

  @Delete('secrets/:id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Revoke (soft-delete) a credential — resolution returns undefined after',
  })
  async revokeSecret(@Param('id') id: string): Promise<void> {
    await this.admin.revokeSecret(id);
  }

  @Patch('secrets/:id')
  @ApiOperation({ summary: 'Edit a credential’s metadata (name/notes/group) — never the material' })
  async updateSecret(
    @Param('id') id: string,
    @Body(new ZodBody(updateCredentialMetaSchema)) dto: UpdateCredentialMetaDto,
  ): Promise<SecretMetadataView> {
    return toSecretMetadataView(await this.admin.updateSecretMeta(id, dto));
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
    return toOAuthSessionView(session);
  }

  @Get('oauth-sessions')
  @ApiOperation({ summary: 'List registered OAuth subscription sessions (token-free, paginated)' })
  async listOAuthSessions(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<OAuthSessionListView>> {
    const result = await this.admin.listOAuthSessions(toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.secretRefId, toOAuthSessionListView);
  }

  @Delete('oauth-sessions/:id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Revoke (soft-delete) an OAuth session — channel resolution returns undefined after',
  })
  async revokeOAuthSession(@Param('id') id: string): Promise<void> {
    await this.admin.revokeOAuthSession(id);
  }

  @Patch('oauth-sessions/:id')
  @ApiOperation({
    summary: 'Edit an OAuth session’s metadata (name/notes/group) — never the tokens',
  })
  async updateOAuthSession(
    @Param('id') id: string,
    @Body(new ZodBody(updateCredentialMetaSchema)) dto: UpdateCredentialMetaDto,
  ): Promise<OAuthSessionListView> {
    return toOAuthSessionListView(await this.admin.updateOAuthSessionMeta(id, dto));
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
    return codexLoginStartViewSchema.parse(this.admin.startCodexLogin());
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
    return toOAuthSessionView(session);
  }

  // ----- resources -----

  @Post('resources')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({ summary: 'Register a catalog resource (+ io_schema)' })
  async createResource(
    @Body(new ZodBody(createResourceSchema)) dto: CreateResourceDto,
  ): Promise<ResourceView> {
    return toResourceView(await this.admin.createResource(dto));
  }

  @Post('resources/ensure')
  @ApiOperation({
    summary: 'Reuse-or-create a platform for (providerType, modality) — 模型接入 onboarding',
  })
  async ensureResource(
    @Body(new ZodBody(ensureResourceSchema)) dto: EnsureResourceDto,
  ): Promise<ResourceView> {
    return toResourceView(await this.admin.ensureResource(dto));
  }

  @Get('provider-types')
  @ApiOperation({
    summary: 'The provider types every registered adapter serves (channel provider options)',
  })
  listProviderTypes(): string[] {
    return this.admin.listProviderTypes();
  }

  @Get('resources')
  @ApiOperation({ summary: 'List catalog resources (paginated)' })
  async listResources(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<ResourceView>> {
    const result = await this.admin.listResources(toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toResourceView);
  }

  @Get('resources/:id')
  @ApiOperation({ summary: 'Get one catalog resource by id or 404' })
  async getResource(@Param('id') id: string): Promise<ResourceView> {
    return toResourceView(await this.admin.getResource(id));
  }

  @Patch('resources/:id')
  @ApiOperation({ summary: 'Update a resource (status only — key fields are immutable)' })
  async updateResource(
    @Param('id') id: string,
    @Body(new ZodBody(updateResourceSchema)) dto: UpdateResourceDto,
  ): Promise<ResourceView> {
    return toResourceView(await this.admin.updateResource(id, dto));
  }

  @Post('resources/:id/channels')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({ summary: 'Add an upstream channel to a resource' })
  async createChannel(
    @Param('id') id: string,
    @Body(new ZodBody(createChannelSchema)) dto: CreateChannelDto,
  ): Promise<ChannelView> {
    return toChannelView(await this.admin.createChannel(id, dto));
  }

  @Get('resources/:id/channels')
  @ApiOperation({ summary: "List a resource's upstream channels (incl. disabled, paginated)" })
  async listChannels(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<ChannelView>> {
    const result = await this.admin.listResourceChannels(id, toPageParams({ cursor, limit }));
    const counts = await this.admin.modelCountsByChannels(result.rows.map((r) => r.id));
    return mapPageEnvelope(
      result,
      (r) => r.id,
      (r) => toChannelView(r, counts.get(r.id) ?? 0),
    );
  }

  @Get('resources/:id/channels/:channelId')
  @ApiOperation({ summary: 'Get one channel of a resource or 404 (channel ∉ resource → 404)' })
  async getChannel(
    @Param('id') id: string,
    @Param('channelId') channelId: string,
  ): Promise<ChannelView> {
    const row = await this.admin.getChannel(id, channelId);
    const counts = await this.admin.modelCountsByChannels([row.id]);
    return toChannelView(row, counts.get(row.id) ?? 0);
  }

  @Get('resources/:id/channels/:channelId/models')
  @ApiOperation({ summary: 'List the models a channel serves (channel_model links)' })
  async listChannelModels(
    @Param('id') id: string,
    @Param('channelId') channelId: string,
  ): Promise<ModelView[]> {
    const rows = await this.admin.listChannelModels(id, channelId);
    const served = await this.admin.servedChannelsByModels(rows.map((r) => r.id));
    return rows.map((r) => toModelView(r, served.get(r.id) ?? []));
  }

  @Post('resources/:id/channels/:channelId/models')
  @HttpCode(201)
  @ApiOperation({ summary: 'Link an existing platform model to a channel' })
  async linkChannelModel(
    @Param('id') id: string,
    @Param('channelId') channelId: string,
    @Body(new ZodBody(channelModelLinkInputSchema)) dto: ChannelModelLinkInput,
  ): Promise<{ ok: true }> {
    await this.admin.linkChannelModel(id, channelId, dto.model_id);
    return { ok: true };
  }

  @Delete('resources/:id/channels/:channelId/models/:modelId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Unlink a model from a channel (does not delete the model)' })
  async unlinkChannelModel(
    @Param('id') id: string,
    @Param('channelId') channelId: string,
    @Param('modelId') modelId: string,
  ): Promise<void> {
    await this.admin.unlinkChannelModel(id, channelId, modelId);
  }

  @Patch('resources/:id/channels/:channelId')
  @ApiOperation({ summary: 'Update an upstream channel (weight/status/endpoint/model/...)' })
  async updateChannel(
    @Param('channelId') channelId: string,
    @Body(new ZodBody(updateChannelSchema)) dto: UpdateChannelDto,
  ): Promise<ChannelView> {
    return toChannelView(await this.admin.updateChannel(channelId, dto));
  }

  @Delete('resources/:id/channels/:channelId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete an upstream channel (channel ∉ resource → 404)' })
  async deleteChannel(
    @Param('id') id: string,
    @Param('channelId') channelId: string,
  ): Promise<void> {
    await this.admin.deleteChannel(id, channelId);
  }

  @Post('resources/:id/channels/:channelId/sync-models')
  @HttpCode(200)
  @Idempotent()
  @ApiOperation({
    summary: "Sync a channel provider's available models into model rows (multi-model routing)",
  })
  async syncChannelModels(
    @Param('id') id: string,
    @Param('channelId') channelId: string,
    @Body(new ZodBody(syncChannelModelsSchema)) dto: SyncChannelModelsDto,
  ): Promise<{
    resource_id: string;
    created: string[];
    updated: string[];
    total: number;
    summary: { name: string; priced: string }[];
  }> {
    return this.admin.syncChannelModels(id, channelId, dto);
  }

  // ----- pricebook -----

  @Post('pricebook')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({ summary: 'Add a pricebook entry (fixed amount in credits)' })
  async createPricebook(
    @Body(new ZodBody(createPricebookSchema)) dto: CreatePricebookDto,
  ): Promise<PricebookView> {
    return toPricebookView(await this.admin.createPricebook(dto));
  }

  @Get('pricebook')
  @ApiOperation({ summary: 'List a resource’s pricebook entries (paginated)' })
  async listPricebook(
    @Query('resourceId') resourceId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<PricebookView>> {
    const result = await this.admin.listPricebook(resourceId, toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toPricebookView);
  }

  @Get('pricebook/:id')
  @ApiOperation({ summary: 'Get one pricebook entry by id or 404' })
  async getPricebook(@Param('id') id: string): Promise<PricebookView> {
    return toPricebookView(await this.admin.getPricebook(id));
  }

  @Patch('pricebook/:id')
  @ApiOperation({ summary: 'Update a pricebook entry (fixedCredits → µcredit spec.amount)' })
  async updatePricebook(
    @Param('id') id: string,
    @Body(new ZodBody(updatePricebookSchema)) dto: UpdatePricebookDto,
  ): Promise<PricebookView> {
    return toPricebookView(await this.admin.updatePricebook(id, dto));
  }

  @Delete('pricebook/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete a pricebook entry' })
  async deletePricebook(@Param('id') id: string): Promise<void> {
    await this.admin.deletePricebook(id);
  }

  // ----- modifiers -----

  @Post('modifiers')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({ summary: 'Add a pricing modifier (scope-aware, §9.2)' })
  async createModifier(
    @Body(new ZodBody(createModifierSchema)) dto: CreateModifierDto,
  ): Promise<ModifierView> {
    return toModifierView(await this.admin.createModifier(dto));
  }

  @Get('modifiers')
  @ApiOperation({ summary: 'List pricing modifiers (paginated)' })
  async listModifiers(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<ModifierView>> {
    const result = await this.admin.listModifiers(toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toModifierView);
  }

  @Get('modifiers/:id')
  @ApiOperation({ summary: 'Get one pricing modifier by id or 404' })
  async getModifier(@Param('id') id: string): Promise<ModifierView> {
    return toModifierView(await this.admin.getModifier(id));
  }

  @Patch('modifiers/:id')
  @ApiOperation({ summary: 'Update a pricing modifier (credit-op value → µcredits)' })
  async updateModifier(
    @Param('id') id: string,
    @Body(new ZodBody(updateModifierSchema)) dto: UpdateModifierDto,
  ): Promise<ModifierView> {
    return toModifierView(await this.admin.updateModifier(id, dto));
  }

  @Delete('modifiers/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete a pricing modifier' })
  async deleteModifier(@Param('id') id: string): Promise<void> {
    await this.admin.deleteModifier(id);
  }

  // ----- icon catalog (selectable brand icons) -----

  @Get('icons')
  @ApiOperation({ summary: 'List the selectable icon catalog (plugin/channel/model picker)' })
  async listIcons(): Promise<IconAssetView[]> {
    return (await this.admin.listIcons()).map(toIconAssetView);
  }

  // ----- governance limits (额度套餐) -----

  @Get('limit-plans')
  @ApiOperation({ summary: 'List limit plans (额度套餐) with rules + binding counts' })
  async listLimitPlans(): Promise<LimitPlanView[]> {
    return (await this.admin.listLimitPlans()).map(toLimitPlanView);
  }

  @Post('limit-plans')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a limit plan (+ rules)' })
  @Audit({
    action: 'limit_plan.create',
    target: 'limit_plan',
    resolve: ({ result }) => {
      const r = result as { id?: string; name?: string };
      return { targetId: r.id ?? null, meta: { name: r.name } };
    },
  })
  async createLimitPlan(
    @Body(new ZodBody(createLimitPlanRequestSchema)) dto: CreateLimitPlanDto,
  ): Promise<LimitPlanView> {
    return toLimitPlanView(await this.admin.createLimitPlan(dto));
  }

  @Get('limit-plans/:id')
  @ApiOperation({ summary: 'Get one limit plan (+ rules) or 404' })
  async getLimitPlan(@Param('id') id: string): Promise<LimitPlanView> {
    return toLimitPlanView(await this.admin.getLimitPlan(id));
  }

  @Patch('limit-plans/:id')
  @ApiOperation({ summary: 'Update a limit plan; a present `rules` REPLACES the rule set' })
  @Audit({
    action: 'limit_plan.update',
    target: 'limit_plan',
    resolve: ({ params, body }) => {
      const b = body as { name?: string; status?: string; rules?: unknown[] };
      return {
        targetId: params.id ?? null,
        meta: { name: b.name, status: b.status, ruleCount: b.rules?.length },
      };
    },
  })
  async updateLimitPlan(
    @Param('id') id: string,
    @Body(new ZodBody(updateLimitPlanRequestSchema)) dto: UpdateLimitPlanDto,
  ): Promise<LimitPlanView> {
    return toLimitPlanView(await this.admin.updateLimitPlan(id, dto));
  }

  @Delete('limit-plans/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete a limit plan' })
  @Audit({
    action: 'limit_plan.delete',
    target: 'limit_plan',
    resolve: ({ params }) => ({ targetId: params.id ?? null }),
  })
  async deleteLimitPlan(@Param('id') id: string): Promise<void> {
    await this.admin.deleteLimitPlan(id);
  }

  @Get('limits/usage')
  @ApiOperation({ summary: "A subject's accumulated usage rows (usage-vs-cap UI)" })
  async listLimitUsage(
    @Query('subjectType') subjectType: string,
    @Query('subjectId') subjectId: string,
  ): Promise<LimitUsageView[]> {
    return (await this.admin.listLimitUsage(subjectType, subjectId)).map(toLimitUsageView);
  }

  @Get('limits/status')
  @ApiOperation({
    summary: "A subject's effective rules paired with current usage (usage-vs-cap bars)",
  })
  async limitStatus(
    @Query('subjectType') subjectType: string,
    @Query('subjectId') subjectId: string,
    @Query('planId') planId?: string,
  ): Promise<LimitRuleStatusView[]> {
    const st = subjectType === 'key' ? 'key' : subjectType === 'subject' ? 'subject' : 'tenant';
    const rows = await this.admin.limitStatus(st, subjectId, planId ?? null);
    return rows.map(toLimitRuleStatusView);
  }

  @Get('limits/alerts')
  @ApiOperation({ summary: 'Recent limit threshold alerts (newest first)' })
  async listLimitAlerts(): Promise<LimitAlertView[]> {
    return (await this.admin.listLimitAlerts()).map(toLimitAlertView);
  }

  // ----- records (审计日志 + reconcile) -----

  @Get('audit-log')
  @ApiOperation({
    summary: 'Audit log (记录系统) — who-changed-what, keyset-paginated, filterable',
  })
  async listAuditLog(
    @Query('tenantId') tenantId?: string,
    @Query('subjectId') subjectId?: string,
    @Query('actorType') actorType?: string,
    @Query('action') action?: string,
    @Query('targetType') targetType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<AuditLogView>> {
    const result = await this.admin.listAuditLog(
      {
        ...(tenantId !== undefined ? { tenantId } : {}),
        ...(subjectId !== undefined ? { subjectId } : {}),
        ...(actorType !== undefined ? { actorType } : {}),
        ...(action !== undefined ? { action } : {}),
        ...(targetType !== undefined ? { targetType } : {}),
        ...(from !== undefined ? { from: new Date(from) } : {}),
        ...(to !== undefined ? { to: new Date(to) } : {}),
      },
      toPageParams({ cursor, limit }),
    );
    return mapPageEnvelope(result, (r) => r.id, toAuditLogView);
  }

  @Get('records/reconcile')
  @ApiOperation({ summary: "A tenant's account balance(s) vs ledger sum (记录系统 reconcile)" })
  async reconcile(@Query('tenantId') tenantId: string): Promise<ReconcileRowView[]> {
    return (await this.admin.reconcile(tenantId)).map(toReconcileRowView);
  }

  @Post('api-keys/:id/limit-plan')
  @ApiOperation({ summary: "Bind/unbind a key's limit plan (planId null = clear)" })
  @Audit({
    action: 'api_key.limit_plan_bind',
    target: 'api_key',
    resolve: ({ params, body }) => ({
      targetId: params.id ?? null,
      meta: { planId: (body as { planId?: string | null }).planId },
    }),
  })
  async setApiKeyLimitPlan(
    @Param('id') id: string,
    @Body(new ZodBody(setLimitPlanRequestSchema)) dto: SetLimitPlanDto,
  ): Promise<{ ok: true }> {
    await this.admin.setApiKeyLimitPlan(id, dto.planId);
    return { ok: true };
  }

  @Post('tenants/:id/limit-plan')
  @ApiOperation({ summary: "Bind/unbind a tenant's limit plan (planId null = clear)" })
  @Audit({
    action: 'tenant.limit_plan_bind',
    target: 'tenant',
    resolve: ({ params, body }) => ({
      tenantId: params.id ?? null,
      targetId: params.id ?? null,
      meta: { planId: (body as { planId?: string | null }).planId },
    }),
  })
  async setTenantLimitPlan(
    @Param('id') id: string,
    @Body(new ZodBody(setLimitPlanRequestSchema)) dto: SetLimitPlanDto,
  ): Promise<{ ok: true }> {
    await this.admin.setTenantLimitPlan(id, dto.planId);
    return { ok: true };
  }

  // ----- provider plugins (P2) -----

  @Get('plugins')
  @ApiOperation({ summary: 'List provider plugins (manifest + handler) with channel/model counts' })
  async listPlugins(): Promise<ProviderPluginView[]> {
    const [rows, counts] = await Promise.all([this.admin.listPlugins(), this.admin.pluginCounts()]);
    return rows.map((r) => toPluginView(r, counts.get(r.id)));
  }

  @Get('plugins/:id/channels')
  @ApiOperation({ summary: "List a plugin's bound channels across resources (模型接入 3-pane)" })
  async listPluginChannels(@Param('id') id: string): Promise<ChannelView[]> {
    const rows = await this.admin.listPluginChannels(id);
    const counts = await this.admin.modelCountsByChannels(rows.map((r) => r.id));
    return rows.map((r) => toChannelView(r, counts.get(r.id) ?? 0));
  }

  @Post('plugins')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a provider plugin' })
  async createPlugin(
    @Body(new ZodBody(createPluginRequestSchema)) dto: CreatePluginDto,
  ): Promise<ProviderPluginView> {
    return toPluginView(await this.admin.createPlugin(dto));
  }

  @Post('plugins/test')
  @ApiOperation({ summary: 'Run one handler fn in the sandbox with a sample arg (test panel)' })
  async testPlugin(
    @Body(new ZodBody(testPluginRequestSchema)) dto: TestPluginDto,
  ): Promise<TestPluginResponse> {
    return this.admin.testPlugin(dto);
  }

  @Patch('plugins/:id')
  @ApiOperation({ summary: 'Update a provider plugin (edit bumps version → freeze)' })
  async updatePlugin(
    @Param('id') id: string,
    @Body(new ZodBody(updatePluginRequestSchema)) dto: UpdatePluginDto,
  ): Promise<ProviderPluginView> {
    return toPluginView(await this.admin.updatePlugin(id, dto));
  }

  @Delete('plugins/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete a custom provider plugin (built-ins rejected)' })
  async deletePlugin(@Param('id') id: string): Promise<void> {
    await this.admin.deletePlugin(id);
  }

  // ----- models -----

  @Post('models')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({ summary: 'Register a relay model (name → chat resource)' })
  async createModel(@Body(new ZodBody(createModelSchema)) dto: CreateModelDto): Promise<ModelView> {
    return toModelView(await this.admin.createModel(dto));
  }

  @Post('models/test')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Probe a candidate model (connectivity + functional) before adding it',
  })
  async testModel(
    @Body(new ZodBody(modelTestRequestSchema)) dto: ModelTestDto,
  ): Promise<ModelTestResult> {
    return this.modelTest.test(dto);
  }

  @Get('models')
  @ApiOperation({ summary: 'List the relay model catalog (paginated)' })
  async listModels(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<ModelView>> {
    const result = await this.admin.listModels(toPageParams({ cursor, limit }));
    const served = await this.admin.servedChannelsByModels(result.rows.map((r) => r.id));
    return mapPageEnvelope(
      result,
      (r) => r.id,
      (r) => toModelView(r, served.get(r.id) ?? []),
    );
  }

  @Get('models/:name')
  @ApiOperation({ summary: 'Get one relay model by name or 404' })
  async getModel(@Param('name') name: string): Promise<ModelView> {
    const row = await this.admin.getModel(name);
    const served = await this.admin.servedChannelsByModels([row.id]);
    return toModelView(row, served.get(row.id) ?? []);
  }

  @Patch('models/:name')
  @ApiOperation({ summary: 'Update a relay model (display/capabilities/prices/visibility/status)' })
  async updateModel(
    @Param('name') name: string,
    @Body(new ZodBody(updateModelSchema)) dto: UpdateModelDto,
  ): Promise<ModelView> {
    return toModelView(await this.admin.updateModel(name, dto));
  }

  @Delete('models/:name')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete a relay model — it stops routing after' })
  async deleteModel(@Param('name') name: string): Promise<void> {
    await this.admin.deleteModel(name);
  }

  // ----- bulk admin actions (前端打磨) -----
  // Each returns a partial-success {succeeded, failed} (one bad id never aborts
  // the batch) and emits ONE audit_log row per affected entity in the service.

  @Post('models/bulk')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Bulk enable/disable/delete models (by name; partial success + per-entity audit)',
  })
  async bulkModels(
    @Body(new ZodBody(bulkModelActionSchema)) dto: BulkModelActionDto,
    @Req() req: AdminRequest,
  ): Promise<BulkResultView> {
    return this.admin.bulkModels(dto.action, dto.ids, req.admin?.adminId);
  }

  @Post('channels/bulk')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Bulk enable/disable/delete channels (by id; partial success + per-entity audit)',
  })
  async bulkChannels(
    @Body(new ZodBody(bulkChannelActionSchema)) dto: BulkChannelActionDto,
    @Req() req: AdminRequest,
  ): Promise<BulkResultView> {
    return this.admin.bulkChannels(dto.action, dto.ids, req.admin?.adminId);
  }

  @Post('oauth-sessions/bulk')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Bulk revoke OAuth sessions (by id; partial success + per-entity audit)',
  })
  async bulkRevokeOAuthSessions(
    @Body(new ZodBody(bulkOAuthSessionActionSchema)) dto: BulkOAuthSessionActionDto,
    @Req() req: AdminRequest,
  ): Promise<BulkResultView> {
    return this.admin.bulkRevokeOAuthSessions(dto.ids, req.admin?.adminId);
  }

  @Post('models/:name/grants')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({ summary: 'Grant a tenant-visibility model to a tenant' })
  @Audit({
    action: 'model_grant.create',
    target: 'model_grant',
    resolve: ({ params, body }) => {
      const b = body as { tenantId?: string };
      return {
        tenantId: b.tenantId ?? null,
        targetId: params.name ?? null,
        meta: { model: params.name },
      };
    },
  })
  async grantModel(
    @Param('name') name: string,
    @Body(new ZodBody(grantModelSchema)) dto: GrantModelDto,
  ): Promise<{ ok: true }> {
    await this.admin.grantModel(name, dto);
    return { ok: true };
  }

  @Get('models/:name/grants')
  @ApiOperation({
    summary: "List a model's tenant grants (paginated); 404 if the model is unknown",
  })
  async listModelGrants(
    @Param('name') name: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<ModelGrantView>> {
    const result = await this.admin.listModelGrants(name, toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toModelGrantView);
  }

  @Delete('models/:name/grants/:tenantId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke (hard-delete) a tenant grant of a model' })
  @Audit({
    action: 'model_grant.revoke',
    target: 'model_grant',
    resolve: ({ params }) => ({
      tenantId: params.tenantId ?? null,
      targetId: params.name ?? null,
      meta: { model: params.name },
    }),
  })
  async deleteModelGrant(
    @Param('name') name: string,
    @Param('tenantId') tenantId: string,
  ): Promise<void> {
    await this.admin.deleteModelGrant(name, tenantId);
  }

  // ----- jobs -----

  @Get('jobs')
  @ApiOperation({ summary: 'List a tenant’s jobs (keyset, paginated)' })
  async listJobs(
    @Query('tenantId') tenantId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<JobView>> {
    const result = await this.admin.listJobs(tenantId, toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toJobView);
  }

  // ----- ledger -----

  @Get('ledger')
  @ApiOperation({ summary: 'List a tenant’s ledger transactions (keyset, paginated)' })
  async listLedger(
    @Query('tenantId') tenantId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<LedgerView>> {
    const result = await this.admin.listLedger(tenantId, toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toLedgerView);
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

  @Get('redemption-codes')
  @ApiOperation({ summary: 'List minted redemption codes (status filter, paginated)' })
  async listRedemptionCodes(
    @Query() raw: Record<string, string>,
  ): Promise<PageEnvelope<RedemptionCodeView>> {
    const q = parseRedemptionCodesQuery(raw);
    const filter = q.status !== undefined ? { status: q.status } : {};
    const page = toPageParams({
      ...(q.limit !== undefined ? { limit: String(q.limit) } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
    });
    const result = await this.admin.listRedemptionCodes(filter, page);
    return mapPageEnvelope(result, (r) => r.code, toRedemptionCodeView);
  }

  // ----- official model price catalog (Track 2) -----

  @Post('official-prices')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({
    summary: 'Add an official model price (USD/1M → µUSD/1M); (provider,slug) unique',
  })
  async createOfficialPrice(
    @Body(new ZodBody(createOfficialPriceSchema)) dto: CreateOfficialPriceDto,
  ): Promise<OfficialPriceView> {
    return toOfficialPriceView(await this.admin.createOfficialPrice(dto));
  }

  @Get('official-prices')
  @ApiOperation({ summary: 'List the official price catalog (optional ?provider=, paginated)' })
  async listOfficialPrices(
    @Query() raw: Record<string, string>,
  ): Promise<PageEnvelope<OfficialPriceView>> {
    const q = parseOfficialPricesQuery(raw);
    const filter = q.provider !== undefined ? { provider: q.provider } : {};
    const page = toPageParams({
      ...(q.limit !== undefined ? { limit: String(q.limit) } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
    });
    const result = await this.admin.listOfficialPrices(filter, page);
    return mapPageEnvelope(result, (r) => r.id, toOfficialPriceView);
  }

  @Get('official-prices/:id')
  @ApiOperation({ summary: 'Get one official price by id or 404' })
  async getOfficialPrice(@Param('id') id: string): Promise<OfficialPriceView> {
    return toOfficialPriceView(await this.admin.getOfficialPrice(id));
  }

  @Patch('official-prices/:id')
  @ApiOperation({ summary: 'Update an official price (USD/1M → µUSD/1M)' })
  async updateOfficialPrice(
    @Param('id') id: string,
    @Body(new ZodBody(updateOfficialPriceSchema)) dto: UpdateOfficialPriceDto,
  ): Promise<OfficialPriceView> {
    return toOfficialPriceView(await this.admin.updateOfficialPrice(id, dto));
  }

  @Delete('official-prices/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete an official price (frees the (provider,slug) pair)' })
  async deleteOfficialPrice(@Param('id') id: string): Promise<void> {
    await this.admin.deleteOfficialPrice(id);
  }

  // ----- proxies (代理) -----

  @Post('proxies')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({ summary: 'Create a managed egress proxy (URL encrypted at rest; name unique)' })
  async createProxy(@Body(new ZodBody(createProxySchema)) dto: CreateProxyDto): Promise<ProxyView> {
    return toProxyView(await this.admin.createProxy(dto));
  }

  @Get('proxies')
  @ApiOperation({ summary: 'List managed egress proxies (paginated; credentials never returned)' })
  async listProxies(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<ProxyView>> {
    const result = await this.admin.listProxies(toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toProxyView);
  }

  @Get('proxies/:id')
  @ApiOperation({ summary: 'Get one proxy by id or 404' })
  async getProxy(@Param('id') id: string): Promise<ProxyView> {
    return toProxyView(await this.admin.getProxy(id));
  }

  @Patch('proxies/:id')
  @ApiOperation({ summary: 'Update a proxy (name/url/status/description; url re-encrypts)' })
  async updateProxy(
    @Param('id') id: string,
    @Body(new ZodBody(updateProxySchema)) dto: UpdateProxyDto,
  ): Promise<ProxyView> {
    return toProxyView(await this.admin.updateProxy(id, dto));
  }

  @Post('proxies/:id/probe')
  @HttpCode(200)
  @ApiOperation({ summary: 'Probe a proxy and record its health (latency/reachability)' })
  async probeProxy(
    @Param('id') id: string,
    @Body(new ZodBody(proxyProbeRequestSchema)) dto: ProxyProbeDto,
  ): Promise<ProxyView> {
    return toProxyView(await this.admin.probeProxy(id, dto));
  }

  @Delete('proxies/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete a proxy (bound channels fall back to no proxy)' })
  async deleteProxy(@Param('id') id: string): Promise<void> {
    await this.admin.deleteProxy(id);
  }

  // ----- fault policies (调用容错) -----

  @Post('fault-policies')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({
    summary: 'Create a fault-tolerance policy (retry/backoff/timeouts; name unique)',
  })
  async createFaultPolicy(
    @Body(new ZodBody(createFaultPolicySchema)) dto: CreateFaultPolicyDto,
  ): Promise<FaultPolicyView> {
    return toFaultPolicyView(await this.admin.createFaultPolicy(dto));
  }

  @Get('fault-policies')
  @ApiOperation({ summary: 'List fault-tolerance policies (paginated)' })
  async listFaultPolicies(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<FaultPolicyView>> {
    const result = await this.admin.listFaultPolicies(toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toFaultPolicyView);
  }

  @Get('fault-policies/:id')
  @ApiOperation({ summary: 'Get one fault policy by id or 404' })
  async getFaultPolicy(@Param('id') id: string): Promise<FaultPolicyView> {
    return toFaultPolicyView(await this.admin.getFaultPolicy(id));
  }

  @Patch('fault-policies/:id')
  @ApiOperation({ summary: 'Update a fault policy (retry/backoff/timeouts/triggers/status)' })
  async updateFaultPolicy(
    @Param('id') id: string,
    @Body(new ZodBody(updateFaultPolicySchema)) dto: UpdateFaultPolicyDto,
  ): Promise<FaultPolicyView> {
    return toFaultPolicyView(await this.admin.updateFaultPolicy(id, dto));
  }

  @Delete('fault-policies/:id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Soft-delete a fault policy (bound channels fall back to engine defaults)',
  })
  async deleteFaultPolicy(@Param('id') id: string): Promise<void> {
    await this.admin.deleteFaultPolicy(id);
  }

  // ----- route groups (分组; Track 3) -----

  @Post('route-groups')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({ summary: 'Create a route group (group_ratio_bps in basis points; name unique)' })
  async createRouteGroup(
    @Body(new ZodBody(createRouteGroupSchema)) dto: CreateRouteGroupDto,
  ): Promise<RouteGroupView> {
    return toRouteGroupView(await this.admin.createRouteGroup(dto));
  }

  @Get('route-groups')
  @ApiOperation({ summary: 'List route groups (paginated)' })
  async listRouteGroups(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<RouteGroupView>> {
    const result = await this.admin.listRouteGroups(toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toRouteGroupView);
  }

  @Get('route-groups/:id')
  @ApiOperation({ summary: 'Get one route group by id or 404' })
  async getRouteGroup(@Param('id') id: string): Promise<RouteGroupView> {
    return toRouteGroupView(await this.admin.getRouteGroup(id));
  }

  @Patch('route-groups/:id')
  @ApiOperation({ summary: 'Update a route group (name/group_ratio_bps/status/description)' })
  async updateRouteGroup(
    @Param('id') id: string,
    @Body(new ZodBody(updateRouteGroupSchema)) dto: UpdateRouteGroupDto,
  ): Promise<RouteGroupView> {
    return toRouteGroupView(await this.admin.updateRouteGroup(id, dto));
  }

  @Delete('route-groups/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete a route group (frees the name; drops from routing)' })
  async deleteRouteGroup(@Param('id') id: string): Promise<void> {
    await this.admin.deleteRouteGroup(id);
  }

  @Put('route-groups/:id/channels/:channelId')
  @ApiOperation({
    summary: "Add/update a channel's membership in a route group (priority/weight; upserts)",
  })
  async addGroupChannel(
    @Param('id') id: string,
    @Param('channelId') channelId: string,
    @Body(new ZodBody(addGroupChannelSchema)) dto: AddGroupChannelDto,
  ): Promise<RouteGroupChannelView> {
    return toRouteGroupChannelView(await this.admin.addChannelToGroup(id, channelId, dto));
  }

  @Get('route-groups/:id/channels')
  @ApiOperation({ summary: "List a group's channel memberships (with priority/weight, paginated)" })
  async listGroupChannels(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<RouteGroupChannelView>> {
    const result = await this.admin.listGroupChannels(id, toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.channelId, toRouteGroupChannelView);
  }

  @Delete('route-groups/:id/channels/:channelId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a channel from a route group (hard-deletes the membership)' })
  async removeGroupChannel(
    @Param('id') id: string,
    @Param('channelId') channelId: string,
  ): Promise<void> {
    await this.admin.removeChannelFromGroup(id, channelId);
  }

  // ----- usage stats -----

  @Get('usage')
  @ApiOperation({ summary: 'Global per-call usage log (all tenants, paginated)' })
  async listUsage(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<UsageLogView>> {
    const result = await this.admin.listUsageGlobal(toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toUsageLogView);
  }

  // ----- relay traces (upstream audit) -----

  @Get('relay-traces')
  @ApiOperation({ summary: 'Upstream relay audit trace (filtered, paginated, token-redacted)' })
  async listRelayTraces(
    @Query() raw: Record<string, string>,
  ): Promise<PageEnvelope<RelayTraceView>> {
    const q = parseRelayTraceQuery(raw);
    const filter = {
      ...(q.jobId !== undefined ? { jobId: q.jobId } : {}),
      ...(q.tenantId !== undefined ? { tenantId: q.tenantId } : {}),
      ...(q.providerType !== undefined ? { providerType: q.providerType } : {}),
      ...(q.channelId !== undefined ? { channelId: q.channelId } : {}),
      ...(q.from !== undefined ? { from: new Date(q.from) } : {}),
      ...(q.to !== undefined ? { to: new Date(q.to) } : {}),
      ...(q.responseStatus !== undefined ? { responseStatus: q.responseStatus } : {}),
      ...(q.errorsOnly !== undefined ? { errorsOnly: q.errorsOnly } : {}),
      ...(q.isStream !== undefined ? { isStream: q.isStream } : {}),
      ...(q.routeTag !== undefined ? { routeTag: q.routeTag } : {}),
    };
    const page = toPageParams({
      ...(q.limit !== undefined ? { limit: String(q.limit) } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
    });
    const result = await this.admin.listRelayTraces(filter, page);
    return mapPageEnvelope(result, (r) => r.id, toRelayTraceView);
  }

  // ----- analytics -----

  @Get('analytics/usage')
  @ApiOperation({ summary: 'Usage rollups by minute/hour/day/model/tenant/channel/api-key' })
  async analyticsUsage(@Query() raw: Record<string, string>): Promise<UsageRollupView[]> {
    const q = parseAnalyticsUsageQuery(raw);
    const rows = await this.admin.analyticsUsage(q);
    return rows.map(toUsageRollupView);
  }

  // ----- ops snapshot -----

  @Get('summary')
  @ApiOperation({ summary: 'Authoritative platform counts (tenants/resources/accounts)' })
  async summary(): Promise<OpsSummaryView> {
    return opsSummaryViewSchema.parse(await this.admin.opsSummary());
  }

  @Get('health')
  @ApiOperation({ summary: 'Live ops health: per-channel circuit-breaker state + billable RPM' })
  async health(): Promise<OpsHealthView> {
    const snapshot = await this.admin.opsHealth();
    return opsHealthViewSchema.parse({
      window_seconds: snapshot.windowSeconds,
      rpm_billable: snapshot.rpmBillable,
      channels: snapshot.channels.map(toChannelHealthView),
    });
  }

  @Get('health/models')
  @ApiOperation({
    summary:
      'Per-model health (status page): availability, latency, uptime history from real traffic',
  })
  async modelHealth(@Query('days') days?: string): Promise<ModelHealthView[]> {
    // Clamp the window to [1, 90] days; default 7.
    const parsed = days === undefined ? 7 : Number(days);
    const window = Number.isFinite(parsed) ? Math.min(90, Math.max(1, Math.trunc(parsed))) : 7;
    const report = await this.admin.modelHealthReport(window);
    return report.map(toModelHealthView);
  }

  // ----- circuit breakers (弹性2.0 status surface) -----

  @Get('breakers')
  @ApiOperation({
    summary: 'Live circuit-breaker status: tripped/probing (channel, model) FSM rows',
  })
  async listBreakers(): Promise<BreakerView[]> {
    const rows = await this.admin.listBreakers();
    return rows.map(toBreakerView);
  }

  @Post('breakers/:channelId/:model/reset')
  @HttpCode(204)
  @ApiOperation({ summary: 'Reset a circuit breaker back to closed (ops un-stick)' })
  @Audit({
    action: 'breaker.reset',
    target: 'channel_breaker',
    resolve: ({ params }) => ({
      targetId: params.channelId ?? null,
      meta: { model: params.model },
    }),
  })
  async resetBreaker(
    @Param('channelId') channelId: string,
    @Param('model') model: string,
  ): Promise<void> {
    await this.admin.resetBreaker(channelId, model);
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

/**
 * Validate the relay-traces query against its zod schema (same 400-on-failure
 * contract as {@link parseAnalyticsUsageQuery}, since query params bypass the
 * {@link ZodBody} pipe). A bad cursor is caught downstream by `toPageParams`.
 */
function parseRelayTraceQuery(raw: Record<string, string>): RelayTraceQueryDto {
  const result = relayTraceQuerySchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join('.') ?? '';
    const detail = first === undefined ? 'invalid query' : `${path}: ${first.message}`;
    throw engineInvalidInput(detail);
  }
  return result.data;
}

/**
 * Validate the redemption-codes query against its zod schema (same 400-on-failure
 * contract as {@link parseRelayTraceQuery}, since query params bypass the
 * {@link ZodBody} pipe).
 */
function parseRedemptionCodesQuery(raw: Record<string, string>): RedemptionCodesQueryDto {
  const result = redemptionCodesQuerySchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join('.') ?? '';
    const detail = first === undefined ? 'invalid query' : `${path}: ${first.message}`;
    throw engineInvalidInput(detail);
  }
  return result.data;
}

/**
 * Validate the official-prices query against its zod schema (same 400-on-failure
 * contract as {@link parseRedemptionCodesQuery}, since query params bypass the
 * {@link ZodBody} pipe).
 */
function parseOfficialPricesQuery(raw: Record<string, string>): OfficialPricesQueryDto {
  const result = officialPricesQuerySchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join('.') ?? '';
    const detail = first === undefined ? 'invalid query' : `${path}: ${first.message}`;
    throw engineInvalidInput(detail);
  }
  return result.data;
}

function toTenantView(row: TenantRow): TenantView {
  return tenantViewSchema.parse({
    id: row.id,
    name: row.name,
    isolation_mode: row.isolationMode,
    created_at: row.createdAt.toISOString(),
  });
}

function toSubAccountView(row: SubAccountRow): SubAccountView {
  return subAccountViewSchema.parse({
    id: row.id,
    tenant_id: row.tenantId,
    subject_id: row.subjectId,
    credit_balance: row.creditBalance.toString(),
    credit_held: row.creditHeld.toString(),
    status: row.status,
    created_at: row.createdAt.toISOString(),
  });
}

function toSubjectView(row: SubjectRow): SubjectView {
  return subjectViewSchema.parse({
    id: row.id,
    tenant_id: row.tenantId,
    external_id: row.externalId,
    email: row.email,
    display_name: row.displayName,
    limit_plan_id: row.limitPlanId,
    status: row.status,
    created_at: row.createdAt.toISOString(),
  });
}

function toProvisionView(r: ProvisionResult): ProvisionView {
  return provisionViewSchema.parse({
    tenant: toTenantView(r.tenant),
    account: toAccountView(r.account),
    api_key: { id: r.apiKey.id, plaintext: r.apiKey.plaintext },
  });
}

function toApiKeyView(row: Omit<ApiKeyRow, 'hash'>): ApiKeyView {
  return apiKeyViewSchema.parse({
    id: row.id,
    tenant_id: row.tenantId,
    resource_allowlist: row.resourceAllowlist,
    rate_limit: row.rateLimit,
    status: row.status,
    route_group_id: row.routeGroupId,
    limit_plan_id: row.limitPlanId,
    subject_id: row.subjectId,
    created_at: row.createdAt.toISOString(),
  });
}

function toAdminTokenView(row: AdminTokenRow): AdminTokenView {
  return adminTokenViewSchema.parse({
    id: row.id,
    name: row.name,
    created_by: row.createdBy,
    status: row.status,
    expires_at: row.expiresAt === null ? null : row.expiresAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

function toRouteGroupView(row: RouteGroupRow): RouteGroupView {
  return routeGroupViewSchema.parse({
    id: row.id,
    name: row.name,
    group_ratio_bps: row.groupRatioBps,
    fallback_group_id: row.fallbackGroupId,
    status: row.status,
    description: row.description,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

function toRouteGroupChannelView(row: RouteGroupChannelRow): RouteGroupChannelView {
  return routeGroupChannelViewSchema.parse({
    group_id: row.groupId,
    channel_id: row.channelId,
    priority: row.priority,
    weight: row.weight,
    created_at: row.createdAt.toISOString(),
  });
}

function toSecretMetadataView(row: SecretRefView): SecretMetadataView {
  return {
    id: row.id,
    provider: row.provider,
    locator: row.locator,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** Project a created/completed OAuth session (token-free) to its contract view. */
function toOAuthSessionView(session: {
  id: string;
  providerKind: string;
  accountLabel?: string | null;
  accountId?: string | null;
}): OAuthSessionView {
  return oauthSessionViewSchema.parse({
    id: session.id,
    provider_kind: session.providerKind,
    account_label: session.accountLabel ?? null,
    account_id: session.accountId ?? null,
  });
}

/** Project a `provider_plugin` row → its API view (snake_case; manifest validated). */
function toIconAssetView(row: IconAssetRow): IconAssetView {
  return iconAssetViewSchema.parse({
    key: row.key,
    label: row.label,
    category: row.category,
    svg: row.svg,
  });
}

function toLimitRuleView(row: LimitRuleRow): LimitRuleView {
  return limitRuleViewSchema.parse({
    id: row.id,
    dimension: row.dimension,
    period: row.period,
    cap: row.cap.toString(),
    model_scope: row.modelScope,
    alert_pct: row.alertPct,
    enforce: row.enforce,
  });
}

function toLimitPlanView(p: {
  plan: LimitPlanRow;
  rules: LimitRuleRow[];
  bindings: { keys: number; tenants: number };
}): LimitPlanView {
  return limitPlanViewSchema.parse({
    id: p.plan.id,
    name: p.plan.name,
    description: p.plan.description,
    status: p.plan.status,
    tenant_id: p.plan.tenantId,
    rules: p.rules.map(toLimitRuleView),
    key_count: p.bindings.keys,
    tenant_count: p.bindings.tenants,
    created_at: p.plan.createdAt.toISOString(),
    updated_at: p.plan.updatedAt.toISOString(),
  });
}

function toAuditLogView(row: AuditLogRow): AuditLogView {
  return auditLogViewSchema.parse({
    id: row.id,
    created_at: row.createdAt.toISOString(),
    actor_type: row.actorType,
    actor_id: row.actorId,
    tenant_id: row.tenantId,
    subject_id: row.subjectId,
    action: row.action,
    target_type: row.targetType,
    target_id: row.targetId,
    meta: row.meta,
    request_id: row.requestId,
  });
}

function toReconcileRowView(r: ReconcileRow): ReconcileRowView {
  return reconcileRowViewSchema.parse({
    kind: r.kind,
    account_id: r.accountId,
    subject_id: r.subjectId,
    balance: r.balance.toString(),
    ledger_sum: r.ledgerSum.toString(),
    drift: r.drift.toString(),
  });
}

function toLimitRuleStatusView(r: LimitRuleStatus): LimitRuleStatusView {
  return limitRuleStatusViewSchema.parse({
    dimension: r.dimension,
    period: r.period,
    cap: r.cap.toString(),
    used: r.used.toString(),
    model_scope: r.modelScope,
    alert_pct: r.alertPct,
    enforce: r.enforce,
  });
}

function toLimitUsageView(row: LimitUsageRow): LimitUsageView {
  return limitUsageViewSchema.parse({
    subject_type: row.subjectType,
    subject_id: row.subjectId,
    dimension: row.dimension,
    period_key: row.periodKey,
    model_scope: row.modelScope,
    used: row.used.toString(),
    period_start: row.periodStart === null ? null : row.periodStart.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

function toLimitAlertView(row: LimitAlertRow): LimitAlertView {
  return limitAlertViewSchema.parse({
    id: row.id,
    subject_type: row.subjectType,
    subject_id: row.subjectId,
    rule_id: row.ruleId,
    dimension: row.dimension,
    period_key: row.periodKey,
    used: row.used.toString(),
    cap: row.cap.toString(),
    pct: row.pct,
    created_at: row.createdAt.toISOString(),
  });
}

function toPluginView(
  row: ProviderPluginRow,
  counts: { channels: number; models: number } = { channels: 0, models: 0 },
): ProviderPluginView {
  return providerPluginViewSchema.parse({
    id: row.id,
    slug: row.slug,
    label: row.label,
    modalities: row.modalities,
    protocol: row.protocol,
    auth_strategy: row.authStrategy,
    manifest: row.manifest,
    handler: row.handler,
    version: row.version,
    builtin: row.builtin,
    icon: row.icon,
    channel_count: counts.channels,
    model_count: counts.models,
    status: row.status,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

function toOAuthSessionListView(row: OAuthSessionListRow): OAuthSessionListView {
  return oauthSessionListViewSchema.parse({
    id: row.secretRefId,
    provider_kind: row.providerKind,
    account_label: row.accountLabel,
    account_id: row.accountId,
    name: row.name,
    notes: row.notes,
    group: row.groupTag,
    status: row.status,
    expires_at: row.expiresAt === null ? null : row.expiresAt.toISOString(),
    last_refresh_at: row.lastRefreshAt === null ? null : row.lastRefreshAt.toISOString(),
  });
}

function toAccountView(row: AccountRow): AccountView {
  return accountViewSchema.parse({
    id: row.id,
    tenant_id: row.tenantId,
    credit_balance: row.creditBalance.toString(),
    credit_held: row.creditHeld.toString(),
    limit_plan_id: row.limitPlanId,
    created_at: row.createdAt.toISOString(),
  });
}

function toResourceView(row: Resource): ResourceView {
  return resourceViewSchema.parse({
    id: row.id,
    tenant_id: row.tenantId,
    kind: row.kind,
    modality: row.modality,
    provider_type: row.providerType,
    exec_modes: row.execModes,
    status: row.status,
    current_version: row.currentVersion,
    created_at: row.createdAt.toISOString(),
  });
}

function toChannelView(row: UpstreamChannelRow, modelCount = 0): ChannelView {
  return channelViewSchema.parse({
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
    input_cost_per_1m: row.inputCostPer1m === null ? null : row.inputCostPer1m.toString(),
    output_cost_per_1m: row.outputCostPer1m === null ? null : row.outputCostPer1m.toString(),
    fault_policy_id: row.faultPolicyId,
    model_count: modelCount,
    icon: row.icon,
    plugin_id: row.pluginId,
    tags: row.tags,
  });
}

function toProxyView(row: ProxyRow): ProxyView {
  return proxyViewSchema.parse({
    id: row.id,
    name: row.name,
    scheme: row.scheme,
    host: row.host,
    status: row.status,
    healthy: row.healthy,
    last_checked_at: row.lastCheckedAt === null ? null : row.lastCheckedAt.toISOString(),
    last_latency_ms: row.lastLatencyMs,
    last_error: row.lastError,
    description: row.description,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

function toFaultPolicyView(row: FaultPolicyRow): FaultPolicyView {
  return faultPolicyViewSchema.parse({
    id: row.id,
    name: row.name,
    fast_fail: row.fastFail,
    retry_count: row.retryCount,
    backoff_type: row.backoffType,
    backoff_ms: row.backoffMs,
    connect_timeout_ms: row.connectTimeoutMs,
    ttft_timeout_ms: row.ttftTimeoutMs,
    total_timeout_ms: row.totalTimeoutMs,
    idle_timeout_ms: row.idleTimeoutMs,
    retry_codes: row.retryCodes,
    retry_messages: row.retryMessages,
    breaker_enabled: row.breakerEnabled,
    breaker_window_ms: row.breakerWindowMs,
    breaker_min_volume: row.breakerMinVolume,
    breaker_failure_rate_pct: row.breakerFailureRatePct,
    breaker_half_open_trial: row.breakerHalfOpenTrial,
    breaker_half_open_successes: row.breakerHalfOpenSuccesses,
    breaker_open_cooldown_ms: row.breakerOpenCooldownMs,
    breaker_open_cooldown_cap_ms: row.breakerOpenCooldownCapMs,
    status: row.status,
    description: row.description,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

function toPricebookView(row: PricebookEntryRow): PricebookView {
  return pricebookViewSchema.parse({
    id: row.id,
    resource_id: row.resourceId,
    resource_version: row.resourceVersion,
    version: row.version,
    method: row.method,
    timing: row.timing,
    spec: row.spec,
    markup: row.markup,
    active: row.active,
  });
}

function toModifierView(row: ModifierRow): ModifierView {
  return modifierViewSchema.parse({
    id: row.id,
    scope: row.scope,
    when_expr: row.whenExpr,
    op: row.op,
    value: row.value === null ? null : row.value.toString(),
    stackable: row.stackable,
    priority: row.priority,
    version: row.version,
    active: row.active,
  });
}

function toLedgerView(row: LedgerRow): LedgerView {
  return ledgerViewSchema.parse({
    id: row.id,
    tenant_id: row.tenantId,
    account_id: row.accountId,
    subject_id: row.subjectId,
    type: row.type,
    credits_delta: row.creditsDelta.toString(),
    balance_after: row.balanceAfter.toString(),
    resource_id: row.resourceId,
    job_id: row.jobId,
    created_at: row.createdAt.toISOString(),
  });
}

function toJobView(row: Job): JobView {
  return jobViewSchema.parse({
    job_id: row.id,
    tenant_id: row.tenantId,
    subject_id: row.subjectId,
    resource_id: row.resourceId,
    status: row.status,
    exec_mode: row.execMode,
    cost: row.costCredits === null ? null : row.costCredits.toString(),
    created_at: row.createdAt.toISOString(),
  });
}

function toModelView(row: ModelRow, servedChannelIds: string[] = []): ModelView {
  return modelViewSchema.parse({
    id: row.id,
    name: row.name,
    display: row.display,
    modality: row.modality,
    capabilities: row.capabilities,
    visibility: row.visibility,
    resource_id: row.resourceId,
    input_price: row.inputPrice.toString(),
    output_price: row.outputPrice.toString(),
    rate_limit: row.rateLimit,
    fallback_models: row.fallbackModels,
    served_channel_ids: servedChannelIds,
    tags: row.tags,
    maker: row.maker,
    context_length: row.contextLength,
    reasoning: row.reasoning,
    icon: row.icon,
    status: row.status,
    created_at: row.createdAt.toISOString(),
  });
}

function toModelGrantView(row: ModelGrantRow): ModelGrantView {
  return modelGrantViewSchema.parse({
    id: row.id,
    model_id: row.modelId,
    tenant_id: row.tenantId,
    created_at: row.createdAt.toISOString(),
  });
}

function toOfficialPriceView(row: OfficialModelPriceRow): OfficialPriceView {
  return officialPriceViewSchema.parse({
    id: row.id,
    provider: row.provider,
    model_slug: row.modelSlug,
    display_name: row.displayName,
    input_price_per_1m: row.inputPricePer1m.toString(),
    output_price_per_1m: row.outputPricePer1m.toString(),
    cached_input_price_per_1m:
      row.cachedInputPricePer1m === null ? null : row.cachedInputPricePer1m.toString(),
    source_url: row.sourceUrl,
    effective_at: row.effectiveAt === null ? null : row.effectiveAt.toISOString(),
    notes: row.notes,
    updated_by: row.updatedBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

function toRedemptionCodeView(row: RedemptionCodeRow): RedemptionCodeView {
  return redemptionCodeViewSchema.parse({
    code: row.code,
    credit_amount: row.creditAmount.toString(),
    status: row.status,
    redeemed_by_tenant: row.redeemedByTenant,
    redeemed_at: row.redeemedAt === null ? null : row.redeemedAt.toISOString(),
    expires_at: row.expiresAt === null ? null : row.expiresAt.toISOString(),
    created_at: row.createdAt.toISOString(),
  });
}

function toUsageLogView(row: UsageLogRow): UsageLogView {
  return usageLogViewSchema.parse({
    id: row.id,
    tenant_id: row.tenantId,
    subject_id: row.subjectId,
    model: row.model,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cost: row.cost.toString(),
    latency_ms: row.latencyMs,
    status: row.status,
    route_tag: row.routeTag,
    created_at: row.createdAt.toISOString(),
  });
}

function toUsageRollupView(row: UsageRollupRow): UsageRollupView {
  return usageRollupViewSchema.parse({
    bucket: row.bucket,
    requests: row.requests,
    input_tokens: row.inputTokens.toString(),
    output_tokens: row.outputTokens.toString(),
    cost: row.cost.toString(),
    provider_cost: row.providerCost.toString(),
    margin: row.margin.toString(),
    errors: row.errors,
    avg_latency_ms: row.avgLatencyMs,
    p95_latency_ms: row.p95LatencyMs,
  });
}

function toBreakerView(row: BreakerStatusWithRate): BreakerView {
  return breakerViewSchema.parse({
    channel_id: row.channelId,
    channel_name: row.channelName,
    resource_id: row.resourceId,
    model: row.model,
    state: row.state,
    opened_at: row.openedAt === null ? null : row.openedAt.toISOString(),
    cooldown_until: row.cooldownUntil === null ? null : row.cooldownUntil.toISOString(),
    trip_count: row.tripCount,
    half_open_successes: row.halfOpenSuccesses,
    // Recent-window failure rate (%) from Redis; rounded to 2 dp. null = window
    // unreadable (Redis miss/outage) — the FSM state stays authoritative.
    failure_rate: row.failureRate === null ? null : Math.round(row.failureRate * 100) / 100,
    last_transition_at: row.lastTransitionAt === null ? null : row.lastTransitionAt.toISOString(),
  });
}

function toChannelHealthView(row: ChannelHealthRow): ChannelHealthView {
  return channelHealthViewSchema.parse({
    channel_id: row.channelId,
    resource_id: row.resourceId,
    provider_type: row.providerType,
    status: row.status,
    credential_ref: row.credentialRef,
    cooldown_until: row.cooldownUntil === null ? null : row.cooldownUntil.toISOString(),
    consecutive_failures: row.consecutiveFailures,
    last_failure_at: row.lastFailureAt === null ? null : row.lastFailureAt.toISOString(),
  });
}

function toModelHealthView(r: {
  summary: ModelHealthRow;
  history: ModelHealthBucket[];
}): ModelHealthView {
  const { summary, history } = r;
  // Availability = succeeded / total; 100% when there was no traffic.
  const availability =
    summary.total > 0 ? ((summary.total - summary.errors) / summary.total) * 100 : 100;
  return modelHealthViewSchema.parse({
    model: summary.model,
    total: summary.total,
    errors: summary.errors,
    availability_pct: Math.round(availability * 100) / 100,
    avg_latency_ms: summary.avgLatencyMs,
    p95_latency_ms: summary.p95LatencyMs,
    last_status: summary.lastStatus,
    last_seen_at: summary.lastSeenAt === null ? null : summary.lastSeenAt.toISOString(),
    history: history.map((b) => ({ day: b.day, total: b.total, errors: b.errors })),
  });
}
