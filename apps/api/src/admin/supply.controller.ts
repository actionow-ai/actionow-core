import {
  type Channel as SupplyChannelView,
  channelSchema as supplyChannelViewSchema,
  type Credential as SupplyCredentialView,
  credentialSchema as supplyCredentialViewSchema,
  type Model as SupplyModelView,
  type ModelGrantView,
  modelGrantViewSchema,
  modelSchema as supplyModelViewSchema,
  type Offering as SupplyOfferingView,
  offeringSchema as supplyOfferingViewSchema,
  type PriceCard as SupplyPriceCardView,
  priceCardSchema as supplyPriceCardViewSchema,
  type Provider as SupplyProviderView,
  providerSchema as supplyProviderViewSchema,
} from '@actionow/contracts';
import type {
  SupplyChannelRow,
  SupplyCredentialRow,
  SupplyModelGrantRow,
  SupplyModelRow,
  SupplyOfferingRow,
  SupplyPriceCardRow,
  SupplyProviderRow,
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
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Audit } from '../audit/audit.decorator.js';
import { AuditInterceptor } from '../audit/audit.interceptor.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { Idempotent } from '../common/idempotent.decorator.js';
import { mapPageEnvelope, type PageEnvelope, toPageParams } from '../common/pagination.js';
import { ZodBody } from '../common/zod.pipe.js';
import { AdminGuard } from './auth/admin.guard.js';
import { Roles } from './auth/roles.decorator.js';
import {
  type CreateSupplyChannelDto,
  createSupplyChannelSchema,
  type CreateSupplyCredentialDto,
  createSupplyCredentialSchema,
  type CreateSupplyModelDto,
  createSupplyModelSchema,
  type CreateSupplyOfferingDto,
  createSupplyOfferingSchema,
  type CreateSupplyPriceCardDto,
  createSupplyPriceCardSchema,
  type CreateSupplyPriceCardVersionDto,
  createSupplyPriceCardVersionSchema,
  type CreateSupplyProviderDto,
  createSupplyProviderSchema,
  type GrantSupplyModelDto,
  grantSupplyModelSchema,
  type SupplyPriceCardFromOfficialDto,
  supplyPriceCardFromOfficialSchema,
  type UpdateApiKeyModelAllowlistDto,
  updateApiKeyModelAllowlistSchema,
  type UpdateSupplyChannelDto,
  updateSupplyChannelSchema,
  type UpdateSupplyCredentialDto,
  updateSupplyCredentialSchema,
  type UpdateSupplyModelDto,
  updateSupplyModelSchema,
  type UpdateSupplyOfferingDto,
  updateSupplyOfferingSchema,
  type UpdateSupplyProviderDto,
  updateSupplyProviderSchema,
} from './dto/admin.dto.js';
import { SupplyAdminService } from './supply.service.js';

/**
 * Admin CRUD for the NEW-WORLD supply skeleton (model-supply greenfield 批次1,
 * design §2), mounted under `/admin/supply/*` — ZERO overlap with the
 * old-world `/admin/models` / `/admin/resources/:id/channels` routes while the
 * two worlds coexist. Same protection stack as {@link AdminController}: admin
 * JWT (+ `admin` role), opt-in `Idempotency-Key` replay on non-secret POSTs,
 * and `@Audit` on every mutation. Responses are the FROZEN batch-0 entity
 * schemas parsed as views — the credential view is ALWAYS redacted
 * (`secret_hint` only; the secret never leaves the vault).
 */
@ApiTags('admin')
@ApiBearerAuth('jwt')
@UseGuards(AdminGuard)
@Roles('admin')
@UseInterceptors(IdempotencyInterceptor)
@UseInterceptors(AuditInterceptor)
@Controller('admin')
export class SupplyAdminController {
  constructor(private readonly supply: SupplyAdminService) {}

  // ----- providers (厂商) -----

