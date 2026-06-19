import createClient, { type Client } from 'openapi-fetch';

import type { components, paths } from './generated/openapi.js';

export type { components, paths };

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
