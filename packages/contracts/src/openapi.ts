import {
  extendZodWithOpenApi,
  OpenApiGeneratorV3,
  OpenAPIRegistry,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import { accountViewSchema, tenantViewSchema } from './admin-views.js';
import {
  officialPriceViewSchema,
  routeGroupChannelViewSchema,
  routeGroupViewSchema,
} from './billing-views.js';
import {
  channelViewSchema,
  modelGrantViewSchema,
  modelViewSchema,
  modifierViewSchema,
  pricebookViewSchema,
  resourceViewSchema,
} from './catalog-views.js';
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
