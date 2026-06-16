import type { ApiClient } from './client';
import type {
  AccountView,
  ApiKeyCreatedView,
  ApiKeyView,
  ChannelView,
  CreateAccountBody,
  CreateApiKeyBody,
  CreateChannelBody,
  CreateModifierBody,
  CreatePricebookBody,
  CreateResourceBody,
  CreateTenantBody,
  DifyImportBody,
  DifyImportView,
  JobView,
  ModifierView,
  Page,
  PricebookView,
  ResourceView,
  TenantView,
  TopupBody,
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
  };
}

export type AdminApi = ReturnType<typeof makeAdminApi>;
