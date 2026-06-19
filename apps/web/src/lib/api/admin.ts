import type { ApiClient } from './client';
import type {
  AccountView,
  AddGroupChannelBody,
  AnalyticsUsageQuery,
  ApiKeyCreatedView,
  ApiKeyView,
  ChannelView,
  CreateAccountBody,
  CreateApiKeyBody,
  CreateChannelBody,
  CreateModelBody,
  CreateModifierBody,
  CreateOfficialPriceBody,
  CreatePricebookBody,
  CreateResourceBody,
  CreateRouteGroupBody,
  CreateSecretBody,
  CreateTenantBody,
  DifyImportBody,
  DifyImportView,
  GenerateCodesBody,
  JobView,
  LedgerView,
  ModelGrantView,
  ModelView,
  ModifierView,
  OfficialPriceView,
  Page,
  PaymentIntentView,
  PricebookView,
  RelayTraceQuery,
  RelayTraceView,
  ResourceView,
  RouteGroupChannelView,
  RouteGroupView,
  SecretView,
  SyncChannelModelsBody,
  SyncChannelModelsResult,
  TenantView,
  TopupBody,
  UpdateApiKeyGroupBody,
  UpdateChannelBody,
  UpdateModelBody,
  UpdateOfficialPriceBody,
  UpdateResourceBody,
  UpdateRouteGroupBody,
  UsageLogView,
  UsageRollupView,
} from './types';

interface KeysetParams {
  tenantId: string;
  cursor?: string;
  limit?: number;
}

