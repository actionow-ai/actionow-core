/** Single source of truth for TanStack Query cache keys (admin plane). */
export const qk = {
  tenants: () => ['admin', 'tenants'] as const,
  accounts: () => ['admin', 'accounts'] as const,
  resources: () => ['admin', 'resources'] as const,
  channels: (resourceId: string) => ['admin', 'resources', resourceId, 'channels'] as const,
  pricebook: (resourceId: string) => ['admin', 'pricebook', resourceId] as const,
  modifiers: () => ['admin', 'modifiers'] as const,
  secrets: () => ['admin', 'secrets'] as const,
  apiKeys: (tenantId: string) => ['admin', 'api-keys', tenantId] as const,
  redemptionCodes: (status?: string) =>
    status === undefined
      ? (['admin', 'redemption-codes'] as const)
      : (['admin', 'redemption-codes', status] as const),
  oauthSessions: () => ['admin', 'oauth-sessions'] as const,
  routeGroups: () => ['admin', 'route-groups'] as const,
  routeGroupChannels: (id: string) => ['admin', 'route-groups', id, 'channels'] as const,
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

  // Tenant self-service console plane.
  consoleApiKeys: () => ['console', 'api-keys'] as const,
  consoleUsage: () => ['console', 'usage'] as const,
  consoleModels: () => ['console', 'models'] as const,
  consoleAnalytics: (params: Record<string, unknown>) => ['console', 'analytics', params] as const,
  consoleUsageLog: () => ['console', 'usage-log'] as const,
  consolePayments: () => ['console', 'payments'] as const,
  consoleMe: () => ['console', 'me'] as const,
  consoleBalance: () => ['console', 'balance'] as const,
  consoleFiles: (kind?: string) =>
    kind === undefined ? (['console', 'files'] as const) : (['console', 'files', kind] as const),
  ledger: (tenantId: string) => ['admin', 'ledger', tenantId] as const,
  payments: (tenantId: string) => ['admin', 'payments', tenantId] as const,
};
