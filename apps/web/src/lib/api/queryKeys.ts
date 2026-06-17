/** Single source of truth for TanStack Query cache keys (admin plane). */
export const qk = {
  tenants: () => ['admin', 'tenants'] as const,
  resources: () => ['admin', 'resources'] as const,
  channels: (resourceId: string) => ['admin', 'resources', resourceId, 'channels'] as const,
  pricebook: (resourceId: string) => ['admin', 'pricebook', resourceId] as const,
  modifiers: () => ['admin', 'modifiers'] as const,
  apiKeys: (tenantId: string) => ['admin', 'api-keys', tenantId] as const,
  jobs: (tenantId: string) => ['admin', 'jobs', tenantId] as const,
  models: () => ['admin', 'models'] as const,
  modelGrants: (name: string) => ['admin', 'models', name, 'grants'] as const,
  usage: (params: Record<string, unknown>) => ['admin', 'usage', params] as const,
  analyticsUsage: (params: Record<string, unknown>) =>
    ['admin', 'analytics-usage', params] as const,
  ledger: (tenantId: string) => ['admin', 'ledger', tenantId] as const,
  payments: (tenantId: string) => ['admin', 'payments', tenantId] as const,
};
