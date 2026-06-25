/** Single source of truth for TanStack Query cache keys (admin plane). */
export const qk = {
  tenants: () => ['admin', 'tenants'] as const,
  subjects: (tenantId: string) => ['admin', 'tenants', tenantId, 'subjects'] as const,
  subAccount: (tenantId: string, sid: string) =>
    ['admin', 'tenants', tenantId, 'subjects', sid, 'sub-account'] as const,
  accounts: () => ['admin', 'accounts'] as const,
  resources: () => ['admin', 'resources'] as const,
  channels: (resourceId: string) => ['admin', 'resources', resourceId, 'channels'] as const,
  channelModels: (channelId: string) => ['admin', 'channels', channelId, 'models'] as const,
  pricebook: (resourceId: string) => ['admin', 'pricebook', resourceId] as const,
  modifiers: () => ['admin', 'modifiers'] as const,
  difyBindings: () => ['admin', 'dify'] as const,
  secrets: () => ['admin', 'secrets'] as const,
  apiKeys: (tenantId: string) => ['admin', 'api-keys', tenantId] as const,
  adminTokens: () => ['admin', 'tokens'] as const,
  redemptionCodes: (status?: string) =>
    status === undefined
      ? (['admin', 'redemption-codes'] as const)
      : (['admin', 'redemption-codes', status] as const),
  oauthSessions: () => ['admin', 'oauth-sessions'] as const,
  plugins: () => ['admin', 'plugins'] as const,
  pluginChannels: (id: string) => ['admin', 'plugins', id, 'channels'] as const,
  icons: () => ['admin', 'icons'] as const,
  providerTypes: () => ['admin', 'provider-types'] as const,
  routeGroups: () => ['admin', 'route-groups'] as const,
  routeGroupChannels: (id: string) => ['admin', 'route-groups', id, 'channels'] as const,
  faultPolicies: () => ['admin', 'fault-policies'] as const,
  limitPlans: () => ['admin', 'limit-plans'] as const,
  limitUsage: (subjectType: string, subjectId: string) =>
    ['admin', 'limit-usage', subjectType, subjectId] as const,
  limitStatus: (subjectType: string, subjectId: string) =>
    ['admin', 'limit-status', subjectType, subjectId] as const,
  limitAlerts: () => ['admin', 'limit-alerts'] as const,
  auditLog: (params: Record<string, unknown>) => ['admin', 'audit-log', params] as const,
  reconcile: (tenantId: string) => ['admin', 'reconcile', tenantId] as const,
  proxies: () => ['admin', 'proxies'] as const,
  modelHealth: (days: number) => ['admin', 'model-health', days] as const,
  /** No params → the bare prefix (invalidates every param variant); with params → the specific filtered key. */
  officialPrices: (params?: Record<string, unknown>) =>
    params === undefined
      ? (['admin', 'official-prices'] as const)
      : (['admin', 'official-prices', params] as const),
  jobs: (tenantId: string) => ['admin', 'jobs', tenantId] as const,
  models: () => ['admin', 'models'] as const,
  model: (name: string) => ['admin', 'models', name] as const,
  modelGrants: (name: string) => ['admin', 'models', name, 'grants'] as const,
  usage: (params: Record<string, unknown>) => ['admin', 'usage', params] as const,
  analyticsUsage: (params: Record<string, unknown>) =>
    ['admin', 'analytics-usage', params] as const,
  relayTraces: (params: Record<string, unknown>) => ['admin', 'relay-traces', params] as const,
  summary: () => ['admin', 'summary'] as const,
  health: () => ['admin', 'health'] as const,

  // Tenant self-service console plane.
  consoleApiKeys: () => ['console', 'api-keys'] as const,
  consoleUsage: () => ['console', 'usage'] as const,
  consoleModels: () => ['console', 'models'] as const,
  consoleAnalytics: (params: Record<string, unknown>) => ['console', 'analytics', params] as const,
  consoleUsageLog: () => ['console', 'usage-log'] as const,
  consolePayments: () => ['console', 'payments'] as const,
  consolePaymentIntent: (id: string) => ['console', 'payments', 'intent', id] as const,
  consoleMe: () => ['console', 'me'] as const,
  consoleBalance: () => ['console', 'balance'] as const,
  consoleFiles: (kind?: string) =>
    kind === undefined ? (['console', 'files'] as const) : (['console', 'files', kind] as const),
  consoleLimits: () => ['console', 'limits'] as const,
  ledger: (tenantId: string) => ['admin', 'ledger', tenantId] as const,
  payments: (tenantId: string) => ['admin', 'payments', tenantId] as const,
};
