import type { ApiClient } from './client';
import type { SdkClient } from './sdkClient';
import { page, unwrap } from './sdkClient';
import type {
  AccountView,
  AddGroupChannelBody,
  AdminTokenView,
  AnalyticsUsageQuery,
  ApiKeyCreatedView,
  ApiKeyView,
  ChannelView,
  CodexLoginCompleteBody,
  CodexLoginStartBody,
  CodexLoginStartView,
  CreateAccountBody,
  CreateAdminTokenBody,
  CreateApiKeyBody,
  CreateChannelBody,
  CreateFaultPolicyBody,
  CreateModelBody,
  CreateModifierBody,
  CreateOAuthSessionBody,
  CreateOfficialPriceBody,
  CreatePluginRequest,
  CreatePricebookBody,
  CreateProxyBody,
  CreateResourceBody,
  CreateRouteGroupBody,
  CreateSecretBody,
  CreateTenantBody,
  DifyBindingView,
  DifyImportBody,
  DifyImportView,
  FaultPolicyView,
  GenerateCodesBody,
  IconAssetView,
  JobView,
  LedgerView,
  ModelGrantView,
  ModelHealthView,
  ModelTestRequest,
  ModelTestResult,
  ModelView,
  ModifierView,
  OAuthSessionListView,
  OAuthSessionView,
  OfficialPriceView,
  OpsHealthView,
  OpsSummaryView,
  Page,
  PaymentIntentView,
  PricebookView,
  ProviderPluginView,
  ProvisionBody,
  ProvisionView,
  ProxyProbeBody,
  ProxyView,
  RedemptionCodeView,
  RelayTraceQuery,
  RelayTraceView,
  ResourceView,
  RouteGroupChannelView,
  RouteGroupView,
  SecretView,
  SyncChannelModelsBody,
  SyncChannelModelsResult,
  TenantView,
  TestPluginRequest,
  TestPluginResponse,
  TopupBody,
  UpdateApiKeyGroupBody,
  UpdateChannelBody,
  UpdateCredentialMetaBody,
  UpdateDifyBody,
  UpdateFaultPolicyBody,
  UpdateModelBody,
  UpdateModifierBody,
  UpdateOfficialPriceBody,
  UpdatePluginRequest,
  UpdatePricebookBody,
  UpdateProxyBody,
  UpdateResourceBody,
  UpdateRouteGroupBody,
  UpdateTenantBody,
  UsageLogView,
  UsageRollupView,
} from './types';

interface KeysetParams {
  tenantId: string;
  cursor?: string;
  limit?: number;
}

/** The header object for an optional Idempotency-Key (POST mutation safety). */
function idem(key?: string): { 'Idempotency-Key': string } | undefined {
  return key ? { 'Idempotency-Key': key } : undefined;
}

/**
 * The admin control-plane client. The bulk issues calls through the typed SDK
 * (`sdk`, an `openapi-fetch` client driven by the contract); the `unwrap`/`page`
 * helpers re-throw the §4.7 `ApiError` and route 401→`onUnauthorized` (logout).
 * A few endpoints whose RESPONSE shape has no contract schema (e.g. the
 * mint-once `{ id, plaintext }`, relay traces, sync-models) stay on the
 * hand-written `rawClient` — each is annotated inline with the reason.
 */
