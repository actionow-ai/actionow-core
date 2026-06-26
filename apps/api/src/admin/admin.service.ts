import { randomUUID } from 'node:crypto';

import type { AdapterRegistry } from '@actionow/adapters';
import {
  type AdapterContext,
  type CreatePluginRequest,
  type HttpClient,
  type RelayTraceView,
  relayTraceViewSchema,
  type TestPluginRequest,
  type TestPluginResponse,
  type UpdatePluginRequest,
} from '@actionow/contracts';
import {
  type AccountRow,
  addChannelToGroup,
  anyResourceTenantId,
  type ApiKeyRow,
  type AuditLogFilter,
  type AuditLogRow,
  type BreakerStatusRow,
  type ChannelHealthRow,
  channelIdsByModelIds,
  checkFallbackChain,
  countAccounts,
  countByPlugin,
  countModelsByChannelIds,
  countPlanBindings,
  countResources,
  countTenants,
  countUsageLogs,
  createAccount,
  createApiKey,
  type CreatedApiKey,
  createEncryptedSecret,
  createFaultPolicy,
  type CreateFaultPolicyInput,
  createLimitPlan,
  createModel,
  type CreateModelInput,
  createModifier,
  createOAuthSession,
  type CreateOAuthSessionInput,
  createOfficialPrice,
  type CreateOfficialPriceInput,
  createPlugin,
  createPricebookEntry,
  createProxy,
  type CreateProxyInput,
  createRedemptionCode,
  createResource,
  createRouteGroup,
  type CreateRouteGroupInput,
  createSubAccount,
  createSubject,
  createTenant,
  createUpstreamChannel,
  type Database,
  decryptSecret,
  deleteModelGrant,
  encryptSecret,
  type FaultPolicyRow,
  findResourceByProviderModality,
  getAccount,
  getChannelById,
  getFaultPolicyById,
  getLimitPlanById,
  getModelById,
  getModelByName,
  getModifierById,
  getOfficialPriceById,
  getPluginById,
  getPricebookEntryById,
  getProxyById,
  getResource,
  getRouteGroupById,
  getSecretRefById,
  getSubAccount,
  getSubjectById,
  getTenant,
  grantModel,
  type IconAssetRow,
  type Job,
  type KeysetResult,
  type LedgerRow,
  type LimitAlertRow,
  type LimitPlanRow,
  type LimitRuleInput,
  type LimitRuleRow,
  type LimitRuleStatus,
  limitRuleStatus,
  type LimitUsageRow,
  linkChannelModel,
  linkChannelModelsByNames,
  listAccounts,
  listAllChannelsWithHealth,
  listApiKeys,
  listAuditLog,
  listBreakersWithChannel,
  listChannelModels,
  listChannelsByPlugin,
  listChannelsForResource,
  listFaultPolicies,
  listGroupChannels,
  listIconAssets,
  listJobs,
  listLedger,
  listLimitAlerts,
  listLimitPlans,
  listModelGrants,
  listModelHealth,
  listModelHealthHistory,
  listModels,
  listModifiers,
  listOAuthSessions,
  listOfficialPrices,
  listPlugins,
  listPricebookEntries,
  listProxies,
  listRedemptionCodes,
  listRelayTraces,
  listResources,
  listRouteGroups,
  listRulesByPlan,
  listRulesByPlanIds,
  listSecretRefs,
  listSubjectsByTenant,
  listTenants,
  listUsageForSubject,
  listUsageLogsGlobal,
  type ModelGrantRow,
  type ModelHealthBucket,
  type ModelHealthRow,
  type ModelRow,
  type ModifierRow,
  normalizeModelSlug,
  type OAuthSessionListRow,
  type OfficialModelPriceRow,
  type PageParams,
  type PluginCounts,
  type PricebookEntryRow,
  type ProviderPluginRow,
  type ProxyRow,
  type ReconcileRow,
  reconcileTenant,
  recordProxyHealth,
  type RedemptionCodeRow,
  type RelayTraceFilter,
  type RelayTraceRow,
  removeChannelFromGroup,
  replacePlanRules,
  resetBreaker,
  type Resource,
  rollupUsage,
  type RouteGroupChannelRow,
  type RouteGroupRow,
  type SecretRefRow,
  type SecretRefView,
  setApiKeyGroup,
  setApiKeyLimitPlan,
  setTenantLimitPlan,
  softDeleteApiKey,
  softDeleteChannel,
  softDeleteFaultPolicy,
  softDeleteLimitPlan,
  softDeleteModel,
  softDeleteModifier,
  softDeleteOAuthSession,
  softDeleteOfficialPrice,
  softDeletePlugin,
  softDeletePricebookEntry,
  softDeleteProxy,
  softDeleteRouteGroup,
  softDeleteSecretRef,
  softDeleteSubject,
  type SubAccountRow,
  type SubjectDeleteResult,
  type SubjectRow,
  type TenantRow,
  topUp,
  topupSubAccount,
  transferCredits,
  unlinkAllForChannel,
  unlinkChannelModel,
  updateFaultPolicy,
  type UpdateFaultPolicyInput,
  updateLimitPlan,
  updateModel,
  updateModifier,
  updateOAuthSessionMeta,
  updateOfficialPrice,
  updatePlugin,
  updatePricebookEntry,
  updateProxy,
  type UpdateProxyInput,
  updateResource,
  updateRouteGroup,
  updateSecretRefMeta,
  updateSubject,
  updateTenant,
  updateUpstreamChannel,
  type UpdateUpstreamChannelInput,
  upsertModelsFromSync,
  type UpstreamChannelRow,
  type UsageLogRow,
  type UsageRollupQuery,
  type UsageRollupRow,
} from '@actionow/db';
import { creditsToMicro } from '@actionow/domain';
import {
  type BreakerStore,
  buildCodexAuthorizeUrl,
  CodexAuthError,
  exchangeCodexCode,
  generateCodexPkce,
  parseChatgptIdentity,
  redactHeaders,
  runHandler,
  SandboxError,
} from '@actionow/engine';
import { type AppEnv, createHttpClient } from '@actionow/infra';
import { Inject, Injectable, Optional } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { engineInvalidInput, engineNotFound } from '../common/errors.js';
import { SecretResolver } from '../common/secret-resolver.js';
import { ADAPTERS, BREAKER, DB, ENV, HTTP } from '../common/tokens.js';
import type {
  AddGroupChannelDto,
  AnalyticsUsageQueryDto,
  CodexLoginComplete,
  CreateAccountDto,
  CreateApiKeyDto,
  CreateChannelDto,
  CreateFaultPolicyDto,
  CreateLimitPlanDto,
  CreateModelDto,
  CreateModifierDto,
  CreateOAuthSessionDto,
  CreateOfficialPriceDto,
  CreatePricebookDto,
  CreateProxyDto,
  CreateResourceDto,
  CreateRouteGroupDto,
  CreateSecretDto,
  CreateSubAccountDto,
  CreateSubjectDto,
  CreateTenantDto,
  EnsureResourceDto,
  GenerateCodesDto,
  GrantModelDto,
  ProvisionDto,
  ProxyProbeDto,
  SyncChannelModelsDto,
  TopupDto,
  TopupSubAccountDto,
  TransferCreditsDto,
  UpdateApiKeyGroupDto,
  UpdateChannelDto,
  UpdateFaultPolicyDto,
  UpdateLimitPlanDto,
  UpdateModelDto,
  UpdateModifierDto,
  UpdateOfficialPriceDto,
  UpdatePricebookDto,
  UpdateProxyDto,
  UpdateResourceDto,
  UpdateRouteGroupDto,
  UpdateSubjectDto,
  UpdateTenantDto,
} from './dto/admin.dto.js';

/** Modifier ops whose `value` is a µcredit amount (vs. a whole-percent int). */
const CREDIT_VALUE_OPS = new Set(['flat_off', 'override_rate']);

/**
 * Map a channel's `provider_type` onto the official-catalog `provider` key the
 * sync matcher looks up against (Track 2; spec D7). Subscription/relay
 * provider-types resolve to their underlying API provider so codex/openai both
 * price off the `openai` catalog. An unlisted provider_type is used verbatim.
 */
const PROVIDER_TYPE_TO_CATALOG: Readonly<Record<string, string>> = {
  'codex-oauth': 'openai',
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'google',
};

/** Resolve the official-catalog provider for a channel `provider_type` (default = verbatim). */
function catalogProviderFor(providerType: string): string {
  return PROVIDER_TYPE_TO_CATALOG[providerType] ?? providerType;
}

/**
 * Convert a HUMAN USD-per-1M-tokens amount (e.g. `1.25`) to an integer µUSD/1M
 * = `round(usd × 1_000_000)` (the official-price boundary conversion; mirrors
 * `creditsToMicro`'s `round(x × 1e6)` style — `1 USD = 1_000_000 µUSD`).
 */
function usdPer1mToMicro(usd: number): bigint {
  return BigInt(Math.round(usd * 1_000_000));
}

/** Postgres SQLSTATE for a unique-constraint violation (`unique_violation`). */
const PG_UNIQUE_VIOLATION = '23505';

/** The nil UUID — a sentinel "no real group" id for the create-side fallback walk. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * True iff `err` (or any error in its `cause` chain) is a Postgres
 * unique-constraint violation (SQLSTATE `23505`). Used to turn a colliding text
 * PK (`resource.id`, `redemption_code.code`) — which can't be made a partial
 * unique index — into a clean 4xx instead of a 500. The SQLSTATE `code` lives on
 * the postgres-js `PostgresError`, but drizzle may wrap that in a
 * `DrizzleQueryError` (which only exposes it via `.cause`), so we walk the chain.
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

/** Reject a sealed codex login `state` older than this — the round-trip is prompt. */
const CODEX_STATE_TTL_MS = 10 * 60_000;

/** The OAuth-session view returned by both the paste-auth and login paths (NO tokens). */
interface OAuthSessionView {
  id: string;
  providerKind: string;
  accountLabel?: string;
  accountId?: string;
}

/** The fields a successful token acquisition contributes to a persisted session. */
interface OAuthSessionInputs {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  idToken?: string | undefined;
  /** An explicit account-id override (the paste path supplies this). */
  accountId?: string | undefined;
  /** An explicit label override (paste path: `account_label`/`email`; login: `accountLabel`). */
  accountLabel?: string | undefined;
}

/** The atomic result of {@link AdminService.provision}: tenant + account + one-time key. */
export interface ProvisionResult {
  tenant: TenantRow;
  account: AccountRow;
  apiKey: CreatedApiKey;
}

/**
 * A breaker status row ({@link BreakerStatusRow}, the PG FSM state joined with its
 * channel) enriched with the recent-window `failureRate` (%) read live from Redis
 * for `GET /admin/breakers` (弹性2.0, spec §⑤). `null` when the window can't be
 * read (Redis miss/outage, or no breaker store wired).
 */
export type BreakerStatusWithRate = BreakerStatusRow & { failureRate: number | null };

/** The partial-success result of a bulk admin action (前端打磨). */
export interface BulkResult {
  succeeded: string[];
  failed: { id: string; error: string }[];
}

/**
 * Apply a per-id mutation across `ids`, collecting PARTIAL success. Each id runs
 * its own try/catch — a throwing `perId` lands that id in `failed` (with the
 * error message) and NEVER aborts the rest of the batch. Ids are processed
 * sequentially so a failing op can't race the others.
 */
async function bulkApply(ids: string[], perId: (id: string) => Promise<void>): Promise<BulkResult> {
  const succeeded: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const id of ids) {
    try {
      await perId(id);
      succeeded.push(id);
    } catch (e) {
      failed.push({ id, error: e instanceof Error ? e.message : 'failed' });
    }
  }
  return { succeeded, failed };
}

/** Neutral, no-auth 204 endpoint a proxy probe fetches to prove reachability. */
const DEFAULT_PROXY_PROBE_URL = 'https://www.gstatic.com/generate_204';

/** Redact `scheme://user:pass@` credentials from a proxy probe error before persisting it. */
function sanitizeProxyError(message: string): string {
  return message.replace(/:\/\/[^/@\s]+@/g, '://***@').slice(0, 500);
}

/**
 * The thin write/read layer behind the admin CRUD controllers. Owns the
 * dto→db-repo mapping and the credit→µcredit conversion at the boundary: every
 * human-credit input (account opening balance, topup, fixed pricebook amount,
 * credit-denominated modifier value) is converted via `creditsToMicro` here, so
 * the db only ever stores µcredits.
 */
