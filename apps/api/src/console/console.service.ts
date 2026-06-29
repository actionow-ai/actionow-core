import type {
  CreateSubAccountBody,
  CreateSubjectBody,
  TopupSubAccountBody,
  TransferCreditsBody,
  UpdateSubjectBody,
} from '@actionow/contracts';
import {
  type AccountRow,
  type ApiKeyRow,
  appendMessage,
  claimRedemptionCode,
  type Conversation,
  countPlanBindings,
  createApiKey,
  createConversation,
  type CreatedApiKey,
  createLimitPlan,
  createSubAccount,
  createSubject,
  createSubUser,
  type Database,
  disableApiKeyForTenant,
  type FileObject,
  findUserByEmail,
  findUserById,
  getAccount,
  getConversation,
  getIntentByIdForTenant,
  getLimitPlanById,
  getLimitPlanForTenant,
  getSubAccount,
  getSubjectById,
  getTenantLimitPlanId,
  type Job,
  type KeysetResult,
  type LedgerRow,
  type LimitAlertRow,
  type LimitPlanRow,
  type LimitRuleInput,
  type LimitRuleRow,
  type LimitRuleStatus,
  limitRuleStatus,
  listApiKeys,
  listConversations,
  listFilesByTenant,
  listIntentsByTenant,
  listJobs,
  listLedger,
  listLimitAlertsForSubject,
  listLimitPlansByTenant,
  listMessages,
  listRulesByPlan,
  listRulesByPlanIds,
  listSubjectsByTenant,
  listUsageLogsByTenant,
  listUsersByTenant,
  type Message,
  type PageParams,
  type PaymentIntentRow,
  replacePlanRules,
  rollupUsage,
  rotateApiKeyForTenant,
  softDeleteConversation,
  softDeleteLimitPlan,
  softDeleteSubject,
  type SubAccountRow,
  type SubjectDeleteResult,
  type SubjectRow,
  topUp,
  transferCredits,
  updateConversation,
  updateLimitPlan,
  updateSubject,
  updateUserPassword,
  updateUserStatus,
  updateUserTenantRole,
  type UsageLogRow,
  type UsageRollupQuery,
  type UsageRollupRow,
  type UserRecord,
} from '@actionow/db';
import { creditsToMicro } from '@actionow/domain';
import type { PaymentService } from '@actionow/engine';
import { hashPassword, verifyPassword } from '@actionow/infra';
import { Inject, Injectable } from '@nestjs/common';

