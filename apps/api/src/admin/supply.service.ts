import {
  createSupplyChannel,
  type CreateSupplyChannelInput,
  createSupplyCredential,
  type CreateSupplyCredentialInput,
  createSupplyModel,
  type CreateSupplyModelInput,
  createSupplyOffering,
  type CreateSupplyOfferingInput,
  createSupplyPriceCard,
  type CreateSupplyPriceCardInput,
  createSupplyPriceCardVersion,
  createSupplyProvider,
  type CreateSupplyProviderInput,
  type Database,
  getSupplyChannelById,
  getSupplyCredentialById,
  getSupplyModelById,
  getSupplyOfferingById,
  getSupplyPriceCardById,
  getSupplyProviderById,
  getTenant,
  grantSupplyModel,
  type KeysetResult,
  listSupplyChannels,
  type ListSupplyChannelsFilter,
  listSupplyCredentials,
  type ListSupplyCredentialsFilter,
  listSupplyModelGrants,
  listSupplyModels,
  type ListSupplyModelsFilter,
  listSupplyOfferings,
  type ListSupplyOfferingsFilter,
  listSupplyPriceCards,
  listSupplyProviders,
  matchOfficialPrice,
  officialPriceToSpec,
  type PageParams,
  revokeSupplyModel,
  softDeleteSupplyChannel,
  softDeleteSupplyCredential,
  softDeleteSupplyModel,
  softDeleteSupplyOffering,
  softDeleteSupplyPriceCard,
  softDeleteSupplyProvider,
  type SupplyChannelRow,
  type SupplyCredentialRow,
  type SupplyModelGrantRow,
  type SupplyModelRow,
  type SupplyOfferingRow,
  type SupplyPriceCardRow,
  type SupplyPriceCardVersionPatch,
  type SupplyProviderRow,
  updateApiKeyModelAllowlist,
  updateSupplyChannel,
  type UpdateSupplyChannelInput,
  updateSupplyCredential,
  type UpdateSupplyCredentialInput,
  updateSupplyModel,
  type UpdateSupplyModelInput,
  updateSupplyOffering,
  type UpdateSupplyOfferingInput,
  updateSupplyProvider,
  type UpdateSupplyProviderInput,
} from '@actionow/db';
import type { AppEnv } from '@actionow/infra';
import { Inject, Injectable } from '@nestjs/common';

import { engineInvalidInput, engineNotFound } from '../common/errors.js';
import { DB, ENV } from '../common/tokens.js';
import type {
  CreateSupplyChannelDto,
  CreateSupplyCredentialDto,
  CreateSupplyModelDto,
  CreateSupplyOfferingDto,
  CreateSupplyPriceCardDto,
  CreateSupplyPriceCardVersionDto,
  CreateSupplyProviderDto,
  GrantSupplyModelDto,
  SupplyPriceCardFromOfficialDto,
  UpdateSupplyChannelDto,
  UpdateSupplyCredentialDto,
  UpdateSupplyModelDto,
  UpdateSupplyOfferingDto,
  UpdateSupplyProviderDto,
} from './dto/admin.dto.js';

/** Postgres SQLSTATE for a unique-constraint violation (`unique_violation`). */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * True iff `err` (or any error in its `cause` chain) is a Postgres
 * unique-constraint violation (SQLSTATE `23505`) — the partial unique indexes
 * (provider slug, model external name, offering (model, channel)) surface as a
 * clean 400 instead of a 500. Local copy of the admin.service helper (drizzle
 * may wrap the `PostgresError`, exposing the code only via `.cause`).
 */
