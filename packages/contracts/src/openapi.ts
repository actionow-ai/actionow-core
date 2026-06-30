import {
  extendZodWithOpenApi,
  OpenApiGeneratorV3,
  OpenAPIRegistry,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import {
  bulkChannelActionSchema,
  bulkModelActionSchema,
  bulkOAuthSessionActionSchema,
  codexLoginCompleteSchema,
  codexLoginStartSchema,
  createAccountSchema,
  createAdminTokenSchema,
  createApiKeySchema,
  createOAuthSessionSchema,
  createSecretSchema,
  createSubAccountSchema,
  createSubjectSchema,
  createTenantSchema,
  generateCodesSchema,
  latestAuditRequestSchema,
  provisionSchema,
  topupSchema,
  topupSubAccountSchema,
  transferCreditsSchema,
  updateApiKeyGroupSchema,
  updateCredentialMetaSchema,
  updateSubjectSchema,
  updateTenantSchema,
} from './admin-requests.js';
import {
  accountViewSchema,
  adminTokenViewSchema,
  bulkResultViewSchema,
  latestAuditViewSchema,
  provisionViewSchema,
  subAccountViewSchema,
  subjectViewSchema,
  tenantViewSchema,
} from './admin-views.js';
import {
  jwksResponseSchema,
  logoutRequestSchema,
  refreshRequestSchema,
  tokenPairSchema,
} from './auth-requests.js';
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
  createModelSpecSchema,
  createModifierSchema,
  createPricebookSchema,
  createResourceSchema,
  difyImportSchema,
  grantModelSchema,
  syncChannelModelsSchema,
  updateChannelSchema,
  updateDifySchema,
  updateModelSchema,
  updateModelSpecSchema,
  updateModifierSchema,
  updatePricebookSchema,
  updateResourceSchema,
} from './catalog-requests.js';
import {
  channelViewSchema,
  difyBindingViewSchema,
  modelGrantViewSchema,
  modelSpecViewSchema,
  modelViewSchema,
  modifierViewSchema,
  pricebookViewSchema,
  resourceViewSchema,
} from './catalog-views.js';
import { transcriptionRequestSchema, transcriptionResponseSchema } from './chat.js';
import {
  appendMessageSchema,
  consoleChangePasswordSchema,
  consoleCreateApiKeySchema,
  consoleCreateIntentSchema,
  createConversationSchema,
  updateConversationSchema,
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
  conversationDetailViewSchema,
  conversationViewSchema,
  messageViewSchema,
  storageUsageViewSchema,
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
  createFaultPolicySchema,
  faultPolicyViewSchema,
  updateFaultPolicySchema,
} from './fault-policy.js';
import { modelTestRequestSchema, modelTestResultSchema } from './model-test.js';
import {
  apiKeyViewSchema,
  breakerViewSchema,
  channelHealthViewSchema,
  codexLoginStartViewSchema,
  difyImportViewSchema,
  jobViewSchema,
  ledgerViewSchema,
  modelHealthViewSchema,
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
import { priceSpecSchema } from './pricing.js';
import {
  createPluginRequestSchema,
  providerPluginViewSchema,
  testPluginRequestSchema,
  testPluginResponseSchema,
  updatePluginRequestSchema,
} from './provider-plugin.js';
import {
  createProxySchema,
  proxyProbeRequestSchema,
  proxyViewSchema,
  updateProxySchema,
} from './proxy.js';

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
  const Subject = registry.register('SubjectView', subjectViewSchema);
  const SubAccount = registry.register('SubAccountView', subAccountViewSchema);
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
  const ModelSpec = registry.register('ModelSpecView', modelSpecViewSchema);
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
  const ModelHealth = registry.register('ModelHealthView', modelHealthViewSchema);
  const OpsSummary = registry.register('OpsSummaryView', opsSummaryViewSchema);
  // per-(channel, model) circuit-breaker status surface (弹性2.0)
  const Breaker = registry.register('BreakerView', breakerViewSchema);

  // The full pricing-method union (`PriceSpec`) registered as ONE named
  // component so the official-price `scheme` (media/credits/matrix) renders as a
  // referenced union in the SDK instead of an opaque `unknown`. The runtime
  // view/body schemas embed `priceSpecSchema.nullable()` (a `z.discriminatedUnion`
  // wrapper that `@asteasolutions/zod-to-openapi` re-inlines as `union | {nullable}`
  // → openapi-typescript collapses to `unknown`). For the OpenAPI doc ONLY we
  // override the `scheme` field to a clean `$ref` to this component made nullable
  // via metadata (`{ allOf: [{$ref}, {nullable}] }`), so the SDK type is the real
  // `PriceSpec | null`. The runtime contract (ZodBody validation) is unaffected —
  // it validates against the original `.nullable()` schemas.
  const PriceSpecRef = registry.register('PriceSpec', priceSpecSchema);
  // `.openapi({ nullable })` is honored at runtime (it lands in the schema
  // metadata) but the v7 `ZodOpenAPIMetadata` typings narrow a discriminated
  // union's single-arg overload to a `string` refId, so the metadata-bag form
  // does not type-check — pass it through an `unknown` cast (runtime-correct; the
  // probe proves it serializes). NOTE: this is the no-refId metadata overload, so
  // it ADDS nullability to the existing `PriceSpec` ref (it does NOT mint a new
  // component). Emits `{ allOf: [{ $ref }, { nullable: true }] }`, which
  // `normalizeNullableRefs` hoists to `{ allOf: [{ $ref }], nullable: true }`.
  const nullablePriceSpec = PriceSpecRef.openapi({ nullable: true } as unknown as string);

  // billing & routing views (billing-views)
  const RouteGroup = registry.register('RouteGroupView', routeGroupViewSchema);
  const RouteGroupChannel = registry.register('RouteGroupChannelView', routeGroupChannelViewSchema);
  const OfficialPrice = registry.register(
    'OfficialPriceView',
    officialPriceViewSchema.extend({ scheme: nullablePriceSpec }),
  );

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
  const StorageUsage = registry.register('StorageUsageView', storageUsageViewSchema);
  // Playground conversation persistence (tenant console).
  const Conversation = registry.register('ConversationView', conversationViewSchema);
  const ConversationDetail = registry.register(
    'ConversationDetailView',
    conversationDetailViewSchema,
  );
  const MessageV = registry.register('MessageView', messageViewSchema);
  const CreateConversation = registry.register('CreateConversationBody', createConversationSchema);
  const UpdateConversation = registry.register('UpdateConversationBody', updateConversationSchema);
  const AppendMessage = registry.register('AppendMessageBody', appendMessageSchema);

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
  const CreateSubject = registry.register('CreateSubjectBody', createSubjectSchema);
  const UpdateSubject = registry.register('UpdateSubjectBody', updateSubjectSchema);
  const CreateSubAccount = registry.register('CreateSubAccountBody', createSubAccountSchema);
  const TopupSubAccount = registry.register('TopupSubAccountBody', topupSubAccountSchema);
  const TransferCredits = registry.register('TransferCreditsBody', transferCreditsSchema);
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
  // Bulk admin actions (前端打磨) — one batch request → partial-success result.
  const BulkModelAction = registry.register('BulkModelActionBody', bulkModelActionSchema);
  const BulkChannelAction = registry.register('BulkChannelActionBody', bulkChannelActionSchema);
  const BulkOAuthSessionAction = registry.register(
    'BulkOAuthSessionActionBody',
    bulkOAuthSessionActionSchema,
  );
  const BulkResult = registry.register('BulkResultView', bulkResultViewSchema);
  // Latest-audit batch (前端打磨 — audit/version badges).
  const LatestAuditRequest = registry.register('LatestAuditRequestBody', latestAuditRequestSchema);
  const LatestAudit = registry.register('LatestAuditView', latestAuditViewSchema);
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
  const CreateModelSpec = registry.register('CreateModelSpecBody', createModelSpecSchema);
  const UpdateModelSpec = registry.register('UpdateModelSpecBody', updateModelSpecSchema);
  const GrantModel = registry.register('GrantModelBody', grantModelSchema);
  const ModelTest = registry.register('ModelTestBody', modelTestRequestSchema);
  const ModelTestResult = registry.register('ModelTestResult', modelTestResultSchema);
  // billing & routing (billing-requests)
  const CreateRouteGroup = registry.register('CreateRouteGroupBody', createRouteGroupSchema);
  const UpdateRouteGroup = registry.register('UpdateRouteGroupBody', updateRouteGroupSchema);
  const FaultPolicy = registry.register('FaultPolicyView', faultPolicyViewSchema);
  const CreateFaultPolicy = registry.register('CreateFaultPolicyBody', createFaultPolicySchema);
  const UpdateFaultPolicy = registry.register('UpdateFaultPolicyBody', updateFaultPolicySchema);
  const Proxy = registry.register('ProxyView', proxyViewSchema);
  const CreateProxy = registry.register('CreateProxyBody', createProxySchema);
  const UpdateProxy = registry.register('UpdateProxyBody', updateProxySchema);
  const ProxyProbe = registry.register('ProxyProbeBody', proxyProbeRequestSchema);
  const AddGroupChannel = registry.register('AddGroupChannelBody', addGroupChannelSchema);
  // Same `scheme` `$ref` override as the view (optional on the bodies): the
  // runtime schemas keep `priceSpecSchema.nullable().optional()`; the OpenAPI doc
  // points the field at the `PriceSpec` component made nullable via metadata.
  const CreateOfficialPrice = registry.register(
    'CreateOfficialPriceBody',
    createOfficialPriceSchema.extend({ scheme: nullablePriceSpec.optional() }),
  );
  const UpdateOfficialPrice = registry.register(
    'UpdateOfficialPriceBody',
    updateOfficialPriceSchema.extend({ scheme: nullablePriceSpec.optional() }),
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
  // Speech-to-text relay (multipart) contracts. `TranscriptionReq` carries the
  // non-file fields; the path's multipart requestBody extends it with the binary
  // `file` part. `TranscriptionResp` is the richest (verbose_json) response shape.
  const TranscriptionReq = transcriptionRequestSchema;
  const TranscriptionResp = registry.register('TranscriptionResponse', transcriptionResponseSchema);

  // platform-auth session contracts (auth-sessions slice)
  const TokenPair = registry.register('TokenPair', tokenPairSchema);
  const RefreshReq = registry.register('RefreshBody', refreshRequestSchema);
  const LogoutReq = registry.register('LogoutBody', logoutRequestSchema);
  const Jwks = registry.register('JwksResponse', jwksResponseSchema);

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
  // Bulk admin actions (前端打磨) — each returns a partial-success {succeeded, failed}.
  write({
    method: 'post',
    path: '/admin/models/bulk',
    summary: 'Bulk enable/disable/delete models (by name; partial success)',
    tag: 'catalog',
    body: BulkModelAction,
    response: BulkResult,
  });
  write({
    method: 'post',
    path: '/admin/channels/bulk',
    summary: 'Bulk enable/disable/delete channels (by id; partial success)',
    tag: 'catalog',
    body: BulkChannelAction,
    response: BulkResult,
  });
  write({
    method: 'post',
    path: '/admin/oauth-sessions/bulk',
    summary: 'Bulk revoke OAuth sessions (by id; partial success)',
    tag: 'admin',
    body: BulkOAuthSessionAction,
    response: BulkResult,
  });
  write({
    method: 'post',
    path: '/admin/audit-log/latest',
    summary: 'Newest audit_log row per target id (batch; for entity-list audit badges)',
    tag: 'admin',
    body: LatestAuditRequest,
    response: z.array(LatestAudit),
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
    // 染色: narrow the audit trace to one route tag (canary) the call was pinned to.
    routeTag: z.string().optional(),
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
  list('/admin/fault-policies', 'List fault-tolerance policies', FaultPolicy, 'catalog');
  getOne('/admin/fault-policies/{id}', 'Get one fault policy', FaultPolicy, 'catalog');
  list('/admin/proxies', 'List managed egress proxies', Proxy, 'catalog');
  getOne('/admin/proxies/{id}', 'Get one proxy', Proxy, 'catalog');
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
  // 规格库: the official model spec catalog, filterable by vendor / type.
  const modelSpecsQuery = keyset.extend({
    vendor: z.string().optional(),
    type: z.string().optional(),
  });
  list(
    '/admin/model-specs',
    'List the official model spec catalog (规格库)',
    ModelSpec,
    'catalog',
    modelSpecsQuery,
  );
  list('/admin/models/{name}/grants', 'List a model’s tenant grants', ModelGrant, 'catalog');
  list('/console/api-keys', 'List your tenant API keys', ConsoleApiKey, 'console', keyset);
  list('/console/models', 'Models visible to your tenant', ConsoleModel, 'console');
  list('/console/usage-log', 'Your tenant per-call usage log', ConsoleUsageLog, 'console', keyset);
  list('/console/payments', 'Your tenant payment history', ConsolePayment, 'console', keyset);
  // Tenant asset gallery: ready media files, newest-first, optionally narrowed to a media kind.
  const consoleFilesQuery = keyset.extend({ kind: z.enum(['image', 'video', 'audio']).optional() });
  list('/console/files', 'Your tenant media files', ConsoleFile, 'console', consoleFilesQuery);
  // Playground: saved chat conversations (keyset, most-recent-activity first).
  list('/console/conversations', 'Your playground conversations', Conversation, 'console', keyset);
  getOne(
    '/console/conversations/{id}',
    'A conversation with its full transcript',
    ConversationDetail,
    'console',
  );
  del('/console/conversations/{id}', 'Delete one of your conversations', 'console');
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
  getOne('/admin/model-specs/{id}', 'Get one model spec', ModelSpec, 'catalog');
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
  // 规格库 CRUD: maintain the official model spec catalog.
  write({
    method: 'post',
    path: '/admin/model-specs',
    summary: 'Add a model spec to the catalog',
    tag: 'catalog',
    body: CreateModelSpec,
    response: ModelSpec,
    created: true,
  });
  write({
    method: 'patch',
    path: '/admin/model-specs/{id}',
    summary: 'Update a model spec',
    tag: 'catalog',
    body: UpdateModelSpec,
    response: ModelSpec,
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
  getArray(
    '/admin/health/models',
    'Per-model health from real traffic (status page): availability, latency, uptime history',
    ModelHealth,
    'admin',
    z.object({ days: z.coerce.number().int().min(1).max(90).optional() }),
  );
  // 弹性2.0 circuit-breaker status surface: list tripped/probing breakers + ops reset.
  getArray(
    '/admin/breakers',
    'Live circuit-breaker status: tripped/probing (channel, model) FSM rows',
    Breaker,
    'admin',
  );
  // Reset one (channel, model) breaker back to closed (ops un-stick). No body; 204.
  registry.registerPath({
    method: 'post',
    path: '/admin/breakers/{channelId}/{model}/reset',
    summary: 'Reset a circuit breaker back to closed (ops un-stick)',
    tags: ['admin'],
    request: { params: z.object({ channelId: z.string(), model: z.string() }) },
    responses: { 204: { description: 'Breaker cleared' } },
  });

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
  // Object-storage usage + quota (JWT plane) — the asset-gallery quota bar.
  getOne(
    '/console/files/usage',
    'Your tenant object-storage usage + quota',
    StorageUsage,
    'console',
  );

  // --- DELETE (revoke/remove → 204; the FE methods return void) -------------
  del('/admin/resources/{id}/channels/{channelId}', 'Delete a channel', 'catalog');
  del('/admin/api-keys/{id}', 'Revoke an API key', 'admin');
  del('/admin/tokens/{id}', 'Revoke an admin service token', 'admin');
  del('/admin/oauth-sessions/{id}', 'Revoke an OAuth subscription session', 'admin');
  del('/admin/route-groups/{id}', 'Delete a route group', 'billing');
  del('/admin/route-groups/{id}/channels/{channelId}', 'Remove a group channel', 'billing');
  del('/admin/official-prices/{id}', 'Delete an official price row', 'billing');
  del('/admin/model-specs/{id}', 'Soft-delete a model spec', 'catalog');
  del('/admin/pricebook/{id}', 'Delete a pricebook entry', 'pricing');
  del('/admin/modifiers/{id}', 'Delete a pricing modifier', 'pricing');
  del('/admin/plugins/{id}', 'Soft-delete a custom provider plugin', 'catalog');
  del('/admin/secrets/{id}', 'Revoke an encrypted credential', 'admin');
  del('/admin/models/{name}', 'Delete a relay model', 'catalog');
  del('/admin/models/{name}/grants/{tenantId}', 'Revoke a model grant', 'catalog');
  del('/console/files/{id}', 'Delete one of your tenant’s files', 'console');

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
  // tenant subjects (end-users; unified tenancy G-A)
  list('/admin/tenants/{id}/users', "List a tenant's subjects (paginated)", Subject, 'tenants');
  getOne('/admin/tenants/{id}/users/{sid}', 'Get one subject by id', Subject, 'tenants');
  write({
    method: 'post',
    path: '/admin/tenants/{id}/users',
    summary: 'Create a subject (end-user) under a tenant',
    tag: 'tenants',
    body: CreateSubject,
    response: Subject,
    created: true,
  });
  write({
    method: 'patch',
    path: '/admin/tenants/{id}/users/{sid}',
    summary: 'Update a subject',
    tag: 'tenants',
    body: UpdateSubject,
    response: Subject,
  });
  del('/admin/tenants/{id}/users/{sid}', 'Soft-delete a subject', 'tenants');
  // subject sub-wallets (HARD mode; unified tenancy G-E)
  getOne(
    '/admin/tenants/{id}/users/{sid}/sub-account',
    'Get a subject sub-wallet (balance/held)',
    SubAccount,
    'tenants',
  );
  write({
    method: 'post',
    path: '/admin/tenants/{id}/users/{sid}/sub-account',
    summary: 'Open a HARD sub-wallet for a subject',
    tag: 'tenants',
    body: CreateSubAccount,
    response: SubAccount,
    created: true,
  });
  write({
    method: 'post',
    path: '/admin/tenants/{id}/users/{sid}/sub-account/topup',
    summary: "Credit a subject's sub-wallet",
    tag: 'tenants',
    body: TopupSubAccount,
    response: SubAccount,
  });
  write({
    method: 'post',
    path: '/admin/tenants/{id}/users/{sid}/sub-account/transfer',
    summary: 'Transfer credits between the tenant pool and a sub-wallet',
    tag: 'tenants',
    body: TransferCredits,
    response: SubAccount,
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
    method: 'post',
    path: '/admin/models/test',
    summary: 'Probe a candidate model (connectivity + functional) before adding it',
    tag: 'catalog',
    body: ModelTest,
    response: ModelTestResult,
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

  // fault-tolerance policies (调用容错)
  write({
    method: 'post',
    path: '/admin/fault-policies',
    summary: 'Create a fault-tolerance policy',
    tag: 'catalog',
    body: CreateFaultPolicy,
    response: FaultPolicy,
    created: true,
  });
  write({
    method: 'patch',
    path: '/admin/fault-policies/{id}',
    summary: 'Update a fault-tolerance policy',
    tag: 'catalog',
    body: UpdateFaultPolicy,
    response: FaultPolicy,
  });
  del('/admin/fault-policies/{id}', 'Delete a fault-tolerance policy', 'catalog');

  // managed egress proxies (代理)
  write({
    method: 'post',
    path: '/admin/proxies',
    summary: 'Create a managed egress proxy',
    tag: 'catalog',
    body: CreateProxy,
    response: Proxy,
    created: true,
  });
  write({
    method: 'patch',
    path: '/admin/proxies/{id}',
    summary: 'Update a managed proxy',
    tag: 'catalog',
    body: UpdateProxy,
    response: Proxy,
  });
  write({
    method: 'post',
    path: '/admin/proxies/{id}/probe',
    summary: 'Probe a proxy and record its health',
    tag: 'catalog',
    body: ProxyProbe,
    response: Proxy,
  });
  del('/admin/proxies/{id}', 'Delete a managed proxy', 'catalog');

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
  // Playground conversations: create / rename+re-model / append a turn.
  write({
    method: 'post',
    path: '/console/conversations',
    summary: 'Start a playground conversation',
    tag: 'console',
    body: CreateConversation,
    response: Conversation,
    created: true,
  });
  write({
    method: 'patch',
    path: '/console/conversations/{id}',
    summary: 'Rename / re-model a conversation',
    tag: 'console',
    body: UpdateConversation,
    response: Conversation,
  });
  write({
    method: 'post',
    path: '/console/conversations/{id}/messages',
    summary: 'Append a turn to a conversation',
    tag: 'console',
    body: AppendMessage,
    response: MessageV,
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

  // OpenAI-compatible speech-to-text relay (`POST /v1/audio/transcriptions`),
  // billed per audio second. multipart/form-data: a binary `file` part + the
  // non-file fields (model/language/prompt/response_format/temperature). The
  // request is registered directly (not via `write`, which assumes JSON) so the
  // SDK types the multipart body + the verbose_json response.
  registry.registerPath({
    method: 'post',
    path: '/v1/audio/transcriptions',
    summary: 'OpenAI-compatible speech-to-text (multipart upload; billed per audio second)',
    tags: ['data-plane'],
    request: {
      body: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: TranscriptionReq.extend({
              file: z.string().openapi({ type: 'string', format: 'binary' }),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Transcription (shape per response_format)',
        content: { 'application/json': { schema: TranscriptionResp } },
      },
    },
  });

  // --- platform-auth session paths (auth-sessions slice) --------------------
  // `/auth/refresh` + `/auth/logout` are credential-exchange endpoints (no Bearer
  // needed — the refresh token IS the credential); the JWKS is fully public.
  registry.registerPath({
    method: 'post',
    path: '/auth/refresh',
    summary: 'Rotate a refresh token (returns a new access + refresh pair)',
    tags: ['auth'],
    security: [],
    request: { body: { content: { 'application/json': { schema: RefreshReq } }, required: true } },
    responses: {
      200: {
        description: 'New token pair',
        content: { 'application/json': { schema: TokenPair } },
      },
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/auth/logout',
    summary: 'Revoke a refresh token (logout)',
    tags: ['auth'],
    security: [],
    request: { body: { content: { 'application/json': { schema: LogoutReq } }, required: true } },
    responses: { 204: { description: 'Logged out (idempotent)' } },
  });
  registry.registerPath({
    method: 'get',
    path: '/.well-known/jwks.json',
    summary: 'Public JWK set for verifying RS256 access tokens (empty under HS256)',
    tags: ['well-known'],
    security: [],
    responses: {
      200: {
        description: 'JWK set',
        content: { 'application/json': { schema: Jwks } },
      },
    },
  });

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
  normalizeNullableRefs(doc);
  return doc;
}

/**
 * Normalize zod-to-openapi's nullable-`$ref` shape for openapi-typescript.
 *
 * `register('X', s).openapi({ nullable: true })` emits
 * `{ allOf: [{ $ref }, { nullable: true }] }` (the nullable lives as a sibling
 * member INSIDE the `allOf`). openapi-typescript renders that intersection as
 * `X & unknown` (≈ `X`, and crucially NOT nullable). Hoisting the flag to the
 * top — `{ allOf: [{ $ref }], nullable: true }` — makes openapi-typescript emit
 * the intended `X | null`. We do this as a post-pass (mirrors `attachErrors`) so
 * the registration stays declarative; it touches ONLY the exact `allOf:[ref] +
 * sibling {nullable:true}` shape and leaves every other schema untouched. Used by
 * the official-price `scheme` field (a nullable `PriceSpec` $ref).
 */
function normalizeNullableRefs(doc: ReturnType<OpenApiGeneratorV3['generateDocument']>): void {
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const allOf = obj.allOf;
    if (Array.isArray(allOf)) {
      const refs = allOf.filter(
        (m): m is Record<string, unknown> =>
          typeof m === 'object' && m !== null && '$ref' in (m as object),
      );
      const nullableSiblings = allOf.filter(
        (m): m is Record<string, unknown> =>
          typeof m === 'object' &&
          m !== null &&
          Object.keys(m as object).length === 1 &&
          (m as Record<string, unknown>).nullable === true,
      );
      // The exact nullable-`$ref` shape: one+ `$ref` member(s) plus a lone
      // `{ nullable: true }` sibling and nothing else. Hoist `nullable` to top
      // and drop the empty sibling.
      if (nullableSiblings.length > 0 && refs.length + nullableSiblings.length === allOf.length) {
        obj.allOf = refs;
        obj.nullable = true;
      }
    }
    for (const value of Object.values(obj)) visit(value);
  };
  visit(doc);
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
