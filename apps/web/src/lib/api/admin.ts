import type { ApiClient } from './client';
import type { SdkClient } from './sdkClient';
import { page, unwrap } from './sdkClient';
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

    listPricebook: async (resourceId: string) =>
      page<PricebookView>(
        await sdk.GET('/admin/pricebook', { params: { query: { resourceId } } }),
        u,
      ).rows,
    createPricebook: async (body: CreatePricebookBody, idempotencyKey?: string) =>
      unwrap(await sdk.POST('/admin/pricebook', { body, headers: idem(idempotencyKey) }), u),

    listModifiers: async () => page<ModifierView>(await sdk.GET('/admin/modifiers'), u).rows,
    createModifier: async (body: CreateModifierBody) =>
      unwrap(await sdk.POST('/admin/modifiers', { body }), u),

    // HYBRID: the dify-import response (`DifyImportView`) isn't a registered path
    // response (the import path declares only a 201 with no body schema).
    difyImport: (body: DifyImportBody) =>
      rawClient.post<DifyImportView>('/admin/dify/import', body),

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
    listOfficialPrices: async () =>
      page<OfficialPriceView>(await sdk.GET('/admin/official-prices'), u).rows,
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

    listModels: async () => page<ModelView>(await sdk.GET('/admin/models'), u).rows,
    createModel: async (body: CreateModelBody, idempotencyKey?: string) =>
      unwrap(await sdk.POST('/admin/models', { body, headers: idem(idempotencyKey) }), u),
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

    // HYBRID: the redemption-codes POST returns `{ codes, credit_amount }`, which
    // the path doesn't declare as a response body — keep on raw.
    generateCodes: (body: GenerateCodesBody) =>
      rawClient.post<{ codes: string[]; credit_amount: string }>('/admin/redemption-codes', body),

    listUsage: async (params: {
      tenantId?: string;
      cursor?: string;
      limit?: number;
    }): Promise<Page<UsageLogView>> =>
      page<UsageLogView>(await sdk.GET('/admin/usage', { params: { query: params } }), u),
    analyticsUsage: async (params: AnalyticsUsageQuery): Promise<UsageRollupView[]> =>
      unwrap(await sdk.GET('/admin/analytics/usage', { params: { query: params } }), u),

    // HYBRID: relay traces have no contract view schema (`RelayTraceView` is an
    // FE-local interface, not migrated into @actionow/contracts) — keep on raw.
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
      rawClient.getPage<RelayTraceView>('/admin/relay-traces', {
        tenantId,
        jobId,
        providerType,
        channelId,
        from,
        to,
        limit,
        cursor,
      }),

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
