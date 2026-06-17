import type { ApiClient } from './client';
import type {
  AccountView,
  AnalyticsUsageQuery,
  ApiKeyCreatedView,
  ApiKeyView,
  ChannelView,
  CreateAccountBody,
  CreateApiKeyBody,
  CreateChannelBody,
  CreateModelBody,
  CreateModifierBody,
  CreatePricebookBody,
  CreateResourceBody,
  CreateSecretBody,
  CreateTenantBody,
  DifyImportBody,
  DifyImportView,
  GenerateCodesBody,
  JobView,
  LedgerView,
  ModelView,
  ModifierView,
  Page,
  PaymentIntentView,
  PricebookView,
  ResourceView,
  SecretView,
  SyncChannelModelsBody,
  SyncChannelModelsResult,
  TenantView,
  TopupBody,
  UpdateChannelBody,
  UpdateResourceBody,
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

    listJobs: ({ tenantId, cursor, limit }: KeysetParams): Promise<Page<JobView>> =>
      client.getPage<JobView>('/admin/jobs', { tenantId, cursor, limit }),

    createSecret: (body: CreateSecretBody) => client.post<SecretView>('/admin/secrets', body),

    listModels: async () => (await client.getPage<ModelView>('/admin/models')).rows,
    createModel: (body: CreateModelBody) => client.post<ModelView>('/admin/models', body),
    grantModel: (name: string, body: { tenantId: string }) =>
      client.post<{ ok: true }>(`/admin/models/${name}/grants`, body),

    generateCodes: (body: GenerateCodesBody) =>
      client.post<{ codes: string[]; credit_amount: string }>('/admin/redemption-codes', body),

    listUsage: (params: { tenantId?: string; cursor?: string; limit?: number }) =>
      client.getPage<UsageLogView>('/admin/usage', params),
    analyticsUsage: (params: AnalyticsUsageQuery) =>
      client.get<UsageRollupView[]>('/admin/analytics/usage', { ...params }),

    listLedger: ({ tenantId, cursor, limit }: KeysetParams): Promise<Page<LedgerView>> =>
      client.getPage<LedgerView>('/admin/ledger', { tenantId, cursor, limit }),

    listPayments: (tenantId: string, limit?: number): Promise<Page<PaymentIntentView>> =>
      client.getPage<PaymentIntentView>('/admin/payments', { tenantId, limit }),
  };
}

export type AdminApi = ReturnType<typeof makeAdminApi>;
