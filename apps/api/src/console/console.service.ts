import {
  type ApiKeyRow,
  createApiKey,
  type CreatedApiKey,
  type Database,
  disableApiKeyForTenant,
  type Job,
  type KeysetResult,
  type LedgerRow,
  listApiKeys,
  listJobs,
  listLedger,
  type PageParams,
  rotateApiKeyForTenant,
} from '@actionow/db';
import type { PaymentService } from '@actionow/engine';
import { Inject, Injectable } from '@nestjs/common';

import { engineNotFound } from '../common/errors.js';
import { DB, PAYMENTS } from '../common/tokens.js';
import type { ConsoleCreateApiKeyDto, ConsoleCreateIntentDto } from './dto/console.dto.js';
import { MODELS_PORT, type ModelsPort, type ModelView } from './models.port.js';

/** The body of a successful self-serve topup (`POST /console/payments/topup`). */
export interface ConsoleCreateIntentResponse {
  intent_id: string;
  redirect_url?: string;
  qr?: string;
}

/**
 * The tenant-scoped read/write layer behind the console controller. Mirrors
 * {@link AdminService} but every method is scoped to a `tenantId` the
 * ConsoleGuard supplies from the authenticated principal — the tenant is NEVER
 * read from a request body, so a caller can only ever touch their own tenant.
 *
 * Reuses the Task-2 tenant-predicated api-key repos, the admin usage list
 * helpers (`listJobs`/`listLedger`), the engine {@link PaymentService} for
 * self-topup, and the {@link ModelsPort} seam for the visible-models list.
 */
@Injectable()
export class ConsoleService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(PAYMENTS) private readonly payments: PaymentService,
    @Inject(MODELS_PORT) private readonly models: ModelsPort,
  ) {}

  // ----- api keys -----

  /** Mint a key for the caller's tenant; the plaintext is returned ONCE. */
  createApiKey(dto: ConsoleCreateApiKeyDto, tenantId: string): Promise<CreatedApiKey> {
    return createApiKey(this.db, {
      tenantId,
      resourceAllowlist: dto.resourceAllowlist,
      rateLimit: dto.rateLimit,
    });
  }

  /** List the caller-tenant's keys WITHOUT the hash (the plaintext is unrecoverable). */
  listApiKeys(tenantId: string, page: PageParams): Promise<KeysetResult<Omit<ApiKeyRow, 'hash'>>> {
    return listApiKeys(this.db, tenantId, page);
  }

  /** Disable one of the caller-tenant's keys, or 404 (cross-tenant → 404). */
  async disableApiKey(keyId: string, tenantId: string): Promise<void> {
    const disabled = await disableApiKeyForTenant(this.db, keyId, tenantId);
    if (!disabled) {
      throw engineNotFound(`api key ${keyId} not found`);
    }
  }

  /**
   * Rotate one of the caller-tenant's keys: mint a fresh plaintext that inherits
   * the old key's settings and disable the old row. 404 on a cross-tenant id.
   */
  async rotateApiKey(keyId: string, tenantId: string): Promise<CreatedApiKey> {
    const rotated = await rotateApiKeyForTenant(this.db, keyId, tenantId);
    if (rotated === undefined) {
      throw engineNotFound(`api key ${keyId} not found`);
    }
    return rotated;
  }

  // ----- usage -----

  listJobs(tenantId: string, page: PageParams): Promise<KeysetResult<Job>> {
    return listJobs(this.db, tenantId, page);
  }

  listLedger(tenantId: string, page: PageParams): Promise<KeysetResult<LedgerRow>> {
    return listLedger(this.db, tenantId, page);
  }

  // ----- models -----

  /** List the models visible to the caller's tenant (delegated to the seam). */
  listModels(tenantId: string): Promise<ModelView[]> {
    return this.models.listVisibleModels(this.db, tenantId);
  }

  // ----- payments -----

  /**
   * Create a self-serve `topup` intent for the caller's tenant. The purpose is
   * hardcoded to `topup`; `amount_minor` (a safe integer) is carried downstream
   * as a `bigint` so money never touches a float.
   */
  async selfTopup(
    dto: ConsoleCreateIntentDto,
    tenantId: string,
  ): Promise<ConsoleCreateIntentResponse> {
    const result = await this.payments.createIntent({
      tenantId,
      provider: dto.provider,
      purpose: 'topup',
      amountMinor: BigInt(dto.amount_minor),
      currency: dto.currency,
    });
    return {
      intent_id: result.intentId,
      ...(result.redirectUrl !== undefined ? { redirect_url: result.redirectUrl } : {}),
      ...(result.qr !== undefined ? { qr: result.qr } : {}),
    };
  }
}