@Injectable()
export class AdminService {
  private readonly http: HttpClient;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: AppEnv,
    // The engine's adapter registry + the chat relay's credential resolver, both
    // exported by the global DbModule — needed by the model-sync endpoint to call
    // the provider's `listModels` with a resolved per-channel credential/proxy.
    @Inject(ADAPTERS) private readonly adapters: AdapterRegistry,
    private readonly secrets: SecretResolver,
    // Best-effort audit writer (记录系统). The bulk endpoints emit ONE audit_log
    // row per affected entity through this so each entity's badge reflects the
    // change; a failed audit write never disturbs the bulk op.
    private readonly audit: AuditService,
    @Optional() @Inject(HTTP) http?: HttpClient,
    // The circuit breaker (弹性2.0) — read-only here, used to enrich the breaker
    // status surface with each `(channel, model)`'s recent-window failure_rate
    // (a Redis-only signal). Optional so unit tests that don't wire Redis still
    // construct the service; absent ⇒ failure_rate degrades to null.
    @Optional() @Inject(BREAKER) private readonly breaker?: BreakerStore,
  ) {
    // Default to a real fetch client so existing constructions/tests that don't
    // wire an HTTP provider keep working; the OAuth-login e2e overrides it.
    this.http = http ?? createHttpClient();
  }

  // ----- provider types + platform auto-ensure (模型接入 onboarding) -----

  /** The provider types every registered adapter serves — the real source for the channel provider dropdown. */
  listProviderTypes(): string[] {
    return [...new Set(this.adapters.providerTypes())].sort((a, b) => a.localeCompare(b));
  }

  /**
   * Reuse-or-create a platform (resource) for `(providerType, modality)` so the
   * 模型接入 channel-add flow never makes the operator hand-create one. Reuses the
   * newest live match; otherwise creates a fresh resource under the operator's
   * platform tenant (the newest existing resource's tenant) with a unique slug id
   * + sensible defaults. Throws when there is no tenant to own a new resource.
   */
  async ensureResource(dto: EnsureResourceDto): Promise<Resource> {
    const existing = await findResourceByProviderModality(this.db, dto.providerType, dto.modality);
    if (existing !== undefined) return existing;
    const tenantId = await anyResourceTenantId(this.db);
    if (tenantId === undefined) {
      throw engineInvalidInput('no platform tenant exists yet — create a platform manually first');
    }
    // Build a unique human-readable slug id (provider-modality, suffixed on collision).
    const base = `${dto.providerType}-${dto.modality}`;
    let id = base;
    for (let n = 2; (await getResource(this.db, id)) !== undefined; n++)
      id = `${base}-${String(n)}`;
    return createResource(this.db, {
      id,
      tenantId,
      kind: 'model',
      modality: dto.modality,
      providerType: dto.providerType,
      execModes: ['blocking'],
      ioSchema: {
        inputs: [{ key: 'prompt', type: 'string', required: true }],
        outputs: [{ key: 'text', type: 'string' }],
      },
      version: 1,
    });
  }

  // ----- tenants -----

  createTenant(dto: CreateTenantDto): Promise<TenantRow> {
    return createTenant(this.db, { name: dto.name, isolationMode: dto.isolationMode });
  }

  /**
   * Atomically provision a customer in ONE transaction: a tenant + its account
   * (optional opening balance, human credits → µcredits) + an API key. If any
   * step fails the whole thing rolls back, so an embedder never ends up with a
   * half-created tenant. The plaintext key is returned ONCE (never re-derivable).
   */
  provision(dto: ProvisionDto): Promise<ProvisionResult> {
    const creditBalance = dto.credits === undefined ? undefined : creditsToMicro(dto.credits);
    return this.db.transaction(async (tx) => {
      const tenant = await createTenant(tx, { name: dto.name, isolationMode: dto.isolationMode });
      const account = await createAccount(tx, { tenantId: tenant.id, creditBalance });
      const apiKey = await createApiKey(tx, {
        tenantId: tenant.id,
        resourceAllowlist: dto.resourceAllowlist,
        rateLimit: dto.rateLimit,
      });
      return { tenant, account, apiKey };
    });
  }

  listTenants(page: PageParams): Promise<KeysetResult<TenantRow>> {
    return listTenants(this.db, page);
  }

  /** Fetch one tenant by id, or `resource_not_found` (404) when absent/soft-deleted. */
  async getTenant(tenantId: string): Promise<TenantRow> {
    const row = await getTenant(this.db, tenantId);
    if (row === undefined) {
      throw engineNotFound(`tenant ${tenantId} not found`);
    }
    return row;
  }

  /** Patch a tenant's `isolationMode` (the only mutable field); 404 when absent. */
  async updateTenant(tenantId: string, dto: UpdateTenantDto): Promise<TenantRow> {
    const row = await updateTenant(this.db, tenantId, { isolationMode: dto.isolationMode });
    if (row === undefined) {
      throw engineNotFound(`tenant ${tenantId} not found`);
    }
    return row;
  }

  // ----- tenant subjects (end-users; unified tenancy G-A) -----

  /** Create a subject under a tenant (404 if the tenant is absent/soft-deleted). */
  async createSubject(tenantId: string, dto: CreateSubjectDto): Promise<SubjectRow> {
    await this.getTenant(tenantId);
    return createSubject(this.db, {
      tenantId,
      externalId: dto.externalId,
      email: dto.email,
      displayName: dto.displayName,
      limitPlanId: dto.limitPlanId,
    });
  }

  /** List a tenant's live subjects, keyset-paginated. */
  listSubjects(tenantId: string, page: PageParams): Promise<KeysetResult<SubjectRow>> {
    return listSubjectsByTenant(this.db, tenantId, page);
  }

  /** Fetch one subject by id (tenant-scoped), or 404. */
  async getSubject(tenantId: string, id: string): Promise<SubjectRow> {
    const row = await getSubjectById(this.db, tenantId, id);
    if (row === undefined) throw engineNotFound(`subject ${id} not found`);
    return row;
  }

  /** Patch a subject (tenant-scoped); 404 when absent. `external_id` is immutable. */
  async updateSubject(tenantId: string, id: string, dto: UpdateSubjectDto): Promise<SubjectRow> {
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
   * Soft-delete a subject (tenant-scoped) + cascade (sweep sub-wallet → pool,
   * disable subject keys); 404 when absent (idempotent second call). Returns the
   * cascade summary for the audit record.
   */
  async deleteSubject(tenantId: string, id: string): Promise<SubjectDeleteResult> {
    const deleted = await softDeleteSubject(this.db, tenantId, id);
    if (deleted === undefined) throw engineNotFound(`subject ${id} not found`);
    return deleted;
  }

  // ----- subject sub-wallets (HARD mode; unified tenancy G-E) -----

  /** Open a HARD sub-wallet for a subject (404 if the subject isn't in the tenant). */
  async createSubAccount(
    tenantId: string,
    subjectId: string,
    dto: CreateSubAccountDto,
  ): Promise<SubAccountRow> {
    await this.getSubject(tenantId, subjectId);
    const creditBalance = dto.credits === undefined ? undefined : creditsToMicro(dto.credits);
    return createSubAccount(this.db, {
      tenantId,
      subjectId,
      ...(creditBalance !== undefined ? { creditBalance } : {}),
    });
  }

  /** The subject's sub-wallet (balance/held), or 404 when none. */
  async getSubAccount(tenantId: string, subjectId: string): Promise<SubAccountRow> {
    const sub = await getSubAccount(this.db, tenantId, subjectId);
    if (sub === undefined) throw engineNotFound(`sub-wallet for subject ${subjectId} not found`);
    return sub;
  }

  /** Credit a subject's sub-wallet (404 when none). Returns the new µcredit balance. */
  async topupSubAccount(
    tenantId: string,
    subjectId: string,
    dto: TopupSubAccountDto,
  ): Promise<bigint> {
    await this.getSubAccount(tenantId, subjectId);
    return topupSubAccount(this.db, tenantId, subjectId, creditsToMicro(dto.credits));
  }

  /** Transfer credits between the tenant pool and the subject's sub-wallet (404 when none). */
  async transferCredits(
    tenantId: string,
    subjectId: string,
    dto: TransferCreditsDto,
  ): Promise<void> {
    await this.getSubAccount(tenantId, subjectId);
    await transferCredits(this.db, {
      tenantId,
      subjectId,
      amount: creditsToMicro(dto.credits),
      direction: dto.direction,
    });
  }

  // ----- accounts -----

  createAccount(dto: CreateAccountDto): Promise<AccountRow> {
    const creditBalance = dto.credits === undefined ? undefined : creditsToMicro(dto.credits);
    return createAccount(this.db, { tenantId: dto.tenantId, creditBalance });
  }

  /** List accounts (balance/held view), keyset-paginated — read-only, like the per-id GET. */
  listAccounts(page: PageParams): Promise<KeysetResult<AccountRow>> {
    return listAccounts(this.db, page);
  }

  /**
   * Fetch one account's balance/held view by id, or `resource_not_found` (404).
   * There is intentionally NO account PATCH/DELETE: the balance/held only move via
   * the topup + ledger paths (`topUp`/`holdCredits`/`settle`), never a direct
   * write — an admin must not be able to set a balance out from under the ledger.
   */
  async getAccountById(accountId: string): Promise<AccountRow> {
    const row = await getAccount(this.db, accountId);
    if (row === undefined) {
      throw engineNotFound(`account ${accountId} not found`);
    }
    return row;
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

  /**
   * Mint a key; the plaintext is returned ONCE (only its hash is stored). An
   * optional `routeGroupId` binds the key to a route group (Track 3) — validated
   * to exist (a non-existent group → 404), then set in a follow-up
   * {@link setApiKeyGroup} (the mint repo does not take a group). Omitted → the
   * key is unbound (the `default` group resolves at routing time).
   */
  async createApiKey(dto: CreateApiKeyDto): Promise<CreatedApiKey> {
    if (dto.routeGroupId !== undefined) {
      await this.requireRouteGroup(dto.routeGroupId);
    }
    // A subject-scoped key (unified tenancy G-B): the subject must belong to the
    // same tenant (→ 404 otherwise), so a key can never be bound cross-tenant.
    if (dto.subjectId !== undefined) {
      const subj = await getSubjectById(this.db, dto.tenantId, dto.subjectId);
      if (subj === undefined) throw engineNotFound(`subject ${dto.subjectId} not found`);
    }
    const created = await createApiKey(this.db, {
      tenantId: dto.tenantId,
      resourceAllowlist: dto.resourceAllowlist,
      rateLimit: dto.rateLimit,
      subjectId: dto.subjectId,
    });
    if (dto.routeGroupId !== undefined) {
      await setApiKeyGroup(this.db, created.id, dto.routeGroupId);
    }
    return created;
  }

  /**
   * (Re)bind an API key to a route group (Track 3). A non-null `routeGroupId` is
   * validated to exist FIRST (→ 404 when unknown), then bound; `null` unbinds the
   * key (→ the `default` group resolves at routing time). Throws
   * `resource_not_found` (404) when the key id matches no live key.
   */
  async setApiKeyGroup(keyId: string, dto: UpdateApiKeyGroupDto): Promise<{ id: string }> {
    if (dto.routeGroupId !== null) {
      await this.requireRouteGroup(dto.routeGroupId);
    }
    const ok = await setApiKeyGroup(this.db, keyId, dto.routeGroupId);
    if (!ok) {
      throw engineNotFound(`api key ${keyId} not found`);
    }
    return { id: keyId };
  }

  /** Ensure a route group exists (live), or throw `resource_not_found` (404). */
  private async requireRouteGroup(groupId: string): Promise<RouteGroupRow> {
    const group = await getRouteGroupById(this.db, groupId);
    if (group === undefined) {
      throw engineNotFound(`route group ${groupId} not found`);
    }
    return group;
  }

  /**
   * Validate a proposed cross-group `fallbackGroupId` (弹性2.0). `null` clears the
   * fallback — always allowed. Otherwise the target must be a LIVE group (404 if
   * not), and following the resulting chain must neither loop back to `sourceId`
   * (a cycle, incl. a direct self-reference) nor exceed `FALLBACK_MAX_DEPTH`
   * groups — both mapped to a clean 400. For CREATE, pass a sentinel `sourceId`
   * that can't appear in the graph (a self-cycle is impossible without a real id).
   */
  private async validateFallbackGroup(
    sourceId: string,
    fallbackGroupId: string | null,
  ): Promise<void> {
    if (fallbackGroupId === null) return;
    await this.requireRouteGroup(fallbackGroupId);
    const verdict = await checkFallbackChain(
      sourceId,
      fallbackGroupId,
      async (id) => (await getRouteGroupById(this.db, id))?.fallbackGroupId ?? null,
    );
    if (verdict === 'cycle') {
      throw engineInvalidInput('fallback target would form a cycle');
    }
    if (verdict === 'too-deep') {
      throw engineInvalidInput('fallback chain would exceed the maximum depth');
    }
  }

  /** List a tenant's keys WITHOUT the hash (the plaintext is unrecoverable). */
  listApiKeys(tenantId: string, page: PageParams): Promise<KeysetResult<Omit<ApiKeyRow, 'hash'>>> {
    return listApiKeys(this.db, tenantId, page);
  }

  /**
   * Revoke (soft-delete) an API key by id. The {@link ApiKeyGuard} treats a
   * soft-deleted key as absent (its lookup filters `deleted_at IS NULL`), so the
   * SAME key is rejected with 401 afterwards. Throws `resource_not_found` (404)
   * when the id does not match a live key (already revoked / unknown).
   */
  async revokeApiKey(keyId: string): Promise<{ id: string }> {
    const id = await softDeleteApiKey(this.db, keyId);
    if (id === undefined) {
      throw engineNotFound(`api key ${keyId} not found`);
    }
    return { id };
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
    // Validate the key length here so a misconfigured key fails as a clear 400
    // rather than an opaque 500 from the crypto layer (the value never reaches it).
    if (Buffer.from(keyB64, 'base64').length !== 32) {
      throw engineInvalidInput('SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    }
    return createEncryptedSecret(this.db, { value: dto.value, label: dto.label, keyB64 });
  }

  /**
   * List credentials (secret_refs) for the operator view, METADATA ONLY. The
   * {@link listSecretRefs} repo selects only id/provider/locator/timestamps —
   * the `enc` ciphertext (in `secret_material`) is never joined — so a secret
   * VALUE can never leave the service via this path.
   */
  listSecrets(page: PageParams): Promise<KeysetResult<SecretRefView>> {
    return listSecretRefs(this.db, page);
  }

  /**
   * Fetch one credential's METADATA by id (never the material). Throws
   * `resource_not_found` (404) when the id does not match a live secret
   * (soft-deleted / unknown).
   */
  async getSecret(id: string): Promise<SecretRefView> {
    const row = await getSecretRefById(this.db, id);
    if (row === undefined) {
      throw engineNotFound(`secret ${id} not found`);
    }
    return row;
  }

  /**
   * Revoke (soft-delete) a credential by id. {@link resolveSecretRef} treats a
   * soft-deleted secret as absent (its `getSecretRef` deref filters
   * `deleted_at IS NULL`), so resolution returns `undefined` afterwards. Throws
   * `resource_not_found` (404) when the id does not match a live secret.
   */
  async revokeSecret(id: string): Promise<{ id: string }> {
    const deleted = await softDeleteSecretRef(this.db, id);
    if (deleted === undefined) {
      throw engineNotFound(`secret ${id} not found`);
    }
    return { id: deleted };
  }

  /**
   * Edit a credential's operator metadata (name/notes/group) ONLY — never the
   * material. Returns the refreshed metadata-only view. Throws `resource_not_found`
   * (404) when the id does not match a live secret.
   */
  async updateSecretMeta(
    id: string,
    meta: {
      name?: string | null | undefined;
      notes?: string | null | undefined;
      group?: string | null | undefined;
    },
  ): Promise<SecretRefView> {
    const updated = await updateSecretRefMeta(this.db, id, meta);
    if (updated === undefined) {
      throw engineNotFound(`secret ${id} not found`);
    }
    return updated;
  }

  // ----- oauth sessions (BYO subscription) -----

  /**
   * Register a BYO OAuth-subscription session from a pasted provider auth-json
   * (the operator ran the provider's OAuth on their own machine, opt-in). Gated
   * behind `ENABLE_OAUTH_CHANNELS` + the DTO's explicit ToS acknowledgement (the
   * `z.literal(true)` already rejects a missing/false ack as `invalid_input`).
   *
   * Both tokens are encrypted at rest by {@link createOAuthSession} and NEVER
   * returned or logged. The account id is derived from the `id_token` claims
   * (falling back to an explicit `account_id`); the label falls back to the
   * exported `email`. An `expiresAt` is computed from `expires_in` (or the
   * RFC3339 `expired` string), falling back to an already-expired timestamp when
   * both are absent so the refresh sweep always picks the session up.
   */
  async createOAuthSession(dto: CreateOAuthSessionDto): Promise<OAuthSessionView> {
    this.requireOAuthEnabled();
    const a = dto.authJson;
    // `expiresAt` is UNCONDITIONAL: when both `expires_in` and the RFC3339
    // `expired` are absent we fall back to an already-expired timestamp so the
    // refresh sweep claims the session on its next tick (a NULL `expires_at` is
    // filtered out by `listRefreshableSessions`, leaving the token unrecoverable).
    const expiresAt =
      a.expires_in !== undefined
        ? new Date(Date.now() + a.expires_in * 1000)
        : a.expired !== undefined
          ? new Date(a.expired)
          : new Date(0);
    // A malformed `expired` paste yields an `Invalid Date`; reject it cleanly as
    // `invalid_input` (400) rather than letting Drizzle's `.toISOString()` throw a 500.
    if (Number.isNaN(expiresAt.getTime())) {
      throw engineInvalidInput('authJson.expired is not a valid date');
    }
    return this.persistOAuthSession(dto.providerKind, {
      accessToken: a.access_token,
      refreshToken: a.refresh_token,
      expiresAt,
      idToken: a.id_token,
      accountId: a.account_id,
      accountLabel: a.account_label ?? a.email,
    });
  }

  /**
   * List every registered OAuth-subscription session for the operator view,
   * token-free. Gated behind `ENABLE_OAUTH_CHANNELS` (mirroring the create
   * path), but does NOT require `SECRET_ENCRYPTION_KEY` — nothing is decrypted.
   * The {@link listOAuthSessions} repo never selects the ciphertext columns, so
   * the access/refresh tokens NEVER reach this layer; the snake_case view maps
   * only the metadata fields.
   */
  listOAuthSessions(page: PageParams): Promise<KeysetResult<OAuthSessionListRow>> {
    if (this.env.ENABLE_OAUTH_CHANNELS !== true) {
      throw engineInvalidInput('oauth channels are disabled (set ENABLE_OAUTH_CHANNELS)');
    }
    return listOAuthSessions(this.db, page);
  }

  /**
   * Revoke (soft-delete) a registered OAuth-subscription session by its
   * `secret_ref` id. Soft-deletes both the `oauth_session` and its owning
   * `secret_ref` so {@link resolveSecretRef} returns `undefined` (the oauth
   * branch derefs through {@link getOAuthSession}, which filters `deleted_at`)
   * and the credential drops out of every listing. NOT gated on
   * `ENABLE_OAUTH_CHANNELS` — revoking a credential must always be possible
   * (a security operation), even if the feature was later disabled. Throws
   * `resource_not_found` (404) when the id does not match a live session.
   */
  async revokeOAuthSession(secretRefId: string): Promise<{ id: string }> {
    const id = await softDeleteOAuthSession(this.db, secretRefId);
    if (id === undefined) {
      throw engineNotFound(`oauth session ${secretRefId} not found`);
    }
    return { id };
  }

  /**
   * Edit an OAuth session's operator metadata (name/notes/group) ONLY — never the
   * token material. Returns the refreshed token-free list row. Throws
   * `resource_not_found` (404) when the id does not match a live session.
   */
  async updateOAuthSessionMeta(
    secretRefId: string,
    meta: {
      name?: string | null | undefined;
      notes?: string | null | undefined;
      group?: string | null | undefined;
    },
  ): Promise<OAuthSessionListRow> {
    const row = await updateOAuthSessionMeta(this.db, secretRefId, meta);
    if (row === undefined) {
      throw engineNotFound(`oauth session ${secretRefId} not found`);
    }
    return row;
  }

  // ----- icon catalog (selectable brand icons) -----

  /** The seeded selectable icon catalog (plugin/channel/model icon picker). */
  listIcons(): Promise<IconAssetRow[]> {
    return listIconAssets(this.db);
  }

  /** Every channel bound to a plugin (across resources) — 模型接入 3-pane middle column. */
  listPluginChannels(pluginId: string): Promise<UpstreamChannelRow[]> {
    return listChannelsByPlugin(this.db, pluginId);
  }

  // ----- provider plugins (P2) -----

  listPlugins(): Promise<ProviderPluginRow[]> {
    return listPlugins(this.db);
  }

  /** Per-plugin live channel + distinct-model counts (模型接入 card stats). */
  pluginCounts(): Promise<Map<string, PluginCounts>> {
    return countByPlugin(this.db);
  }

  // ----- governance limits (额度套餐) -----

  private ruleInputs(rules: CreateLimitPlanDto['rules']): LimitRuleInput[] {
    return rules.map((r) => ({
      dimension: r.dimension,
      period: r.period ?? null,
      cap: BigInt(r.cap),
      modelScope: r.modelScope ?? null,
      alertPct: r.alertPct ?? null,
      enforce: 'hard',
    }));
  }

  async listLimitPlans(): Promise<
    { plan: LimitPlanRow; rules: LimitRuleRow[]; bindings: { keys: number; tenants: number } }[]
  > {
    const plans = await listLimitPlans(this.db);
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

  async getLimitPlan(id: string): Promise<{
    plan: LimitPlanRow;
    rules: LimitRuleRow[];
    bindings: { keys: number; tenants: number };
  }> {
    const plan = await getLimitPlanById(this.db, id);
    if (plan === undefined) throw engineNotFound(`limit plan ${id} not found`);
    const rules = await listRulesByPlan(this.db, id);
    const bindings = (await countPlanBindings(this.db, [id])).get(id) ?? { keys: 0, tenants: 0 };
    return { plan, rules, bindings };
  }

  async createLimitPlan(dto: CreateLimitPlanDto): Promise<{
    plan: LimitPlanRow;
    rules: LimitRuleRow[];
    bindings: { keys: number; tenants: number };
  }> {
    return this.db.transaction(async (tx) => {
      const plan = await createLimitPlan(tx, {
        name: dto.name,
        description: dto.description ?? null,
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      });
      const rules = await replacePlanRules(tx, plan.id, this.ruleInputs(dto.rules));
      return { plan, rules, bindings: { keys: 0, tenants: 0 } };
    });
  }

  async updateLimitPlan(
    id: string,
    dto: UpdateLimitPlanDto,
  ): Promise<{
    plan: LimitPlanRow;
    rules: LimitRuleRow[];
    bindings: { keys: number; tenants: number };
  }> {
    return this.db.transaction(async (tx) => {
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

  async deleteLimitPlan(id: string): Promise<void> {
    const deleted = await softDeleteLimitPlan(this.db, id);
    if (deleted === undefined) throw engineNotFound(`limit plan ${id} not found`);
  }

  listLimitUsage(subjectType: string, subjectId: string): Promise<LimitUsageRow[]> {
    return listUsageForSubject(this.db, subjectType, subjectId);
  }

  /** Effective rules paired with current usage for a subject's bound plan (usage bars). */
  limitStatus(
    subjectType: 'key' | 'tenant' | 'subject',
    subjectId: string,
    planId: string | null,
  ): Promise<LimitRuleStatus[]> {
    return limitRuleStatus(this.db, subjectType, subjectId, planId);
  }

  listLimitAlerts(): Promise<LimitAlertRow[]> {
    return listLimitAlerts(this.db);
  }

  // ----- records (审计日志 + reconcile) -----

  listAuditLog(filter: AuditLogFilter, page: PageParams): Promise<KeysetResult<AuditLogRow>> {
    return listAuditLog(this.db, filter, page);
  }

  reconcile(tenantId: string): Promise<ReconcileRow[]> {
    return reconcileTenant(this.db, tenantId);
  }

  async setApiKeyLimitPlan(apiKeyId: string, planId: string | null): Promise<void> {
    const ok = await setApiKeyLimitPlan(this.db, apiKeyId, planId);
    if (!ok) throw engineNotFound(`api key ${apiKeyId} not found`);
  }

  async setTenantLimitPlan(tenantId: string, planId: string | null): Promise<void> {
    const ok = await setTenantLimitPlan(this.db, tenantId, planId);
    if (!ok) throw engineNotFound(`tenant ${tenantId} account not found`);
  }

  createPlugin(dto: CreatePluginRequest): Promise<ProviderPluginRow> {
    return createPlugin(this.db, {
      slug: dto.slug,
      label: dto.label,
      modalities: dto.manifest.modalities,
      protocol: dto.manifest.protocol,
      authStrategy: dto.manifest.authStrategy,
      manifest: dto.manifest,
      handler: dto.handler,
      ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
    });
  }

  async updatePlugin(id: string, dto: UpdatePluginRequest): Promise<ProviderPluginRow> {
    const row = await updatePlugin(this.db, id, {
      ...(dto.label !== undefined ? { label: dto.label } : {}),
      ...(dto.manifest !== undefined
        ? {
            manifest: dto.manifest,
            modalities: dto.manifest.modalities,
            protocol: dto.manifest.protocol,
            authStrategy: dto.manifest.authStrategy,
          }
        : {}),
      ...(dto.handler !== undefined ? { handler: dto.handler } : {}),
      ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
    });
    if (row === undefined) throw engineNotFound(`plugin ${id} not found`);
    return row;
  }

  async deletePlugin(id: string): Promise<void> {
    const row = await getPluginById(this.db, id);
    if (row === undefined) throw engineNotFound(`plugin ${id} not found`);
    if (row.builtin) throw engineInvalidInput('built-in plugins cannot be deleted');
    await softDeletePlugin(this.db, id);
  }

  /**
   * Run ONE handler fn in the QuickJS sandbox with a sample argument (operator
   * test panel). A sandbox throw/timeout/non-JSON is returned as `{ok:false}` —
   * never a 500 — so the panel renders the error inline.
   */
  async testPlugin(dto: TestPluginRequest): Promise<TestPluginResponse> {
    try {
      const result = await runHandler(dto.handler, dto.fn, dto.arg);
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof SandboxError ? err.message : 'handler failed';
      return { ok: false, error: message };
    }
  }

  /**
   * Begin the turnkey server-side codex OAuth login. The explicit ToS ack is
   * enforced by the controller's `codexLoginStartSchema` (`z.literal(true)`)
   * before we get here. Generates a PKCE pair and SEALS the verifier into the
   * OAuth `state` by encrypting it with the master key (so the two endpoints
   * share NO server state — multi-replica safe — and the ciphertext is an
   * unguessable CSRF token). Returns the `authorize_url` the operator opens plus
   * the sealed `state` to echo back to `.../complete`.
   */
  startCodexLogin(): { authorize_url: string; state: string } {
    const keyB64 = this.requireOAuthEnabled();
    const { verifier, challenge } = generateCodexPkce();
    const state = encryptSecret(JSON.stringify({ v: verifier, t: Date.now() }), keyB64);
    const authorize_url = buildCodexAuthorizeUrl({ state, codeChallenge: challenge });
    return { authorize_url, state };
  }

  /**
   * Finish the codex login: unseal the PKCE verifier from `state`, exchange the
   * authorization `code` for tokens, and persist them (encrypted at rest, never
   * returned). Any decrypt/parse/staleness failure on `state`, and any code
   * rejection from upstream, surfaces as a clean `invalid_input` (400) — never a
   * 500. The tokens themselves are never logged or echoed.
   */
  async completeCodexLogin(dto: CodexLoginComplete): Promise<OAuthSessionView> {
    const keyB64 = this.requireOAuthEnabled();
    const codeVerifier = this.unsealCodexState(dto.state, keyB64);
    let tokens;
    try {
      // SECURITY: `this.http` MUST stay an untraced FetchHttpClient — the code-exchange
      // response carries access/refresh tokens; a RELAY_TRACE-wrapped client would
      // persist them at rest in relay_trace.
      tokens = await exchangeCodexCode(this.http, { code: dto.code, codeVerifier }, new Date());
    } catch (err) {
      if (err instanceof CodexAuthError) {
        // terminal (bad/dead code) and transient (429) both fail the login here;
        // a clean 400 keeps the master key + verifier off the error path.
        throw engineInvalidInput('codex authorization failed');
      }
      throw err;
    }
    return this.persistOAuthSession('codex-oauth', {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      idToken: tokens.idToken,
      accountLabel: dto.accountLabel,
    });
  }

  /** The shared gate both oauth paths run: env flag + a present, 32-byte master key. */
  private requireOAuthEnabled(): string {
    if (this.env.ENABLE_OAUTH_CHANNELS !== true) {
      throw engineInvalidInput('oauth channels are disabled (set ENABLE_OAUTH_CHANNELS)');
    }
    const keyB64 = this.env.SECRET_ENCRYPTION_KEY;
    if (keyB64 === undefined || keyB64 === '') {
      throw engineInvalidInput('SECRET_ENCRYPTION_KEY is not configured');
    }
    return keyB64;
  }

  /**
   * Recover the PKCE `code_verifier` sealed into a login `state` by
   * {@link startCodexLogin}. Any decrypt/parse/shape failure, or a state older
   * than {@link CODEX_STATE_TTL_MS}, throws `invalid_input` — never a 500 (the
   * thrown message carries no key/verifier material).
   */
  private unsealCodexState(state: string, keyB64: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(decryptSecret(state, keyB64));
    } catch {
      throw engineInvalidInput('invalid login state');
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { v?: unknown }).v !== 'string' ||
      typeof (parsed as { t?: unknown }).t !== 'number'
    ) {
      throw engineInvalidInput('invalid login state');
    }
    const { v, t } = parsed as { v: string; t: number };
    if (Date.now() - t >= CODEX_STATE_TTL_MS) {
      throw engineInvalidInput('login state expired');
    }
    return v;
  }

  /**
   * The shared persistence both oauth paths reach: derive the account id/label
   * from an optional id_token (overridable), encrypt + insert the tokens via
   * {@link createOAuthSession}, and return the token-free view. The `expiresAt`
   * is passed UNCONDITIONALLY (the callers compute the fallback).
   */
  private async persistOAuthSession(
    providerKind: string,
    s: OAuthSessionInputs,
  ): Promise<OAuthSessionView> {
    const keyB64 = this.requireOAuthEnabled();
    const identity = s.idToken !== undefined ? parseChatgptIdentity(s.idToken) : {};
    const accountId = s.accountId ?? identity.accountId;
    const accountLabel = s.accountLabel ?? identity.email;
    const input: CreateOAuthSessionInput = {
      providerKind,
      accessToken: s.accessToken,
      refreshToken: s.refreshToken,
      keyB64,
      expiresAt: s.expiresAt,
      ...(accountId !== undefined ? { accountId } : {}),
      ...(accountLabel !== undefined ? { accountLabel } : {}),
    };
    const row = await createOAuthSession(this.db, input);
    return {
      id: row.id,
      providerKind,
      ...(accountLabel !== undefined ? { accountLabel } : {}),
      ...(accountId !== undefined ? { accountId } : {}),
    };
  }

  // ----- resources -----

  async createResource(dto: CreateResourceDto): Promise<Resource> {
    try {
      return await createResource(this.db, {
        id: dto.id,
        tenantId: dto.tenantId,
        kind: dto.kind,
        modality: dto.modality,
        providerType: dto.providerType,
        execModes: dto.execModes,
        ioSchema: dto.ioSchema,
        version: dto.version ?? 1,
      });
    } catch (err) {
      // The text PK (`resource.id`) and `(resource_id, version)` can't be partial
      // unique indexes, so a re-create that collides (e.g. re-POSTing the same id
      // + version, or an id still occupied by a soft-deleted row) surfaces as a
      // Postgres 23505. Map it to a clean 400 instead of a 500. We do NOT revive
      // the soft-deleted row — the operator must pick a fresh id.
      if (isUniqueViolation(err)) {
        throw engineInvalidInput(`resource '${dto.id}' already exists`);
      }
      throw err;
    }
  }

  listResources(page: PageParams): Promise<KeysetResult<Resource>> {
    return listResources(this.db, page);
  }

  /** Fetch one resource by id, or `resource_not_found` (404) when absent/soft-deleted. */
  async getResource(resourceId: string): Promise<Resource> {
    const row = await getResource(this.db, resourceId);
    if (row === undefined) {
      throw engineNotFound(`resource ${resourceId} not found`);
    }
    return row;
  }

  /**
   * Patch a resource's SAFE fields (only `status`). The key fields
   * (`id`/`kind`/`modality`/`providerType`) are immutable. 404 when absent.
   */
  async updateResource(resourceId: string, dto: UpdateResourceDto): Promise<Resource> {
    const row = await updateResource(this.db, resourceId, { status: dto.status });
    if (row === undefined) {
      throw engineNotFound(`resource ${resourceId} not found`);
    }
    return row;
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
      // HUMAN USD/1M cost rates → integer µUSD/1M (Track 5); omitted → null.
      ...(dto.inputCostUsdPer1m !== undefined
        ? { inputCostPer1m: usdPer1mToMicro(dto.inputCostUsdPer1m) }
        : {}),
      ...(dto.outputCostUsdPer1m !== undefined
        ? { outputCostPer1m: usdPer1mToMicro(dto.outputCostUsdPer1m) }
        : {}),
      ...(dto.faultPolicyId !== undefined ? { faultPolicyId: dto.faultPolicyId } : {}),
      ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
      ...(dto.pluginId !== undefined ? { pluginId: dto.pluginId } : {}),
      ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
    });
  }

  /** List every channel of a resource (incl. disabled) — operator routing view. */
  listResourceChannels(
    resourceId: string,
    page: PageParams,
  ): Promise<KeysetResult<UpstreamChannelRow>> {
    return listChannelsForResource(this.db, resourceId, page);
  }

  /**
   * Patch an upstream channel's routing fields (weight/status/endpoint/model/...)
   * + the Track-5 per-channel cost rates. The HUMAN USD/1M cost fields are
   * converted to integer µUSD/1M here (mirroring the create path); passing `null`
   * CLEARS a cost column (→ unknown cost / 0). All other fields pass through.
   */
  async updateChannel(channelId: string, dto: UpdateChannelDto): Promise<UpstreamChannelRow> {
    const patch: {
      -readonly [K in keyof UpdateUpstreamChannelInput]: UpdateUpstreamChannelInput[K];
    } = {};
    if (dto.credentialRef !== undefined) patch.credentialRef = dto.credentialRef;
    if (dto.endpoint !== undefined) patch.endpoint = dto.endpoint;
    if (dto.model !== undefined) patch.model = dto.model;
    if (dto.proxyRef !== undefined) patch.proxyRef = dto.proxyRef;
    if (dto.config !== undefined) patch.config = dto.config;
    if (dto.weight !== undefined) patch.weight = dto.weight;
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.inputCostUsdPer1m !== undefined) {
      patch.inputCostPer1m =
        dto.inputCostUsdPer1m === null ? null : usdPer1mToMicro(dto.inputCostUsdPer1m);
    }
    if (dto.outputCostUsdPer1m !== undefined) {
      patch.outputCostPer1m =
        dto.outputCostUsdPer1m === null ? null : usdPer1mToMicro(dto.outputCostUsdPer1m);
    }
    if (dto.faultPolicyId !== undefined) patch.faultPolicyId = dto.faultPolicyId;
    if (dto.icon !== undefined) patch.icon = dto.icon;
    if (dto.pluginId !== undefined) patch.pluginId = dto.pluginId;
    if (dto.tags !== undefined) patch.tags = dto.tags;
    const row = await updateUpstreamChannel(this.db, channelId, patch);
    if (row === undefined) {
      throw engineNotFound(`channel ${channelId} not found`);
    }
    return row;
  }

  /**
   * Fetch one channel scoped to its resource (the nested route), or
   * `resource_not_found` (404) when the channel is absent / soft-deleted / does
   * not belong to `resourceId`.
   */
  async getChannel(resourceId: string, channelId: string): Promise<UpstreamChannelRow> {
    const row = await getChannelById(this.db, channelId, resourceId);
    if (row === undefined) {
      throw engineNotFound(`channel ${channelId} not found for resource ${resourceId}`);
    }
    return row;
  }

  /**
   * Revoke (soft-delete) a channel scoped to its resource. Routing
   * (`listChannels`) and the operator listing both filter soft-deleted, so the
   * channel drops out immediately. 404 when no live channel matched (already
   * deleted / wrong resource / unknown).
   */
  async deleteChannel(resourceId: string, channelId: string): Promise<{ id: string }> {
    const id = await softDeleteChannel(this.db, channelId, resourceId);
    if (id === undefined) {
      throw engineNotFound(`channel ${channelId} not found for resource ${resourceId}`);
    }
    // Drop this channel's model links (pure join data — no reason to keep them
    // once the channel is gone; also keeps model_count / routing correct).
    await unlinkAllForChannel(this.db, channelId);
    return { id };
  }

  // --- channel↔model links (catalog supply-hierarchy) -----------------------

  /** Per-channel link counts (batch) for populating `model_count` in channel views. */
  async modelCountsByChannels(channelIds: string[]): Promise<Map<string, number>> {
    return countModelsByChannelIds(this.db, channelIds);
  }

  /** Served-channel ids (batch) for populating `served_channel_ids` in model views. */
  async servedChannelsByModels(modelIds: string[]): Promise<Map<string, string[]>> {
    return channelIdsByModelIds(this.db, modelIds);
  }

  /** The models a channel serves (right-panel grid); 404s if the channel ∉ resource. */
  async listChannelModels(resourceId: string, channelId: string): Promise<ModelRow[]> {
    await this.getChannel(resourceId, channelId);
    return listChannelModels(this.db, channelId);
  }

  /** Link an existing platform model to a channel; validates the channel + same-platform model. */
  async linkChannelModel(resourceId: string, channelId: string, modelId: string): Promise<void> {
    await this.getChannel(resourceId, channelId);
    const m = await getModelById(this.db, modelId);
    if (m?.resourceId !== resourceId) {
      throw engineInvalidInput('model must belong to the same platform as the channel');
    }
    await linkChannelModel(this.db, channelId, modelId);
  }

  /** Remove a channel↔model link; 404s if the channel ∉ resource. */
  async unlinkChannelModel(resourceId: string, channelId: string, modelId: string): Promise<void> {
    await this.getChannel(resourceId, channelId);
    await unlinkChannelModel(this.db, channelId, modelId);
  }

  /**
   * Sync the upstream models a channel's provider exposes into `model` rows
   * (multi-model routing + Track 2 auto-pricing). Loads the channel (verifying it
   * belongs to `resourceId`), resolves the provider adapter, and — if it supports
   * model discovery (`listModels`) — calls it with an {@link AdapterContext} built
   * the SAME way the chat relay/engine does (per-channel model/endpoint/config, the
   * credential resolved via the shared {@link SecretResolver} incl. its `oauth`
   * branch, the egress proxy resolved from `proxyRef` with the global
   * `UPSTREAM_PROXY_URL` fallback).
   *
   * Each upstream slug becomes a `model` row via {@link upsertModelsFromSync},
   * AUTO-PRICED against the {@link officialModelPrice} catalog under the
   * channel's catalog provider ({@link catalogProviderFor}):
   * - matched → priced from the official µUSD/1M row, `active`;
   * - unmatched → `disabled` + `needs_pricing` (NEVER billable at 0) — UNLESS the
   *   request supplies explicit `defaultInputPrice`/`defaultOutputPrice` (µUSD/1M),
   *   in which case the unmatched model is created `active` at those prices;
   * - existing → price/status preserved (display + capabilities refreshed).
   *
   * Returns the created/updated names, the total, and a per-model
   * `priced: official|default|needs_pricing|existing` summary.
   */
  async syncChannelModels(
    resourceId: string,
    channelId: string,
    dto: SyncChannelModelsDto,
  ): Promise<{
    resource_id: string;
    created: string[];
    updated: string[];
    total: number;
    summary: { name: string; priced: string }[];
  }> {
    // Load the channel and verify it belongs to this resource (else not_found).
    // A resource has few channels; a generous page bounds the scan without a
    // dedicated single-channel getter (a Track D concern).
    const { rows: channels } = await listChannelsForResource(this.db, resourceId, { limit: 200 });
    const channel = channels.find((c) => c.id === channelId);
    if (channel === undefined) {
      throw engineNotFound(`channel ${channelId} not found for resource ${resourceId}`);
    }

    // Resolve the provider adapter; reject providers without model discovery.
    const adapter = this.adapters.get(channel.providerType);
    if (adapter.listModels === undefined) {
      throw engineInvalidInput(`provider ${channel.providerType} does not support model sync`);
    }

    const ctx = await this.buildSyncContext(channel);
    const models = await adapter.listModels(ctx);

    const result = await upsertModelsFromSync(this.db, {
      resourceId,
      provider: catalogProviderFor(channel.providerType),
      models: models.map((m) => ({
        name: m.id,
        display: m.displayName,
        capabilities: m.capabilities,
      })),
      // Explicit unmatched-default override (µUSD/1M). When omitted, an unmatched
      // model becomes `needs_pricing`+disabled rather than billing at 0.
      ...(dto.defaultInputPrice !== undefined
        ? { defaultInputPrice: BigInt(dto.defaultInputPrice) }
        : {}),
      ...(dto.defaultOutputPrice !== undefined
        ? { defaultOutputPrice: BigInt(dto.defaultOutputPrice) }
        : {}),
    });

    // Catalog supply-hierarchy: a synced channel now OWNS the models it
    // discovered — link them so they show in its model grid + route preferentially.
    await linkChannelModelsByNames(this.db, channelId, [...result.created, ...result.updated]);

    return {
      resource_id: resourceId,
      created: result.created,
      updated: result.updated,
      total: result.created.length + result.updated.length,
      summary: result.summary.map((s) => ({ name: s.name, priced: s.priced })),
    };
  }

  /**
   * Build the {@link AdapterContext} for a channel's `listModels` call, mirroring
   * the engine's `buildContext`/`resolveProxy`: the credential is resolved via the
   * shared {@link SecretResolver} (so the `oauth` branch returns the live access
   * token), the egress proxy comes from `proxyRef` (falling back to the global
   * `UPSTREAM_PROXY_URL`), and each optional field is assigned only when present
   * (exactOptionalPropertyTypes).
   */
  private async buildSyncContext(channel: UpstreamChannelRow): Promise<AdapterContext> {
    const ctx: AdapterContext = { providerType: channel.providerType, http: this.http };
    if (channel.model !== null) ctx.model = channel.model;
    if (channel.endpoint !== null) ctx.endpoint = channel.endpoint;
    if (channel.config !== null) ctx.config = channel.config;
    if (channel.credentialRef !== null) {
      const apiKey = await this.secrets.resolve(channel.credentialRef);
      if (apiKey !== undefined) ctx.apiKey = apiKey;
    }
    const proxyUrl = await this.resolveChannelProxy(channel);
    if (proxyUrl !== undefined) ctx.proxyUrl = proxyUrl;
    return ctx;
  }

  /** Resolve a channel's egress proxy: its `proxyRef` (via the resolver), else `UPSTREAM_PROXY_URL`. */
  private async resolveChannelProxy(channel: UpstreamChannelRow): Promise<string | undefined> {
    if (channel.proxyRef !== null) {
      const url = await this.secrets.resolve(channel.proxyRef);
      if (url !== undefined) return url;
    }
    return this.env.UPSTREAM_PROXY_URL;
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

  listPricebook(resourceId: string, page: PageParams): Promise<KeysetResult<PricebookEntryRow>> {
    return listPricebookEntries(this.db, resourceId, page);
  }

  /** Fetch one pricebook entry by id, or `resource_not_found` (404) when absent. */
  async getPricebook(id: string): Promise<PricebookEntryRow> {
    const row = await getPricebookEntryById(this.db, id);
    if (row === undefined) {
      throw engineNotFound(`pricebook entry ${id} not found`);
    }
    return row;
  }

  /**
   * Patch a pricebook entry. Mirrors the create path's credit→µcredit conversion:
   * a human-credit `fixedCredits` is converted and merged into the persisted
   * `spec` as a µcredit `amount`. The EFFECTIVE method (the patched `method` if
   * present, else the entry's stored one) decides whether `fixedCredits` is
   * valid (`fixed` only). 404 when the entry is absent / soft-deleted.
   */
  async updatePricebook(id: string, dto: UpdatePricebookDto): Promise<PricebookEntryRow> {
    const existing = await getPricebookEntryById(this.db, id);
    if (existing === undefined) {
      throw engineNotFound(`pricebook entry ${id} not found`);
    }
    const patch: {
      method?: string;
      timing?: string;
      spec?: unknown;
      markup?: unknown;
      active?: boolean;
    } = {};
    if (dto.method !== undefined) patch.method = dto.method;
    if (dto.timing !== undefined) patch.timing = dto.timing;
    if (dto.markup !== undefined) patch.markup = dto.markup;
    if (dto.active !== undefined) patch.active = dto.active;
    // The spec is rebuilt only when the caller sends a `spec` or a `fixedCredits`;
    // an omitted-both PATCH leaves the stored spec untouched.
    if (dto.spec !== undefined || dto.fixedCredits !== undefined) {
      patch.spec = this.buildUpdatePricebookSpec(dto, existing.method);
    }
    const row = await updatePricebookEntry(this.db, id, patch);
    if (row === undefined) {
      throw engineNotFound(`pricebook entry ${id} not found`);
    }
    return row;
  }

  /**
   * Build the patched `spec`, applying the SAME credit→µcredit conversion as
   * {@link buildPricebookSpec}. Validates `fixedCredits` against the EFFECTIVE
   * method (the patched one, else the stored `currentMethod`).
   */
  private buildUpdatePricebookSpec(dto: UpdatePricebookDto, currentMethod: string): unknown {
    if (dto.fixedCredits === undefined) {
      return dto.spec ?? {};
    }
    const effectiveMethod = dto.method ?? currentMethod;
    if (effectiveMethod !== 'fixed') {
      throw engineInvalidInput('fixedCredits is only valid for method "fixed"');
    }
    const base = isRecord(dto.spec) ? dto.spec : {};
    return { method: 'fixed', ...base, amount: creditsToMicro(dto.fixedCredits).toString() };
  }

  /** Revoke (soft-delete) a pricebook entry; 404 when no live entry matched. */
  async deletePricebook(id: string): Promise<{ id: string }> {
    const deleted = await softDeletePricebookEntry(this.db, id);
    if (deleted === undefined) {
      throw engineNotFound(`pricebook entry ${id} not found`);
    }
    return { id: deleted };
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

  private modifierValue(dto: CreateModifierDto): bigint {
    // `value` is required by createModifierSchema (every op needs one).
    return CREDIT_VALUE_OPS.has(dto.op) ? creditsToMicro(dto.value) : BigInt(Math.round(dto.value));
  }

  listModifiers(page: PageParams): Promise<KeysetResult<ModifierRow>> {
    return listModifiers(this.db, page);
  }

  /** Fetch one modifier by id, or `resource_not_found` (404) when absent. */
  async getModifier(id: string): Promise<ModifierRow> {
    const row = await getModifierById(this.db, id);
    if (row === undefined) {
      throw engineNotFound(`modifier ${id} not found`);
    }
    return row;
  }

  /**
   * Patch a modifier. Mirrors the create path's credit conversion: when the
   * patch carries a `value`, it is converted to µcredits for credit ops
   * (`flat_off`/`override_rate`) and kept as a whole-percent int otherwise. The
   * EFFECTIVE op (the patched `op` if present, else the stored one) drives the
   * conversion — so changing op + value together is consistent. 404 when absent.
   */
  async updateModifier(id: string, dto: UpdateModifierDto): Promise<ModifierRow> {
    const existing = await getModifierById(this.db, id);
    if (existing === undefined) {
      throw engineNotFound(`modifier ${id} not found`);
    }
    const effectiveOp = dto.op ?? existing.op;
    const patch: {
      whenExpr?: string | null;
      op?: string;
      value?: bigint;
      stackable?: boolean;
      priority?: number;
      active?: boolean;
    } = {};
    if (dto.whenExpr !== undefined) patch.whenExpr = dto.whenExpr;
    if (dto.op !== undefined) patch.op = dto.op;
    if (dto.value !== undefined) {
      patch.value = CREDIT_VALUE_OPS.has(effectiveOp)
        ? creditsToMicro(dto.value)
        : BigInt(Math.round(dto.value));
    }
    if (dto.stackable !== undefined) patch.stackable = dto.stackable;
    if (dto.priority !== undefined) patch.priority = dto.priority;
    if (dto.active !== undefined) patch.active = dto.active;
    const row = await updateModifier(this.db, id, patch);
    if (row === undefined) {
      throw engineNotFound(`modifier ${id} not found`);
    }
    return row;
  }

  /** Revoke (soft-delete) a modifier; 404 when no live modifier matched. */
  async deleteModifier(id: string): Promise<{ id: string }> {
    const deleted = await softDeleteModifier(this.db, id);
    if (deleted === undefined) {
      throw engineNotFound(`modifier ${id} not found`);
    }
    return { id: deleted };
  }

  // ----- models -----

  /**
   * Register a relay model. `inputPrice`/`outputPrice` are µUSD per 1M tokens
   * integers (`$X/1M → X×1e6`; NOT human credits) — passed through unchanged.
   * `capabilities` defaults to `{}` when omitted.
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
      ...(dto.rateLimit !== undefined ? { rateLimit: dto.rateLimit } : {}),
      ...(dto.fallbackModels !== undefined ? { fallbackModels: dto.fallbackModels } : {}),
      ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
      ...(dto.maker !== undefined ? { maker: dto.maker } : {}),
      ...(dto.contextLength !== undefined ? { contextLength: dto.contextLength } : {}),
      ...(dto.reasoning !== undefined ? { reasoning: dto.reasoning } : {}),
      ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
    };
    return createModel(this.db, input);
  }

  listModels(page: PageParams): Promise<KeysetResult<ModelRow>> {
    return listModels(this.db, page);
  }

  /**
   * Per-model health for the status page, derived from real `usage_log` traffic
   * over the last `days` (no synthetic probing). Joins the per-model summary with
   * its per-day uptime history for the sparkline.
   */
  async modelHealthReport(
    days: number,
  ): Promise<{ summary: ModelHealthRow; history: ModelHealthBucket[] }[]> {
    const since = new Date(Date.now() - days * 86_400_000);
    const [summaries, history] = await Promise.all([
      listModelHealth(this.db, since),
      listModelHealthHistory(this.db, since),
    ]);
    const byModel = new Map<string, ModelHealthBucket[]>();
    for (const b of history) {
      const arr = byModel.get(b.model) ?? [];
      arr.push(b);
      byModel.set(b.model, arr);
    }
    return summaries.map((summary) => ({ summary, history: byModel.get(summary.model) ?? [] }));
  }

  /** Fetch one model by its unique `name`, or `resource_not_found` (404) when absent. */
  async getModel(name: string): Promise<ModelRow> {
    const row = await getModelByName(this.db, name);
    if (row === undefined) {
      throw engineNotFound(`model ${name} not found`);
    }
    return row;
  }

  /**
   * Patch a relay model (by `name`). `inputPrice`/`outputPrice` are µUSD-per-1M-token
   * integers (passed through unchanged, same convention as create). `display`
   * may be set to `null`. 404 when the model is absent / soft-deleted.
   */
  async updateModel(name: string, dto: UpdateModelDto): Promise<ModelRow> {
    const patch: {
      display?: string | null;
      capabilities?: Record<string, boolean>;
      inputPrice?: bigint;
      outputPrice?: bigint;
      visibility?: string;
      rateLimit?: number | null;
      fallbackModels?: string[] | null;
      tags?: string[];
      maker?: string | null;
      contextLength?: number | null;
      reasoning?: string | null;
      icon?: string | null;
      status?: string;
    } = {};
    if (dto.display !== undefined) patch.display = dto.display;
    if (dto.capabilities !== undefined) patch.capabilities = dto.capabilities;
    if (dto.inputPrice !== undefined) patch.inputPrice = BigInt(dto.inputPrice);
    if (dto.outputPrice !== undefined) patch.outputPrice = BigInt(dto.outputPrice);
    if (dto.visibility !== undefined) patch.visibility = dto.visibility;
    if (dto.rateLimit !== undefined) patch.rateLimit = dto.rateLimit;
    if (dto.fallbackModels !== undefined) patch.fallbackModels = dto.fallbackModels;
    if (dto.tags !== undefined) patch.tags = dto.tags;
    if (dto.maker !== undefined) patch.maker = dto.maker;
    if (dto.contextLength !== undefined) patch.contextLength = dto.contextLength;
    if (dto.reasoning !== undefined) patch.reasoning = dto.reasoning;
    if (dto.icon !== undefined) patch.icon = dto.icon;
    if (dto.status !== undefined) patch.status = dto.status;
    const row = await updateModel(this.db, name, patch);
    if (row === undefined) {
      throw engineNotFound(`model ${name} not found`);
    }
    return row;
  }

  /**
   * Revoke (soft-delete) a model (by `name`). `resolveModelForTenant` filters
   * soft-deleted, so the model stops routing immediately. 404 when no live model
   * matched (already deleted / unknown).
   */
  async deleteModel(name: string): Promise<{ name: string }> {
    const deleted = await softDeleteModel(this.db, name);
    if (deleted === undefined) {
      throw engineNotFound(`model ${name} not found`);
    }
    return { name: deleted };
  }

  // ----- bulk admin actions (前端打磨) -----

  /**
   * Bulk enable/disable/delete models BY NAME with partial success. Each name
   * reuses the SAME single-row repo op as the per-row routes (`updateModel`
   * status / `softDeleteModel`) and — on success — emits ONE `audit_log` row
   * (`model.enable|disable|delete`, best-effort via {@link AuditService}) so the
   * entity's audit badge reflects the bulk change. A name that matched no live
   * model throws `not found`, landing it in `failed` without aborting the batch.
   */
  bulkModels(
    action: 'enable' | 'disable' | 'delete',
    names: string[],
    actorId?: string,
  ): Promise<BulkResult> {
    return bulkApply(names, async (name) => {
      if (action === 'delete') {
        const deleted = await softDeleteModel(this.db, name);
        if (deleted === undefined) throw engineNotFound(`model ${name} not found`);
      } else {
        const status = action === 'enable' ? 'active' : 'disabled';
        const row = await updateModel(this.db, name, { status });
        if (row === undefined) throw engineNotFound(`model ${name} not found`);
      }
      await this.audit.record({
        actorType: 'operator',
        actorId: actorId ?? null,
        action: `model.${action}`,
        targetType: 'model',
        targetId: name,
      });
    });
  }

  /**
   * Bulk enable/disable/delete channels BY ID with partial success. Reuses the
   * single-row repo ops (`updateUpstreamChannel` status / `softDeleteChannel`,
   * + `unlinkAllForChannel` on delete, mirroring {@link deleteChannel}). Emits
   * one `audit_log` row per affected channel (`channel.enable|disable|delete`,
   * best-effort). Channel ids are global, so the soft-delete is NOT
   * resource-scoped here (the bulk route is flat). An id matching no live
   * channel throws `not found` → that id lands in `failed`.
   */
  bulkChannels(
    action: 'enable' | 'disable' | 'delete',
    ids: string[],
    actorId?: string,
  ): Promise<BulkResult> {
    return bulkApply(ids, async (id) => {
      if (action === 'delete') {
        const deleted = await softDeleteChannel(this.db, id);
        if (deleted === undefined) throw engineNotFound(`channel ${id} not found`);
        await unlinkAllForChannel(this.db, id);
      } else {
        const status = action === 'enable' ? 'active' : 'disabled';
        const row = await updateUpstreamChannel(this.db, id, { status });
        if (row === undefined) throw engineNotFound(`channel ${id} not found`);
      }
      await this.audit.record({
        actorType: 'operator',
        actorId: actorId ?? null,
        action: `channel.${action}`,
        targetType: 'channel',
        targetId: id,
      });
    });
  }

  /**
   * Bulk revoke OAuth sessions BY ID with partial success. Reuses the single-row
   * {@link revokeOAuthSession} repo op (soft-deletes the session + its
   * secret_ref). NOT gated on `ENABLE_OAUTH_CHANNELS` — revoking a credential is
   * a security operation that must always be possible. Emits one `audit_log` row
   * per revoked session (`oauth_session.revoke`, best-effort). An id matching no
   * live session throws `not found` → that id lands in `failed`.
   */
  bulkRevokeOAuthSessions(ids: string[], actorId?: string): Promise<BulkResult> {
    return bulkApply(ids, async (id) => {
      const deleted = await softDeleteOAuthSession(this.db, id);
      if (deleted === undefined) throw engineNotFound(`oauth session ${id} not found`);
      await this.audit.record({
        actorType: 'operator',
        actorId: actorId ?? null,
        action: 'oauth_session.revoke',
        targetType: 'oauth_session',
        targetId: id,
      });
    });
  }

  /** Grant a tenant-visibility model (by name) to a tenant. */
  async grantModel(modelName: string, dto: GrantModelDto): Promise<void> {
    await grantModel(this.db, modelName, dto.tenantId);
  }

  /**
   * List a model's tenant grants (by model `name`), paginated. 404 when the
   * model itself is absent / soft-deleted (so an operator can tell a missing
   * model from one with zero grants).
   */
  async listModelGrants(modelName: string, page: PageParams): Promise<KeysetResult<ModelGrantRow>> {
    const m = await getModelByName(this.db, modelName);
    if (m === undefined) {
      throw engineNotFound(`model ${modelName} not found`);
    }
    return listModelGrants(this.db, modelName, page);
  }

  /**
   * Revoke a tenant's grant of a model: HARD-deletes the `model_grant` row
   * (`model_grant` has no `deleted_at`). 404 when the model is absent or the
   * tenant has no grant on it.
   */
  async deleteModelGrant(modelName: string, tenantId: string): Promise<{ id: string }> {
    const id = await deleteModelGrant(this.db, modelName, tenantId);
    if (id === undefined) {
      throw engineNotFound(`grant for tenant ${tenantId} on model ${modelName} not found`);
    }
    return { id };
  }

  // ----- jobs -----

  listJobs(tenantId: string, page: PageParams): Promise<KeysetResult<Job>> {
    return listJobs(this.db, tenantId, page);
  }

  // ----- ledger -----

  listLedger(tenantId: string, page: PageParams): Promise<KeysetResult<LedgerRow>> {
    return listLedger(this.db, tenantId, page);
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
      try {
        await createRedemptionCode(this.db, {
          code,
          creditAmount,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        });
      } catch (err) {
        // `redemption_code.code` is the text PK (no partial unique possible), so a
        // collision — including a code still held by a soft-deleted row — is a
        // Postgres 23505. Map it to a clean 400 rather than a 500.
        if (isUniqueViolation(err)) {
          throw engineInvalidInput(`redemption code '${code}' already exists`);
        }
        throw err;
      }
      codes.push(code);
    }
    return { codes, creditAmount };
  }

  /**
   * List minted redemption codes (admin mint view), keyset-paginated. An optional
   * `status` filter (`unused`/`redeemed`) narrows the set. Returning the `code`
   * value is acceptable — it IS the row's identity on an admin-only listing.
   */
  listRedemptionCodes(
    filter: { status?: string | undefined },
    page: PageParams,
  ): Promise<KeysetResult<RedemptionCodeRow>> {
    const f = filter.status !== undefined ? { status: filter.status } : {};
    return listRedemptionCodes(this.db, f, page);
  }

  // ----- official model price catalog (Track 2) -----

  /**
   * Add an official-price catalog row (cost basis). The DTO carries HUMAN
   * USD-per-1M-tokens (e.g. `1.25`); each is converted to integer µUSD/1M via
   * {@link usdPer1mToMicro} here at the boundary (the db only stores µUSD). The
   * `modelSlug` is normalized to the catalog's canonical form so it matches the
   * sync matcher. A `(provider, slug)` collision (incl. a pair still held by a
   * soft-deleted row) is mapped to a clean 400.
   */
  async createOfficialPrice(dto: CreateOfficialPriceDto): Promise<OfficialModelPriceRow> {
    const input: CreateOfficialPriceInput = {
      provider: dto.provider,
      modelSlug: normalizeModelSlug(dto.modelSlug),
      inputPricePer1m: usdPer1mToMicro(dto.inputUsdPer1m),
      outputPricePer1m: usdPer1mToMicro(dto.outputUsdPer1m),
      ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}),
      ...(dto.cachedInputUsdPer1m !== undefined
        ? { cachedInputPricePer1m: usdPer1mToMicro(dto.cachedInputUsdPer1m) }
        : {}),
      ...(dto.sourceUrl !== undefined ? { sourceUrl: dto.sourceUrl } : {}),
      ...(dto.effectiveAt !== undefined ? { effectiveAt: new Date(dto.effectiveAt) } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
    };
    try {
      return await createOfficialPrice(this.db, input);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw engineInvalidInput(
          `official price for '${input.provider}/${input.modelSlug}' already exists`,
        );
      }
      throw err;
    }
  }

  listOfficialPrices(
    filter: { provider?: string | undefined },
    page: PageParams,
  ): Promise<KeysetResult<OfficialModelPriceRow>> {
    const f = filter.provider !== undefined ? { provider: filter.provider } : {};
    return listOfficialPrices(this.db, f, page);
  }

  /** Fetch one catalog row by id, or `resource_not_found` (404) when absent/soft-deleted. */
  async getOfficialPrice(id: string): Promise<OfficialModelPriceRow> {
    const row = await getOfficialPriceById(this.db, id);
    if (row === undefined) {
      throw engineNotFound(`official price ${id} not found`);
    }
    return row;
  }

  /**
   * Patch a catalog row (by id). The USD-per-1M price fields are converted to
   * µUSD/1M (same convention as create); the nullable metadata fields may be set
   * to `null` to clear them. 404 when the row is absent / soft-deleted.
   */
  async updateOfficialPrice(
    id: string,
    dto: UpdateOfficialPriceDto,
  ): Promise<OfficialModelPriceRow> {
    const patch: {
      displayName?: string | null;
      inputPricePer1m?: bigint;
      outputPricePer1m?: bigint;
      cachedInputPricePer1m?: bigint | null;
      sourceUrl?: string | null;
      effectiveAt?: Date | null;
      notes?: string | null;
    } = {};
    if (dto.displayName !== undefined) patch.displayName = dto.displayName;
    if (dto.inputUsdPer1m !== undefined) patch.inputPricePer1m = usdPer1mToMicro(dto.inputUsdPer1m);
    if (dto.outputUsdPer1m !== undefined)
      patch.outputPricePer1m = usdPer1mToMicro(dto.outputUsdPer1m);
    if (dto.cachedInputUsdPer1m !== undefined)
      patch.cachedInputPricePer1m =
        dto.cachedInputUsdPer1m === null ? null : usdPer1mToMicro(dto.cachedInputUsdPer1m);
    if (dto.sourceUrl !== undefined) patch.sourceUrl = dto.sourceUrl;
    if (dto.effectiveAt !== undefined)
      patch.effectiveAt = dto.effectiveAt === null ? null : new Date(dto.effectiveAt);
    if (dto.notes !== undefined) patch.notes = dto.notes;
    const row = await updateOfficialPrice(this.db, id, patch);
    if (row === undefined) {
      throw engineNotFound(`official price ${id} not found`);
    }
    return row;
  }

  /** Revoke (soft-delete) a catalog row; 404 when no live row matched. */
  async deleteOfficialPrice(id: string): Promise<{ id: string }> {
    const deleted = await softDeleteOfficialPrice(this.db, id);
    if (deleted === undefined) {
      throw engineNotFound(`official price ${id} not found`);
    }
    return { id: deleted };
  }

  // ----- proxies (代理) -----

  /** Validate + return the AES master key, or a clean 400 (mirrors createSecret). */
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

  /** Create a managed proxy (URL encrypted at rest). Duplicate name → clean 400. */
  async createProxy(dto: CreateProxyDto): Promise<ProxyRow> {
    const keyB64 = this.requireEncryptionKey();
    const input: CreateProxyInput = {
      name: dto.name,
      url: dto.url,
      keyB64,
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
    };
    try {
      return await createProxy(this.db, input);
    } catch (err) {
      if (isUniqueViolation(err)) throw engineInvalidInput(`proxy '${dto.name}' already exists`);
      throw err;
    }
  }

  listProxies(page: PageParams): Promise<KeysetResult<ProxyRow>> {
    return listProxies(this.db, page);
  }

  async getProxy(id: string): Promise<ProxyRow> {
    const row = await getProxyById(this.db, id);
    if (row === undefined) throw engineNotFound(`proxy ${id} not found`);
    return row;
  }

  /** Patch a proxy; supplying `url` re-encrypts it (requires the master key). 404 when absent. */
  async updateProxy(id: string, dto: UpdateProxyDto): Promise<ProxyRow> {
    const patch: { -readonly [K in keyof UpdateProxyInput]: UpdateProxyInput[K] } = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.url !== undefined) {
      patch.url = dto.url;
      patch.keyB64 = this.requireEncryptionKey();
    }
    let row: ProxyRow | undefined;
    try {
      row = await updateProxy(this.db, id, patch);
    } catch (err) {
      if (isUniqueViolation(err))
        throw engineInvalidInput(`proxy '${dto.name ?? ''}' already exists`);
      throw err;
    }
    if (row === undefined) throw engineNotFound(`proxy ${id} not found`);
    return row;
  }

  async deleteProxy(id: string): Promise<{ id: string }> {
    const deleted = await softDeleteProxy(this.db, id);
    if (deleted === undefined) throw engineNotFound(`proxy ${id} not found`);
    return { id: deleted };
  }

  /**
   * Probe a proxy's reachability: decrypt its URL and GET `probeUrl` THROUGH it.
   * ANY HTTP response = reachable (the proxy connected upstream); a transport
   * throw = failing. Records health/latency/error (credentials redacted) and
   * returns the updated row. Note: SOCKS proxies are only exercised when egress
   * is curl (`HTTP_EGRESS=curl`); the undici client handles HTTP/HTTPS proxies.
   */
  async probeProxy(id: string, dto: ProxyProbeDto): Promise<ProxyRow> {
    const row = await getProxyById(this.db, id);
    if (row === undefined) throw engineNotFound(`proxy ${id} not found`);
    const keyB64 = this.requireEncryptionKey();
    let url: string;
    try {
      url = decryptSecret(row.encryptedUrl, keyB64);
    } catch {
      throw engineInvalidInput('failed to decrypt proxy URL (wrong SECRET_ENCRYPTION_KEY?)');
    }
    const probeUrl = dto.probeUrl ?? DEFAULT_PROXY_PROBE_URL;
    const timeoutMs = dto.timeoutMs ?? 10_000;
    const now = new Date();
    const start = Date.now();
    try {
      const res = await this.http.request({
        method: 'GET',
        url: probeUrl,
        proxyUrl: url,
        timeoutMs,
      });
      // A real HTTP response (ANY status — even 4xx/5xx) means the proxy reached
      // upstream → reachable. The curl egress reports `status: 0` for a proxy
      // CONNECT failure (it doesn't throw), so guard on `status > 0`.
      if (res.status > 0) {
        const updated = await recordProxyHealth(this.db, id, {
          healthy: true,
          latencyMs: Date.now() - start,
          error: null,
          now,
        });
        return updated ?? row;
      }
      const updated = await recordProxyHealth(this.db, id, {
        healthy: false,
        error: 'failed to connect through proxy',
        now,
      });
      return updated ?? row;
    } catch (err) {
      const message = sanitizeProxyError(err instanceof Error ? err.message : String(err));
      const updated = await recordProxyHealth(this.db, id, { healthy: false, error: message, now });
      return updated ?? row;
    }
  }

  // ----- fault policies (调用容错) -----

  /**
   * Create a fault-tolerance policy. All fields pass through as data (no money
   * conversion). A `(name)` collision among LIVE policies (partial-unique index)
   * maps to a clean 400 via the shared {@link isUniqueViolation} 23505 walk.
   */
  async createFaultPolicy(dto: CreateFaultPolicyDto): Promise<FaultPolicyRow> {
    const input: CreateFaultPolicyInput = {
      name: dto.name,
      ...(dto.fastFail !== undefined ? { fastFail: dto.fastFail } : {}),
      ...(dto.retryCount !== undefined ? { retryCount: dto.retryCount } : {}),
      ...(dto.backoffType !== undefined ? { backoffType: dto.backoffType } : {}),
      ...(dto.backoffMs !== undefined ? { backoffMs: dto.backoffMs } : {}),
      ...(dto.connectTimeoutMs !== undefined ? { connectTimeoutMs: dto.connectTimeoutMs } : {}),
      ...(dto.ttftTimeoutMs !== undefined ? { ttftTimeoutMs: dto.ttftTimeoutMs } : {}),
      ...(dto.totalTimeoutMs !== undefined ? { totalTimeoutMs: dto.totalTimeoutMs } : {}),
      ...(dto.idleTimeoutMs !== undefined ? { idleTimeoutMs: dto.idleTimeoutMs } : {}),
      ...(dto.retryCodes !== undefined ? { retryCodes: dto.retryCodes } : {}),
      ...(dto.retryMessages !== undefined ? { retryMessages: dto.retryMessages } : {}),
      ...(dto.breakerEnabled !== undefined ? { breakerEnabled: dto.breakerEnabled } : {}),
      ...(dto.breakerWindowMs !== undefined ? { breakerWindowMs: dto.breakerWindowMs } : {}),
      ...(dto.breakerMinVolume !== undefined ? { breakerMinVolume: dto.breakerMinVolume } : {}),
      ...(dto.breakerFailureRatePct !== undefined
        ? { breakerFailureRatePct: dto.breakerFailureRatePct }
        : {}),
      ...(dto.breakerHalfOpenTrial !== undefined
        ? { breakerHalfOpenTrial: dto.breakerHalfOpenTrial }
        : {}),
      ...(dto.breakerHalfOpenSuccesses !== undefined
        ? { breakerHalfOpenSuccesses: dto.breakerHalfOpenSuccesses }
        : {}),
      ...(dto.breakerOpenCooldownMs !== undefined
        ? { breakerOpenCooldownMs: dto.breakerOpenCooldownMs }
        : {}),
      ...(dto.breakerOpenCooldownCapMs !== undefined
        ? { breakerOpenCooldownCapMs: dto.breakerOpenCooldownCapMs }
        : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
    };
    try {
      return await createFaultPolicy(this.db, input);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw engineInvalidInput(`fault policy '${dto.name}' already exists`);
      }
      throw err;
    }
  }

  listFaultPolicies(page: PageParams): Promise<KeysetResult<FaultPolicyRow>> {
    return listFaultPolicies(this.db, page);
  }

  /** Fetch one fault policy by id, or `resource_not_found` (404) when absent/soft-deleted. */
  async getFaultPolicy(id: string): Promise<FaultPolicyRow> {
    const row = await getFaultPolicyById(this.db, id);
    if (row === undefined) throw engineNotFound(`fault policy ${id} not found`);
    return row;
  }

  /** Patch a fault policy; nullable timeouts/triggers/description may be cleared. 404 when absent. */
  async updateFaultPolicy(id: string, dto: UpdateFaultPolicyDto): Promise<FaultPolicyRow> {
    const patch: { -readonly [K in keyof UpdateFaultPolicyInput]: UpdateFaultPolicyInput[K] } = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.fastFail !== undefined) patch.fastFail = dto.fastFail;
    if (dto.retryCount !== undefined) patch.retryCount = dto.retryCount;
    if (dto.backoffType !== undefined) patch.backoffType = dto.backoffType;
    if (dto.backoffMs !== undefined) patch.backoffMs = dto.backoffMs;
    if (dto.connectTimeoutMs !== undefined) patch.connectTimeoutMs = dto.connectTimeoutMs;
    if (dto.ttftTimeoutMs !== undefined) patch.ttftTimeoutMs = dto.ttftTimeoutMs;
    if (dto.totalTimeoutMs !== undefined) patch.totalTimeoutMs = dto.totalTimeoutMs;
    if (dto.idleTimeoutMs !== undefined) patch.idleTimeoutMs = dto.idleTimeoutMs;
    if (dto.retryCodes !== undefined) patch.retryCodes = dto.retryCodes;
    if (dto.retryMessages !== undefined) patch.retryMessages = dto.retryMessages;
    if (dto.breakerEnabled !== undefined) patch.breakerEnabled = dto.breakerEnabled;
    if (dto.breakerWindowMs !== undefined) patch.breakerWindowMs = dto.breakerWindowMs;
    if (dto.breakerMinVolume !== undefined) patch.breakerMinVolume = dto.breakerMinVolume;
    if (dto.breakerFailureRatePct !== undefined)
      patch.breakerFailureRatePct = dto.breakerFailureRatePct;
    if (dto.breakerHalfOpenTrial !== undefined)
      patch.breakerHalfOpenTrial = dto.breakerHalfOpenTrial;
    if (dto.breakerHalfOpenSuccesses !== undefined)
      patch.breakerHalfOpenSuccesses = dto.breakerHalfOpenSuccesses;
    if (dto.breakerOpenCooldownMs !== undefined)
      patch.breakerOpenCooldownMs = dto.breakerOpenCooldownMs;
    if (dto.breakerOpenCooldownCapMs !== undefined)
      patch.breakerOpenCooldownCapMs = dto.breakerOpenCooldownCapMs;
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.description !== undefined) patch.description = dto.description;
    let row: FaultPolicyRow | undefined;
    try {
      row = await updateFaultPolicy(this.db, id, patch);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw engineInvalidInput(`fault policy '${dto.name ?? ''}' already exists`);
      }
      throw err;
    }
    if (row === undefined) throw engineNotFound(`fault policy ${id} not found`);
    return row;
  }

  /** Revoke (soft-delete) a fault policy. Bound channels treat it as absent → engine defaults. 404 when absent. */
  async deleteFaultPolicy(id: string): Promise<{ id: string }> {
    const deleted = await softDeleteFaultPolicy(this.db, id);
    if (deleted === undefined) throw engineNotFound(`fault policy ${id} not found`);
    return { id: deleted };
  }

  // ----- route groups (分组; Track 3) -----

  /**
   * Create a route group. `groupRatioBps` is integer basis points (`10000 =
   * 1.0×`) — passed through unchanged (NOT a credit/USD conversion). A `(name)`
   * collision among LIVE groups (the partial-unique index, incl. a name still
   * held by a soft-deleted row) is mapped to a clean 400 via the shared
   * {@link isUniqueViolation} 23505 walk.
   */
  async createRouteGroup(dto: CreateRouteGroupDto): Promise<RouteGroupRow> {
    // The new group has no id yet, so a self-cycle is impossible on create; a
    // sentinel source id (the nil UUID never names a real group) lets the shared
    // walk still enforce the existing-chain depth cap from the proposed target.
    if (dto.fallbackGroupId !== undefined && dto.fallbackGroupId !== null) {
      await this.validateFallbackGroup(NIL_UUID, dto.fallbackGroupId);
    }
    const input: CreateRouteGroupInput = {
      name: dto.name,
      ...(dto.groupRatioBps !== undefined ? { groupRatioBps: dto.groupRatioBps } : {}),
      ...(dto.fallbackGroupId !== undefined ? { fallbackGroupId: dto.fallbackGroupId } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
    };
    try {
      return await createRouteGroup(this.db, input);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw engineInvalidInput(`route group '${dto.name}' already exists`);
      }
      throw err;
    }
  }

  listRouteGroups(page: PageParams): Promise<KeysetResult<RouteGroupRow>> {
    return listRouteGroups(this.db, page);
  }

  /** Fetch one route group by id, or `resource_not_found` (404) when absent/soft-deleted. */
  getRouteGroup(id: string): Promise<RouteGroupRow> {
    return this.requireRouteGroup(id);
  }

  /**
   * Patch a route group (name/group_ratio_bps/status/description). A `(name)`
   * collision is mapped to a clean 400 (same partial-unique 23505 walk as create);
   * `description` may be set to `null`. 404 when the group is absent / soft-deleted.
   */
  async updateRouteGroup(id: string, dto: UpdateRouteGroupDto): Promise<RouteGroupRow> {
    const patch: {
      name?: string;
      groupRatioBps?: number;
      fallbackGroupId?: string | null;
      status?: string;
      description?: string | null;
    } = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.groupRatioBps !== undefined) patch.groupRatioBps = dto.groupRatioBps;
    if (dto.fallbackGroupId !== undefined) {
      // Cross-group failover (弹性2.0): a non-null target must exist and not form a
      // cycle / over-deep chain back through this very group. `null` clears it.
      await this.validateFallbackGroup(id, dto.fallbackGroupId);
      patch.fallbackGroupId = dto.fallbackGroupId;
    }
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.description !== undefined) patch.description = dto.description;
    let row: RouteGroupRow | undefined;
    try {
      row = await updateRouteGroup(this.db, id, patch);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw engineInvalidInput(`route group '${dto.name ?? ''}' already exists`);
      }
      throw err;
    }
    if (row === undefined) {
      throw engineNotFound(`route group ${id} not found`);
    }
    return row;
  }

  /**
   * Revoke (soft-delete) a route group. `listRouteGroups`/`getRouteGroup` and
   * the Track-4 router (`listGroupChannelsForResource`) all filter soft-deleted,
   * so the group drops out immediately; the partial unique frees its name. 404
   * when no live group matched.
   */
  async deleteRouteGroup(id: string): Promise<{ id: string }> {
    const deleted = await softDeleteRouteGroup(this.db, id);
    if (deleted === undefined) {
      throw engineNotFound(`route group ${id} not found`);
    }
    return { id: deleted };
  }

  /**
   * Add a channel to a route group (UPSERTS priority/weight on re-add). Validates
   * both the group (404 when unknown) and the channel (404 when absent /
   * soft-deleted) exist first. `priority` (HIGHER = tried first) and `weight`
   * default to 0/1.
   */
  async addChannelToGroup(
    groupId: string,
    channelId: string,
    dto: AddGroupChannelDto,
  ): Promise<RouteGroupChannelRow> {
    await this.requireRouteGroup(groupId);
    const channel = await getChannelById(this.db, channelId);
    if (channel === undefined) {
      throw engineNotFound(`channel ${channelId} not found`);
    }
    return addChannelToGroup(this.db, {
      groupId,
      channelId,
      ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
      ...(dto.weight !== undefined ? { weight: dto.weight } : {}),
    });
  }

  /**
   * List a group's channel memberships (with their per-(group,channel)
   * priority/weight), keyset-paginated. 404 when the group itself is absent /
   * soft-deleted (so an operator can tell a missing group from an empty one).
   */
  async listGroupChannels(
    groupId: string,
    page: PageParams,
  ): Promise<KeysetResult<RouteGroupChannelRow>> {
    await this.requireRouteGroup(groupId);
    return listGroupChannels(this.db, groupId, page);
  }

  /**
   * Remove a channel from a route group (HARD-deletes the membership row).
   * Validates the group exists (404), then removes; a channel that was not a
   * member yields a 404 (so the DELETE is observably idempotent on a known group).
   */
  async removeChannelFromGroup(groupId: string, channelId: string): Promise<{ channelId: string }> {
    await this.requireRouteGroup(groupId);
    const removed = await removeChannelFromGroup(this.db, groupId, channelId);
    if (!removed) {
      throw engineNotFound(`channel ${channelId} not a member of route group ${groupId}`);
    }
    return { channelId };
  }

  // ----- relay traces (upstream audit) -----

  /**
   * List `relay_trace` audit rows for the admin read endpoint, filtered +
   * keyset-paginated. Returns the RAW {@link KeysetResult} so the controller's
   * `mapPageEnvelope` derives `next_cursor` from the true `(created_at, id)`
   * keyset; the view projection (incl. read-side redaction) is applied by
   * {@link toRelayTraceView}.
   */
  listRelayTraces(
    filter: RelayTraceFilter,
    page: PageParams,
  ): Promise<KeysetResult<RelayTraceRow>> {
    return listRelayTraces(this.db, filter, page);
  }

  // ----- usage stats -----

  listUsageGlobal(page: PageParams): Promise<KeysetResult<UsageLogRow>> {
    return listUsageLogsGlobal(this.db, page);
  }

  // ----- analytics -----

  /**
   * GROUP-BY rollup over `usage_log` for the admin analytics endpoint. Optional
   * `tenantId`/`from`/`to` narrow the scope; ISO-8601 bounds are parsed to
   * `Date`s here. Conditional assignment keeps `exactOptionalPropertyTypes`
   * happy — an absent field is never written as `undefined`.
   */
  analyticsUsage(q: AnalyticsUsageQueryDto): Promise<UsageRollupRow[]> {
    const query: UsageRollupQuery = { groupBy: q.groupBy };
    if (q.tenantId !== undefined) query.tenantId = q.tenantId;
    if (q.from !== undefined) query.from = new Date(q.from);
    if (q.to !== undefined) query.to = new Date(q.to);
    return rollupUsage(this.db, query);
  }

  // ----- ops snapshot -----

  /** Authoritative platform counts for the overview KPI band (true `count(*)`). */
  async opsSummary(): Promise<{ tenants: number; resources: number; accounts: number }> {
    const [tenants, resources, accounts] = await Promise.all([
      countTenants(this.db),
      countResources(this.db),
      countAccounts(this.db),
    ]);
    return { tenants, resources, accounts };
  }

  /**
   * Read-only ops health snapshot: per-channel circuit-breaker state +
   * billable throughput normalized to req/min over the last `windowSeconds`.
   * Introduces no new aggregates beyond the channel-health join and a windowed
   * `count(*)`.
   */
  async opsHealth(
    windowSeconds = 60,
  ): Promise<{ windowSeconds: number; rpmBillable: number; channels: ChannelHealthRow[] }> {
    const from = new Date(Date.now() - windowSeconds * 1000);
    const [count, channels] = await Promise.all([
      countUsageLogs(this.db, { from }),
      listAllChannelsWithHealth(this.db),
    ]);
    const rpmBillable = windowSeconds === 0 ? 0 : Math.round((count / windowSeconds) * 60);
    return { windowSeconds, rpmBillable, channels };
  }

  /**
   * Every tripped/probing `(channel, model)` circuit breaker for the ops status
   * surface (`GET /admin/breakers`, 弹性2.0), joined to the channel's name, each
   * enriched with its recent-window `failureRate` (%) read live from the breaker's
   * Redis sliding window — the same signal that trips it (spec §⑤). The PG row
   * carries only the FSM state, so the rate is fetched per row from the breaker
   * store; a Redis miss/outage (or no store wired) degrades `failureRate` to null,
   * never failing the surface.
   */
  async listBreakers(): Promise<BreakerStatusWithRate[]> {
    const rows = await listBreakersWithChannel(this.db);
    if (this.breaker === undefined) {
      return rows.map((row) => ({ ...row, failureRate: null }));
    }
    const now = new Date();
    return Promise.all(
      rows.map(async (row) => {
        const stats = await this.breaker?.windowStats(row.channelId, row.model, now);
        return { ...row, failureRate: stats?.failureRatePct ?? null };
      }),
    );
  }

  /**
   * Reset one `(channel, model)` breaker back to closed (ops un-stick): deletes
   * its row, so the channel re-enters routing immediately. Idempotent — clearing
   * an already-closed (absent) breaker is a safe no-op.
   */
  resetBreaker(channelId: string, model: string): Promise<void> {
    return resetBreaker(this.db, channelId, model);
  }
}

