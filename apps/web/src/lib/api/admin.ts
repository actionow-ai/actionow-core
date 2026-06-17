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
  TenantView,
  TopupBody,
  UpdateChannelBody,
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
    listTenants: () => client.get<TenantView[]>('/admin/tenants'),
    createTenant: (body: CreateTenantBody) => client.post<TenantView>('/admin/tenants', body),

    listResources: () => client.get<ResourceView[]>('/admin/resources'),
    createResource: (body: CreateResourceBody) =>
      client.post<ResourceView>('/admin/resources', body),
    createChannel: (resourceId: string, body: CreateChannelBody) =>
      client.post<ChannelView>(`/admin/resources/${resourceId}/channels`, body),
    listChannels: (resourceId: string) =>
      client.get<ChannelView[]>(`/admin/resources/${resourceId}/channels`),
    updateChannel: (resourceId: string, channelId: string, body: UpdateChannelBody) =>
      client.patch<ChannelView>(`/admin/resources/${resourceId}/channels/${channelId}`, body),

    listPricebook: (resourceId: string) =>
      client.get<PricebookView[]>('/admin/pricebook', { resourceId }),
    createPricebook: (body: CreatePricebookBody) =>
      client.post<PricebookView>('/admin/pricebook', body),

    listModifiers: () => client.get<ModifierView[]>('/admin/modifiers'),
    createModifier: (body: CreateModifierBody) =>
      client.post<ModifierView>('/admin/modifiers', body),

    difyImport: (body: DifyImportBody) => client.post<DifyImportView>('/admin/dify/import', body),

    createAccount: (body: CreateAccountBody) => client.post<AccountView>('/admin/accounts', body),
    topup: (accountId: string, body: TopupBody) =>
      client.post<{ account_id: string; balance: string }>(
        `/admin/accounts/${accountId}/topup`,
        body,
      ),

    listApiKeys: (tenantId: string) => client.get<ApiKeyView[]>('/admin/api-keys', { tenantId }),
    createApiKey: (body: CreateApiKeyBody) =>
      client.post<ApiKeyCreatedView>('/admin/api-keys', body),

    listJobs: async ({ tenantId, cursor, limit }: KeysetParams): Promise<Page<JobView>> => {
      const r = await client.get<{ jobs: JobView[]; next_cursor: string | null }>('/admin/jobs', {
        tenantId,
        cursor,
        limit,
      });
      return { rows: r.jobs, nextCursor: r.next_cursor };
    },

    createSecret: (body: CreateSecretBody) => client.post<SecretView>('/admin/secrets', body),

    listModels: () => client.get<ModelView[]>('/admin/models'),
    createModel: (body: CreateModelBody) => client.post<ModelView>('/admin/models', body),
    grantModel: (name: string, body: { tenantId: string }) =>
      client.post<{ ok: true }>(`/admin/models/${name}/grants`, body),

    generateCodes: (body: GenerateCodesBody) =>
      client.post<{ codes: string[]; credit_amount: string }>('/admin/redemption-codes', body),

    listUsage: (params: { limit?: number }) =>
      client.get<{ logs: UsageLogView[] }>('/admin/usage', params),
    analyticsUsage: (params: AnalyticsUsageQuery) =>
      client.get<UsageRollupView[]>('/admin/analytics/usage', { ...params }),

    listLedger: async ({ tenantId, cursor, limit }: KeysetParams): Promise<Page<LedgerView>> => {
      const r = await client.get<{ transactions: LedgerView[]; next_cursor: string | null }>(
        '/admin/ledger',
        { tenantId, cursor, limit },
      );
      return { rows: r.transactions, nextCursor: r.next_cursor };
    },

    listPayments: (tenantId: string, limit?: number) =>
      client.get<{ intents: PaymentIntentView[] }>('/admin/payments', { tenantId, limit }),
  };
}

export type AdminApi = ReturnType<typeof makeAdminApi>;