export function makeAdminApi(sdk: SdkClient, rawClient: ApiClient, onUnauthorized: () => void) {
  const u = onUnauthorized;
  return {
    listTenants: async () => page<TenantView>(await sdk.GET('/admin/tenants'), u).rows,
    createTenant: async (body: CreateTenantBody, idempotencyKey?: string) =>
      unwrap(await sdk.POST('/admin/tenants', { body, headers: idem(idempotencyKey) }), u),
    // Atomic onboarding: tenant + account + API key in one call. Returns the
    // key plaintext ONCE (shown then, never again).
    provision: async (body: ProvisionBody, idempotencyKey?: string): Promise<ProvisionView> =>
      unwrap(await sdk.POST('/admin/provision', { body, headers: idem(idempotencyKey) }), u),
    updateTenant: async (id: string, body: UpdateTenantBody) =>
      unwrap(await sdk.PATCH('/admin/tenants/{id}', { params: { path: { id } }, body }), u),

    listResources: async () => page<ResourceView>(await sdk.GET('/admin/resources'), u).rows,
    createResource: async (body: CreateResourceBody, idempotencyKey?: string) =>
      unwrap(await sdk.POST('/admin/resources', { body, headers: idem(idempotencyKey) }), u),
    updateResource: async (id: string, body: UpdateResourceBody) =>
      unwrap(await sdk.PATCH('/admin/resources/{id}', { params: { path: { id } }, body }), u),
    createChannel: async (resourceId: string, body: CreateChannelBody, idempotencyKey?: string) =>
      unwrap(
        await sdk.POST('/admin/resources/{id}/channels', {
          params: { path: { id: resourceId } },
          body,
          headers: idem(idempotencyKey),
        }),
        u,
      ),
    listChannels: async (resourceId: string) =>
      page<ChannelView>(
        await sdk.GET('/admin/resources/{id}/channels', { params: { path: { id: resourceId } } }),
        u,
      ).rows,
    updateChannel: async (resourceId: string, channelId: string, body: UpdateChannelBody) =>
      unwrap(
        await sdk.PATCH('/admin/resources/{id}/channels/{channelId}', {
          params: { path: { id: resourceId, channelId } },
          body,
        }),
        u,
      ),
    deleteChannel: async (resourceId: string, channelId: string): Promise<void> => {
      unwrap(
        await sdk.DELETE('/admin/resources/{id}/channels/{channelId}', {
          params: { path: { id: resourceId, channelId } },
        }),
        u,
      );
    },
    // HYBRID: the sync-models response (`SyncChannelModelsResult`) is an FE-local
    // shape with no contract view schema — keep on the raw client.
    syncChannelModels: (resourceId: string, channelId: string, body: SyncChannelModelsBody) =>
      rawClient.post<SyncChannelModelsResult>(
        `/admin/resources/${resourceId}/channels/${channelId}/sync-models`,
        body,
      ),

    // Channel↔model links (catalog supply-hierarchy). RAW: these admin routes
    // aren't in the generated SDK path set (gen-openapi registers a fixed set),
    // but their bodies/views are contract types.
    listChannelModels: (resourceId: string, channelId: string) =>
      rawClient.get<ModelView[]>(`/admin/resources/${resourceId}/channels/${channelId}/models`),
    linkChannelModel: (resourceId: string, channelId: string, modelId: string) =>
      rawClient.post<{ ok: true }>(`/admin/resources/${resourceId}/channels/${channelId}/models`, {
        model_id: modelId,
      }),
    unlinkChannelModel: async (
      resourceId: string,
      channelId: string,
      modelId: string,
    ): Promise<void> => {
      await rawClient.delete<unknown>(
        `/admin/resources/${resourceId}/channels/${channelId}/models/${encodeURIComponent(modelId)}`,
      );
    },

    listPricebook: async (resourceId: string) =>
      page<PricebookView>(
        await sdk.GET('/admin/pricebook', { params: { query: { resourceId } } }),
        u,
      ).rows,
    createPricebook: async (body: CreatePricebookBody, idempotencyKey?: string) =>
      unwrap(await sdk.POST('/admin/pricebook', { body, headers: idem(idempotencyKey) }), u),
    updatePricebook: async (id: string, body: UpdatePricebookBody) =>
      unwrap(await sdk.PATCH('/admin/pricebook/{id}', { params: { path: { id } }, body }), u),
    deletePricebook: async (id: string): Promise<void> => {
      unwrap(await sdk.DELETE('/admin/pricebook/{id}', { params: { path: { id } } }), u);
    },

    listModifiers: async (
      params: { cursor?: string; limit?: number } = {},
    ): Promise<Page<ModifierView>> =>
      page<ModifierView>(await sdk.GET('/admin/modifiers', { params: { query: params } }), u),
    createModifier: async (body: CreateModifierBody) =>
      unwrap(await sdk.POST('/admin/modifiers', { body }), u),
    updateModifier: async (id: string, body: UpdateModifierBody) =>
      unwrap(await sdk.PATCH('/admin/modifiers/{id}', { params: { path: { id } }, body }), u),
    deleteModifier: async (id: string): Promise<void> => {
      unwrap(await sdk.DELETE('/admin/modifiers/{id}', { params: { path: { id } } }), u);
    },

    // HYBRID: the dify-import response (`DifyImportView`) isn't a registered path
    // response (the import path declares only a 201 with no body schema).
    difyImport: (body: DifyImportBody) =>
      rawClient.post<DifyImportView>('/admin/dify/import', body),
    listDify: async (
      params: { cursor?: string; limit?: number } = {},
    ): Promise<Page<DifyBindingView>> =>
      page<DifyBindingView>(await sdk.GET('/admin/dify', { params: { query: params } }), u),
    updateDify: async (resourceId: string, body: UpdateDifyBody) =>
      unwrap(
        await sdk.PATCH('/admin/dify/{resourceId}', { params: { path: { resourceId } }, body }),
        u,
      ),
    deleteDify: async (resourceId: string): Promise<void> => {
      unwrap(await sdk.DELETE('/admin/dify/{resourceId}', { params: { path: { resourceId } } }), u);
    },

    listAccounts: async () => page<AccountView>(await sdk.GET('/admin/accounts'), u).rows,
    createAccount: async (body: CreateAccountBody) =>
      unwrap(await sdk.POST('/admin/accounts', { body }), u),
    // HYBRID: topup returns `{ account_id, balance }`, but the path's response
    // schema is the full `AccountView` — keep the precise FE return on raw.
    topup: (accountId: string, body: TopupBody) =>
      rawClient.post<{ account_id: string; balance: string }>(
        `/admin/accounts/${accountId}/topup`,
        body,
      ),

    listApiKeys: async (tenantId: string) =>
      page<ApiKeyView>(await sdk.GET('/admin/api-keys', { params: { query: { tenantId } } }), u)
        .rows,
    // HYBRID: minting returns the plaintext-once `ApiKeyCreatedView`; the admin
    // api-keys POST path declares an `ApiKeyView` response (no plaintext), so the
    // typed SDK would mistype it — keep on raw to preserve `{ id, plaintext }`.
    createApiKey: (body: CreateApiKeyBody) =>
      rawClient.post<ApiKeyCreatedView>('/admin/api-keys', body),
    // HYBRID: group-bind returns `{ id, route_group_id }`, but the path's response
    // schema is the full `ApiKeyView` — keep the precise FE return on raw.
    updateApiKeyGroup: (id: string, body: UpdateApiKeyGroupBody) =>
      rawClient.patch<{ id: string; route_group_id: string | null }>(
        `/admin/api-keys/${id}/group`,
        body,
      ),
    // Revoke (soft-delete) a key — 204 → void.
    deleteApiKey: async (id: string): Promise<void> => {
      unwrap(await sdk.DELETE('/admin/api-keys/{id}', { params: { path: { id } } }), u);
    },

    // --- Admin service tokens (M2M credentials for the admin API) ---
    listAdminTokens: async () => page<AdminTokenView>(await sdk.GET('/admin/tokens'), u).rows,
    // Mint returns the plaintext (`at_…`) ONCE — the registered path response IS
    // `{ id, plaintext }`, so the typed SDK returns it directly (no raw needed).
    createAdminToken: async (body: CreateAdminTokenBody): Promise<ApiKeyCreatedView> =>
      unwrap(await sdk.POST('/admin/tokens', { body }), u),
    revokeAdminToken: async (id: string): Promise<void> => {
      unwrap(await sdk.DELETE('/admin/tokens/{id}', { params: { path: { id } } }), u);
    },

    // --- Fault-tolerance policies (调用容错) ---
    listFaultPolicies: async () =>
      page<FaultPolicyView>(await sdk.GET('/admin/fault-policies'), u).rows,
    createFaultPolicy: async (body: CreateFaultPolicyBody, idempotencyKey?: string) =>
      unwrap(await sdk.POST('/admin/fault-policies', { body, headers: idem(idempotencyKey) }), u),
    getFaultPolicy: async (id: string) =>
      unwrap(await sdk.GET('/admin/fault-policies/{id}', { params: { path: { id } } }), u),
    updateFaultPolicy: async (id: string, body: UpdateFaultPolicyBody) =>
      unwrap(await sdk.PATCH('/admin/fault-policies/{id}', { params: { path: { id } }, body }), u),
    deleteFaultPolicy: async (id: string): Promise<void> => {
      unwrap(await sdk.DELETE('/admin/fault-policies/{id}', { params: { path: { id } } }), u);
    },

    // --- Model health status page (持续健康监控) ---
    modelHealth: async (days = 7): Promise<ModelHealthView[]> =>
      unwrap(await sdk.GET('/admin/health/models', { params: { query: { days } } }), u),

    // --- Managed egress proxies (代理) ---
    listProxies: async () => page<ProxyView>(await sdk.GET('/admin/proxies'), u).rows,
    createProxy: async (body: CreateProxyBody, idempotencyKey?: string) =>
      unwrap(await sdk.POST('/admin/proxies', { body, headers: idem(idempotencyKey) }), u),
    getProxy: async (id: string) =>
      unwrap(await sdk.GET('/admin/proxies/{id}', { params: { path: { id } } }), u),
    updateProxy: async (id: string, body: UpdateProxyBody) =>
      unwrap(await sdk.PATCH('/admin/proxies/{id}', { params: { path: { id } }, body }), u),
    deleteProxy: async (id: string): Promise<void> => {
      unwrap(await sdk.DELETE('/admin/proxies/{id}', { params: { path: { id } } }), u);
    },
    probeProxy: async (id: string, body: ProxyProbeBody = {}): Promise<ProxyView> =>
      unwrap(await sdk.POST('/admin/proxies/{id}/probe', { params: { path: { id } }, body }), u),

    // --- Route groups (billing/routing) ---
    listRouteGroups: async () => page<RouteGroupView>(await sdk.GET('/admin/route-groups'), u).rows,
    createRouteGroup: async (body: CreateRouteGroupBody, idempotencyKey?: string) =>
      unwrap(await sdk.POST('/admin/route-groups', { body, headers: idem(idempotencyKey) }), u),
    getRouteGroup: async (id: string) =>
      unwrap(await sdk.GET('/admin/route-groups/{id}', { params: { path: { id } } }), u),
    updateRouteGroup: async (id: string, body: UpdateRouteGroupBody) =>
      unwrap(await sdk.PATCH('/admin/route-groups/{id}', { params: { path: { id } }, body }), u),
    deleteRouteGroup: async (id: string): Promise<void> => {
      unwrap(await sdk.DELETE('/admin/route-groups/{id}', { params: { path: { id } } }), u);
    },
    listGroupChannels: async (id: string) =>
      page<RouteGroupChannelView>(
        await sdk.GET('/admin/route-groups/{id}/channels', { params: { path: { id } } }),
        u,
      ).rows,
    // PUT membership upsert — the PUT verb is the idempotency; never an Idempotency-Key.
    addGroupChannel: async (id: string, channelId: string, body: AddGroupChannelBody) =>
      unwrap(
        await sdk.PUT('/admin/route-groups/{id}/channels/{channelId}', {
          params: { path: { id, channelId } },
          body,
        }),
        u,
      ),
    removeGroupChannel: async (id: string, channelId: string): Promise<void> => {
      unwrap(
        await sdk.DELETE('/admin/route-groups/{id}/channels/{channelId}', {
          params: { path: { id, channelId } },
        }),
        u,
      );
    },

    // --- Official prices (reference catalog) ---
    listOfficialPrices: async (
      params: { cursor?: string; limit?: number } = {},
    ): Promise<Page<OfficialPriceView>> =>
      page<OfficialPriceView>(
        await sdk.GET('/admin/official-prices', { params: { query: params } }),
        u,
      ),
    createOfficialPrice: async (body: CreateOfficialPriceBody, idempotencyKey?: string) =>
      unwrap(await sdk.POST('/admin/official-prices', { body, headers: idem(idempotencyKey) }), u),
    updateOfficialPrice: async (id: string, body: UpdateOfficialPriceBody) =>
      unwrap(await sdk.PATCH('/admin/official-prices/{id}', { params: { path: { id } }, body }), u),
    deleteOfficialPrice: async (id: string): Promise<void> => {
      unwrap(await sdk.DELETE('/admin/official-prices/{id}', { params: { path: { id } } }), u);
    },

    listJobs: async ({ tenantId, cursor, limit }: KeysetParams): Promise<Page<JobView>> =>
      page<JobView>(
        await sdk.GET('/admin/jobs', { params: { query: { tenantId, cursor, limit } } }),
        u,
      ),

    // HYBRID: the secrets POST path declares only a 201 (no body schema), but the
    // FE consumes the returned `SecretView` — keep on raw.
    createSecret: (body: CreateSecretBody) => rawClient.post<SecretView>('/admin/secrets', body),
    listSecrets: async () => page<SecretView>(await sdk.GET('/admin/secrets'), u).rows,
    // Keyset-paginated variant (the credentials page lists with LoadMore).
    listSecretsPage: async (
      params: { cursor?: string; limit?: number } = {},
    ): Promise<Page<SecretView>> =>
      page<SecretView>(await sdk.GET('/admin/secrets', { params: { query: params } }), u),
    // Revoke (soft-delete) a stored credential — 204 → void.
    deleteSecret: async (id: string): Promise<void> => {
      unwrap(await sdk.DELETE('/admin/secrets/{id}', { params: { path: { id } } }), u);
    },
    // Edit a stored credential's metadata (name/notes/group) — never the material.
    updateSecret: async (id: string, body: UpdateCredentialMetaBody): Promise<SecretView> =>
      unwrap(await sdk.PATCH('/admin/secrets/{id}', { params: { path: { id } }, body }), u),

    // --- icon catalog (selectable brand icons; admin-only, not in the SDK) ---
    listIcons: (): Promise<IconAssetView[]> => rawClient.get<IconAssetView[]>('/admin/icons'),

    // --- provider plugins (P2) ---
    listPlugins: async (): Promise<ProviderPluginView[]> =>
      unwrap(await sdk.GET('/admin/plugins'), u),
    createPlugin: async (body: CreatePluginRequest): Promise<ProviderPluginView> =>
      unwrap(await sdk.POST('/admin/plugins', { body }), u),
    updatePlugin: async (id: string, body: UpdatePluginRequest): Promise<ProviderPluginView> =>
      unwrap(await sdk.PATCH('/admin/plugins/{id}', { params: { path: { id } }, body }), u),
    deletePlugin: async (id: string): Promise<void> => {
      unwrap(await sdk.DELETE('/admin/plugins/{id}', { params: { path: { id } } }), u);
    },
    testPlugin: async (body: TestPluginRequest): Promise<TestPluginResponse> =>
      unwrap(await sdk.POST('/admin/plugins/test', { body }), u),

    listModels: async () => page<ModelView>(await sdk.GET('/admin/models'), u).rows,
    createModel: async (body: CreateModelBody, idempotencyKey?: string) =>
      unwrap(await sdk.POST('/admin/models', { body, headers: idem(idempotencyKey) }), u),
    // Pre-add probe: connectivity + functional test of a CANDIDATE model (the
    // `model` need not exist yet) against the resource's channel.
    testModel: async (body: ModelTestRequest): Promise<ModelTestResult> =>
      unwrap(await sdk.POST('/admin/models/test', { body }), u),
    getModel: async (name: string) =>
      unwrap(await sdk.GET('/admin/models/{name}', { params: { path: { name } } }), u),
    updateModel: async (name: string, body: UpdateModelBody) =>
      unwrap(await sdk.PATCH('/admin/models/{name}', { params: { path: { name } }, body }), u),
    deleteModel: async (name: string): Promise<void> => {
      unwrap(await sdk.DELETE('/admin/models/{name}', { params: { path: { name } } }), u);
    },
    // HYBRID: grant returns `{ ok: true }`, which the grants POST path doesn't
    // declare as a response body — keep on raw.
    grantModel: (name: string, body: { tenantId: string }, idempotencyKey?: string) =>
      rawClient.post<{ ok: true }>(`/admin/models/${encodeURIComponent(name)}/grants`, body, {
        idempotencyKey,
      }),
    listModelGrants: async (name: string) =>
      page<ModelGrantView>(
        await sdk.GET('/admin/models/{name}/grants', { params: { path: { name } } }),
        u,
      ).rows,
    revokeModelGrant: async (name: string, tenantId: string): Promise<void> => {
      unwrap(
        await sdk.DELETE('/admin/models/{name}/grants/{tenantId}', {
          params: { path: { name, tenantId } },
        }),
        u,
      );
    },

    // Mint redemption codes — returns the plaintext codes + per-code grant ONCE.
    generateCodes: async (body: GenerateCodesBody) =>
      unwrap(await sdk.POST('/admin/redemption-codes', { body }), u),
    // List minted codes (optional status filter); newest-first, keyset-paginated.
    listRedemptionCodes: async (
      params: { status?: 'unused' | 'redeemed'; cursor?: string; limit?: number } = {},
    ): Promise<Page<RedemptionCodeView>> =>
      page<RedemptionCodeView>(
        await sdk.GET('/admin/redemption-codes', { params: { query: params } }),
        u,
      ),

    // --- upstream OAuth credentials (BYO paste-auth + turnkey codex login) ---
    listOAuthSessions: async (
      params: { cursor?: string; limit?: number } = {},
    ): Promise<Page<OAuthSessionListView>> =>
      page<OAuthSessionListView>(
        await sdk.GET('/admin/oauth-sessions', { params: { query: params } }),
        u,
      ),
    createOAuthSession: async (body: CreateOAuthSessionBody): Promise<OAuthSessionView> =>
      unwrap(await sdk.POST('/admin/oauth-sessions', { body }), u),
    revokeOAuthSession: async (id: string): Promise<void> => {
      unwrap(await sdk.DELETE('/admin/oauth-sessions/{id}', { params: { path: { id } } }), u);
    },
    // Edit an OAuth session's metadata (name/notes/group) — never the tokens.
    updateOAuthSession: async (
      id: string,
      body: UpdateCredentialMetaBody,
    ): Promise<OAuthSessionListView> =>
      unwrap(await sdk.PATCH('/admin/oauth-sessions/{id}', { params: { path: { id } }, body }), u),
    // Turnkey codex login: start (→ authorize_url + sealed state) then complete (code → session).
    startCodexLogin: async (body: CodexLoginStartBody): Promise<CodexLoginStartView> =>
      unwrap(await sdk.POST('/admin/oauth-sessions/codex/login/start', { body }), u),
    completeCodexLogin: async (body: CodexLoginCompleteBody): Promise<OAuthSessionView> =>
      unwrap(await sdk.POST('/admin/oauth-sessions/codex/login/complete', { body }), u),

    listUsage: async (params: {
      tenantId?: string;
      cursor?: string;
      limit?: number;
    }): Promise<Page<UsageLogView>> =>
      page<UsageLogView>(await sdk.GET('/admin/usage', { params: { query: params } }), u),
    analyticsUsage: async (params: AnalyticsUsageQuery): Promise<UsageRollupView[]> =>
      unwrap(await sdk.GET('/admin/analytics/usage', { params: { query: params } }), u),

    // Authoritative platform counts for the overview KPI band (true count(*)).
    getSummary: async (): Promise<OpsSummaryView> => unwrap(await sdk.GET('/admin/summary'), u),
    // Live ops health: per-channel circuit-breaker state + billable RPM.
    getHealth: async (): Promise<OpsHealthView> => unwrap(await sdk.GET('/admin/health'), u),

    listRelayTraces: async ({
      tenantId,
      jobId,
      providerType,
      channelId,
      from,
      to,
      responseStatus,
      errorsOnly,
      isStream,
      limit,
      cursor,
    }: RelayTraceQuery): Promise<Page<RelayTraceView>> =>
      page<RelayTraceView>(
        await sdk.GET('/admin/relay-traces', {
          params: {
            query: {
              tenantId,
              jobId,
              providerType,
              channelId,
              from,
              to,
              ...(responseStatus !== undefined ? { responseStatus } : {}),
              ...(errorsOnly ? { errorsOnly: 'true' as const } : {}),
              ...(isStream !== undefined
                ? { isStream: isStream ? ('true' as const) : ('false' as const) }
                : {}),
              limit,
              cursor,
            },
          },
        }),
        u,
      ),

    listLedger: async ({ tenantId, cursor, limit }: KeysetParams): Promise<Page<LedgerView>> =>
      page<LedgerView>(
        await sdk.GET('/admin/ledger', { params: { query: { tenantId, cursor, limit } } }),
        u,
      ),

    listPayments: async (tenantId: string, limit?: number): Promise<Page<PaymentIntentView>> =>
      page<PaymentIntentView>(
        await sdk.GET('/admin/payments', { params: { query: { tenantId, limit } } }),
        u,
      ),
  };
}

export type AdminApi = ReturnType<typeof makeAdminApi>;
