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
  ConsoleCreateUserBody,
  ConsoleFileView,
  ConsoleIntentView,
  ConsoleLimitStatusView,
  ConsoleMeView,
  ConsoleModelView,
  ConsolePaymentView,
  ConsoleUpdateUserBody,
  ConsoleUsageLogView,
  ConsoleUsageRollupView,
  ConsoleUsageView,
  ConsoleUserView,
  CreateSubAccountBody,
  CreateSubjectBody,
  FileView,
  LimitPlanView,
  Page,
  PresignUploadBody,
  PresignUploadResult,
  SubAccountView,
  SubjectView,
  TopupSubAccountBody,
  TransferCreditsBody,
  UpdateSubjectBody,
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

    // Upload: presign → the caller PUTs the bytes to `upload_url` → confirm.
    presignUpload: async (body: PresignUploadBody): Promise<PresignUploadResult> =>
      unwrap(await sdk.POST('/console/files/presign-upload', { body }), u),
    confirmFile: async (id: string): Promise<FileView> =>
      unwrap(await sdk.POST('/console/files/{id}/confirm', { params: { path: { id } } }), u),

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
    // Your tenant governance status (bound plan, usage-vs-cap, alerts). RAW: this
    // console route isn't in the generated SDK path set, but its view is a
    // contract type.
    limits: (): Promise<ConsoleLimitStatusView> =>
      rawClient.get<ConsoleLimitStatusView>('/console/limits'),

    // --- Tenant-org sub-users (RBAC v1, tenant-admin-only). RAW: these console
    // routes aren't in the generated SDK path set (matching the limit-plan /
    // audit-log precedent), but their bodies/views are contract types. The
    // TenantAdminGuard enforces the 403 server-side; the FE additionally hides
    // these controls from members (UX-only gate, never the security boundary). ---
    // List unwraps the keyset envelope's `data` (like `admin.listAuditLog`);
    // the Members page renders a non-paginated DataTable of the tenant's seats.
    listUsers: async (): Promise<ConsoleUserView[]> => {
      const env = await rawClient.get<{
        data: ConsoleUserView[];
        next_cursor: string | null;
      }>('/console/users');
      return env.data;
    },
    // Create returns `{ id, email }` ONLY (the server never echoes the password).
    createUser: (body: ConsoleCreateUserBody): Promise<{ id: string; email: string }> =>
      rawClient.post<{ id: string; email: string }>('/console/users', body),
    // Promote/demote (`tenantRole`) and/or soft-disable (`status`) a sub-user.
    updateUser: (id: string, body: ConsoleUpdateUserBody): Promise<ConsoleUserView> =>
      rawClient.patch<ConsoleUserView>(`/console/users/${id}`, body),
    // Disable returns `{ id, status: 'disabled' }` (200, not a 204) — return void.
    disableUser: async (id: string): Promise<void> => {
      await rawClient.delete<{ id: string; status: string }>(`/console/users/${id}`);
    },

    // --- Tenant end-users (subjects) + their HARD sub-wallets + 额度套餐 binding
    // (end-user data plane, tenant-admin-only). RAW: these console routes aren't in
    // the generated SDK path set (matching the limit-plan / RBAC sub-user
    // precedent), but their bodies/views are contract types. The backend
    // TenantAdminGuard enforces the 403; the caller's token scopes the tenant
    // (never a body field — a cross-tenant id → 404). The FE additionally hides
    // these controls from members (UX-only gate, never the security boundary). ---
    // List unwraps the keyset envelope's `data` (like `listUsers`); the Subjects
    // page renders a non-paginated DataTable of the tenant's end-users.
    listSubjects: async (): Promise<SubjectView[]> => {
      const env = await rawClient.get<{
        data: SubjectView[];
        next_cursor: string | null;
      }>('/console/subjects');
      return env.data;
    },
    createSubject: (body: CreateSubjectBody): Promise<SubjectView> =>
      rawClient.post<SubjectView>('/console/subjects', body),
    updateSubject: (id: string, body: UpdateSubjectBody): Promise<SubjectView> =>
      rawClient.patch<SubjectView>(`/console/subjects/${id}`, body),
    // Soft-delete + cascade (sweep sub-wallet, disable scoped keys). Returns
    // `{ id, status: 'deleted' }` (200, not a 204) — return void.
    deleteSubject: async (id: string): Promise<void> => {
      await rawClient.delete<{ id: string; status: string }>(`/console/subjects/${id}`);
    },
    // Bind/unbind a subject's 额度套餐 (`planId: null` clears). Both subject AND
    // plan are intersected with your tenant scope server-side (cross-tenant → 404).
    setSubjectLimitPlan: (id: string, planId: string | null): Promise<{ ok: true }> =>
      rawClient.post<{ ok: true }>(`/console/subjects/${id}/limit-plan`, { planId }),

    // HARD sub-wallet for one subject. GET 404s when no wallet is open yet — the
    // page maps that to `null` (not an error). Open path is `.../sub-account/open`.
    getSubAccount: (id: string): Promise<SubAccountView> =>
      rawClient.get<SubAccountView>(`/console/subjects/${id}/sub-account`),
    openSubAccount: (id: string, body: CreateSubAccountBody): Promise<SubAccountView> =>
      rawClient.post<SubAccountView>(`/console/subjects/${id}/sub-account/open`, body),
    topupSubAccount: (id: string, body: TopupSubAccountBody): Promise<SubAccountView> =>
      rawClient.post<SubAccountView>(`/console/subjects/${id}/sub-account/topup`, body),
    transferSubAccount: (id: string, body: TransferCreditsBody): Promise<SubAccountView> =>
      rawClient.post<SubAccountView>(`/console/subjects/${id}/sub-account/transfer`, body),

    // Tenant-owned 额度套餐 (limit plans) — drives the plan-binding select on the
    // Subjects page (Task 9 builds the full plans CRUD on this same surface).
    listLimitPlans: (): Promise<LimitPlanView[]> =>
      rawClient.get<LimitPlanView[]>('/console/limit-plans'),
  };
}

export type ConsoleApi = ReturnType<typeof makeConsoleApi>;
