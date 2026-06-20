import {
  extendZodWithOpenApi,
  OpenApiGeneratorV3,
  OpenAPIRegistry,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import {
  createAccountSchema,
  createApiKeySchema,
  createSecretSchema,
  createTenantSchema,
  generateCodesSchema,
  topupSchema,
  updateApiKeyGroupSchema,
  updateTenantSchema,
} from './admin-requests.js';
import { accountViewSchema, tenantViewSchema } from './admin-views.js';
import {
  addGroupChannelSchema,
  createOfficialPriceSchema,
  createRouteGroupSchema,
  updateOfficialPriceSchema,
  updateRouteGroupSchema,
} from './billing-requests.js';
import {
  officialPriceViewSchema,
  routeGroupChannelViewSchema,
  routeGroupViewSchema,
} from './billing-views.js';
import {
  createChannelSchema,
  createModelSchema,
  createModifierSchema,
  createPricebookSchema,
  createResourceSchema,
  difyImportSchema,
  grantModelSchema,
  syncChannelModelsSchema,
  updateChannelSchema,
  updateModelSchema,
  updateModifierSchema,
  updatePricebookSchema,
  updateResourceSchema,
} from './catalog-requests.js';
import {
  channelViewSchema,
  modelGrantViewSchema,
  modelViewSchema,
  modifierViewSchema,
  pricebookViewSchema,
  resourceViewSchema,
} from './catalog-views.js';
import {
  consoleChangePasswordSchema,
  consoleCreateApiKeySchema,
  consoleCreateIntentSchema,
} from './console-requests.js';
import {
  consoleApiKeyViewSchema,
  consoleBalanceViewSchema,
  consoleIntentViewSchema,
  consoleJobViewSchema,
  consoleLedgerViewSchema,
  consoleMeViewSchema,
  consoleModelViewSchema,
  consolePaymentViewSchema,
  consoleUsageLogViewSchema,
} from './console-views.js';
import {
  apiKeyViewSchema,
  difyImportViewSchema,
  jobViewSchema,
  ledgerViewSchema,
  paymentIntentViewSchema,
  secretViewSchema,
  usageLogViewSchema,
  usageRollupViewSchema,
} from './ops-views.js';

/**
 * BUILD-TIME ONLY. This module turns the pure zod view contracts into an OpenAPI
 * v3 document — the B2 leg of the contract-first pipeline (zod → OpenAPI → SDK).
 * It is intentionally NOT re-exported from `index.ts`, so neither the frontend
 * (type-only consumer) nor the backend ever pulls `@asteasolutions/zod-to-openapi`
 * into their bundles; only `scripts/gen-openapi.ts` imports it.
 */
extendZodWithOpenApi(z);

/** The paginated list envelope `mapPageEnvelope` serves: `{ data, next_cursor, has_more }`. */
function pageOf(item: z.ZodTypeAny): z.ZodTypeAny {
  return z.object({
    data: z.array(item),
    next_cursor: z.string().nullable(),
    has_more: z.boolean(),
  });
}

/** Build the OpenAPI v3 document from the zod contracts (the single source of truth). */
export function buildOpenApiDocument(): ReturnType<OpenApiGeneratorV3['generateDocument']> {
  const registry = new OpenAPIRegistry();

  // --- component schemas (named) derived from the migrated contracts ---
  const Tenant = registry.register('TenantView', tenantViewSchema);
  const Account = registry.register('AccountView', accountViewSchema);
  const Resource = registry.register('ResourceView', resourceViewSchema);
  const Channel = registry.register('ChannelView', channelViewSchema);
  const Model = registry.register('ModelView', modelViewSchema);
  registry.register('ModelGrantView', modelGrantViewSchema);
  const Pricebook = registry.register('PricebookView', pricebookViewSchema);
  const Modifier = registry.register('ModifierView', modifierViewSchema);

  // admin operational views (ops-views)
  const ApiKey = registry.register('ApiKeyView', apiKeyViewSchema);
  const Job = registry.register('JobView', jobViewSchema);
  const Ledger = registry.register('LedgerView', ledgerViewSchema);
  const UsageLog = registry.register('UsageLogView', usageLogViewSchema);
  registry.register('UsageRollupView', usageRollupViewSchema);
  const Payment = registry.register('PaymentIntentView', paymentIntentViewSchema);
  registry.register('SecretView', secretViewSchema);
  registry.register('DifyImportView', difyImportViewSchema);

  // billing & routing views (billing-views)
  const RouteGroup = registry.register('RouteGroupView', routeGroupViewSchema);
  const RouteGroupChannel = registry.register('RouteGroupChannelView', routeGroupChannelViewSchema);
  const OfficialPrice = registry.register('OfficialPriceView', officialPriceViewSchema);

  // tenant console views (console-views)
  const ConsoleApiKey = registry.register('ConsoleApiKeyView', consoleApiKeyViewSchema);
  registry.register('ConsoleJobView', consoleJobViewSchema);
  registry.register('ConsoleLedgerView', consoleLedgerViewSchema);
  const ConsoleModel = registry.register('ConsoleModelView', consoleModelViewSchema);
  const ConsoleUsageLog = registry.register('ConsoleUsageLogView', consoleUsageLogViewSchema);
  const ConsolePayment = registry.register('ConsolePaymentView', consolePaymentViewSchema);
  registry.register('ConsoleMeView', consoleMeViewSchema);
  registry.register('ConsoleBalanceView', consoleBalanceViewSchema);
  registry.register('ConsoleIntentView', consoleIntentViewSchema);

  // --- request-body schemas (named) derived from the migrated contracts ----
  // (these are the write-side single source of truth; the create/update paths
  // below reference them as `request.body`.)
  // admin core (admin-requests)
  const CreateTenant = registry.register('CreateTenantBody', createTenantSchema);
  const UpdateTenant = registry.register('UpdateTenantBody', updateTenantSchema);
  const CreateAccount = registry.register('CreateAccountBody', createAccountSchema);
  const Topup = registry.register('TopupBody', topupSchema);
  const CreateApiKey = registry.register('CreateApiKeyBody', createApiKeySchema);
  const UpdateApiKeyGroup = registry.register('UpdateApiKeyGroupBody', updateApiKeyGroupSchema);
  const CreateSecret = registry.register('CreateSecretBody', createSecretSchema);
  const GenerateCodes = registry.register('GenerateCodesBody', generateCodesSchema);
  // catalog (catalog-requests)
  const CreateResource = registry.register('CreateResourceBody', createResourceSchema);
  const UpdateResource = registry.register('UpdateResourceBody', updateResourceSchema);
  const CreateChannel = registry.register('CreateChannelBody', createChannelSchema);
  const UpdateChannel = registry.register('UpdateChannelBody', updateChannelSchema);
  const SyncChannelModels = registry.register('SyncChannelModelsBody', syncChannelModelsSchema);
  const CreatePricebook = registry.register('CreatePricebookBody', createPricebookSchema);
  const UpdatePricebook = registry.register('UpdatePricebookBody', updatePricebookSchema);
  const CreateModifier = registry.register('CreateModifierBody', createModifierSchema);
  const UpdateModifier = registry.register('UpdateModifierBody', updateModifierSchema);
  const DifyImport = registry.register('DifyImportBody', difyImportSchema);
  const CreateModel = registry.register('CreateModelBody', createModelSchema);
  const UpdateModel = registry.register('UpdateModelBody', updateModelSchema);
  const GrantModel = registry.register('GrantModelBody', grantModelSchema);
  // billing & routing (billing-requests)
  const CreateRouteGroup = registry.register('CreateRouteGroupBody', createRouteGroupSchema);
  const UpdateRouteGroup = registry.register('UpdateRouteGroupBody', updateRouteGroupSchema);
  const AddGroupChannel = registry.register('AddGroupChannelBody', addGroupChannelSchema);
  const CreateOfficialPrice = registry.register(
    'CreateOfficialPriceBody',
    createOfficialPriceSchema,
  );
  const UpdateOfficialPrice = registry.register(
    'UpdateOfficialPriceBody',
    updateOfficialPriceSchema,
  );
  // tenant console (console-requests)
  const ConsoleCreateApiKey = registry.register(
    'ConsoleCreateApiKeyBody',
    consoleCreateApiKeySchema,
  );
  const ConsoleCreateIntent = registry.register(
    'ConsoleCreateIntentBody',
    consoleCreateIntentSchema,
  );
  const ConsoleChangePassword = registry.register(
    'ConsoleChangePasswordBody',
    consoleChangePasswordSchema,
  );

  // --- representative list paths referencing the registered schemas ---
  // (GET/list endpoints prove the response-schema chain; request bodies follow
  // once the create/update schemas migrate into contracts.)
  const list = (path: string, summary: string, item: z.ZodTypeAny, tag: string) => {
    registry.registerPath({
      method: 'get',
      path,
      summary,
      tags: [tag],
      responses: {
        200: {
          description: summary,
          content: { 'application/json': { schema: pageOf(item) } },
        },
      },
    });
  };

  /**
   * A write endpoint (POST/PATCH/PUT) whose `request.body` is one of the migrated
   * request-body contracts. `response` is the success schema (`200`/`201`); pass
   * `created: true` for a `201`. Some PATCH/PUT endpoints return no body — pass
   * `response: undefined` for a `204`.
   */
  const write = (args: {
    method: 'post' | 'patch' | 'put';
    path: string;
    summary: string;
    tag: string;
    body: z.ZodTypeAny;
    response?: z.ZodTypeAny;
    created?: boolean;
  }) => {
    const { method, path, summary, tag, body, response, created } = args;
    const status = response === undefined ? 204 : created ? 201 : 200;
    registry.registerPath({
      method,
      path,
      summary,
      tags: [tag],
      request: {
        body: { content: { 'application/json': { schema: body } }, required: true },
      },
      responses: {
        [status]: {
          description: summary,
          ...(response === undefined
            ? {}
            : { content: { 'application/json': { schema: response } } }),
        },
      },
    });
  };

  list('/admin/tenants', 'List tenants (paginated)', Tenant, 'tenants');
  list('/admin/accounts', 'List accounts (balance/held)', Account, 'tenants');
  list('/admin/resources', 'List catalog resources', Resource, 'catalog');
  list('/admin/resources/{id}/channels', 'List a resource’s channels', Channel, 'catalog');
  list('/admin/models', 'List relay models', Model, 'catalog');
  list('/admin/pricebook', 'List pricebook entries', Pricebook, 'pricing');
  list('/admin/modifiers', 'List pricing modifiers', Modifier, 'pricing');
  list('/admin/api-keys', 'List a tenant’s API keys', ApiKey, 'admin');
  list('/admin/jobs', 'List a tenant’s jobs', Job, 'admin');
  list('/admin/ledger', 'List a tenant’s ledger transactions', Ledger, 'admin');
  list('/admin/usage', 'Global per-call usage log', UsageLog, 'admin');
  list('/admin/payments', 'List a tenant’s payment intents', Payment, 'admin');
  list('/admin/route-groups', 'List route groups', RouteGroup, 'billing');
  list(
    '/admin/route-groups/{id}/channels',
    'List a group’s channels',
    RouteGroupChannel,
    'billing',
  );
  list('/admin/official-prices', 'List the official price catalog', OfficialPrice, 'billing');
  list('/console/api-keys', 'List your tenant API keys', ConsoleApiKey, 'console');
  list('/console/models', 'Models visible to your tenant', ConsoleModel, 'console');
  list('/console/usage-log', 'Your tenant per-call usage log', ConsoleUsageLog, 'console');
  list('/console/payments', 'Your tenant payment history', ConsolePayment, 'console');

  // --- write paths referencing the migrated request-body contracts ----------
  // admin core
  write({
    method: 'post',
    path: '/admin/tenants',
    summary: 'Create a tenant',
    tag: 'tenants',
    body: CreateTenant,
    response: Tenant,
    created: true,
  });
  write({
    method: 'patch',
    path: '/admin/tenants/{id}',
    summary: 'Update a tenant',
    tag: 'tenants',
    body: UpdateTenant,
    response: Tenant,
  });
  write({
    method: 'post',
    path: '/admin/accounts',
    summary: 'Create an account',
    tag: 'tenants',
    body: CreateAccount,
    response: Account,
    created: true,
  });
  write({
    method: 'post',
    path: '/admin/accounts/{id}/topup',
    summary: 'Credit an account',
    tag: 'tenants',
    body: Topup,
    response: Account,
  });
  write({
    method: 'post',
    path: '/admin/api-keys',
    summary: 'Mint an API key',
    tag: 'admin',
    body: CreateApiKey,
    response: ApiKey,
    created: true,
  });
  write({
    method: 'patch',
    path: '/admin/api-keys/{id}/group',
    summary: 'Bind an API key’s route group',
    tag: 'admin',
    body: UpdateApiKeyGroup,
    response: ApiKey,
  });
  write({
    method: 'post',
    path: '/admin/secrets',
    summary: 'Create an encrypted credential',
    tag: 'admin',
    body: CreateSecret,
    created: true,
  });
  write({
    method: 'post',
    path: '/admin/redemption-codes',
    summary: 'Batch-mint redemption codes',
    tag: 'admin',
    body: GenerateCodes,
    created: true,
  });

  // catalog
  write({
    method: 'post',
    path: '/admin/resources',
    summary: 'Register a catalog resource',
    tag: 'catalog',
    body: CreateResource,
    response: Resource,
    created: true,
  });
  write({
    method: 'patch',
    path: '/admin/resources/{id}',
    summary: 'Update a resource',
    tag: 'catalog',
    body: UpdateResource,
    response: Resource,
  });
  write({
    method: 'post',
    path: '/admin/resources/{id}/channels',
    summary: 'Add an upstream channel',
    tag: 'catalog',
    body: CreateChannel,
    response: Channel,
    created: true,
  });
  write({
    method: 'patch',
    path: '/admin/resources/{id}/channels/{channelId}',
    summary: 'Patch a channel',
    tag: 'catalog',
    body: UpdateChannel,
    response: Channel,
  });
  write({
    method: 'post',
    path: '/admin/resources/{id}/channels/{channelId}/sync-models',
    summary: 'Sync a channel’s upstream models',
    tag: 'catalog',
    body: SyncChannelModels,
  });
  write({
    method: 'post',
    path: '/admin/pricebook',
    summary: 'Add a pricebook entry',
    tag: 'pricing',
    body: CreatePricebook,
    response: Pricebook,
    created: true,
  });
  write({
    method: 'patch',
    path: '/admin/pricebook/{id}',
    summary: 'Update a pricebook entry',
    tag: 'pricing',
    body: UpdatePricebook,
    response: Pricebook,
  });
  write({
    method: 'post',
    path: '/admin/modifiers',
    summary: 'Add a pricing modifier',
    tag: 'pricing',
    body: CreateModifier,
    response: Modifier,
    created: true,
  });
  write({
    method: 'patch',
    path: '/admin/modifiers/{id}',
    summary: 'Update a pricing modifier',
    tag: 'pricing',
    body: UpdateModifier,
    response: Modifier,
  });
  write({
    method: 'post',
    path: '/admin/dify/import',
    summary: 'Register a BYO Dify workflow',
    tag: 'catalog',
    body: DifyImport,
    created: true,
  });
  write({
    method: 'post',
    path: '/admin/models',
    summary: 'Register a relay model',
    tag: 'catalog',
    body: CreateModel,
    response: Model,
    created: true,
  });
  write({
    method: 'patch',
    path: '/admin/models/{name}',
    summary: 'Update a relay model',
    tag: 'catalog',
    body: UpdateModel,
    response: Model,
  });
  write({
    method: 'post',
    path: '/admin/models/{name}/grants',
    summary: 'Grant a tenant-visibility model',
    tag: 'catalog',
    body: GrantModel,
    created: true,
  });

  // billing & routing
  write({
    method: 'post',
    path: '/admin/route-groups',
    summary: 'Create a route group',
    tag: 'billing',
    body: CreateRouteGroup,
    response: RouteGroup,
    created: true,
  });
  write({
    method: 'patch',
    path: '/admin/route-groups/{id}',
    summary: 'Update a route group',
    tag: 'billing',
    body: UpdateRouteGroup,
    response: RouteGroup,
  });
  write({
    method: 'put',
    path: '/admin/route-groups/{id}/channels/{channelId}',
    summary: 'Add/update a group channel membership',
    tag: 'billing',
    body: AddGroupChannel,
    response: RouteGroupChannel,
  });
  write({
    method: 'post',
    path: '/admin/official-prices',
    summary: 'Add an official price catalog row',
    tag: 'billing',
    body: CreateOfficialPrice,
    response: OfficialPrice,
    created: true,
  });
  write({
    method: 'patch',
    path: '/admin/official-prices/{id}',
    summary: 'Update an official price catalog row',
    tag: 'billing',
    body: UpdateOfficialPrice,
    response: OfficialPrice,
  });

  // tenant console
  write({
    method: 'post',
    path: '/console/api-keys',
    summary: 'Mint an API key for your tenant',
    tag: 'console',
    body: ConsoleCreateApiKey,
    response: ConsoleApiKey,
    created: true,
  });
  write({
    method: 'post',
    path: '/console/payments/topup',
    summary: 'Start a self-serve credit topup',
    tag: 'console',
    body: ConsoleCreateIntent,
  });
  write({
    method: 'patch',
    path: '/console/settings',
    summary: 'Change your console password',
    tag: 'console',
    body: ConsoleChangePassword,
  });

  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: '3.0.0',
    info: {
      title: 'Actionow control-plane API',
      version: '0.1.0',
      description:
        'Generated from the @actionow/contracts zod schemas (single source of truth). ' +
        'Covers the contract-migrated views; expands as more views migrate.',
    },
    servers: [{ url: '/' }],
  });
}