  @Post('supply/providers')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({ summary: 'Register a supply provider (brand + defaults; slug unique)' })
  @Audit({
    action: 'supply_provider.create',
    target: 'supply_provider',
    resolve: ({ result }) => {
      const r = result as { id?: string; slug?: string };
      return { targetId: r.id ?? null, meta: { slug: r.slug } };
    },
  })
  async createSupplyProvider(
    @Body(new ZodBody(createSupplyProviderSchema)) dto: CreateSupplyProviderDto,
  ): Promise<SupplyProviderView> {
    return toSupplyProviderView(await this.supply.createProvider(dto));
  }

  @Get('supply/providers')
  @ApiOperation({ summary: 'List supply providers (paginated)' })
  async listSupplyProviders(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<SupplyProviderView>> {
    const result = await this.supply.listProviders(toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toSupplyProviderView);
  }

  @Get('supply/providers/:id')
  @ApiOperation({ summary: 'Get one supply provider by id or 404' })
  async getSupplyProvider(@Param('id') id: string): Promise<SupplyProviderView> {
    return toSupplyProviderView(await this.supply.getProvider(id));
  }

  @Patch('supply/providers/:id')
  @ApiOperation({ summary: 'Update a supply provider (defaults a channel may override)' })
  @Audit({
    action: 'supply_provider.update',
    target: 'supply_provider',
    resolve: ({ params }) => ({ targetId: params.id ?? null }),
  })
  async updateSupplyProvider(
    @Param('id') id: string,
    @Body(new ZodBody(updateSupplyProviderSchema)) dto: UpdateSupplyProviderDto,
  ): Promise<SupplyProviderView> {
    return toSupplyProviderView(await this.supply.updateProvider(id, dto));
  }

  @Delete('supply/providers/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete a supply provider (frees its slug)' })
  @Audit({
    action: 'supply_provider.delete',
    target: 'supply_provider',
    resolve: ({ params }) => ({ targetId: params.id ?? null }),
  })
  async deleteSupplyProvider(@Param('id') id: string): Promise<void> {
    await this.supply.deleteProvider(id);
  }

  // ----- channels (渠道) -----

  @Post('supply/channels')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({ summary: 'Create a supply channel under a live provider' })
  @Audit({
    action: 'supply_channel.create',
    target: 'supply_channel',
    resolve: ({ result }) => {
      const r = result as { id?: string; name?: string };
      return { targetId: r.id ?? null, meta: { name: r.name } };
    },
  })
  async createSupplyChannel(
    @Body(new ZodBody(createSupplyChannelSchema)) dto: CreateSupplyChannelDto,
  ): Promise<SupplyChannelView> {
    return toSupplyChannelView(await this.supply.createChannel(dto));
  }

  @Get('supply/channels')
  @ApiOperation({ summary: 'List supply channels (optional provider_id / tenant_id filters)' })
  async listSupplyChannels(
    @Query('provider_id') providerId?: string,
    @Query('tenant_id') tenantId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<SupplyChannelView>> {
    const result = await this.supply.listChannels(
      { providerId, tenantId },
      toPageParams({ cursor, limit }),
    );
    return mapPageEnvelope(result, (r) => r.id, toSupplyChannelView);
  }

  @Get('supply/channels/:id')
  @ApiOperation({ summary: 'Get one supply channel by id or 404' })
  async getSupplyChannel(@Param('id') id: string): Promise<SupplyChannelView> {
    return toSupplyChannelView(await this.supply.getChannel(id));
  }

  @Patch('supply/channels/:id')
  @ApiOperation({ summary: 'Update a supply channel (provider binding immutable)' })
  @Audit({
    action: 'supply_channel.update',
    target: 'supply_channel',
    resolve: ({ params }) => ({ targetId: params.id ?? null }),
  })
  async updateSupplyChannel(
    @Param('id') id: string,
    @Body(new ZodBody(updateSupplyChannelSchema)) dto: UpdateSupplyChannelDto,
  ): Promise<SupplyChannelView> {
    return toSupplyChannelView(await this.supply.updateChannel(id, dto));
  }

  @Delete('supply/channels/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete a supply channel' })
  @Audit({
    action: 'supply_channel.delete',
    target: 'supply_channel',
    resolve: ({ params }) => ({ targetId: params.id ?? null }),
  })
  async deleteSupplyChannel(@Param('id') id: string): Promise<void> {
    await this.supply.deleteChannel(id);
  }

