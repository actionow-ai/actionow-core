import type { ApiClient, PageEnvelope } from './client';
import type { SdkClient } from './sdkClient';
import { page, unwrap } from './sdkClient';
import type {
  ApiKeyCreatedView,
  ConsoleAnalyticsQuery,
  ConsoleApiKeyView,
  ConsoleBalanceView,
  ConsoleChangePasswordBody,
  ConsoleCreateApiKeyBody,
  ConsoleIntentView,
  ConsoleJobView,
  ConsoleLedgerView,
  ConsoleMeView,
  ConsoleModelView,
  ConsolePaymentView,
  ConsoleTopupBody,
  ConsoleUsageLogView,
  ConsoleUsageView,
  Page,
  UsageRollupView,
} from './types';

/**
 * The tenant self-service console client — sibling to `makeAdminApi`, scoped to
 * the caller's OWN tenant (the backend `ConsoleGuard` derives the tenant from
 * the JWT, never from a body/query). The bulk goes through the typed SDK; the
 * `/console/usage` composite, the wider-`provider` topup body, and the
 * `{ ok: true }` change-password return stay on the raw client (annotated).
 * Money stays decimal µ-strings.
 */
export function makeConsoleApi(sdk: SdkClient, rawClient: ApiClient, onUnauthorized: () => void) {
  const u = onUnauthorized;
  return {
    listApiKeys: async (): Promise<Page<ConsoleApiKeyView>> =>
      page<ConsoleApiKeyView>(await sdk.GET('/console/api-keys'), u),
    createApiKey: async (body: ConsoleCreateApiKeyBody): Promise<ApiKeyCreatedView> =>
      unwrap(await sdk.POST('/console/api-keys', { body }), u),
    // Rotate: new plaintext returned once; the old key is disabled server-side.
    // No request body — the `{id}` path identifies the key.
    rotateApiKey: async (id: string): Promise<ApiKeyCreatedView> =>
      unwrap(await sdk.POST('/console/api-keys/{id}/rotate', { params: { path: { id } } }), u),
    // Disable returns 200 with a body (not 204), unlike the admin hard-delete.
    disableApiKey: async (id: string): Promise<{ id: string; status: string }> =>
      unwrap(await sdk.DELETE('/console/api-keys/{id}', { params: { path: { id } } }), u),

    // HYBRID: `/console/usage` returns TWO independent keyset envelopes in one
    // composite body (`{ jobs, ledger }`); that bespoke shape isn't worth a custom
    // OpenAPI schema, so it stays on the raw client and is remapped here.
    usage: async (limit?: number): Promise<ConsoleUsageView> => {
      const raw = await rawClient.get<{
        jobs: PageEnvelope<ConsoleJobView>;
        ledger: PageEnvelope<ConsoleLedgerView>;
      }>('/console/usage', { limit });
      return {
        jobs: { rows: raw.jobs.data, nextCursor: raw.jobs.next_cursor },
        ledger: { rows: raw.ledger.data, nextCursor: raw.ledger.next_cursor },
      };
    },

    listModels: async (): Promise<ConsoleModelView[]> =>
      page<ConsoleModelView>(await sdk.GET('/console/models'), u).rows,

    // Tenant usage rollups (raw array, like the admin analytics route).
    analyticsUsage: async (params: ConsoleAnalyticsQuery): Promise<UsageRollupView[]> =>
      unwrap(await sdk.GET('/console/analytics/usage', { params: { query: params } }), u),
    // Per-call usage log — cursor-paginated keyset.
    usageLog: async (params: {
      cursor?: string;
      limit?: number;
    }): Promise<Page<ConsoleUsageLogView>> =>
      page<ConsoleUsageLogView>(
        await sdk.GET('/console/usage-log', { params: { query: params } }),
        u,
      ),

    // HYBRID: the topup form holds `provider` as a plain `string` (a
    // SegmentedControl), wider than the contract body's `provider` enum, so the
    // typed SDK POST would reject it — keep on raw (see `ConsoleTopupBody`).
    topup: (body: ConsoleTopupBody): Promise<ConsoleIntentView> =>
      rawClient.post<ConsoleIntentView>('/console/payments/intents', body),
    // Topup history — cursor-paginated.
    listPayments: async (params: {
      cursor?: string;
      limit?: number;
    }): Promise<Page<ConsolePaymentView>> =>
      page<ConsolePaymentView>(
        await sdk.GET('/console/payments', { params: { query: params } }),
        u,
      ),

    // Tenant credit balance + held (dedicated endpoint).
    balance: async (): Promise<ConsoleBalanceView> => unwrap(await sdk.GET('/console/balance'), u),

    // Profile + self-serve change-password.
    me: async (): Promise<ConsoleMeView> => unwrap(await sdk.GET('/console/me'), u),
    // HYBRID: the backend returns `{ ok: true }` (200), but the registered path is
    // a no-body 204; keep on raw to preserve the exact `{ ok: true }` return.
    changePassword: (body: ConsoleChangePasswordBody) =>
      rawClient.patch<{ ok: true }>('/console/settings', body),
  };
}

export type ConsoleApi = ReturnType<typeof makeConsoleApi>;
