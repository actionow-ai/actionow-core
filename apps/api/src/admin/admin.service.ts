import { randomUUID } from 'node:crypto';

import {
  type AccountRow,
  type ApiKeyRow,
  createAccount,
  createApiKey,
  type CreatedApiKey,
  createEncryptedSecret,
  createModel,
  type CreateModelInput,
  createModifier,
  createPricebookEntry,
  createRedemptionCode,
  createResource,
  createTenant,
  createUpstreamChannel,
  type Database,
  getAccount,
  getResource,
  grantModel,
  type Job,
  type LedgerRow,
  listApiKeys,
  listChannelsForResource,
  listJobs,
  listLedger,
  listModels,
  listModifiers,
  listPricebookEntries,
  listResources,
  listTenants,
  listUsageLogsGlobal,
  type ModelRow,
  type ModifierRow,
  type PricebookEntryRow,
  type Resource,
  type SecretRefRow,
  type TenantRow,
  topUp,
  updateUpstreamChannel,
  type UpstreamChannelRow,
  type UsageLogRow,
} from '@actionow/db';
import { creditsToMicro } from '@actionow/domain';
import type { AppEnv } from '@actionow/infra';
import { Inject, Injectable } from '@nestjs/common';

import { engineInvalidInput, engineNotFound } from '../common/errors.js';
import { DB, ENV } from '../common/tokens.js';
import type {
  CreateAccountDto,
  CreateApiKeyDto,
  CreateChannelDto,
  CreateModelDto,
  CreateModifierDto,
  CreatePricebookDto,
  CreateResourceDto,
  CreateSecretDto,
  CreateTenantDto,
  GenerateCodesDto,
  GrantModelDto,
  TopupDto,
  UpdateChannelDto,
} from './dto/admin.dto.js';

/** Modifier ops whose `value` is a µcredit amount (vs. a whole-percent int). */
const CREDIT_VALUE_OPS = new Set(['flat_off', 'override_rate']);

/**
 * The thin write/read layer behind the admin CRUD controllers. Owns the
 * dto→db-repo mapping and the credit→µcredit conversion at the boundary: every
 * human-credit input (account opening balance, topup, fixed pricebook amount,
 * credit-denominated modifier value) is converted via `creditsToMicro` here, so
 * the db only ever stores µcredits.
 */