  // ----- credentials (凭证 — response ALWAYS redacted) -----

  @Post('supply/credentials')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({
    summary:
      'Add a credential to a channel pool (secret encrypted at rest; response redacted — never the secret)',
  })
  @Audit({
    action: 'supply_credential.create',
    target: 'supply_credential',
    resolve: ({ result }) => {
      const r = result as { id?: string; name?: string };
      return { targetId: r.id ?? null, meta: { name: r.name } };
    },
  })
  async createSupplyCredential(
    @Body(new ZodBody(createSupplyCredentialSchema)) dto: CreateSupplyCredentialDto,
  ): Promise<SupplyCredentialView> {
    return toSupplyCredentialView(await this.supply.createCredential(dto));
  }

  @Get('supply/credentials')
  @ApiOperation({ summary: 'List supply credentials (optional channel_id filter; redacted)' })
  async listSupplyCredentials(
    @Query('channel_id') channelId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<SupplyCredentialView>> {
    const result = await this.supply.listCredentials(
      { channelId },
      toPageParams({ cursor, limit }),
    );
    return mapPageEnvelope(result, (r) => r.id, toSupplyCredentialView);
  }

  @Get('supply/credentials/:id')
  @ApiOperation({ summary: 'Get one supply credential by id or 404 (redacted)' })
  async getSupplyCredential(@Param('id') id: string): Promise<SupplyCredentialView> {
    return toSupplyCredentialView(await this.supply.getCredential(id));
  }

  @Patch('supply/credentials/:id')
  @ApiOperation({
    summary: 'Update a supply credential (metadata/quota/cooldown; never the secret)',
  })
  @Audit({
    action: 'supply_credential.update',
    target: 'supply_credential',
    resolve: ({ params }) => ({ targetId: params.id ?? null }),
  })
  async updateSupplyCredential(
    @Param('id') id: string,
    @Body(new ZodBody(updateSupplyCredentialSchema)) dto: UpdateSupplyCredentialDto,
  ): Promise<SupplyCredentialView> {
    return toSupplyCredentialView(await this.supply.updateCredential(id, dto));
  }

  @Delete('supply/credentials/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete a supply credential (drops it from the pool)' })
  @Audit({
    action: 'supply_credential.delete',
    target: 'supply_credential',
    resolve: ({ params }) => ({ targetId: params.id ?? null }),
  })
  async deleteSupplyCredential(@Param('id') id: string): Promise<void> {
    await this.supply.deleteCredential(id);
  }

  // ----- models (产品面) -----

  @Post('supply/models')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({
    summary: 'Register a supply model (external name unique; active requires a sale price card)',
  })
  @Audit({
    action: 'supply_model.create',
    target: 'supply_model',
    resolve: ({ result }) => {
      const r = result as { id?: string; name?: string };
      return { targetId: r.id ?? null, meta: { name: r.name } };
    },
  })
  async createSupplyModel(
    @Body(new ZodBody(createSupplyModelSchema)) dto: CreateSupplyModelDto,
  ): Promise<SupplyModelView> {
    return toSupplyModelView(await this.supply.createModel(dto));
  }

  @Get('supply/models')
  @ApiOperation({ summary: 'List supply models (optional status filter)' })
  async listSupplyModels(
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<SupplyModelView>> {
    const result = await this.supply.listModels({ status }, toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toSupplyModelView);
  }

  @Get('supply/models/:id')
  @ApiOperation({ summary: 'Get one supply model by id or 404' })
  async getSupplyModel(@Param('id') id: string): Promise<SupplyModelView> {
    return toSupplyModelView(await this.supply.getModel(id));
  }

  @Patch('supply/models/:id')
  @ApiOperation({
    summary: 'Update a supply model (needs_pricing gate: active requires a sale price card)',
  })
  @Audit({
    action: 'supply_model.update',
    target: 'supply_model',
    resolve: ({ params, body }) => {
      const b = body as { status?: string };
      return { targetId: params.id ?? null, meta: { status: b.status } };
    },
  })
  async updateSupplyModel(
    @Param('id') id: string,
    @Body(new ZodBody(updateSupplyModelSchema)) dto: UpdateSupplyModelDto,
  ): Promise<SupplyModelView> {
    return toSupplyModelView(await this.supply.updateModel(id, dto));
  }

  @Delete('supply/models/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete a supply model (frees its external name)' })
  @Audit({
    action: 'supply_model.delete',
    target: 'supply_model',
    resolve: ({ params }) => ({ targetId: params.id ?? null }),
  })
  async deleteSupplyModel(@Param('id') id: string): Promise<void> {
    await this.supply.deleteModel(id);
  }

