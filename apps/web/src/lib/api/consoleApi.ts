import type { ApiClient } from './client';
import type { SdkClient } from './sdkClient';
import { page, unwrap } from './sdkClient';
import type {
  ApiKeyCreatedView,
  ConsoleAnalyticsQuery,
  ConsoleApiKeyView,
  ConsoleBalanceView,
  ConsoleChangePasswordBody,
  ConsoleCreateApiKeyBody,
  ConsoleCreateIntentBody,
  ConsoleFileView,
  ConsoleIntentView,
  ConsoleMeView,
  ConsoleModelView,
  ConsolePaymentView,
  ConsoleUsageLogView,
  ConsoleUsageRollupView,
  ConsoleUsageView,
  Page,
} from './types';

/**
 * The tenant self-service console client — sibling to `makeAdminApi`, scoped to
 * the caller's OWN tenant (the backend `ConsoleGuard` derives the tenant from
 * the JWT, never from a body/query). Everything goes through the typed SDK
 * except the `{ ok: true }` change-password return, which stays on the raw
 * client (annotated). Money stays decimal µ-strings.
 */
export function makeConsoleApi(sdk: SdkClient, rawClient: ApiClient, onUnauthorized: () => void) {
  const u = onUnauthorized;
  return {
    listApiKeys: async (
      params: { cursor?: string; limit?: number } = {},
    ): Promise<Page<ConsoleApiKeyView>> =>
      page<ConsoleApiKeyView>(await sdk.GET('/console/api-keys', { params: { query: params } }), u),
    createApiKey: async (body: ConsoleCreateApiKeyBody): Promise<ApiKeyCreatedView> =>
      unwrap(await sdk.POST('/console/api-keys', { body }), u),
    // Rotate: new plaintext returned once; the old key is disabled server-side.
    // No request body — the `{id}` path identifies the key.
    rotateApiKey: async (id: string): Promise<ApiKeyCreatedView> =>
      unwrap(await sdk.POST('/console/api-keys/{id}/rotate', { params: { path: { id } } }), u),
    // Disable returns 200 with a body (not 204), unlike the admin hard-delete.
    disableApiKey: async (id: string): Promise<{ id: string; status: string }> =>
      unwrap(await sdk.DELETE('/console/api-keys/{id}', { params: { path: { id } } }), u),

    // `/console/usage` returns TWO independent keyset envelopes in one composite
    // body (`{ jobs, ledger }`) — a registered OpenAPI schema, remapped here into
    // the FE `Page` shape (the only place two keysets share one response).
    usage: async (limit?: number): Promise<ConsoleUsageView> => {
      const raw = unwrap(await sdk.GET('/console/usage', { params: { query: { limit } } }), u);
      return {
        jobs: { rows: raw.jobs.data, nextCursor: raw.jobs.next_cursor },
        ledger: { rows: raw.ledger.data, nextCursor: raw.ledger.next_cursor },
      };
    },

    listModels: async (): Promise<ConsoleModelView[]> =>
      page<ConsoleModelView>(await sdk.GET('/console/models'), u).rows,

    // Tenant usage rollups (raw array, like the admin analytics route). The
    // tenant view OMITS provider_cost/margin — no platform-markup leak.
    analyticsUsage: async (params: ConsoleAnalyticsQuery): Promise<ConsoleUsageRollupView[]> =>
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

    // Topup: the form narrows `provider` to the contract's payment-provider enum
    // (`ConsoleCreateIntentBody`), so the typed SDK POST accepts it directly.
    topup: async (body: ConsoleCreateIntentBody): Promise<ConsoleIntentView> =>
      unwrap(await sdk.POST('/console/payments/intents', { body }), u),
    // One payment intent's status (poll after a topup to confirm settlement).
    getPaymentIntent: async (id: string): Promise<ConsolePaymentView> =>
      unwrap(await sdk.GET('/console/payments/intents/{id}', { params: { path: { id } } }), u),
    // Topup history — cursor-paginated.
    listPayments: async (params: {
      cursor?: string;
      limit?: number;
    }): Promise<Page<ConsolePaymentView>> =>
      page<ConsolePaymentView>(
        await sdk.GET('/console/payments', { params: { query: params } }),
        u,
      ),

    // Asset gallery: the tenant's ready media files (uploaded + generated),
    // cursor-paginated, optionally narrowed to a media kind.
    listFiles: async (params: {
      cursor?: string;
      limit?: number;
      kind?: 'image' | 'video' | 'audio';
    }): Promise<Page<ConsoleFileView>> =>
      page<ConsoleFileView>(await sdk.GET('/console/files', { params: { query: params } }), u),

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
