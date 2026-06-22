import {
  extendZodWithOpenApi,
  OpenApiGeneratorV3,
  OpenAPIRegistry,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import {
  codexLoginCompleteSchema,
  codexLoginStartSchema,
  createAccountSchema,
  createAdminTokenSchema,
  createApiKeySchema,
  createOAuthSessionSchema,
  createSecretSchema,
  createTenantSchema,
  generateCodesSchema,
  provisionSchema,
  topupSchema,
  updateApiKeyGroupSchema,
  updateCredentialMetaSchema,
  updateTenantSchema,
} from './admin-requests.js';
import {
  accountViewSchema,
  adminTokenViewSchema,
  provisionViewSchema,
  tenantViewSchema,
} from './admin-views.js';
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
  updateDifySchema,
  updateModelSchema,
  updateModifierSchema,
  updatePricebookSchema,
  updateResourceSchema,
} from './catalog-requests.js';
import {
  channelViewSchema,
  difyBindingViewSchema,
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
  consoleFileViewSchema,
  consoleIntentViewSchema,
  consoleJobViewSchema,
  consoleLedgerViewSchema,
  consoleMeViewSchema,
  consoleModelViewSchema,
  consolePaymentViewSchema,
  consoleUsageLogViewSchema,
  consoleUsageRollupViewSchema,
} from './console-views.js';
import {
  fileUrlResultSchema,
  fileViewSchema,
  presignUploadResultSchema,
  presignUploadSchema,
  resourceDetailSchema,
  resourceSummarySchema,
  runBodySchema,
  runJobViewSchema,
  runResponseSchema,
} from './data-plane.js';
import { errorViewSchema } from './error-view.js';
import {
  apiKeyViewSchema,
  channelHealthViewSchema,
  codexLoginStartViewSchema,
  difyImportViewSchema,
  jobViewSchema,
  ledgerViewSchema,
  oauthSessionListViewSchema,
  oauthSessionViewSchema,
  opsHealthViewSchema,
  opsSummaryViewSchema,
  paymentIntentViewSchema,
  redeemCodesResultSchema,
  redemptionCodeViewSchema,
  relayTraceViewSchema,
  secretViewSchema,
  usageLogViewSchema,
  usageRollupViewSchema,
} from './ops-views.js';
import {
  createPluginRequestSchema,
  providerPluginViewSchema,
  testPluginRequestSchema,
  testPluginResponseSchema,
  updatePluginRequestSchema,
} from './provider-plugin.js';

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

/**
 * The `{ id, plaintext }` returned ONCE when a key is minted/rotated (admin AND
 * console). Inline (not a migrated view) — it is a tiny write-only response with
 * no list/read twin, so it stays local to the OpenAPI document.
 */
const apiKeyCreatedSchema = z.object({ id: z.string(), plaintext: z.string() });

