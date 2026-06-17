import { randomUUID } from 'node:crypto';

import type { AdapterRegistry } from '@actionow/adapters';
import type { AdapterContext, HttpClient } from '@actionow/contracts';
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
  createOAuthSession,
  type CreateOAuthSessionInput,
  createPricebookEntry,
  createRedemptionCode,
  createResource,
  createTenant,
  createUpstreamChannel,
  type Database,
  decryptSecret,
  encryptSecret,
  getAccount,
  getResource,
  getSecretRefById,
  grantModel,
  type Job,
  type KeysetResult,
  type LedgerRow,
  listApiKeys,
  listChannelsForResource,
  listJobs,
  listLedger,
  listModels,
  listModifiers,
  listOAuthSessions,
  listPricebookEntries,
  listRelayTraces,
  listResources,
  listSecretRefs,
  listTenants,
  listUsageLogsGlobal,
  type ModelRow,
  type ModifierRow,
  type OAuthSessionListRow,
  type PageParams,
  type PricebookEntryRow,
  type RelayTraceFilter,
  type RelayTraceRow,
  type Resource,
  rollupUsage,
  type SecretRefRow,
  type SecretRefView,
  softDeleteApiKey,
  softDeleteOAuthSession,
  softDeleteSecretRef,
  type TenantRow,
  topUp,
  updateUpstreamChannel,
  upsertModelsFromSync,
  type UpstreamChannelRow,
  type UsageLogRow,
  type UsageRollupQuery,
  type UsageRollupRow,
} from '@actionow/db';
import { creditsToMicro } from '@actionow/domain';
import {
  buildCodexAuthorizeUrl,
  CodexAuthError,
  exchangeCodexCode,
  generateCodexPkce,
  parseChatgptIdentity,
  redactHeaders,
} from '@actionow/engine';
import { type AppEnv, FetchHttpClient } from '@actionow/infra';
import { Inject, Injectable, Optional } from '@nestjs/common';

import { engineInvalidInput, engineNotFound } from '../common/errors.js';
import { SecretResolver } from '../common/secret-resolver.js';
import { ADAPTERS, DB, ENV, HTTP } from '../common/tokens.js';
import type {
  AnalyticsUsageQueryDto,
  CodexLoginComplete,
  CreateAccountDto,
  CreateApiKeyDto,
  CreateChannelDto,
  CreateModelDto,
  CreateModifierDto,
  CreateOAuthSessionDto,
  CreatePricebookDto,
  CreateResourceDto,
  CreateSecretDto,
  CreateTenantDto,
  GenerateCodesDto,
  GrantModelDto,
  SyncChannelModelsDto,
  TopupDto,
  UpdateChannelDto,
} from './dto/admin.dto.js';

/** Modifier ops whose `value` is a µcredit amount (vs. a whole-percent int). */
const CREDIT_VALUE_OPS = new Set(['flat_off', 'override_rate']);

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
    @Optional() @Inject(HTTP) http?: HttpClient,
  ) {
    // Default to a real fetch client so existing constructions/tests that don't
    // wire an HTTP provider keep working; the OAuth-login e2e overrides it.
    this.http = http ?? new FetchHttpClient();
  }

  // ----- tenants -----

  createTenant(dto: CreateTenantDto): Promise<TenantRow> {
    return createTenant(this.db, { name: dto.name, isolationMode: dto.isolationMode });
  }

  listTenants(page: PageParams): Promise<KeysetResult<TenantRow>> {
    return listTenants(this.db, page);
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

  listResources(page: PageParams): Promise<KeysetResult<Resource>> {
    return listResources(this.db, page);
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
  listResourceChannels(
    resourceId: string,
    page: PageParams,
  ): Promise<KeysetResult<UpstreamChannelRow>> {
    return listChannelsForResource(this.db, resourceId, page);
  }

  /** Patch an upstream channel's routing fields (weight/status/endpoint/model/...). */
  async updateChannel(channelId: string, dto: UpdateChannelDto): Promise<UpstreamChannelRow> {
    const row = await updateUpstreamChannel(this.db, channelId, dto);
    if (row === undefined) {
      throw engineNotFound(`channel ${channelId} not found`);
    }
    return row;
  }

  /**
   * Sync the upstream models a channel's provider exposes into `model` rows
   * (multi-model routing). Loads the channel (verifying it belongs to
   * `resourceId`), resolves the provider adapter, and — if it supports model
   * discovery (`listModels`) — calls it with an {@link AdapterContext} built the
   * SAME way the chat relay/engine does (per-channel model/endpoint/config, the
   * credential resolved via the shared {@link SecretResolver} incl. its `oauth`
   * branch, the egress proxy resolved from `proxyRef` with the global
   * `UPSTREAM_PROXY_URL` fallback). Each upstream slug becomes a `model` row via
   * {@link upsertModelsFromSync}: a new model gets the request's per-token default
   * prices (3/7 when omitted), an existing one keeps its price (display +
   * capabilities are refreshed). Returns the created/updated names + total.
   */
  async syncChannelModels(
    resourceId: string,
    channelId: string,
    dto: SyncChannelModelsDto,
  ): Promise<{ resource_id: string; created: string[]; updated: string[]; total: number }> {
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
      models: models.map((m) => ({
        name: m.id,
        display: m.displayName,
        capabilities: m.capabilities,
      })),
      defaultInputPrice: BigInt(dto.defaultInputPrice ?? 3),
      defaultOutputPrice: BigInt(dto.defaultOutputPrice ?? 7),
    });

    return {
      resource_id: resourceId,
      created: result.created,
      updated: result.updated,
      total: result.created.length + result.updated.length,
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

  listModifiers(page: PageParams): Promise<KeysetResult<ModifierRow>> {
    return listModifiers(this.db, page);
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

  listModels(page: PageParams): Promise<KeysetResult<ModelRow>> {
    return listModels(this.db, page);
  }

  /** Grant a tenant-visibility model (by name) to a tenant. */
  async grantModel(modelName: string, dto: GrantModelDto): Promise<void> {
    await grantModel(this.db, modelName, dto.tenantId);
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
      await createRedemptionCode(this.db, {
        code,
        creditAmount,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      });
      codes.push(code);
    }
    return { codes, creditAmount };
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
export interface RelayTraceView {
  id: string;
  created_at: string;
  tenant_id: string | null;
  job_id: string | null;
  channel_id: string | null;
  provider_type: string | null;
  method: string;
  url: string;
  request_headers: Record<string, string> | null;
  request_body: string | null;
  response_status: number | null;
  response_body: string | null;
  is_stream: boolean;
  latency_ms: number | null;
  error: string | null;
  truncated: boolean;
}

/**
 * Project a raw `relay_trace` row to its read view. DEFENSE-IN-DEPTH: re-runs the
 * SAME header redaction the writer (`TracingHttpClient`) applies, so a credential
 * can never surface from the read path even if a hypothetical legacy / un-redacted
 * row slipped past the write-side redaction. Everything else is a verbatim
 * snake_case projection (bodies are already truncated at the byte cap on write).
 */
export function toRelayTraceView(row: RelayTraceRow): RelayTraceView {
  return {
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
  };
}
