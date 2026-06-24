import {
  type AccountRow,
  type ApiKeyRow,
  createApiKey,
  type CreatedApiKey,
  type Database,
  disableApiKeyForTenant,
  type FileObject,
  findUserById,
  getAccount,
  getIntentByIdForTenant,
  getLimitPlanById,
  getTenantLimitPlanId,
  type Job,
  type KeysetResult,
  type LedgerRow,
  type LimitAlertRow,
  type LimitRuleStatus,
  limitRuleStatus,
  listApiKeys,
  listFilesByTenant,
  listIntentsByTenant,
  listJobs,
  listLedger,
  listLimitAlertsForSubject,
  listUsageLogsByTenant,
  type PageParams,
  type PaymentIntentRow,
  rollupUsage,
  rotateApiKeyForTenant,
  updateUserPassword,
  type UsageLogRow,
  type UsageRollupQuery,
  type UsageRollupRow,
  type UserRecord,
} from '@actionow/db';
import type { PaymentService } from '@actionow/engine';
import { hashPassword, verifyPassword } from '@actionow/infra';
import { Inject, Injectable } from '@nestjs/common';

import { engineInvalidInput, engineNotFound } from '../common/errors.js';
import { DB, PAYMENTS } from '../common/tokens.js';
import type {
  ConsoleAnalyticsUsageDto,
  ConsoleChangePasswordDto,
  ConsoleCreateApiKeyDto,
  ConsoleCreateIntentDto,
} from './dto/console.dto.js';
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

  /** Usage rollups for the caller's tenant — the tenant is locked, never from the query. */
  analyticsUsage(tenantId: string, dto: ConsoleAnalyticsUsageDto): Promise<UsageRollupRow[]> {
    const query: UsageRollupQuery = { groupBy: dto.groupBy, tenantId };
    if (dto.from !== undefined) query.from = new Date(dto.from);
    if (dto.to !== undefined) query.to = new Date(dto.to);
    return rollupUsage(this.db, query);
  }

  /** Per-call usage log for the caller's tenant (keyset, newest-first). */
  listUsageLog(tenantId: string, page: PageParams): Promise<KeysetResult<UsageLogRow>> {
    return listUsageLogsByTenant(this.db, tenantId, page);
  }

  // ----- files (asset gallery) -----

  /**
   * The caller-tenant's READY media files (uploaded assets + generated images/
   * videos), keyset newest-first, optionally narrowed to a media `kind`. Pending
   * uploads are excluded — the gallery only shows landed assets.
   */
  listFiles(
    tenantId: string,
    filter: { kind?: 'image' | 'video' | 'audio' },
    page: PageParams,
  ): Promise<KeysetResult<FileObject>> {
    return listFilesByTenant(
      this.db,
      tenantId,
      { status: 'ready', ...(filter.kind !== undefined ? { kind: filter.kind } : {}) },
      page,
    );
  }

  // ----- balance -----

  /** The caller-tenant's billing account (credit balance + held); the guard supplies the id. */
  async balance(accountId: string): Promise<AccountRow> {
    const account = await getAccount(this.db, accountId);
    if (account === undefined) throw engineNotFound(`account ${accountId} not found`);
    return account;
  }

  // ----- payments history -----

  /** The caller-tenant's payment intents (topup history), keyset newest-first. */
  listPayments(tenantId: string, page: PageParams): Promise<KeysetResult<PaymentIntentRow>> {
    return listIntentsByTenant(this.db, tenantId, page);
  }

  /**
   * One of the caller-tenant's payment intents by id (status polling after a
   * topup). Cross-tenant or unknown id → `not_found` (never leaks another
   * tenant's intent).
   */
  async getPaymentIntent(tenantId: string, intentId: string): Promise<PaymentIntentRow> {
    const intent = await getIntentByIdForTenant(this.db, intentId, tenantId);
    if (intent === undefined) throw engineNotFound(`payment intent ${intentId} not found`);
    return intent;
  }

  // ----- profile / settings -----

  /** The caller's own user record (the guard supplies the id). */
  async me(userId: string): Promise<UserRecord> {
    const user = await findUserById(this.db, userId);
    if (user === undefined) throw engineNotFound(`user ${userId} not found`);
    return user;
  }

  /**
   * Change the caller's password: verify the supplied current password against
   * the stored scrypt hash, then swap in a hash of the new one. A wrong current
   * password (or an OAuth-only account with no local hash) is `invalid_input`.
   */
  async changePassword(userId: string, dto: ConsoleChangePasswordDto): Promise<void> {
    const user = await findUserById(this.db, userId);
    if (user === undefined) throw engineNotFound(`user ${userId} not found`);
    if (user.passwordHash === null || !verifyPassword(user.passwordHash, dto.currentPassword)) {
      throw engineInvalidInput('current password is incorrect');
    }
    await updateUserPassword(this.db, userId, hashPassword(dto.newPassword));
  }

  // ----- governance limits (额度套餐) -----

  /**
   * The caller-tenant's governance status: its bound (account-level) limit plan,
   * each effective rule paired with current usage, and recent threshold alerts.
   * `plan` is `null` when no plan is bound (the `/app` budget view shows
   * "unlimited"). Scoped to the tenant — never to a body/query value.
   */
  async limitStatus(tenantId: string): Promise<{
    plan: { id: string; name: string } | null;
    rules: LimitRuleStatus[];
    alerts: LimitAlertRow[];
  }> {
    const planId = await getTenantLimitPlanId(this.db, tenantId);
    const [planRow, rules, alerts] = await Promise.all([
      planId !== null ? getLimitPlanById(this.db, planId) : Promise.resolve(undefined),
      limitRuleStatus(this.db, 'tenant', tenantId, planId),
      listLimitAlertsForSubject(this.db, 'tenant', tenantId),
    ]);
    return {
      plan: planRow ? { id: planRow.id, name: planRow.name } : null,
      rules,
      alerts,
    };
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
