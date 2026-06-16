export interface TenantView {
  id: string;
  name: string;
  isolation_mode: string;
  created_at: string;
}
export interface AccountView {
  id: string;
  tenant_id: string;
  credit_balance: string;
  credit_held: string;
  created_at: string;
}
export interface ApiKeyView {
  id: string;
  tenant_id: string;
  resource_allowlist: string[];
  rate_limit: number | null;
  status: string;
  created_at: string;
}
export interface ApiKeyCreatedView {
  id: string;
  plaintext: string;
}
export interface ResourceView {
  id: string;
  tenant_id: string;
  kind: string;
  modality: string;
  provider_type: string;
  exec_modes: string[];
  status: string;
  current_version: number;
  created_at: string;
}
export interface JobView {
  job_id: string;
  tenant_id: string;
  resource_id: string;
  status: string;
  exec_mode: string;
  cost: string | null;
  created_at: string;
}
export interface Page<T> {
  rows: T[];
  nextCursor: string | null;
}

export interface CreateTenantBody {
  name: string;
  isolationMode?: 'field' | 'schema' | 'db';
}
export interface CreateAccountBody {
  tenantId: string;
  credits?: number;
}
export interface TopupBody {
  credits: number;
}
export interface CreateApiKeyBody {
  tenantId: string;
  resourceAllowlist?: string[];
  rateLimit?: number;
}