@Injectable()
export class AdminService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  // ----- tenants -----

  createTenant(dto: CreateTenantDto): Promise<TenantRow> {
    return createTenant(this.db, { name: dto.name, isolationMode: dto.isolationMode });
  }

  listTenants(): Promise<TenantRow[]> {
    return listTenants(this.db);
  }

  // ----- accounts -----

  createAccount(dto: CreateAccountDto): Promise<AccountRow> {
    const creditBalance = dto.credits === undefined ? undefined : creditsToMicro(dto.credits);
    return createAccount(this.db, { tenantId: dto.tenantId, creditBalance });
  }

  /** Top up an account; `credits` (human) is converted to µcredits here. */
  async topup(accountId: string, dto: TopupDto): Promise<{ balanceMicro: string }> {
    const acct = await getAccount(this.db, accountId);
    if (acct === undefined) {
      throw engineNotFound(`account ${accountId} not found`);
    }
    const balance = await topUp(this.db, accountId, acct.tenantId, creditsToMicro(dto.credits));
    return { balanceMicro: balance.toString() };
  }

  // ----- api keys -----

  /** Mint a key; the plaintext is returned ONCE (only its hash is stored). */
  createApiKey(dto: CreateApiKeyDto): Promise<CreatedApiKey> {
    return createApiKey(this.db, {
      tenantId: dto.tenantId,
      resourceAllowlist: dto.resourceAllowlist,
      rateLimit: dto.rateLimit,
    });
  }

  /** List a tenant's keys WITHOUT the hash (the plaintext is unrecoverable). */
  listApiKeys(tenantId: string): Promise<Omit<ApiKeyRow, 'hash'>[]> {
    return listApiKeys(this.db, tenantId);
  }

  // ----- secrets -----

  /**
   * Encrypt-at-rest a credential and return its `secret_ref` row. The plaintext
   * is encrypted with the configured master key before insert and is NEVER
   * returned or logged; the row's id is usable as a channel `credentialRef`.
   */
  async createSecret(dto: CreateSecretDto): Promise<SecretRefRow> {
    const keyB64 = this.env.SECRET_ENCRYPTION_KEY;
    if (keyB64 === undefined || keyB64 === '') {
      throw engineInvalidInput('SECRET_ENCRYPTION_KEY is not configured');
    }
    return createEncryptedSecret(this.db, { value: dto.value, label: dto.label, keyB64 });
  }

  // ----- resources -----

  createResource(dto: CreateResourceDto): Promise<Resource> {
    return createResource(this.db, {
      id: dto.id,
      tenantId: dto.tenantId,
      kind: dto.kind,
      modality: dto.modality,
      providerType: dto.providerType,
      execModes: dto.execModes,
      ioSchema: dto.ioSchema,
      version: dto.version ?? 1,
    });
  }

  listResources(): Promise<Resource[]> {
    return listResources(this.db);
  }

  async createChannel(resourceId: string, dto: CreateChannelDto): Promise<UpstreamChannelRow> {
    const resource = await getResource(this.db, resourceId);
    if (resource === undefined) {
      throw engineNotFound(`resource ${resourceId} not found`);
    }
    return createUpstreamChannel(this.db, {
      resourceId,
      providerType: dto.providerType,
      credentialRef: dto.credentialRef ?? null,
      endpoint: dto.endpoint ?? null,
      model: dto.model ?? null,
      proxyRef: dto.proxyRef ?? null,
      config: dto.config ?? null,
      weight: dto.weight,
      status: dto.status,
    });
  }

  /** List every channel of a resource (incl. disabled) — operator routing view. */
  listResourceChannels(resourceId: string): Promise<UpstreamChannelRow[]> {
    return listChannelsForResource(this.db, resourceId);
  }

  /** Patch an upstream channel's routing fields (weight/status/endpoint/model/...). */
  async updateChannel(channelId: string, dto: UpdateChannelDto): Promise<UpstreamChannelRow> {
    const row = await updateUpstreamChannel(this.db, channelId, dto);
    if (row === undefined) {
      throw engineNotFound(`channel ${channelId} not found`);
    }
    return row;
  }

  // ----- pricebook -----

  /**
   * Create a pricebook entry. For `method: 'fixed'`, a human-credit `fixedCredits`
   * is converted to a µcredit `amount` and merged into the persisted `spec` so
   * the engine reads µcredits directly.
   */
  createPricebook(dto: CreatePricebookDto): Promise<PricebookEntryRow> {
    const spec = this.buildPricebookSpec(dto);
    return createPricebookEntry(this.db, {
      resourceId: dto.resourceId,
      resourceVersion: dto.resourceVersion,
      version: dto.version,
      method: dto.method,
      timing: dto.timing,
      spec,
      markup: dto.markup,
      active: dto.active,
    });
  }

  private buildPricebookSpec(dto: CreatePricebookDto): unknown {
    if (dto.fixedCredits === undefined) {
      return dto.spec ?? {};
    }
    if (dto.method !== 'fixed') {
      throw engineInvalidInput('fixedCredits is only valid for method "fixed"');
    }
    const base = isRecord(dto.spec) ? dto.spec : {};
    return { method: 'fixed', ...base, amount: creditsToMicro(dto.fixedCredits).toString() };
  }

  listPricebook(resourceId: string): Promise<PricebookEntryRow[]> {
    return listPricebookEntries(this.db, resourceId);
  }

  // ----- modifiers -----

  /**
   * Create a modifier. Credit-denominated ops (`flat_off`/`override_rate`) take
   * a human-credit `value` converted to µcredits; percent ops keep the raw
   * whole-percent integer.
   */
  createModifier(dto: CreateModifierDto): Promise<ModifierRow> {
    const value = this.modifierValue(dto);
    return createModifier(this.db, {
      scope: dto.scope,
      whenExpr: dto.whenExpr ?? null,
      op: dto.op,
      value,
      stackable: dto.stackable,
      priority: dto.priority,
      version: dto.version,
      active: dto.active,
    });
  }

  private modifierValue(dto: CreateModifierDto): bigint | null {
    if (dto.value === undefined) return null;
    return CREDIT_VALUE_OPS.has(dto.op) ? creditsToMicro(dto.value) : BigInt(Math.round(dto.value));
  }

  listModifiers(): Promise<ModifierRow[]> {
    return listModifiers(this.db);
  }

  // ----- models -----

  /**
   * Register a relay model. `inputPrice`/`outputPrice` are µcredit-per-token
   * integers (NOT human credits) — passed through unchanged. `capabilities`
   * defaults to `{}` when omitted.
   */
  createModel(dto: CreateModelDto): Promise<ModelRow> {
    const input: CreateModelInput = {
      name: dto.name,
      resourceId: dto.resourceId,
      ...(dto.display !== undefined ? { display: dto.display } : {}),
      ...(dto.modality !== undefined ? { modality: dto.modality } : {}),
      ...(dto.capabilities !== undefined ? { capabilities: dto.capabilities } : {}),
      ...(dto.visibility !== undefined ? { visibility: dto.visibility } : {}),
      ...(dto.inputPrice !== undefined ? { inputPrice: BigInt(dto.inputPrice) } : {}),
      ...(dto.outputPrice !== undefined ? { outputPrice: BigInt(dto.outputPrice) } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
    };
    return createModel(this.db, input);
  }

  listModels(): Promise<ModelRow[]> {
    return listModels(this.db);
  }

  /** Grant a tenant-visibility model (by name) to a tenant. */
  async grantModel(modelName: string, dto: GrantModelDto): Promise<void> {
    await grantModel(this.db, modelName, dto.tenantId);
  }

  // ----- jobs -----

  listJobs(tenantId: string, cursor: string | undefined, limit: number): Promise<Job[]> {
    return listJobs(this.db, tenantId, cursor, limit);
  }

  // ----- ledger -----

  listLedger(tenantId: string, cursor: string | undefined, limit: number): Promise<LedgerRow[]> {
    return listLedger(this.db, tenantId, cursor, limit);
  }

  // ----- redemption codes -----

  /**
   * Mint `count` redemption codes, each granting `creditsPerCode` (HUMAN credits
   * → µcredits). Codes are 16 uppercase hex chars (collision-free via randomUUID).
   * All share the µcredit grant; returned for the operator to distribute.
   */
  async generateCodes(dto: GenerateCodesDto): Promise<{ codes: string[]; creditAmount: bigint }> {
    const creditAmount = creditsToMicro(dto.creditsPerCode);
    const expiresAt = dto.expiresAt === undefined ? undefined : new Date(dto.expiresAt);
    const codes: string[] = [];
    for (let i = 0; i < dto.count; i += 1) {
      const code = randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase();
      await createRedemptionCode(this.db, {
        code,
        creditAmount,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      });
      codes.push(code);
    }
    return { codes, creditAmount };
  }

  // ----- usage stats -----

  listUsageGlobal(limit: number): Promise<UsageLogRow[]> {
    return listUsageLogsGlobal(this.db, limit);
  }
}

/** True when `value` is a plain object (used to merge into a pricebook spec). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