import { engineInvalidInput, engineNotFound } from '../common/errors.js';
import { DB, PAYMENTS } from '../common/tokens.js';
import type {
  ConsoleAnalyticsUsageDto,
  ConsoleAppendMessageDto,
  ConsoleChangePasswordDto,
  ConsoleCreateApiKeyDto,
  ConsoleCreateConversationDto,
  ConsoleCreateIntentDto,
  ConsoleCreateLimitPlanDto,
  ConsoleUpdateConversationDto,
  ConsoleUpdateLimitPlanDto,
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

  /**
   * Mint a key for the caller's tenant; the plaintext is returned ONCE. An
   * optional `subjectId` binds the key to one of the caller-tenant's end-users —
   * validated to belong to the tenant FIRST (a cross-tenant/unknown id → 404, so
   * the key is never minted against another tenant's subject).
   */
  async createApiKey(dto: ConsoleCreateApiKeyDto, tenantId: string): Promise<CreatedApiKey> {
    if (dto.subjectId !== undefined) {
      const subject = await getSubjectById(this.db, tenantId, dto.subjectId);
      if (subject === undefined) throw engineNotFound(`subject ${dto.subjectId} not found`);
    }
    return createApiKey(this.db, {
      tenantId,
      resourceAllowlist: dto.resourceAllowlist,
      rateLimit: dto.rateLimit,
      ...(dto.subjectId !== undefined ? { subjectId: dto.subjectId } : {}),
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

  // ----- playground conversations -----

  /** The caller-tenant's LIVE saved conversations, keyset, most-recent-activity first. */
  listConversations(tenantId: string, page: PageParams): Promise<KeysetResult<Conversation>> {
    return listConversations(this.db, tenantId, page);
  }

  /** Start a conversation for the caller's tenant (title defaults server-side). */
  createConversation(tenantId: string, dto: ConsoleCreateConversationDto): Promise<Conversation> {
    return createConversation(this.db, {
      tenantId,
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.model !== undefined ? { model: dto.model } : {}),
    });
  }

  /** A conversation + its ordered transcript, or 404 (cross-tenant/deleted → 404). */
  async getConversationDetail(
    id: string,
    tenantId: string,
  ): Promise<{ conversation: Conversation; messages: Message[] }> {
    const conversation = await getConversation(this.db, id, tenantId);
    if (conversation === undefined) throw engineNotFound(`conversation ${id} not found`);
    const messages = await listMessages(this.db, id);
    return { conversation, messages };
  }

  /** Rename / re-model one of the caller-tenant's conversations, or 404. */
  async updateConversation(
    id: string,
    tenantId: string,
    dto: ConsoleUpdateConversationDto,
  ): Promise<Conversation> {
    const updated = await updateConversation(this.db, id, tenantId, {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.model !== undefined ? { model: dto.model } : {}),
    });
    if (updated === undefined) throw engineNotFound(`conversation ${id} not found`);
    return updated;
  }

  /** Soft-delete one of the caller-tenant's conversations, or 404. */
  async deleteConversation(id: string, tenantId: string): Promise<void> {
    const deleted = await softDeleteConversation(this.db, id, tenantId);
    if (deleted === undefined) throw engineNotFound(`conversation ${id} not found`);
  }

  /**
   * Append one persisted turn to a conversation. Verifies tenant ownership FIRST
   * (a cross-tenant/unknown/deleted id → 404), so a turn can never be written to
   * another tenant's conversation.
   */
  async appendMessage(
    id: string,
    tenantId: string,
    dto: ConsoleAppendMessageDto,
  ): Promise<Message> {
    const conversation = await getConversation(this.db, id, tenantId);
    if (conversation === undefined) throw engineNotFound(`conversation ${id} not found`);
    return appendMessage(this.db, id, {
      role: dto.role,
      content: dto.content,
      ...(dto.reasoning !== undefined ? { reasoning: dto.reasoning } : {}),
      ...(dto.usage !== undefined ? { usage: dto.usage } : {}),
      ...(dto.latency_ms !== undefined ? { latencyMs: dto.latency_ms } : {}),
      ...(dto.model !== undefined ? { model: dto.model } : {}),
    });
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

  // ----- tenant-owned limit plans (额度套餐; end-user data plane) -----

  /** Map create/update rule DTOs to repo rule inputs (mirrors {@link AdminService.ruleInputs}). */
  private ruleInputs(rules: ConsoleCreateLimitPlanDto['rules']): LimitRuleInput[] {
    return rules.map((r) => ({
      dimension: r.dimension,
      period: r.period ?? null,
      cap: BigInt(r.cap),
      modelScope: r.modelScope ?? null,
      alertPct: r.alertPct ?? null,
      enforce: 'hard',
    }));
  }

  /**
   * The caller-tenant's OWN limit plans (tenant_id = ctx.tenantId), each with its
   * rules + binding counts. Platform plans (tenant_id NULL) and other tenants'
   * plans are excluded by the tenant-scoped repo — a tenant only ever sees its own
   * 额度套餐.
   */
  async listLimitPlans(
    tenantId: string,
  ): Promise<
    { plan: LimitPlanRow; rules: LimitRuleRow[]; bindings: { keys: number; tenants: number } }[]
  > {
    const plans = await listLimitPlansByTenant(this.db, tenantId);
    const ids = plans.map((p) => p.id);
    const [rulesByPlan, bindings] = await Promise.all([
      listRulesByPlanIds(this.db, ids),
      countPlanBindings(this.db, ids),
    ]);
    return plans.map((p) => ({
      plan: p,
      rules: rulesByPlan.get(p.id) ?? [],
      bindings: bindings.get(p.id) ?? { keys: 0, tenants: 0 },
    }));
  }

  /**
   * One of the caller-tenant's plans by id, scoped to ctx.tenantId — a cross-
   * tenant id OR a platform plan never matches → `not_found` (never leaks another
   * owner's plan). The repo predicate already intersects `tenantId`.
   */
  async getLimitPlan(
    tenantId: string,
    id: string,
  ): Promise<{
    plan: LimitPlanRow;
    rules: LimitRuleRow[];
    bindings: { keys: number; tenants: number };
  }> {
    const plan = await getLimitPlanForTenant(this.db, id, tenantId);
    if (plan === undefined) throw engineNotFound(`limit plan ${id} not found`);
    const rules = await listRulesByPlan(this.db, id);
    const bindings = (await countPlanBindings(this.db, [id])).get(id) ?? { keys: 0, tenants: 0 };
    return { plan, rules, bindings };
  }

  /**
   * Create a tenant-owned plan: `tenant_id` is FORCED to ctx.tenantId (never a
   * body field), so a console admin can only ever create a plan for its own app.
   * Mirrors {@link AdminService.createLimitPlan} but tenant-locked.
   */
  createLimitPlan(
    tenantId: string,
    dto: ConsoleCreateLimitPlanDto,
  ): Promise<{
    plan: LimitPlanRow;
    rules: LimitRuleRow[];
    bindings: { keys: number; tenants: number };
  }> {
    return this.db.transaction(async (tx) => {
      const plan = await createLimitPlan(tx, {
        name: dto.name,
        description: dto.description ?? null,
        tenantId,
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      });
      const rules = await replacePlanRules(tx, plan.id, this.ruleInputs(dto.rules));
      return { plan, rules, bindings: { keys: 0, tenants: 0 } };
    });
  }

  /**
   * Patch one of the caller-tenant's plans (ownership pre-checked → 404 for a
   * cross-tenant/platform id BEFORE any write). A present `rules` REPLACES the
   * rule set. Tenant-scoped.
   */
  async updateLimitPlan(
    tenantId: string,
    id: string,
    dto: ConsoleUpdateLimitPlanDto,
  ): Promise<{
    plan: LimitPlanRow;
    rules: LimitRuleRow[];
    bindings: { keys: number; tenants: number };
  }> {
    return this.db.transaction(async (tx) => {
      // Ownership intersection FIRST — never mutate another tenant's / a platform plan.
      const owned = await getLimitPlanForTenant(tx, id, tenantId);
      if (owned === undefined) throw engineNotFound(`limit plan ${id} not found`);
      const plan = await updateLimitPlan(tx, id, {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      });
      if (plan === undefined) throw engineNotFound(`limit plan ${id} not found`);
      const rules =
        dto.rules !== undefined
          ? await replacePlanRules(tx, id, this.ruleInputs(dto.rules))
          : await listRulesByPlan(tx, id);
      const bindings = (await countPlanBindings(tx, [id])).get(id) ?? { keys: 0, tenants: 0 };
      return { plan, rules, bindings };
    });
  }

  /**
   * Soft-delete one of the caller-tenant's plans (ownership pre-checked → 404 for
   * a cross-tenant/platform id BEFORE the delete). Tenant-scoped.
   */
  async deleteLimitPlan(tenantId: string, id: string): Promise<void> {
    const owned = await getLimitPlanForTenant(this.db, id, tenantId);
    if (owned === undefined) throw engineNotFound(`limit plan ${id} not found`);
    const deleted = await softDeleteLimitPlan(this.db, id);
    if (deleted === undefined) throw engineNotFound(`limit plan ${id} not found`);
  }

  /**
   * Bind/unbind a subject's limit plan (`planId` null clears). BOTH the subject
   * AND the plan must belong to ctx.tenantId — each is intersected with the tenant
   * scope FIRST, so a cross-tenant subject OR a plan the tenant doesn't own (incl.
   * a platform plan) → `not_found` (never binds across the tenant boundary).
   */
  async setSubjectLimitPlan(
    tenantId: string,
    subjectId: string,
    planId: string | null,
  ): Promise<SubjectRow> {
    // Subject must be the caller-tenant's (cross-tenant/unknown → 404).
    await this.getSubject(tenantId, subjectId);
    // Plan (when binding) must be the caller-tenant's OWN plan (cross-tenant /
    // platform / unknown → 404). Unbinding (null) skips the plan check.
    if (planId !== null) {
      const plan = await getLimitPlanForTenant(this.db, planId, tenantId);
      if (plan === undefined) throw engineNotFound(`limit plan ${planId} not found`);
    }
    const row = await updateSubject(this.db, tenantId, subjectId, { limitPlanId: planId });
    if (row === undefined) throw engineNotFound(`subject ${subjectId} not found`);
    return row;
  }

  // ----- sub-users (rbac) -----

  /**
   * Invite a sub-user (tenant member) under the caller's tenant: a normal USER
   * row (`role='user'`, `tenant_role='member'`) with the supplied initial
   * credential hashed. The tenant is the guard's, never a body field; the
   * plaintext password is never returned or logged. Admin-only at the route.
   */
  async inviteSubUser(tenantId: string, email: string, password: string): Promise<UserRecord> {
    // `email` is globally unique — pre-check so a duplicate invite returns a clean
    // 400 (mirrors LocalAuthService.register) instead of a raw 23505 → 500.
    const existing = await findUserByEmail(this.db, email);
    if (existing !== undefined) {
      throw engineInvalidInput('email already registered');
    }
    return createSubUser(this.db, { tenantId, email, passwordHash: hashPassword(password) });
  }

  /** List the caller-tenant's operator users (keyset, newest-first). Admin-only at the route. */
  listUsers(tenantId: string, page: PageParams): Promise<KeysetResult<UserRecord>> {
    return listUsersByTenant(this.db, tenantId, page);
  }

  /**
   * Update a tenant sub-user: promote/demote (`tenantRole`) and/or soft-disable
   * (`status`), both tenant-scoped (a cross-tenant id never matches → 404).
   * Returns the updated row. Admin-only at the route.
   */
  async updateSubUser(
    tenantId: string,
    id: string,
    patch: {
      status?: 'active' | 'disabled' | undefined;
      tenantRole?: 'admin' | 'member' | undefined;
    },
  ): Promise<UserRecord> {
    let row: UserRecord | undefined;
    if (patch.tenantRole !== undefined) {
      row = await updateUserTenantRole(this.db, tenantId, id, patch.tenantRole);
    }
    if (patch.status !== undefined) {
      row = await updateUserStatus(this.db, tenantId, id, patch.status);
    }
    if (row === undefined) throw engineNotFound(`user ${id} not found`);
    return row;
  }

  // ----- tenant subjects (end-users; unified tenancy G-A, console plane) -----

  /**
   * Create a subject (end-user) under the caller's tenant. The tenant is the
   * guard's, NEVER a body field — a console admin can only ever add end-users to
   * its own app. Mirrors {@link AdminService.createSubject} but tenant-locked.
   */
  createSubject(tenantId: string, dto: CreateSubjectBody): Promise<SubjectRow> {
    return createSubject(this.db, {
      tenantId,
      externalId: dto.externalId,
      email: dto.email,
      displayName: dto.displayName,
      limitPlanId: dto.limitPlanId,
    });
  }

  /** List the caller-tenant's live subjects, keyset newest-first. */
  listSubjects(tenantId: string, page: PageParams): Promise<KeysetResult<SubjectRow>> {
    return listSubjectsByTenant(this.db, tenantId, page);
  }

  /**
   * One subject by id, scoped to the caller's tenant — a cross-tenant (or
   * unknown/deleted) id never matches → `not_found` (never leaks another tenant's
   * end-user). The repo predicate already intersects `tenantId`.
   */
  async getSubject(tenantId: string, id: string): Promise<SubjectRow> {
    const row = await getSubjectById(this.db, tenantId, id);
    if (row === undefined) throw engineNotFound(`subject ${id} not found`);
    return row;
  }

  /**
   * An end-user's effective rules paired with current usage (usage-vs-cap bars),
   * tenant-scoped: the subject MUST be the caller-tenant's (cross-tenant/unknown →
   * 404) before any usage is read. Reuses {@link limitRuleStatus} with the
   * `'subject'` scope, exactly as the operator/member surfaces do.
   */
  async subjectLimitStatus(tenantId: string, subjectId: string): Promise<LimitRuleStatus[]> {
    const subject = await this.getSubject(tenantId, subjectId);
    return limitRuleStatus(this.db, 'subject', subjectId, subject.limitPlanId);
  }

  /** Patch a subject (tenant-scoped); 404 when absent/cross-tenant. `external_id` is immutable. */
  async updateSubject(tenantId: string, id: string, dto: UpdateSubjectBody): Promise<SubjectRow> {
    const row = await updateSubject(this.db, tenantId, id, {
      email: dto.email,
      displayName: dto.displayName,
      limitPlanId: dto.limitPlanId,
      status: dto.status,
    });
    if (row === undefined) throw engineNotFound(`subject ${id} not found`);
    return row;
  }

  /**
   * Soft-delete a subject (tenant-scoped) + cascade (sweep its sub-wallet back to
   * the tenant pool, disable its subject-scoped keys); 404 when absent/cross-
   * tenant. Reuses the records-system soft-delete cascade ([[records-system-v1]]
   * R3). Returns the cascade summary for the audit record.
   */
  async deleteSubject(tenantId: string, id: string): Promise<SubjectDeleteResult> {
    const deleted = await softDeleteSubject(this.db, tenantId, id);
    if (deleted === undefined) throw engineNotFound(`subject ${id} not found`);
    return deleted;
  }

  // ----- subject sub-wallets (HARD mode; console plane) -----

  /**
   * Open a HARD sub-wallet for one of the caller-tenant's subjects (optional
   * opening balance in credits). The subject is checked FIRST via the tenant-
   * scoped {@link getSubject} (a cross-tenant/unknown id → 404), so a sub-wallet
   * is never opened against another tenant's end-user. Mirrors
   * {@link AdminService.createSubAccount} but tenant-locked.
   */
  async createSubAccount(
    tenantId: string,
    subjectId: string,
    dto: CreateSubAccountBody,
  ): Promise<SubAccountRow> {
    await this.getSubject(tenantId, subjectId);
    const opening = dto.credits === undefined ? 0n : creditsToMicro(dto.credits);
    // SECURITY (billing integrity): never MINT an opening balance. Create the
    // wallet at zero, then fund the requested opening amount as a CONSERVING
    // allocation from the tenant's own pool (atomic; the whole open rolls back if
    // the pool can't cover it). Mirrors `topupSubAccount`; the minting path stays
    // reserved for the platform/system-admin grant.
    return this.db.transaction(async (tx) => {
      const sub = await createSubAccount(tx, { tenantId, subjectId, creditBalance: 0n });
      if (opening <= 0n) return sub;
      try {
        await transferCredits(tx, {
          tenantId,
          subjectId,
          amount: opening,
          direction: 'to_subject',
        });
      } catch (err) {
        if (err instanceof Error && err.message.includes('insufficient tenant balance')) {
          throw engineInvalidInput('insufficient tenant pool balance to fund the sub-wallet');
        }
        throw err;
      }
      const funded = await getSubAccount(tx, tenantId, subjectId);
      return funded ?? sub;
    });
  }

  /**
   * The caller-tenant subject's sub-wallet (balance/held), or 404. The subject
   * must belong to the tenant (checked first) AND have an open wallet.
   */
  async getSubAccount(tenantId: string, subjectId: string): Promise<SubAccountRow> {
    await this.getSubject(tenantId, subjectId);
    const sub = await getSubAccount(this.db, tenantId, subjectId);
    if (sub === undefined) throw engineNotFound(`sub-wallet for subject ${subjectId} not found`);
    return sub;
  }

  /**
   * Allocate credit to a caller-tenant subject's sub-wallet (amount in credits).
   * 404 when the subject is cross-tenant or has no open wallet.
   *
   * SECURITY (billing integrity): a tenant-admin must NOT be able to mint
   * sub-wallet credit from nothing — a sub-wallet "topup" is an INTERNAL
   * ALLOCATION funded from the tenant's OWN pool. So it routes through the
   * conserving `transferCredits` (atomic pool debit with a no-oversell guard),
   * NOT the minting `topupSubAccount` (which only credits the sub-wallet and is
   * reserved for the platform/system-admin grant path). An insufficient tenant
   * pool balance is rejected (the whole transfer rolls back). Returns the new
   * µcredit sub-wallet balance.
   */
  async topupSubAccount(
    tenantId: string,
    subjectId: string,
    dto: TopupSubAccountBody,
  ): Promise<bigint> {
    await this.getSubAccount(tenantId, subjectId);
    try {
      await transferCredits(this.db, {
        tenantId,
        subjectId,
        amount: creditsToMicro(dto.credits),
        direction: 'to_subject',
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes('insufficient tenant balance')) {
        throw engineInvalidInput('insufficient tenant pool balance to allocate to the sub-wallet');
      }
      throw err;
    }
    const sub = await getSubAccount(this.db, tenantId, subjectId);
    return sub?.creditBalance ?? 0n;
  }

  /**
   * Transfer credits between the tenant pool and a caller-tenant subject's sub-
   * wallet (same tenant; immutable). 404 when cross-tenant or no open wallet.
   */
  async transferCredits(
    tenantId: string,
    subjectId: string,
    dto: TransferCreditsBody,
  ): Promise<void> {
    await this.getSubAccount(tenantId, subjectId);
    await transferCredits(this.db, {
      tenantId,
      subjectId,
      amount: creditsToMicro(dto.credits),
      direction: dto.direction,
    });
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

  // ----- redemption codes -----

  /**
   * Redeem a single-use gift code, crediting the caller's OWN tenant account.
   * The whole claim+credit runs in ONE transaction so a code is never consumed
   * without the matching credit (and a failed credit rolls back the claim flip):
   *
   *  1. {@link claimRedemptionCode} atomically flips `unused`→`redeemed` for THIS
   *     tenant via a single conditional UPDATE (no read-then-write window → no
   *     double-redeem under concurrency).
   *  2. On a miss it disambiguates the failure (missing / expired / already
   *     redeemed) and throws the matching engine error — the throw rolls back the
   *     tx, un-flipping the row it just touched. So a NOT-claimed outcome leaves
   *     the row exactly as it was.
   *  3. On a win it {@link topUp}s the tenant pool by the µcredit grant (appending
   *     a `topup` ledger row); `topUp` opens a SAVEPOINT under the outer tx, which
   *     stays atomic.
   *
   * Returns the granted amount and the new balance, both µcredit decimal strings.
   */
  async redeem(
    code: string,
    tenantId: string,
    accountId: string,
  ): Promise<{ credited: string; balance: string }> {
    return this.db.transaction(async (tx) => {
      const result = await claimRedemptionCode(tx, code, tenantId);
      if (!result.claimed) {
        if (result.missing) throw engineNotFound('redemption code not found');
        if (result.expired) throw engineInvalidInput('redemption code expired');
        // Otherwise it exists but was already redeemed (by this or another tenant).
        throw engineInvalidInput('redemption code already redeemed');
      }
      // `claimed === true` guarantees `creditAmount` (a µcredit bigint); narrow at
      // runtime so neither a cast nor a `!` assertion is needed.
      const { creditAmount } = result;
      if (creditAmount === undefined) {
        throw new Error('claimRedemptionCode returned claimed without a creditAmount');
      }
      const balanceAfter = await topUp(tx, accountId, tenantId, creditAmount);
      return { credited: creditAmount.toString(), balance: balanceAfter.toString() };
    });
  }
}
