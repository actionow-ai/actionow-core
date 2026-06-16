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

// --- Catalog (operator) ---
export interface PricebookView {
  id: string;
  resource_id: string;
  resource_version: number;
  version: number;
  method: string;
  timing: string;
  spec: unknown;
  markup: string | null;
  active: boolean;
}
export interface ModifierView {
  id: string;
  scope: string;
  when_expr: string | null;
  op: string;
  value: string | null;
  stackable: boolean;
  priority: number;
  version: number;
  active: boolean;
}
export interface ChannelView {
  id: string;
  resource_id: string;
  provider_type: string;
  credential_ref: string | null;
  weight: number;
  status: string;
}
export interface DifyImportView {
  resource_id: string;
  version: number;
  io_schema: unknown;
  compat_report: unknown;
}

export interface CreateResourceBody {
  id: string;
  tenantId: string;
  kind: 'model' | 'workflow';
  modality: string;
  providerType: string;
  execModes: string[];
  ioSchema: unknown;
  version?: number;
}
export interface CreateChannelBody {
  providerType: string;
  credentialRef?: string;
  weight?: number;
  status?: string;
}
export interface CreatePricebookBody {
  resourceId: string;
  resourceVersion: number;
  version: number;
  method: string;
  timing: string;
  spec: unknown;
  markup?: number;
  active?: boolean;
}
export interface CreateModifierBody {
  scope: string;
  whenExpr?: string;
  op: string;
  value?: number;
  stackable?: boolean;
  priority?: number;
  version?: number;
  active?: boolean;
}
export interface DifyImportBody {
  tenantId: string;
  resourceId: string;
  yaml: string;
  endpoint: string;
  serviceKeyRef?: string;
  pricingModel: unknown;
  allowBlockers?: boolean;
}
