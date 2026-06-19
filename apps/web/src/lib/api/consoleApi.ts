import type { ApiClient, PageEnvelope } from './client';
import type {
  ApiKeyCreatedView,
  ConsoleApiKeyView,
  ConsoleCreateApiKeyBody,
  ConsoleIntentView,
  ConsoleJobView,
  ConsoleLedgerView,
  ConsoleModelView,
  ConsoleTopupBody,
  ConsoleUsageView,
  Page,
} from './types';

/**
 * The tenant self-service console client — sibling to `makeAdminApi`, scoped to
 * the caller's OWN tenant (the backend `ConsoleGuard` derives the tenant from
 * the JWT, never from a body/query). Money stays decimal µ-strings.
 */
export function makeConsoleApi(client: ApiClient) {
  return {
    listApiKeys: (): Promise<Page<ConsoleApiKeyView>> =>
      client.getPage<ConsoleApiKeyView>('/console/api-keys'),
    createApiKey: (body: ConsoleCreateApiKeyBody) =>
      client.post<ApiKeyCreatedView>('/console/api-keys', body),
    // Rotate: new plaintext returned once; the old key is disabled server-side.
    rotateApiKey: (id: string) => client.post<ApiKeyCreatedView>(`/console/api-keys/${id}/rotate`),
    // Disable returns 200 with a body (not 204), unlike the admin hard-delete.
    disableApiKey: (id: string) =>
      client.delete<{ id: string; status: string }>(`/console/api-keys/${id}`),

    // `/console/usage` returns TWO independent keyset envelopes; map each.
    usage: async (limit?: number): Promise<ConsoleUsageView> => {
      const raw = await client.get<{
        jobs: PageEnvelope<ConsoleJobView>;
        ledger: PageEnvelope<ConsoleLedgerView>;
      }>('/console/usage', { limit });
      return {
        jobs: { rows: raw.jobs.data, nextCursor: raw.jobs.next_cursor },
        ledger: { rows: raw.ledger.data, nextCursor: raw.ledger.next_cursor },
      };
    },

    listModels: async (): Promise<ConsoleModelView[]> =>
      (await client.getPage<ConsoleModelView>('/console/models')).rows,

    topup: (body: ConsoleTopupBody) =>
      client.post<ConsoleIntentView>('/console/payments/intents', body),
  };
}

export type ConsoleApi = ReturnType<typeof makeConsoleApi>;