/** True when `value` is a plain object (used to merge into a pricebook spec). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The serialized `relay_trace` audit row returned by `GET /admin/relay-traces`.
 * snake_case; `created_at` is an ISO string; `request_headers` has had secret
 * header VALUES redacted a SECOND time on read (see {@link toRelayTraceView}).
 */
// RelayTraceView is defined once in @actionow/contracts (ops-views) — single
// source of truth shared with the frontend; toRelayTraceView() `.parse()`s it.
export type { RelayTraceView };

/**
 * Project a raw `relay_trace` row to its read view. DEFENSE-IN-DEPTH: re-runs the
 * SAME header redaction the writer (`TracingHttpClient`) applies, so a credential
 * can never surface from the read path even if a hypothetical legacy / un-redacted
 * row slipped past the write-side redaction. Everything else is a verbatim
 * snake_case projection (bodies are already truncated at the byte cap on write).
 */
export function toRelayTraceView(row: RelayTraceRow): RelayTraceView {
  return relayTraceViewSchema.parse({
    id: row.id,
    created_at: row.createdAt.toISOString(),
    tenant_id: row.tenantId,
    job_id: row.jobId,
    channel_id: row.channelId,
    provider_type: row.providerType,
    method: row.method,
    url: row.url,
    request_headers: redactHeaders(row.requestHeaders ?? undefined) ?? null,
    request_body: row.requestBody,
    response_status: row.responseStatus,
    response_body: row.responseBody,
    is_stream: row.isStream,
    latency_ms: row.latencyMs,
    error: row.error,
    truncated: row.truncated,
    route_tag: row.routeTag,
  });
}
