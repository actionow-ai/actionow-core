import {
  type AccountRow,
  type ApiKeyRow,
  createAccount,
  createApiKey,
  type CreatedApiKey,
  createModifier,
  createPricebookEntry,
  createResource,
  createTenant,
  createUpstreamChannel,
  type Database,
  getAccount,
  getResource,
  type Job,
  type LedgerRow,
  listApiKeys,
  listJobs,
  listLedger,
  listModifiers,
  listPricebookEntries,
  listResources,
  listTenants,
  type ModifierRow,
  type PricebookEntryRow,
  type Resource,
  type TenantRow,
  topUp,
  type UpstreamChannelRow,
} from '@actionow/db';
import { creditsToMicro } from '@actionow/domain';
import { Inject, Injectable } from '@nestjs/common';

import { engineInvalidInput, engineNotFound } from '../common/errors.js';
import { DB } from '../common/tokens.js';
import type {
  CreateAccountDto,
  CreateApiKeyDto,
  CreateChannelDto,
  CreateModifierDto,
  CreatePricebookDto,
  CreateResourceDto,
  CreateTenantDto,
  TopupDto,
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
  constructor(@Inject(DB) private readonly db: Database) {}

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
      weight: dto.weight,
      status: dto.status,
    });
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

  // ----- jobs -----

  listJobs(tenantId: string, cursor: string | undefined, limit: number): Promise<Job[]> {
    return listJobs(this.db, tenantId, cursor, limit);
  }

  // ----- ledger -----

  listLedger(tenantId: string, cursor: string | undefined, limit: number): Promise<LedgerRow[]> {
    return listLedger(this.db, tenantId, cursor, limit);
  }
}

/** True when `value` is a plain object (used to merge into a pricebook spec). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
