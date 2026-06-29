import createClient, { type Client } from 'openapi-fetch';

import type { components, paths } from './generated/openapi.js';

export type { components, paths };

/**
 * Ergonomic data-plane helpers (additive to the generated typed client). They
 * wrap the few flows where a raw `openapi-fetch` call is awkward: the async-job
 * submit→poll loop, SSE streaming, and inbound-webhook signature verification.
 */
export {
  consumeJobStream,
  type ConsumeJobStreamOptions,
  type JobProgressEvent,
  type JobStreamFrame,
} from './job-stream.js';
export { consumeSse, SSE_DONE, type SseFrame } from './sse.js';
export {
  ActionowApiError,
  isTerminalJobStatus,
  JobTimeoutError,
  submitAndWait,
  type SubmitAndWaitOptions,
} from './submit-and-wait.js';
export {
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookVerification,
} from './webhook.js';

/**
 * The contract model types — the SAME single source the backend `.parse()`s and
 * the frontend imports (via @actionow/contracts), here surfaced from the
 * generated OpenAPI types so an external SDK consumer gets identical shapes.
 */
type Schemas = components['schemas'];
export type TenantView = Schemas['TenantView'];
export type AccountView = Schemas['AccountView'];
export type ResourceView = Schemas['ResourceView'];
export type ChannelView = Schemas['ChannelView'];
export type ModelView = Schemas['ModelView'];
export type ModelGrantView = Schemas['ModelGrantView'];
export type PricebookView = Schemas['PricebookView'];
export type ModifierView = Schemas['ModifierView'];
// admin operational views
export type ApiKeyView = Schemas['ApiKeyView'];
export type JobView = Schemas['JobView'];
export type LedgerView = Schemas['LedgerView'];
export type UsageLogView = Schemas['UsageLogView'];
export type UsageRollupView = Schemas['UsageRollupView'];
export type PaymentIntentView = Schemas['PaymentIntentView'];
export type SecretView = Schemas['SecretView'];
export type DifyImportView = Schemas['DifyImportView'];
export type RedemptionCodeView = Schemas['RedemptionCodeView'];
export type RedeemCodesResult = Schemas['RedeemCodesResult'];
// upstream OAuth subscription sessions (credential management)
export type OAuthSessionView = Schemas['OAuthSessionView'];
export type OAuthSessionListView = Schemas['OAuthSessionListView'];
export type CodexLoginStartView = Schemas['CodexLoginStartView'];
// billing & routing views
export type RouteGroupView = Schemas['RouteGroupView'];
export type RouteGroupChannelView = Schemas['RouteGroupChannelView'];
export type OfficialPriceView = Schemas['OfficialPriceView'];
// tenant console views
export type ConsoleApiKeyView = Schemas['ConsoleApiKeyView'];
export type ConsoleJobView = Schemas['ConsoleJobView'];
export type ConsoleLedgerView = Schemas['ConsoleLedgerView'];
export type ConsoleModelView = Schemas['ConsoleModelView'];
export type ConsoleUsageLogView = Schemas['ConsoleUsageLogView'];
export type ConsolePaymentView = Schemas['ConsolePaymentView'];
export type ConsoleMeView = Schemas['ConsoleMeView'];
export type ConsoleBalanceView = Schemas['ConsoleBalanceView'];
export type ConsoleIntentView = Schemas['ConsoleIntentView'];
export type ConsoleFileView = Schemas['ConsoleFileView'];
/** The uniform error envelope returned on any non-2xx (the `error` branch of a result). */
export type ErrorView = Schemas['ErrorView'];
// data-plane views + bodies (the generation hot path: /v1/run, /v1/jobs, /v1/resources, /v1/files)
export type RunResponse = Schemas['RunResponse'];
export type RunJobView = Schemas['RunJobView'];
export type ResourceSummary = Schemas['ResourceSummary'];
export type ResourceDetail = Schemas['ResourceDetail'];
export type PresignUploadResult = Schemas['PresignUploadResult'];
export type FileView = Schemas['FileView'];
export type FileUrlResult = Schemas['FileUrlResult'];