function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  // Bounded walk down the `cause` chain (guards against a self-referential cause).
  for (let depth = 0; cur !== null && cur !== undefined && depth < 8; depth += 1) {
    if (typeof cur === 'object' && (cur as { code?: unknown }).code === PG_UNIQUE_VIOLATION) {
      return true;
    }
    cur = typeof cur === 'object' ? (cur as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/**
 * Admin service for the NEW-WORLD supply skeleton (model-supply greenfield
 * 批次1, design §2): provider / channel / credential / model / offering +
 * price_card + model_grant + the api_key model allowlist. All business goes
 * through the `packages/db` supply repositories; this layer adds the error
 * mapping (`resource_not_found` 404 / `invalid_input` 400), the referential
 * pre-checks the FKs alone would turn into 500s, and the needs_pricing gate
 * (a model is NEVER active without a SALE price card — §10 永不 0 价上架).
 */
@Injectable()
export class SupplyAdminService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  /** Validate + return the AES master key, or a clean 400 (mirrors admin.service). */
  private requireEncryptionKey(): string {
    const keyB64 = this.env.SECRET_ENCRYPTION_KEY;
    if (keyB64 === undefined || keyB64 === '') {
      throw engineInvalidInput('SECRET_ENCRYPTION_KEY is not configured');
    }
    if (Buffer.from(keyB64, 'base64').length !== 32) {
      throw engineInvalidInput('SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    }
    return keyB64;
  }

  // ----- providers (厂商, §2.2) -----

  /** Create a provider. Duplicate live slug → clean 400. */
  async createProvider(dto: CreateSupplyProviderDto): Promise<SupplyProviderRow> {
    const input: CreateSupplyProviderInput = {
      slug: dto.slug,
      name: dto.name,
      defaultDialect: dto.default_dialect,
      ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
      ...(dto.callback_verification !== undefined
        ? { callbackVerification: dto.callback_verification }
        : {}),
      ...(dto.default_fault_policy_id !== undefined
        ? { defaultFaultPolicyId: dto.default_fault_policy_id }
        : {}),
      ...(dto.region !== undefined ? { region: dto.region } : {}),
    };
    try {
      return await createSupplyProvider(this.db, input);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw engineInvalidInput(`supply provider '${dto.slug}' already exists`);
      }
      throw err;
    }
  }

  listProviders(page: PageParams): Promise<KeysetResult<SupplyProviderRow>> {
    return listSupplyProviders(this.db, page);
  }

  /** Fetch one live provider or 404. */
  async getProvider(id: string): Promise<SupplyProviderRow> {
    const row = await getSupplyProviderById(this.db, id);
    if (row === undefined) throw engineNotFound(`supply provider ${id} not found`);
    return row;
  }

  /** Patch a live provider; re-keying to a taken live slug → 400. */
  async updateProvider(id: string, dto: UpdateSupplyProviderDto): Promise<SupplyProviderRow> {
    const patch: UpdateSupplyProviderInput = {
      ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
      ...(dto.default_dialect !== undefined ? { defaultDialect: dto.default_dialect } : {}),
      ...(dto.callback_verification !== undefined
        ? { callbackVerification: dto.callback_verification }
        : {}),
      ...(dto.default_fault_policy_id !== undefined
        ? { defaultFaultPolicyId: dto.default_fault_policy_id }
        : {}),
      ...(dto.region !== undefined ? { region: dto.region } : {}),
    };
    try {
      const row = await updateSupplyProvider(this.db, id, patch);
      if (row === undefined) throw engineNotFound(`supply provider ${id} not found`);
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw engineInvalidInput(`supply provider '${dto.slug ?? ''}' already exists`);
      }
      throw err;
    }
  }

  /** Soft-delete a provider (frees its slug); unknown/already-deleted → 404. */
  async deleteProvider(id: string): Promise<void> {
    const deleted = await softDeleteSupplyProvider(this.db, id);
    if (deleted === undefined) throw engineNotFound(`supply provider ${id} not found`);
  }

  // ----- channels (渠道, §2.3) -----

  /** Create a channel; its provider must be LIVE (FK alone would 500 / accept a dead row). */
  async createChannel(dto: CreateSupplyChannelDto): Promise<SupplyChannelRow> {
    const provider = await getSupplyProviderById(this.db, dto.provider_id);
    if (provider === undefined) {
      throw engineInvalidInput(`provider ${dto.provider_id} not found`);
    }
    const input: CreateSupplyChannelInput = {
      providerId: dto.provider_id,
      name: dto.name,
      authScheme: dto.auth_scheme,
      ...(dto.dialect !== undefined ? { dialect: dto.dialect } : {}),
      ...(dto.base_url !== undefined ? { baseUrl: dto.base_url } : {}),
      ...(dto.proxy_ref !== undefined ? { proxyRef: dto.proxy_ref } : {}),
      ...(dto.region !== undefined ? { region: dto.region } : {}),
      ...(dto.tenant_id !== undefined ? { tenantId: dto.tenant_id } : {}),
      ...(dto.route_group_id !== undefined ? { routeGroupId: dto.route_group_id } : {}),
      ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
    };
    return createSupplyChannel(this.db, input);
  }

  listChannels(
    filter: { providerId?: string | undefined; tenantId?: string | undefined },
    page: PageParams,
  ): Promise<KeysetResult<SupplyChannelRow>> {
    const f: ListSupplyChannelsFilter = {
      ...(filter.providerId !== undefined ? { providerId: filter.providerId } : {}),
      ...(filter.tenantId !== undefined ? { tenantId: filter.tenantId } : {}),
    };
    return listSupplyChannels(this.db, page, f);
  }

  /** Fetch one live channel or 404. */
  async getChannel(id: string): Promise<SupplyChannelRow> {
    const row = await getSupplyChannelById(this.db, id);
    if (row === undefined) throw engineNotFound(`supply channel ${id} not found`);
    return row;
  }

  /** Patch a live channel (`provider_id` is immutable — not in the schema). */
  async updateChannel(id: string, dto: UpdateSupplyChannelDto): Promise<SupplyChannelRow> {
    const patch: UpdateSupplyChannelInput = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.auth_scheme !== undefined ? { authScheme: dto.auth_scheme } : {}),
      ...(dto.dialect !== undefined ? { dialect: dto.dialect } : {}),
      ...(dto.base_url !== undefined ? { baseUrl: dto.base_url } : {}),
      ...(dto.proxy_ref !== undefined ? { proxyRef: dto.proxy_ref } : {}),
      ...(dto.region !== undefined ? { region: dto.region } : {}),
      ...(dto.tenant_id !== undefined ? { tenantId: dto.tenant_id } : {}),
      ...(dto.route_group_id !== undefined ? { routeGroupId: dto.route_group_id } : {}),
      ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
    };
    const row = await updateSupplyChannel(this.db, id, patch);
    if (row === undefined) throw engineNotFound(`supply channel ${id} not found`);
    return row;
  }

  /** Soft-delete a channel; unknown/already-deleted → 404. */
  async deleteChannel(id: string): Promise<void> {
    const deleted = await softDeleteSupplyChannel(this.db, id);
    if (deleted === undefined) throw engineNotFound(`supply channel ${id} not found`);
  }

  // ----- credentials (凭证, §2.4 — secret material vault-only) -----

  /**
   * Add a credential to a channel's pool: the channel must be LIVE and the
   * structured secret's `scheme` must equal the channel's `auth_scheme` (§2.3
   * 鉴权方案决定凭证 schema). The secret is encrypted into the vault inside the
   * repo transaction; this layer never logs or returns it.
   */
  async createCredential(dto: CreateSupplyCredentialDto): Promise<SupplyCredentialRow> {
    const channel = await getSupplyChannelById(this.db, dto.channel_id);
    if (channel === undefined) {
      throw engineInvalidInput(`channel ${dto.channel_id} not found`);
    }
    if (dto.secret.scheme !== channel.authScheme) {
      throw engineInvalidInput(
        `secret scheme '${dto.secret.scheme}' does not match channel auth_scheme '${channel.authScheme}'`,
      );
    }
    const keyB64 = this.requireEncryptionKey();
    const input: CreateSupplyCredentialInput = {
      channelId: dto.channel_id,
      name: dto.name,
      secret: dto.secret,
      keyB64,
      ...(dto.quota !== undefined ? { quota: dto.quota } : {}),
    };
    return createSupplyCredential(this.db, input);
  }

  listCredentials(
    filter: { channelId?: string | undefined },
    page: PageParams,
  ): Promise<KeysetResult<SupplyCredentialRow>> {
    const f: ListSupplyCredentialsFilter = {
      ...(filter.channelId !== undefined ? { channelId: filter.channelId } : {}),
    };
    return listSupplyCredentials(this.db, page, f);
  }

  /** Fetch one live credential (redacted row — the secret stays in the vault) or 404. */
  async getCredential(id: string): Promise<SupplyCredentialRow> {
    const row = await getSupplyCredentialById(this.db, id);
    if (row === undefined) throw engineNotFound(`supply credential ${id} not found`);
    return row;
  }

  /** Patch a live credential's metadata/quota/cooldown (never the secret). */
  async updateCredential(id: string, dto: UpdateSupplyCredentialDto): Promise<SupplyCredentialRow> {
    const patch: UpdateSupplyCredentialInput = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.quota !== undefined ? { quota: dto.quota } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      ...(dto.cooldown_until !== undefined
        ? { cooldownUntil: dto.cooldown_until === null ? null : new Date(dto.cooldown_until) }
        : {}),
    };
    const row = await updateSupplyCredential(this.db, id, patch);
    if (row === undefined) throw engineNotFound(`supply credential ${id} not found`);
    return row;
  }

  /** Soft-delete a credential (drops it from the pool); unknown → 404. */
  async deleteCredential(id: string): Promise<void> {
    const deleted = await softDeleteSupplyCredential(this.db, id);
    if (deleted === undefined) throw engineNotFound(`supply credential ${id} not found`);
  }

  // ----- models (产品面, §2.1) -----

  /**
   * The needs_pricing gate (§10 永不 0 价上架): reject any write whose RESULT
   * would be an `active` model with no SALE price card.
   */
  private static assertPriced(status: string, priceCardId: string | null): void {
    if (status === 'active' && priceCardId === null) {
      throw engineInvalidInput('needs_pricing: model has no sale price card');
    }
  }

  /** Register a model. Duplicate live external name → 400; active requires a price card. */
  async createModel(dto: CreateSupplyModelDto): Promise<SupplyModelRow> {
    SupplyAdminService.assertPriced(dto.status ?? 'draft', dto.price_card_id ?? null);
    const input: CreateSupplyModelInput = {
      name: dto.name,
      displayName: dto.display_name,
      modality: dto.modality,
      operations: dto.operations,
      ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      ...(dto.capabilities !== undefined ? { capabilities: dto.capabilities } : {}),
      ...(dto.price_card_id !== undefined ? { priceCardId: dto.price_card_id } : {}),
      ...(dto.modifier_group_id !== undefined ? { modifierGroupId: dto.modifier_group_id } : {}),
      ...(dto.max_run_time_seconds !== undefined
        ? { maxRunTimeSeconds: dto.max_run_time_seconds }
        : {}),
      ...(dto.artifact !== undefined ? { artifact: dto.artifact } : {}),
      ...(dto.fallback_model_ids !== undefined ? { fallbackModelIds: dto.fallback_model_ids } : {}),
      ...(dto.limit_plan_id !== undefined ? { limitPlanId: dto.limit_plan_id } : {}),
      ...(dto.visibility !== undefined ? { visibility: dto.visibility } : {}),
    };
    try {
      return await createSupplyModel(this.db, input);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw engineInvalidInput(`supply model '${dto.name}' already exists`);
      }
      throw err;
    }
  }

  listModels(
    filter: { status?: string | undefined },
    page: PageParams,
  ): Promise<KeysetResult<SupplyModelRow>> {
    const f: ListSupplyModelsFilter = {
      ...(filter.status !== undefined ? { status: filter.status } : {}),
    };
    return listSupplyModels(this.db, page, f);
  }

  /** Fetch one live model or 404. */
  async getModel(id: string): Promise<SupplyModelRow> {
    const row = await getSupplyModelById(this.db, id);
    if (row === undefined) throw engineNotFound(`supply model ${id} not found`);
    return row;
  }

  /**
   * Patch a live model. The needs_pricing gate checks the EFFECTIVE (current ∪
   * patch) state, so both `status → active` without a card AND clearing the
   * card while active are rejected. Re-keying to a taken live name → 400.
   */
  async updateModel(id: string, dto: UpdateSupplyModelDto): Promise<SupplyModelRow> {
    const current = await getSupplyModelById(this.db, id);
    if (current === undefined) throw engineNotFound(`supply model ${id} not found`);
    const nextStatus = dto.status ?? current.status;
    const nextPriceCardId =
      dto.price_card_id !== undefined ? dto.price_card_id : current.priceCardId;
    SupplyAdminService.assertPriced(nextStatus, nextPriceCardId);
    const patch: UpdateSupplyModelInput = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.display_name !== undefined ? { displayName: dto.display_name } : {}),
      ...(dto.modality !== undefined ? { modality: dto.modality } : {}),
      ...(dto.operations !== undefined ? { operations: dto.operations } : {}),
      ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      ...(dto.capabilities !== undefined ? { capabilities: dto.capabilities } : {}),
      ...(dto.price_card_id !== undefined ? { priceCardId: dto.price_card_id } : {}),
      ...(dto.modifier_group_id !== undefined ? { modifierGroupId: dto.modifier_group_id } : {}),
      ...(dto.max_run_time_seconds !== undefined
        ? { maxRunTimeSeconds: dto.max_run_time_seconds }
        : {}),
      ...(dto.artifact !== undefined ? { artifact: dto.artifact } : {}),
      ...(dto.fallback_model_ids !== undefined ? { fallbackModelIds: dto.fallback_model_ids } : {}),
      ...(dto.limit_plan_id !== undefined ? { limitPlanId: dto.limit_plan_id } : {}),
      ...(dto.visibility !== undefined ? { visibility: dto.visibility } : {}),
    };
    try {
      const row = await updateSupplyModel(this.db, id, patch);
      if (row === undefined) throw engineNotFound(`supply model ${id} not found`);
      return row;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw engineInvalidInput(`supply model '${dto.name ?? ''}' already exists`);
      }
      throw err;
    }
  }

  /** Soft-delete a model (frees its external name); unknown → 404. */
  async deleteModel(id: string): Promise<void> {
    const deleted = await softDeleteSupplyModel(this.db, id);
    if (deleted === undefined) throw engineNotFound(`supply model ${id} not found`);
  }

  // ----- model grants (§2.1 visibility gate) -----

  /** Grant a model to a tenant (idempotent). 404 on unknown model; 400 on unknown tenant. */
  async grantModel(modelId: string, dto: GrantSupplyModelDto): Promise<void> {
    const model = await getSupplyModelById(this.db, modelId);
    if (model === undefined) throw engineNotFound(`supply model ${modelId} not found`);
    const t = await getTenant(this.db, dto.tenant_id);
    if (t === undefined) throw engineInvalidInput(`tenant ${dto.tenant_id} not found`);
    await grantSupplyModel(this.db, modelId, dto.tenant_id);
  }

  /**
   * Revoke a tenant's grant: a TRUE hard delete, idempotent (revoking an
   * absent grant is a no-op 204 — the repo contract). 404 only when the model
   * itself is unknown/soft-deleted.
   */
  async revokeModelGrant(modelId: string, tenantId: string): Promise<void> {
    const model = await getSupplyModelById(this.db, modelId);
    if (model === undefined) throw engineNotFound(`supply model ${modelId} not found`);
    await revokeSupplyModel(this.db, modelId, tenantId);
  }

  /** List a model's tenant grants; 404 when the model itself is unknown. */
  async listModelGrants(
    modelId: string,
    page: PageParams,
  ): Promise<KeysetResult<SupplyModelGrantRow>> {
    const model = await getSupplyModelById(this.db, modelId);
    if (model === undefined) throw engineNotFound(`supply model ${modelId} not found`);
    return listSupplyModelGrants(this.db, modelId, page);
  }

  /**
   * Mint the model's SALE price card off the official catalog: match
   * `(provider, model.name)` (normalized slug), build the effective spec
   * (`officialPriceToSpec` — the stored rich scheme, else the per-1M
   * `model_token` fast-path), insert the card and re-point the model — one
   * transaction, so a failed re-point never leaves an orphan card. No live
   * billable match → 400 `needs_pricing`.
   */
  async priceCardFromOfficial(
    modelId: string,
    dto: SupplyPriceCardFromOfficialDto,
  ): Promise<SupplyPriceCardRow> {
    const model = await getSupplyModelById(this.db, modelId);
    if (model === undefined) throw engineNotFound(`supply model ${modelId} not found`);
    const official = await matchOfficialPrice(this.db, dto.provider, model.name);
    if (official === undefined) {
      throw engineInvalidInput(
        `needs_pricing: no official price matched provider '${dto.provider}' for model '${model.name}'`,
      );
    }
    const spec = officialPriceToSpec(official);
    return this.db.transaction(async (tx) => {
      const card = await createSupplyPriceCard(tx, {
        name: `${model.name} (official ${dto.provider})`,
        // `method === spec.method` invariant: a rich stored scheme keeps its own
        // method; the per-1M fast-path synthesizes `model_token`.
        method: spec.method,
        unit: 'tokens',
        tierDims: [],
        spec,
        effectiveAt: new Date(),
      });
      await updateSupplyModel(tx, modelId, { priceCardId: card.id });
      return card;
    });
  }

  // ----- offerings (供给项, §2.5) -----

  /**
   * Create an offering: both sides of the (model × channel) binding must be
   * LIVE (a bare FK would 500 on unknown ids and accept soft-deleted rows).
   * Duplicate live (model, channel) → 400.
   */
  async createOffering(dto: CreateSupplyOfferingDto): Promise<SupplyOfferingRow> {
    const model = await getSupplyModelById(this.db, dto.model_id);
    if (model === undefined) throw engineInvalidInput(`model ${dto.model_id} not found`);
    const channel = await getSupplyChannelById(this.db, dto.channel_id);
    if (channel === undefined) throw engineInvalidInput(`channel ${dto.channel_id} not found`);
    const input: CreateSupplyOfferingInput = {
      modelId: dto.model_id,
      channelId: dto.channel_id,
      upstreamModelName: dto.upstream_model_name,
      fetchProfile: dto.fetch_profile,
      ...(dto.param_declarations !== undefined
        ? { paramDeclarations: dto.param_declarations }
        : {}),
      ...(dto.timeout_budget_seconds !== undefined
        ? { timeoutBudgetSeconds: dto.timeout_budget_seconds }
        : {}),
      ...(dto.cost_price_card_id !== undefined ? { costPriceCardId: dto.cost_price_card_id } : {}),
      ...(dto.max_concurrency !== undefined ? { maxConcurrency: dto.max_concurrency } : {}),
      ...(dto.weight !== undefined ? { weight: dto.weight } : {}),
      ...(dto.tier !== undefined ? { tier: dto.tier } : {}),
    };
    try {
      return await createSupplyOffering(this.db, input);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw engineInvalidInput(
          `offering for (model ${dto.model_id}, channel ${dto.channel_id}) already exists`,
        );
      }
      throw err;
    }
  }

  listOfferings(
    filter: {
      modelId?: string | undefined;
      channelId?: string | undefined;
      status?: string | undefined;
    },
    page: PageParams,
  ): Promise<KeysetResult<SupplyOfferingRow>> {
    const f: ListSupplyOfferingsFilter = {
      ...(filter.modelId !== undefined ? { modelId: filter.modelId } : {}),
      ...(filter.channelId !== undefined ? { channelId: filter.channelId } : {}),
      ...(filter.status !== undefined ? { status: filter.status } : {}),
    };
    return listSupplyOfferings(this.db, page, f);
  }

  /** Fetch one live offering or 404. */
  async getOffering(id: string): Promise<SupplyOfferingRow> {
    const row = await getSupplyOfferingById(this.db, id);
    if (row === undefined) throw engineNotFound(`supply offering ${id} not found`);
    return row;
  }

  /** Patch a live offering (the (model, channel) identity is immutable). */
  async updateOffering(id: string, dto: UpdateSupplyOfferingDto): Promise<SupplyOfferingRow> {
    const patch: UpdateSupplyOfferingInput = {
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      ...(dto.upstream_model_name !== undefined
        ? { upstreamModelName: dto.upstream_model_name }
        : {}),
      ...(dto.fetch_profile !== undefined ? { fetchProfile: dto.fetch_profile } : {}),
      ...(dto.param_declarations !== undefined
        ? { paramDeclarations: dto.param_declarations }
        : {}),
      ...(dto.timeout_budget_seconds !== undefined
        ? { timeoutBudgetSeconds: dto.timeout_budget_seconds }
        : {}),
      ...(dto.cost_price_card_id !== undefined ? { costPriceCardId: dto.cost_price_card_id } : {}),
      ...(dto.max_concurrency !== undefined ? { maxConcurrency: dto.max_concurrency } : {}),
      ...(dto.weight !== undefined ? { weight: dto.weight } : {}),
      ...(dto.tier !== undefined ? { tier: dto.tier } : {}),
    };
    const row = await updateSupplyOffering(this.db, id, patch);
    if (row === undefined) throw engineNotFound(`supply offering ${id} not found`);
    return row;
  }

  /** Soft-delete an offering (frees its (model, channel) slot); unknown → 404. */
  async deleteOffering(id: string): Promise<void> {
    const deleted = await softDeleteSupplyOffering(this.db, id);
    if (deleted === undefined) throw engineNotFound(`supply offering ${id} not found`);
  }

  // ----- price cards (§2.7 / §9.2 — immutable, versioned; no PATCH) -----

  /** Mint a new price card (fresh lineage; `method === spec.method` schema-checked). */
  async createPriceCard(dto: CreateSupplyPriceCardDto): Promise<SupplyPriceCardRow> {
    const input: CreateSupplyPriceCardInput = {
      name: dto.name,
      method: dto.method,
      unit: dto.unit,
      spec: dto.spec,
      effectiveAt: new Date(dto.effective_at),
      ...(dto.tier_dims !== undefined ? { tierDims: dto.tier_dims } : {}),
      ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
      ...(dto.version !== undefined ? { version: dto.version } : {}),
    };
    return createSupplyPriceCard(this.db, input);
  }

  listPriceCards(page: PageParams): Promise<KeysetResult<SupplyPriceCardRow>> {
    return listSupplyPriceCards(this.db, page);
  }

  /** Fetch one live price card or 404. */
  async getPriceCard(id: string): Promise<SupplyPriceCardRow> {
    const row = await getSupplyPriceCardById(this.db, id);
    if (row === undefined) throw engineNotFound(`supply price card ${id} not found`);
    return row;
  }

  /**
   * Mint the NEXT version of a live card (the ONLY price-change path — cards
   * are immutable once effective). `method === spec.method` is enforced on the
   * EFFECTIVE (base ∪ patch) pair, so patching only `spec` (or only `method`)
   * cannot desync the invariant.
   */
  async createPriceCardVersion(
    id: string,
    dto: CreateSupplyPriceCardVersionDto,
  ): Promise<SupplyPriceCardRow> {
    const base = await getSupplyPriceCardById(this.db, id);
    if (base === undefined) throw engineNotFound(`supply price card ${id} not found`);
    const effectiveMethod = dto.method ?? base.method;
    const effectiveSpec = dto.spec ?? base.spec;
    if (effectiveMethod !== effectiveSpec.method) {
      throw engineInvalidInput('method must equal spec.method');
    }
    const patch: SupplyPriceCardVersionPatch = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.method !== undefined ? { method: dto.method } : {}),
      ...(dto.unit !== undefined ? { unit: dto.unit } : {}),
      ...(dto.spec !== undefined ? { spec: dto.spec } : {}),
      ...(dto.tier_dims !== undefined ? { tierDims: dto.tier_dims } : {}),
      ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
      ...(dto.effective_at !== undefined ? { effectiveAt: new Date(dto.effective_at) } : {}),
    };
    const row = await createSupplyPriceCardVersion(this.db, id, patch);
    if (row === undefined) throw engineNotFound(`supply price card ${id} not found`);
    return row;
  }

  /** Soft-delete a price card (history stays for billing snapshots); unknown → 404. */
  async deletePriceCard(id: string): Promise<void> {
    const deleted = await softDeleteSupplyPriceCard(this.db, id);
    if (deleted === undefined) throw engineNotFound(`supply price card ${id} not found`);
  }

  // ----- api_key model allowlist (§2.6) -----

  /** Replace a key's supply-model allowlist (`[]` = allow ALL); unknown key → 404. */
  async updateModelAllowlist(keyId: string, models: string[]): Promise<{ models: string[] }> {
    const ok = await updateApiKeyModelAllowlist(this.db, keyId, models);
    if (!ok) throw engineNotFound(`api key ${keyId} not found`);
    return { models };
  }
}