  // ----- model grants (visibility gate) -----

  @Post('supply/models/:id/grants')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({ summary: 'Grant a granted-visibility supply model to a tenant (idempotent)' })
  @Audit({
    action: 'supply_model.grant',
    target: 'supply_model_grant',
    resolve: ({ params, body }) => {
      const b = body as { tenant_id?: string };
      return {
        tenantId: b.tenant_id ?? null,
        targetId: params.id ?? null,
        meta: { model_id: params.id },
      };
    },
  })
  async grantSupplyModel(
    @Param('id') id: string,
    @Body(new ZodBody(grantSupplyModelSchema)) dto: GrantSupplyModelDto,
  ): Promise<{ ok: true }> {
    await this.supply.grantModel(id, dto);
    return { ok: true };
  }

  @Get('supply/models/:id/grants')
  @ApiOperation({
    summary: "List a supply model's tenant grants (paginated); 404 if the model is unknown",
  })
  async listSupplyModelGrants(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<ModelGrantView>> {
    const result = await this.supply.listModelGrants(id, toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toSupplyModelGrantView);
  }

  @Delete('supply/models/:id/grants/:tenantId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke (hard-delete) a tenant grant of a supply model (idempotent)' })
  @Audit({
    action: 'supply_model.revoke_grant',
    target: 'supply_model_grant',
    resolve: ({ params }) => ({
      tenantId: params.tenantId ?? null,
      targetId: params.id ?? null,
      meta: { model_id: params.id },
    }),
  })
  async revokeSupplyModelGrant(
    @Param('id') id: string,
    @Param('tenantId') tenantId: string,
  ): Promise<void> {
    await this.supply.revokeModelGrant(id, tenantId);
  }

  @Post('supply/models/:id/price-card/from-official')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({
    summary:
      'Mint the SALE price card from the official price catalog and bind it (no match → 400 needs_pricing)',
  })
  @Audit({
    action: 'supply_model.price_card_from_official',
    target: 'supply_model',
    resolve: ({ params, result }) => {
      const r = result as { id?: string };
      return { targetId: params.id ?? null, meta: { price_card_id: r.id } };
    },
  })
  async supplyPriceCardFromOfficial(
    @Param('id') id: string,
    @Body(new ZodBody(supplyPriceCardFromOfficialSchema)) dto: SupplyPriceCardFromOfficialDto,
  ): Promise<SupplyPriceCardView> {
    return toSupplyPriceCardView(await this.supply.priceCardFromOfficial(id, dto));
  }

  // ----- offerings (供给项) -----

  @Post('supply/offerings')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({ summary: 'Create a supply offering (unique per live (model, channel))' })
  @Audit({
    action: 'supply_offering.create',
    target: 'supply_offering',
    resolve: ({ result }) => {
      // The handler result is the snake_case VIEW (not the db row).
      const r = result as { id?: string; upstream_model_name?: string };
      return { targetId: r.id ?? null, meta: { upstream_model_name: r.upstream_model_name } };
    },
  })
  async createSupplyOffering(
    @Body(new ZodBody(createSupplyOfferingSchema)) dto: CreateSupplyOfferingDto,
  ): Promise<SupplyOfferingView> {
    return toSupplyOfferingView(await this.supply.createOffering(dto));
  }