export function makeAdminApi(client: ApiClient) {
  return {
    listTenants: async () => (await client.getPage<TenantView>('/admin/tenants')).rows,
    createTenant: (body: CreateTenantBody, idempotencyKey?: string) =>
      client.post<TenantView>('/admin/tenants', body, { idempotencyKey }),

    listResources: async () => (await client.getPage<ResourceView>('/admin/resources')).rows,
    createResource: (body: CreateResourceBody, idempotencyKey?: string) =>
      client.post<ResourceView>('/admin/resources', body, { idempotencyKey }),
    updateResource: (id: string, body: UpdateResourceBody) =>
      client.patch<ResourceView>(`/admin/resources/${id}`, body),
    createChannel: (resourceId: string, body: CreateChannelBody, idempotencyKey?: string) =>
      client.post<ChannelView>(`/admin/resources/${resourceId}/channels`, body, { idempotencyKey }),
    listChannels: async (resourceId: string) =>
      (await client.getPage<ChannelView>(`/admin/resources/${resourceId}/channels`)).rows,
    updateChannel: (resourceId: string, channelId: string, body: UpdateChannelBody) =>
      client.patch<ChannelView>(`/admin/resources/${resourceId}/channels/${channelId}`, body),
    deleteChannel: (resourceId: string, channelId: string): Promise<void> =>
      client.delete<undefined>(`/admin/resources/${resourceId}/channels/${channelId}`),
    syncChannelModels: (resourceId: string, channelId: string, body: SyncChannelModelsBody) =>
      client.post<SyncChannelModelsResult>(
        `/admin/resources/${resourceId}/channels/${channelId}/sync-models`,
        body,
      ),

    listPricebook: async (resourceId: string) =>
      (await client.getPage<PricebookView>('/admin/pricebook', { resourceId })).rows,
    createPricebook: (body: CreatePricebookBody, idempotencyKey?: string) =>
      client.post<PricebookView>('/admin/pricebook', body, { idempotencyKey }),

    listModifiers: async () => (await client.getPage<ModifierView>('/admin/modifiers')).rows,
    createModifier: (body: CreateModifierBody) =>
      client.post<ModifierView>('/admin/modifiers', body),

    difyImport: (body: DifyImportBody) => client.post<DifyImportView>('/admin/dify/import', body),

    listAccounts: async () => (await client.getPage<AccountView>('/admin/accounts')).rows,
    createAccount: (body: CreateAccountBody) => client.post<AccountView>('/admin/accounts', body),
    topup: (accountId: string, body: TopupBody) =>
      client.post<{ account_id: string; balance: string }>(
        `/admin/accounts/${accountId}/topup`,
        body,
      ),

    listApiKeys: async (tenantId: string) =>
      (await client.getPage<ApiKeyView>('/admin/api-keys', { tenantId })).rows,
    createApiKey: (body: CreateApiKeyBody) =>
      client.post<ApiKeyCreatedView>('/admin/api-keys', body),
    // (Re)bind a key's route group — `routeGroupId: null` unbinds to `default`.
    // PATCH is naturally idempotent, so no Idempotency-Key.
    updateApiKeyGroup: (id: string, body: UpdateApiKeyGroupBody) =>
      client.patch<{ id: string; route_group_id: string | null }>(
        `/admin/api-keys/${id}/group`,
        body,
      ),
    // Revoke (soft-delete) a key — rejected with 401 thereafter. 204 → void.
    deleteApiKey: (id: string): Promise<void> => client.delete<undefined>(`/admin/api-keys/${id}`),

    // --- Route groups (billing/routing) ---
    listRouteGroups: async () => (await client.getPage<RouteGroupView>('/admin/route-groups')).rows,
    createRouteGroup: (body: CreateRouteGroupBody, idempotencyKey?: string) =>
      client.post<RouteGroupView>('/admin/route-groups', body, { idempotencyKey }),
    getRouteGroup: (id: string) => client.get<RouteGroupView>(`/admin/route-groups/${id}`),
    updateRouteGroup: (id: string, body: UpdateRouteGroupBody) =>
      client.patch<RouteGroupView>(`/admin/route-groups/${id}`, body),
    deleteRouteGroup: (id: string): Promise<void> =>
      client.delete<undefined>(`/admin/route-groups/${id}`),
    listGroupChannels: async (id: string) =>
      (await client.getPage<RouteGroupChannelView>(`/admin/route-groups/${id}/channels`)).rows,
    // PUT membership upsert — the PUT verb is the idempotency; never an Idempotency-Key.
    addGroupChannel: (id: string, channelId: string, body: AddGroupChannelBody) =>
      client.put<RouteGroupChannelView>(`/admin/route-groups/${id}/channels/${channelId}`, body),
    removeGroupChannel: (id: string, channelId: string): Promise<void> =>
      client.delete<undefined>(`/admin/route-groups/${id}/channels/${channelId}`),

    // --- Official prices (reference catalog) ---
    listOfficialPrices: async () =>
      (await client.getPage<OfficialPriceView>('/admin/official-prices')).rows,
    createOfficialPrice: (body: CreateOfficialPriceBody, idempotencyKey?: string) =>
      client.post<OfficialPriceView>('/admin/official-prices', body, { idempotencyKey }),
    updateOfficialPrice: (id: string, body: UpdateOfficialPriceBody) =>
      client.patch<OfficialPriceView>(`/admin/official-prices/${id}`, body),
    deleteOfficialPrice: (id: string): Promise<void> =>
      client.delete<undefined>(`/admin/official-prices/${id}`),

    listJobs: ({ tenantId, cursor, limit }: KeysetParams): Promise<Page<JobView>> =>
      client.getPage<JobView>('/admin/jobs', { tenantId, cursor, limit }),

    createSecret: (body: CreateSecretBody) => client.post<SecretView>('/admin/secrets', body),
    listSecrets: async () => (await client.getPage<SecretView>('/admin/secrets')).rows,

    listModels: async () => (await client.getPage<ModelView>('/admin/models')).rows,
    createModel: (body: CreateModelBody, idempotencyKey?: string) =>
      client.post<ModelView>('/admin/models', body, { idempotencyKey }),
    getModel: (name: string) => client.get<ModelView>(`/admin/models/${encodeURIComponent(name)}`),
    // PATCH carries no idempotency key (the client's `patch` has no such option,
    // and PATCH is naturally idempotent — re-applying the same body is a no-op).
    updateModel: (name: string, body: UpdateModelBody) =>
      client.patch<ModelView>(`/admin/models/${encodeURIComponent(name)}`, body),
    deleteModel: (name: string): Promise<void> =>
      client.delete<undefined>(`/admin/models/${encodeURIComponent(name)}`),
    grantModel: (name: string, body: { tenantId: string }, idempotencyKey?: string) =>
      client.post<{ ok: true }>(`/admin/models/${encodeURIComponent(name)}/grants`, body, {
        idempotencyKey,
      }),
    listModelGrants: async (name: string) =>
      (await client.getPage<ModelGrantView>(`/admin/models/${encodeURIComponent(name)}/grants`))
        .rows,
    revokeModelGrant: (name: string, tenantId: string): Promise<void> =>
      client.delete<undefined>(
        `/admin/models/${encodeURIComponent(name)}/grants/${encodeURIComponent(tenantId)}`,
      ),

    generateCodes: (body: GenerateCodesBody) =>
      client.post<{ codes: string[]; credit_amount: string }>('/admin/redemption-codes', body),

    listUsage: (params: { tenantId?: string; cursor?: string; limit?: number }) =>
      client.getPage<UsageLogView>('/admin/usage', params),
    analyticsUsage: (params: AnalyticsUsageQuery) =>
      client.get<UsageRollupView[]>('/admin/analytics/usage', { ...params }),

    // Upstream relay audit traces — cursor-paginated, filterable, token-redacted.
    listRelayTraces: ({
      tenantId,
      jobId,
      providerType,
      channelId,
      from,
      to,
      limit,
      cursor,
    }: RelayTraceQuery): Promise<Page<RelayTraceView>> =>
      client.getPage<RelayTraceView>('/admin/relay-traces', {
        tenantId,
        jobId,
        providerType,
        channelId,
        from,
        to,
        limit,
        cursor,
      }),

    listLedger: ({ tenantId, cursor, limit }: KeysetParams): Promise<Page<LedgerView>> =>
      client.getPage<LedgerView>('/admin/ledger', { tenantId, cursor, limit }),

    listPayments: (tenantId: string, limit?: number): Promise<Page<PaymentIntentView>> =>
      client.getPage<PaymentIntentView>('/admin/payments', { tenantId, limit }),
  };
}

export type AdminApi = ReturnType<typeof makeAdminApi>;