/**
 * The contract REQUEST-BODY types — the SAME single source the backend `ZodBody`
 * validates and the frontend imports, surfaced here so an external SDK consumer
 * builds POST/PATCH/PUT bodies with identical shapes. Request money/credit fields
 * are HUMAN amounts (numbers); only RESPONSE money is a string.
 */
// admin core (admin-requests)
export type CreateTenantBody = Schemas['CreateTenantBody'];
export type UpdateTenantBody = Schemas['UpdateTenantBody'];
export type CreateAccountBody = Schemas['CreateAccountBody'];
export type TopupBody = Schemas['TopupBody'];
export type CreateApiKeyBody = Schemas['CreateApiKeyBody'];
export type UpdateApiKeyGroupBody = Schemas['UpdateApiKeyGroupBody'];
export type CreateSecretBody = Schemas['CreateSecretBody'];
export type GenerateCodesBody = Schemas['GenerateCodesBody'];
export type CreateOAuthSessionBody = Schemas['CreateOAuthSessionBody'];
export type CodexLoginStartBody = Schemas['CodexLoginStartBody'];
export type CodexLoginCompleteBody = Schemas['CodexLoginCompleteBody'];
// catalog (catalog-requests)
export type CreateResourceBody = Schemas['CreateResourceBody'];
export type UpdateResourceBody = Schemas['UpdateResourceBody'];
export type CreateChannelBody = Schemas['CreateChannelBody'];
export type UpdateChannelBody = Schemas['UpdateChannelBody'];
export type SyncChannelModelsBody = Schemas['SyncChannelModelsBody'];
export type CreatePricebookBody = Schemas['CreatePricebookBody'];
export type UpdatePricebookBody = Schemas['UpdatePricebookBody'];
export type CreateModifierBody = Schemas['CreateModifierBody'];
export type UpdateModifierBody = Schemas['UpdateModifierBody'];
export type DifyImportBody = Schemas['DifyImportBody'];
export type CreateModelBody = Schemas['CreateModelBody'];
export type UpdateModelBody = Schemas['UpdateModelBody'];
export type GrantModelBody = Schemas['GrantModelBody'];
// billing & routing (billing-requests)
export type CreateRouteGroupBody = Schemas['CreateRouteGroupBody'];
export type UpdateRouteGroupBody = Schemas['UpdateRouteGroupBody'];
export type AddGroupChannelBody = Schemas['AddGroupChannelBody'];
export type CreateOfficialPriceBody = Schemas['CreateOfficialPriceBody'];
export type UpdateOfficialPriceBody = Schemas['UpdateOfficialPriceBody'];
// tenant console (console-requests)
export type ConsoleCreateApiKeyBody = Schemas['ConsoleCreateApiKeyBody'];
export type ConsoleCreateIntentBody = Schemas['ConsoleCreateIntentBody'];
export type ConsoleChangePasswordBody = Schemas['ConsoleChangePasswordBody'];
// data-plane (data-plane)
export type RunBody = Schemas['RunBody'];
export type PresignUploadBody = Schemas['PresignUploadBody'];

export interface ActionowClientOptions {
  /** API origin, e.g. `https://gateway.example.com`. */
  baseUrl?: string;
  /** Bearer token for the admin control plane (JWT today; service token later). */
  token?: string;
  /** Override the global fetch (tests, custom agents). */
  fetch?: typeof fetch;
  /** Extra default headers. */
  headers?: Record<string, string>;
}

/**
 * Create a typed Actionow control-plane client. Every path / method / response is
 * typed straight from the OpenAPI contract (generated from the zod schemas), so
 * e.g. `client.GET('/admin/models')` returns the paginated `ModelView` envelope
 * with no hand-written types. Pass `token` to send `Authorization: Bearer`.
 *
 * @example
 * const api = createActionowClient({ baseUrl: 'https://gw.acme.com', token });
 * const { data, error } = await api.GET('/admin/models');
 * data?.data.forEach((m) => console.log(m.name, m.input_price)); // input_price: string (µcredit)
 */
export function createActionowClient(options: ActionowClientOptions = {}): Client<paths> {
  const { token, headers, ...rest } = options;
  return createClient<paths>({
    ...rest,
    headers: {
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      ...headers,
    },
  });
}