/** Build the OpenAPI v3 document from the zod contracts (the single source of truth). */
export function buildOpenApiDocument(): ReturnType<OpenApiGeneratorV3['generateDocument']> {
  const registry = new OpenAPIRegistry();

  // Every registered path is admin/console-scoped and authenticates with a Bearer
  // token — a human admin login JWT OR an `at_`-prefixed admin service token. A
  // global `security` (below) applies this scheme to all paths.
  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Admin/console login JWT, or an `at_`-prefixed admin service token.',
  });

  // --- component schemas (named) derived from the migrated contracts ---
  const Tenant = registry.register('TenantView', tenantViewSchema);
  const Account = registry.register('AccountView', accountViewSchema);
  const AdminToken = registry.register('AdminTokenView', adminTokenViewSchema);
  const Provision = registry.register('ProvisionView', provisionViewSchema);

  // Register the uniform §4.7 error envelope as a component; it is attached as the
  // common 4xx responses to every operation in a post-pass (see `attachErrors`
  // below), so the SDK's `error` branch is typed (ErrorView) on every path.
  registry.register('ErrorView', errorViewSchema);
  const Resource = registry.register('ResourceView', resourceViewSchema);
  const Channel = registry.register('ChannelView', channelViewSchema);
  const Model = registry.register('ModelView', modelViewSchema);
  const ModelGrant = registry.register('ModelGrantView', modelGrantViewSchema);
  const Pricebook = registry.register('PricebookView', pricebookViewSchema);
  const Modifier = registry.register('ModifierView', modifierViewSchema);
  const DifyBinding = registry.register('DifyBindingView', difyBindingViewSchema);
  const UpdateDify = registry.register('UpdateDifyBody', updateDifySchema);

  // admin operational views (ops-views)
  const ApiKey = registry.register('ApiKeyView', apiKeyViewSchema);
  const Job = registry.register('JobView', jobViewSchema);
  const Ledger = registry.register('LedgerView', ledgerViewSchema);
  const UsageLog = registry.register('UsageLogView', usageLogViewSchema);
  const UsageRollup = registry.register('UsageRollupView', usageRollupViewSchema);
  const Payment = registry.register('PaymentIntentView', paymentIntentViewSchema);
  const Secret = registry.register('SecretView', secretViewSchema);
  registry.register('DifyImportView', difyImportViewSchema);
  const RelayTrace = registry.register('RelayTraceView', relayTraceViewSchema);
  const RedemptionCode = registry.register('RedemptionCodeView', redemptionCodeViewSchema);
  const RedeemCodes = registry.register('RedeemCodesResult', redeemCodesResultSchema);
  // upstream OAuth subscription sessions (BYO / turnkey codex) — token-free views.
  const ProviderPlugin = registry.register('ProviderPluginView', providerPluginViewSchema);
  const CreatePlugin = registry.register('CreatePluginBody', createPluginRequestSchema);
  const UpdatePlugin = registry.register('UpdatePluginBody', updatePluginRequestSchema);
  const TestPlugin = registry.register('TestPluginBody', testPluginRequestSchema);
  const TestPluginResp = registry.register('TestPluginResponse', testPluginResponseSchema);
  const OAuthSession = registry.register('OAuthSessionView', oauthSessionViewSchema);
  const OAuthSessionList = registry.register('OAuthSessionListView', oauthSessionListViewSchema);
  const CodexLoginStartV = registry.register('CodexLoginStartView', codexLoginStartViewSchema);
  // ops health snapshot + platform counts (overview KPI band / model-health card)
  registry.register('ChannelHealthView', channelHealthViewSchema);
  const OpsHealth = registry.register('OpsHealthView', opsHealthViewSchema);
  const OpsSummary = registry.register('OpsSummaryView', opsSummaryViewSchema);

  // billing & routing views (billing-views)
  const RouteGroup = registry.register('RouteGroupView', routeGroupViewSchema);
  const RouteGroupChannel = registry.register('RouteGroupChannelView', routeGroupChannelViewSchema);
  const OfficialPrice = registry.register('OfficialPriceView', officialPriceViewSchema);

  // tenant console views (console-views)
  const ConsoleApiKey = registry.register('ConsoleApiKeyView', consoleApiKeyViewSchema);
  // ConsoleJob/ConsoleLedger back the `/console/usage` composite (`{ jobs, ledger }`).
  const ConsoleJob = registry.register('ConsoleJobView', consoleJobViewSchema);
  const ConsoleLedger = registry.register('ConsoleLedgerView', consoleLedgerViewSchema);
  const ConsoleModel = registry.register('ConsoleModelView', consoleModelViewSchema);
  const ConsoleUsageLog = registry.register('ConsoleUsageLogView', consoleUsageLogViewSchema);
  const ConsoleUsageRollup = registry.register(
    'ConsoleUsageRollupView',
    consoleUsageRollupViewSchema,
  );
  const ConsolePayment = registry.register('ConsolePaymentView', consolePaymentViewSchema);
  const ConsoleMe = registry.register('ConsoleMeView', consoleMeViewSchema);
  const ConsoleBalance = registry.register('ConsoleBalanceView', consoleBalanceViewSchema);
  const ConsoleIntent = registry.register('ConsoleIntentView', consoleIntentViewSchema);
  const ConsoleFile = registry.register('ConsoleFileView', consoleFileViewSchema);

  // data-plane views (data-plane): the generation hot path (/v1/run, /v1/jobs,
  // /v1/resources, /v1/files) an external developer's app drives via @actionow/sdk.
  const RunResp = registry.register('RunResponse', runResponseSchema);
  const RunJob = registry.register('RunJobView', runJobViewSchema);
  const ResourceSummary = registry.register('ResourceSummary', resourceSummarySchema);
  const ResourceDetail = registry.register('ResourceDetail', resourceDetailSchema);
  const PresignResult = registry.register('PresignUploadResult', presignUploadResultSchema);
  const FileV = registry.register('FileView', fileViewSchema);
  const FileUrl = registry.register('FileUrlResult', fileUrlResultSchema);

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
  const CreateAdminToken = registry.register('CreateAdminTokenBody', createAdminTokenSchema);
  const ProvisionReq = registry.register('ProvisionBody', provisionSchema);
  const CreateOAuthSession = registry.register('CreateOAuthSessionBody', createOAuthSessionSchema);
  const UpdateCredentialMeta = registry.register(
    'UpdateCredentialMetaBody',
    updateCredentialMetaSchema,
  );
  const CodexLoginStartReq = registry.register('CodexLoginStartBody', codexLoginStartSchema);
  const CodexLoginCompleteReq = registry.register(
    'CodexLoginCompleteBody',
    codexLoginCompleteSchema,
  );
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
  // data-plane request bodies (data-plane)
  const RunReq = registry.register('RunBody', runBodySchema);
  const PresignReq = registry.register('PresignUploadBody', presignUploadSchema);

  /**
   * Derive the OpenAPI path-parameter schema from the `{token}`s in a path.
   * zod-to-openapi does NOT infer path params from the path string, and
   * openapi-fetch types `params.path` as `undefined` unless they're declared —
   * so every templated path must register its params or the SDK won't typecheck.
   */
  function pathParamsOf(path: string): z.ZodTypeAny | undefined {
    const names = [...path.matchAll(/\{(\w+)}/g)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    );
    if (names.length === 0) return undefined;
    return z.object(Object.fromEntries(names.map((n) => [n, z.string()])));
  }

  /** Merge an optional path-param schema + optional query into a `request`. */
  function requestOf(
    path: string,
    query?: z.ZodTypeAny,
    body?: z.ZodTypeAny,
  ): Record<string, unknown> | undefined {
    const params = pathParamsOf(path);
    const req: Record<string, unknown> = {};
    if (params) req.params = params;
    if (query) req.query = query;
    if (body) req.body = { content: { 'application/json': { schema: body } }, required: true };
    return Object.keys(req).length > 0 ? req : undefined;
  }

  // --- representative list paths referencing the registered schemas ---
  // (GET/list endpoints prove the response-schema chain; request bodies follow
  // once the create/update schemas migrate into contracts.)
  const list = (
    path: string,
    summary: string,
    item: z.ZodTypeAny,
    tag: string,
    query?: z.ZodTypeAny,
  ) => {
    const request = requestOf(path, query);
    registry.registerPath({
      method: 'get',
      path,
      summary,
      tags: [tag],
      ...(request ? { request } : {}),
      responses: {
        200: {
          description: summary,
          content: { 'application/json': { schema: pageOf(item) } },
        },
      },
    });
  };

  // Common keyset query (`cursor` + `limit`); some lists add filters on top.
  const keyset = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().optional(),
  });

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
      request: requestOf(path, undefined, body) as never,
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

  /** A GET-one endpoint that returns a single registered view (or 404). */
  const getOne = (path: string, summary: string, view: z.ZodTypeAny, tag: string) => {
    const request = requestOf(path);
    registry.registerPath({
      method: 'get',
      path,
      summary,
      tags: [tag],
      ...(request ? { request } : {}),
      responses: {
        200: { description: summary, content: { 'application/json': { schema: view } } },
      },
    });
  };

  /** A GET endpoint returning a bare array (no list envelope), optional query. */
  const getArray = (
    path: string,
    summary: string,
    item: z.ZodTypeAny,
    tag: string,
    query?: z.ZodTypeAny,
  ) => {
    const request = requestOf(path, query);
    registry.registerPath({
      method: 'get',
      path,
      summary,
      tags: [tag],
      ...(request ? { request } : {}),
      responses: {
        200: {
          description: summary,
          content: { 'application/json': { schema: z.array(item) } },
        },
      },
    });
  };

  /** A DELETE endpoint that returns `204 No Content` (revoke/remove). */
  const del = (path: string, summary: string, tag: string) => {
    const request = requestOf(path);
    registry.registerPath({
      method: 'delete',
      path,
      summary,
      tags: [tag],
      ...(request ? { request } : {}),
      responses: { 204: { description: summary } },
    });
  };

  // Per-list query filters layered on top of the keyset (cursor/limit).
  const tenantKeyset = keyset.extend({ tenantId: z.string().optional() });
  const pricebookQuery = z.object({ resourceId: z.string().optional() });
  const apiKeysQuery = z.object({ tenantId: z.string().optional() });

  list('/admin/tenants', 'List tenants (paginated)', Tenant, 'tenants');
  list('/admin/accounts', 'List accounts (balance/held)', Account, 'tenants');
  list('/admin/resources', 'List catalog resources', Resource, 'catalog');
  list('/admin/resources/{id}/channels', 'List a resource’s channels', Channel, 'catalog');
  list('/admin/models', 'List relay models', Model, 'catalog');
  list('/admin/pricebook', 'List pricebook entries', Pricebook, 'pricing', pricebookQuery);
  list('/admin/modifiers', 'List pricing modifiers', Modifier, 'pricing', keyset);
  list('/admin/api-keys', 'List a tenant’s API keys', ApiKey, 'admin', apiKeysQuery);
  list('/admin/jobs', 'List a tenant’s jobs', Job, 'admin', tenantKeyset);
  list('/admin/ledger', 'List a tenant’s ledger transactions', Ledger, 'admin', tenantKeyset);
  list('/admin/usage', 'Global per-call usage log', UsageLog, 'admin', tenantKeyset);
  list('/admin/payments', 'List a tenant’s payment intents', Payment, 'admin', tenantKeyset);
  list('/admin/secrets', 'List encrypted credentials', Secret, 'admin', keyset);
  list('/admin/tokens', 'List admin service tokens', AdminToken, 'admin', keyset);
  const redemptionQuery = keyset.extend({
    status: z.enum(['unused', 'redeemed']).optional(),
  });
  list(
    '/admin/redemption-codes',
    'List minted redemption codes (status filter, paginated)',
    RedemptionCode,
    'admin',
    redemptionQuery,
  );
  // Upstream OAuth subscription sessions (BYO paste-auth + turnkey codex login).
  list(
    '/admin/oauth-sessions',
    'List OAuth subscription sessions (token-free)',
    OAuthSessionList,
    'admin',
    keyset,
  );
  write({
    method: 'post',
    path: '/admin/oauth-sessions',
    summary: 'Register an OAuth subscription session (paste-auth BYO)',
    tag: 'admin',
    body: CreateOAuthSession,
    response: OAuthSession,
    created: true,
  });
  write({
    method: 'post',
    path: '/admin/oauth-sessions/codex/login/start',
    summary: 'Begin a turnkey codex OAuth login (returns authorize_url + sealed state)',
    tag: 'admin',
    body: CodexLoginStartReq,
    response: CodexLoginStartV,
  });
  write({
    method: 'post',
    path: '/admin/oauth-sessions/codex/login/complete',
    summary: 'Complete a turnkey codex OAuth login (exchange the code)',
    tag: 'admin',
    body: CodexLoginCompleteReq,
    response: OAuthSession,
    created: true,
  });
  // Credential metadata edits (name/notes/group) — never the token/secret material.
  write({
    method: 'patch',
    path: '/admin/oauth-sessions/{id}',
    summary: 'Edit an OAuth session’s metadata (name/notes/group)',
    tag: 'admin',
    body: UpdateCredentialMeta,
    response: OAuthSessionList,
  });
  write({
    method: 'patch',
    path: '/admin/secrets/{id}',
    summary: 'Edit a stored credential’s metadata (name/notes/group)',
    tag: 'admin',
    body: UpdateCredentialMeta,
    response: Secret,
  });
  const relayQuery = z.object({
    tenantId: z.string().optional(),
    jobId: z.string().optional(),
    providerType: z.string().optional(),
    channelId: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    responseStatus: z.coerce.number().optional(),
    errorsOnly: z.enum(['true', 'false']).optional(),
    isStream: z.enum(['true', 'false']).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().optional(),
  });
  list(
    '/admin/relay-traces',
    'List upstream relay traces (audit)',
    RelayTrace,
    'admin',
    relayQuery,
  );
  list('/admin/route-groups', 'List route groups', RouteGroup, 'billing');
  list(
    '/admin/route-groups/{id}/channels',
    'List a group’s channels',
    RouteGroupChannel,
    'billing',
  );
  list(
    '/admin/official-prices',
    'List the official price catalog',
    OfficialPrice,
    'billing',
    keyset,
  );
  list('/admin/models/{name}/grants', 'List a model’s tenant grants', ModelGrant, 'catalog');
  list('/console/api-keys', 'List your tenant API keys', ConsoleApiKey, 'console', keyset);
  list('/console/models', 'Models visible to your tenant', ConsoleModel, 'console');
  list('/console/usage-log', 'Your tenant per-call usage log', ConsoleUsageLog, 'console', keyset);
  list('/console/payments', 'Your tenant payment history', ConsolePayment, 'console', keyset);
  // Tenant asset gallery: ready media files, newest-first, optionally narrowed to a media kind.
  const consoleFilesQuery = keyset.extend({ kind: z.enum(['image', 'video', 'audio']).optional() });
  list('/console/files', 'Your tenant media files', ConsoleFile, 'console', consoleFilesQuery);
  // `/console/usage` is a composite: two independent keyset envelopes in one body.
  registry.registerPath({
    method: 'get',
    path: '/console/usage',
    summary: 'Your tenant recent jobs + ledger (two keyset envelopes)',
    tags: ['console'],
    request: { query: z.object({ limit: z.coerce.number().optional() }) },
    responses: {
      200: {
        description: 'Recent jobs + ledger',
        content: {
          'application/json': {
            schema: z.object({ jobs: pageOf(ConsoleJob), ledger: pageOf(ConsoleLedger) }),
          },
        },
      },
    },
  });

  // --- GET-one (read a single resource) -------------------------------------
  getOne('/admin/models/{name}', 'Get one relay model', Model, 'catalog');
  getOne('/admin/route-groups/{id}', 'Get one route group', RouteGroup, 'billing');

  // --- analytics rollups (bare arrays, query-filtered) ----------------------
  // Query shapes are inline (mirroring the backend admin-DTO query schemas, which
  // live in the API package, not the contracts) so the SDK types `params.query`.
  const adminAnalyticsQuery = z.object({
    groupBy: z.enum(['minute', 'hour', 'day', 'model', 'tenant', 'channel', 'api_key']),
    tenantId: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
  });
  const consoleAnalyticsQuery = z.object({
    groupBy: z.enum(['minute', 'hour', 'day', 'model', 'channel', 'api_key']),
    from: z.string().optional(),
    to: z.string().optional(),
  });
  getArray(
    '/admin/analytics/usage',
    'Admin usage rollups',
    UsageRollup,
    'admin',
    adminAnalyticsQuery,
  );
  // provider plugins (P2)
  getArray('/admin/plugins', 'List provider plugins', ProviderPlugin, 'catalog');
  write({
    method: 'post',
    path: '/admin/plugins',
    summary: 'Create a provider plugin',
    tag: 'catalog',
    body: CreatePlugin,
    response: ProviderPlugin,
    created: true,
  });
  write({
    method: 'post',
    path: '/admin/plugins/test',
    summary: 'Run a handler fn in the sandbox (test panel)',
    tag: 'catalog',
    body: TestPlugin,
    response: TestPluginResp,
  });
  write({
    method: 'patch',
    path: '/admin/plugins/{id}',
    summary: 'Update a provider plugin',
    tag: 'catalog',
    body: UpdatePlugin,
    response: ProviderPlugin,
  });
  getArray(
    '/console/analytics/usage',
    'Your tenant usage rollups',
    ConsoleUsageRollup,
    'console',
    consoleAnalyticsQuery,
  );

  // --- ops snapshot (single-object reads) -----------------------------------
  getOne('/admin/summary', 'Authoritative platform counts', OpsSummary, 'admin');
  getOne(
    '/admin/health',
    'Live ops health (channel circuit-breaker + billable RPM)',
    OpsHealth,
    'admin',
  );

  // --- console reads (single-object endpoints) ------------------------------
  getOne('/console/balance', 'Your tenant credit balance + held', ConsoleBalance, 'console');
  getOne('/console/me', 'Your own profile', ConsoleMe, 'console');
  getOne(
    '/console/payments/intents/{id}',
    'Status of one of your payment intents',
    ConsolePayment,
    'console',
  );
  // Console file upload (tenant JWT) — mirrors the data-plane presign/confirm so
  // a tenant can upload assets from the gallery (img2img inputs, etc.).
  registry.registerPath({
    method: 'post',
    path: '/console/files/presign-upload',
    summary: 'Mint a presigned upload for your tenant',
    tags: ['console'],
    security: [{ bearerAuth: [] }],
    request: { body: { content: { 'application/json': { schema: PresignReq } } } },
    responses: {
      200: {
        description: 'Presigned upload',
        content: { 'application/json': { schema: PresignResult } },
      },
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/console/files/{id}/confirm',
    summary: 'Confirm an uploaded file (head → ready)',
    tags: ['console'],
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: 'Confirmed file', content: { 'application/json': { schema: FileV } } },
    },
  });

  // --- DELETE (revoke/remove → 204; the FE methods return void) -------------
  del('/admin/resources/{id}/channels/{channelId}', 'Delete a channel', 'catalog');
  del('/admin/api-keys/{id}', 'Revoke an API key', 'admin');
  del('/admin/tokens/{id}', 'Revoke an admin service token', 'admin');
  del('/admin/oauth-sessions/{id}', 'Revoke an OAuth subscription session', 'admin');
  del('/admin/route-groups/{id}', 'Delete a route group', 'billing');
  del('/admin/route-groups/{id}/channels/{channelId}', 'Remove a group channel', 'billing');
  del('/admin/official-prices/{id}', 'Delete an official price row', 'billing');
  del('/admin/pricebook/{id}', 'Delete a pricebook entry', 'pricing');
  del('/admin/modifiers/{id}', 'Delete a pricing modifier', 'pricing');
  del('/admin/plugins/{id}', 'Soft-delete a custom provider plugin', 'catalog');
  del('/admin/secrets/{id}', 'Revoke an encrypted credential', 'admin');
  del('/admin/models/{name}', 'Delete a relay model', 'catalog');
  del('/admin/models/{name}/grants/{tenantId}', 'Revoke a model grant', 'catalog');

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
    method: 'post',
    path: '/admin/provision',
    summary: 'Provision a customer atomically (tenant + account + API key)',
    tag: 'tenants',
    body: ProvisionReq,
    response: Provision,
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
    response: RedeemCodes,
    created: true,
  });
  write({
    method: 'post',
    path: '/admin/tokens',
    // Minting returns the plaintext token ONCE (`{ id, plaintext }`), not the view.
    summary: 'Mint an admin service token (M2M)',
    tag: 'admin',
    body: CreateAdminToken,
    response: apiKeyCreatedSchema,
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
  list('/admin/dify', 'List dify bindings', DifyBinding, 'catalog', keyset);
  write({
    method: 'patch',
    path: '/admin/dify/{resourceId}',
    summary: 'Update a dify binding',
    tag: 'catalog',
    body: UpdateDify,
    response: DifyBinding,
  });
  del('/admin/dify/{resourceId}', 'Delete a dify binding', 'catalog');
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
    // Minting returns the plaintext key ONCE, not the listed ConsoleApiKeyView.
    summary: 'Mint an API key for your tenant',
    tag: 'console',
    body: ConsoleCreateApiKey,
    response: apiKeyCreatedSchema,
    created: true,
  });
  // Rotate takes NO body (the `:id` path identifies the key); returns the new
  // plaintext once. Registered directly since `write` requires a request body.
  registry.registerPath({
    method: 'post',
    path: '/console/api-keys/{id}/rotate',
    summary: 'Rotate an API key (new plaintext; old key disabled)',
    tags: ['console'],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      201: {
        description: 'Rotated key',
        content: { 'application/json': { schema: apiKeyCreatedSchema } },
      },
    },
  });
  // Console disable returns 200 WITH a body (`{ id, status }`), unlike the admin
  // hard-delete 204 — registered directly so the SDK types the response body.
  registry.registerPath({
    method: 'delete',
    path: '/console/api-keys/{id}',
    summary: 'Disable one of your API keys',
    tags: ['console'],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Disabled key',
        content: {
          'application/json': {
            schema: z.object({ id: z.string(), status: z.string() }),
          },
        },
      },
    },
  });
  // BUGFIX: the real endpoint is `/console/payments/intents` (see the console
  // controller `@Post('payments/intents')`), NOT `/console/payments/topup`.
  write({
    method: 'post',
    path: '/console/payments/intents',
    summary: 'Start a self-serve credit topup (returns a checkout handle)',
    tag: 'console',
    body: ConsoleCreateIntent,
    response: ConsoleIntent,
    created: true,
  });
  write({
    method: 'patch',
    path: '/console/settings',
    summary: 'Change your console password',
    tag: 'console',
    body: ConsoleChangePassword,
  });

  // --- data-plane paths (/v1/*): the generation hot path (ak_-key authed) -------
  write({
    method: 'post',
    path: '/v1/run/{resourceId}',
    summary: 'Run a resource (blocking → output inline; async → queued, poll /v1/jobs)',
    tag: 'data-plane',
    body: RunReq,
    response: RunResp,
  });
  list('/v1/jobs', 'List your jobs (paginated)', RunJob, 'data-plane', keyset);
  getOne('/v1/jobs/{id}', 'Get a job (status/output/usage/cost)', RunJob, 'data-plane');
  registry.registerPath({
    method: 'post',
    path: '/v1/jobs/{id}/cancel',
    summary: 'Cancel a queued/running job (releases the hold)',
    tags: ['data-plane'],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: 'Canceled job', content: { 'application/json': { schema: RunJob } } },
    },
  });
  list(
    '/v1/resources',
    'List resources visible to your key',
    ResourceSummary,
    'data-plane',
    keyset,
  );
  getOne(
    '/v1/resources/{id}',
    'Get a resource (io_schema + pricing)',
    ResourceDetail,
    'data-plane',
  );
  const filesQuery = keyset.extend({ status: z.enum(['pending', 'ready']).optional() });
  list('/v1/files', 'List your files (paginated)', FileV, 'data-plane', filesQuery);
  write({
    method: 'post',
    path: '/v1/files/presign-upload',
    summary: 'Mint a presigned upload (returns file_id + upload_url)',
    tag: 'data-plane',
    body: PresignReq,
    response: PresignResult,
    created: true,
  });
  registry.registerPath({
    method: 'post',
    path: '/v1/files/{id}/confirm',
    summary: 'Confirm an uploaded file (head → ready)',
    tags: ['data-plane'],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: { description: 'Confirmed file', content: { 'application/json': { schema: FileV } } },
    },
  });
  getOne('/v1/files/{id}/url', 'Get a presigned download URL', FileUrl, 'data-plane');

  const generator = new OpenApiGeneratorV3(registry.definitions);
  const doc = generator.generateDocument({
    openapi: '3.0.0',
    info: {
      title: 'Actionow control-plane API',
      version: '0.1.0',
      description:
        'Generated from the @actionow/contracts zod schemas (single source of truth). ' +
        'Covers the contract-migrated views; expands as more views migrate.',
    },
    servers: [{ url: '/' }],
    // Every registered path requires the Bearer scheme registered above.
    security: [{ bearerAuth: [] }],
  });
  attachErrors(doc);
  return doc;
}

/** The common 4xx codes every endpoint may return (the uniform §4.7 envelope). */
const ERROR_STATUS: Record<string, string> = {
  '400': 'Invalid input',
  '401': 'Unauthorized',
  '403': 'Forbidden',
  '404': 'Not found',
  '409': 'Conflict',
};
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/**
 * Attach the `ErrorView` envelope as the common 4xx responses to EVERY operation,
 * referencing the registered component. zod-to-openapi only emits the declared
 * (2xx) responses; without this, openapi-fetch types each path's `error` as
 * `never`. Run as a post-pass so the per-path `responses` stay terse. Existing
 * responses win (a path that already declares a code keeps its own).
 */
function attachErrors(doc: ReturnType<OpenApiGeneratorV3['generateDocument']>): void {
  const errorResponses: Record<string, unknown> = {};
  for (const [status, description] of Object.entries(ERROR_STATUS)) {
    errorResponses[status] = {
      description,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorView' } } },
    };
  }
  for (const item of Object.values(doc.paths)) {
    const pathItem = item as Record<string, { responses?: Record<string, unknown> } | undefined>;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (op === undefined) continue;
      op.responses = { ...errorResponses, ...op.responses };
    }
  }
}