  @Get('supply/offerings')
  @ApiOperation({
    summary: 'List supply offerings (optional model_id / channel_id / status filters)',
  })
  async listSupplyOfferings(
    @Query('model_id') modelId?: string,
    @Query('channel_id') channelId?: string,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<SupplyOfferingView>> {
    const result = await this.supply.listOfferings(
      { modelId, channelId, status },
      toPageParams({ cursor, limit }),
    );
    return mapPageEnvelope(result, (r) => r.id, toSupplyOfferingView);
  }

  @Get('supply/offerings/:id')
  @ApiOperation({ summary: 'Get one supply offering by id or 404' })
  async getSupplyOffering(@Param('id') id: string): Promise<SupplyOfferingView> {
    return toSupplyOfferingView(await this.supply.getOffering(id));
  }

  @Patch('supply/offerings/:id')
  @ApiOperation({ summary: 'Update a supply offering ((model, channel) identity immutable)' })
  @Audit({
    action: 'supply_offering.update',
    target: 'supply_offering',
    resolve: ({ params, body }) => {
      const b = body as { status?: string };
      return { targetId: params.id ?? null, meta: { status: b.status } };
    },
  })
  async updateSupplyOffering(
    @Param('id') id: string,
    @Body(new ZodBody(updateSupplyOfferingSchema)) dto: UpdateSupplyOfferingDto,
  ): Promise<SupplyOfferingView> {
    return toSupplyOfferingView(await this.supply.updateOffering(id, dto));
  }

  @Delete('supply/offerings/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Soft-delete a supply offering (frees its (model, channel) slot)' })
  @Audit({
    action: 'supply_offering.delete',
    target: 'supply_offering',
    resolve: ({ params }) => ({ targetId: params.id ?? null }),
  })
  async deleteSupplyOffering(@Param('id') id: string): Promise<void> {
    await this.supply.deleteOffering(id);
  }

  // ----- price cards (immutable, versioned — no PATCH) -----

  @Post('supply/price-cards')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({ summary: 'Mint a supply price card (immutable once effective; no PATCH)' })
  @Audit({
    action: 'supply_price_card.create',
    target: 'supply_price_card',
    resolve: ({ result }) => {
      const r = result as { id?: string; name?: string };
      return { targetId: r.id ?? null, meta: { name: r.name } };
    },
  })
  async createSupplyPriceCard(
    @Body(new ZodBody(createSupplyPriceCardSchema)) dto: CreateSupplyPriceCardDto,
  ): Promise<SupplyPriceCardView> {
    return toSupplyPriceCardView(await this.supply.createPriceCard(dto));
  }

  @Get('supply/price-cards')
  @ApiOperation({ summary: 'List supply price cards (paginated)' })
  async listSupplyPriceCards(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<PageEnvelope<SupplyPriceCardView>> {
    const result = await this.supply.listPriceCards(toPageParams({ cursor, limit }));
    return mapPageEnvelope(result, (r) => r.id, toSupplyPriceCardView);
  }

  @Get('supply/price-cards/:id')
  @ApiOperation({ summary: 'Get one supply price card by id or 404' })
  async getSupplyPriceCard(@Param('id') id: string): Promise<SupplyPriceCardView> {
    return toSupplyPriceCardView(await this.supply.getPriceCard(id));
  }

  @Post('supply/price-cards/:id/versions')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({
    summary:
      'Mint the next version of a price card (the only price-change path; re-point the model/offering after)',
  })
  @Audit({
    action: 'supply_price_card.version',
    target: 'supply_price_card',
    resolve: ({ params, result }) => {
      const r = result as { id?: string; version?: number };
      return { targetId: params.id ?? null, meta: { new_card_id: r.id, version: r.version } };
    },
  })
  async createSupplyPriceCardVersion(
    @Param('id') id: string,
    @Body(new ZodBody(createSupplyPriceCardVersionSchema)) dto: CreateSupplyPriceCardVersionDto,
  ): Promise<SupplyPriceCardView> {
    return toSupplyPriceCardView(await this.supply.createPriceCardVersion(id, dto));
  }

  @Delete('supply/price-cards/:id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Soft-delete a supply price card (history stays for billing snapshots)',
  })
  @Audit({
    action: 'supply_price_card.delete',
    target: 'supply_price_card',
    resolve: ({ params }) => ({ targetId: params.id ?? null }),
  })
  async deleteSupplyPriceCard(@Param('id') id: string): Promise<void> {
    await this.supply.deletePriceCard(id);
  }

  // ----- api_key model allowlist (§2.6) -----

