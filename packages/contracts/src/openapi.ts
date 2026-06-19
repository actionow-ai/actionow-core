import {
  extendZodWithOpenApi,
  OpenApiGeneratorV3,
  OpenAPIRegistry,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import { accountViewSchema, tenantViewSchema } from './admin-views.js';
import {
  channelViewSchema,
  modelGrantViewSchema,
  modelViewSchema,
  modifierViewSchema,
  pricebookViewSchema,
  resourceViewSchema,
} from './catalog-views.js';

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
