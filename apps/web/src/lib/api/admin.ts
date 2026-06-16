import type { ApiClient } from './client';
import type {
  AccountView,
  ApiKeyCreatedView,
  ApiKeyView,
  CreateAccountBody,
  CreateApiKeyBody,
  CreateTenantBody,
  JobView,
  Page,
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