  @Patch('api-keys/:id/model-allowlist')
  @ApiOperation({
    summary: "Replace an API key's supply-model allowlist ([] = allow all models)",
  })
  @Audit({
    action: 'api_key.model_allowlist_update',
    target: 'api_key',
    resolve: ({ params, body }) => {
      const b = body as { models?: string[] };
      return { targetId: params.id ?? null, meta: { models: b.models } };
    },
  })
  async updateApiKeyModelAllowlist(
    @Param('id') id: string,
    @Body(new ZodBody(updateApiKeyModelAllowlistSchema)) dto: UpdateApiKeyModelAllowlistDto,
  ): Promise<{ models: string[] }> {
    return this.supply.updateModelAllowlist(id, dto.models);
  }
}

// ----- view mappers (row → frozen entity view; Date → ISO string) -----

function toSupplyProviderView(row: SupplyProviderRow): SupplyProviderView {
  return supplyProviderViewSchema.parse({
    id: row.id,
    slug: row.slug,
    name: row.name,
    icon: row.icon,
    default_dialect: row.defaultDialect,
    callback_verification: row.callbackVerification,
    default_fault_policy_id: row.defaultFaultPolicyId,
    region: row.region,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

function toSupplyChannelView(row: SupplyChannelRow): SupplyChannelView {
  return supplyChannelViewSchema.parse({
    id: row.id,
    provider_id: row.providerId,
    name: row.name,
    dialect: row.dialect,
    base_url: row.baseUrl,
    proxy_ref: row.proxyRef,
    region: row.region,
    auth_scheme: row.authScheme,
    tenant_id: row.tenantId,
    route_group_id: row.routeGroupId,
    tags: row.tags,
    status: row.status,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

/** The credential view is the REDACTED face: `secret_hint` only, never the secret. */
function toSupplyCredentialView(row: SupplyCredentialRow): SupplyCredentialView {
  return supplyCredentialViewSchema.parse({
    id: row.id,
    channel_id: row.channelId,
    name: row.name,
    secret_hint: row.secretHint,
    quota: row.quota,
    status: row.status,
    cooldown_until: row.cooldownUntil === null ? null : row.cooldownUntil.toISOString(),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

function toSupplyModelView(row: SupplyModelRow): SupplyModelView {
  return supplyModelViewSchema.parse({
    id: row.id,
    name: row.name,
    display_name: row.displayName,
    icon: row.icon,
    status: row.status,
    modality: row.modality,
    operations: row.operations,
    capabilities: row.capabilities,
    price_card_id: row.priceCardId,
    modifier_group_id: row.modifierGroupId,
    max_run_time_seconds: row.maxRunTimeSeconds,
    artifact: row.artifact,
    fallback_model_ids: row.fallbackModelIds,
    limit_plan_id: row.limitPlanId,
    visibility: row.visibility,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

function toSupplyOfferingView(row: SupplyOfferingRow): SupplyOfferingView {
  return supplyOfferingViewSchema.parse({
    id: row.id,
    model_id: row.modelId,
    channel_id: row.channelId,
    status: row.status,
    upstream_model_name: row.upstreamModelName,
    fetch_profile: row.fetchProfile,
    timeout_budget_seconds: row.timeoutBudgetSeconds,
    param_declarations: row.paramDeclarations,
    cost_price_card_id: row.costPriceCardId,
    max_concurrency: row.maxConcurrency,
    weight: row.weight,
    tier: row.tier,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

function toSupplyPriceCardView(row: SupplyPriceCardRow): SupplyPriceCardView {
  return supplyPriceCardViewSchema.parse({
    id: row.id,
    name: row.name,
    method: row.method,
    unit: row.unit,
    tier_dims: row.tierDims,
    spec: row.spec,
    currency: row.currency,
    version: row.version,
    effective_at: row.effectiveAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
}

/** Reuses the old-world grant view shape — the two tables are field-identical. */
function toSupplyModelGrantView(row: SupplyModelGrantRow): ModelGrantView {
  return modelGrantViewSchema.parse({
    id: row.id,
    model_id: row.modelId,
    tenant_id: row.tenantId,
    created_at: row.createdAt.toISOString(),
  });
}
