# Frontend Console — Plan 1: Operator Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the operator console's catalog surface — Resources (list+create), Resource detail (pricebook list+add, channel add-form), Modifiers (list+create), and Dify import — against the already-shipped `/admin/*` API, plus the small shared kit those screens need.

**Architecture:** Extend the existing `admin` API client + view/body types; add a few presentational kit components (`SectionHeader`, `StatusBadge`, `EmptyState`, `JsonField`); add a "catalog" nav group; add four feature pages mirroring the existing [TenantsPage](apps/web/src/features/console/TenantsPage.tsx) pattern (TanStack Query + `DataTable` + `Modal` + `useAdminApi`). No new auth/client layer — operator screens reuse the admin client. The tenant `console` client is Plan 3.

**Tech Stack:** React 19 + TS, TanStack Query v5, react-i18next, Phosphor icons, vitest (pure-logic unit tests), browser verification against the real API on `:3000` (seed admin `admin@actionow.local` / `actionow-dev-password`).

---

## Backend dependencies discovered during planning (build to the real API)

These are **real API constraints** — the plan builds only what the shipped `/admin/*` accepts:

1. **`createChannelSchema` accepts only `{ providerType, credentialRef?, weight?, status? }`** (`apps/api/src/admin/dto/admin.dto.ts`). The real-providers `endpoint/model/proxy_ref/config` exist in the DB + engine but are **not yet exposed** by the admin channel-create DTO. → Plan 1's channel form uses only the accepted fields. Extending the DTO is a **backend follow-up** (small: add the four optional fields to `createChannelSchema` + pass through `admin.service.ts::createUpstreamChannel`, which the db repo already supports).
2. **Channels are POST-only** — no `GET` to list a resource's channels. → The channel UI is an **add-form** (write + success toast), not a list. Listing is a backend follow-up.
3. **No `GET /admin/resources/:id`** — only `GET /admin/resources` (list). → Resource detail reads the resource from the resources list (cache/refetch + find by id), not a single-resource fetch.

Confirmed shipped routes used here: `GET/POST /admin/resources`, `POST /admin/resources/:id/channels`, `GET/POST /admin/pricebook?resourceId=`, `GET/POST /admin/modifiers`, `POST /admin/dify/import`.

## File structure

- Modify `apps/web/src/lib/api/types.ts` — add catalog view/body types.
- Modify `apps/web/src/lib/api/admin.ts` — add catalog API methods.
- Create `apps/web/src/lib/api/admin.test.ts` — unit-test the new method URL/body wiring.
- Create `apps/web/src/components/ui/JsonField.tsx` + `validateJson` helper.
- Create `apps/web/src/components/ui/JsonField.test.ts` — unit-test `validateJson`.
- Create `apps/web/src/components/ui/SectionHeader.tsx`, `StatusBadge.tsx`, `EmptyState.tsx`.
- Modify `apps/web/src/components/console/nav-config.ts` — add `catalog` group + mobile tab.
- Modify `apps/web/src/i18n/locales/zh-CN/console.json` + `en/console.json` — catalog strings.
- Create `apps/web/src/features/console/ResourcesPage.tsx`.
- Create `apps/web/src/features/console/ResourceDetailPage.tsx`.
- Create `apps/web/src/features/console/ModifiersPage.tsx`.
- Create `apps/web/src/features/console/DifyImportPage.tsx`.
- Modify `apps/web/src/routes.tsx` — register the four routes.

All commands run from `/Users/alienworm/actionow-web`. Per-task: `pnpm --filter @actionow/web <typecheck|lint|build|test>`.

---

## Task 1: Catalog view/body types

**Files:**

- Modify: `apps/web/src/lib/api/types.ts`

- [ ] **Step 1: Add the types** (append to the file, after the existing bodies)

```ts
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
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm --filter @actionow/web typecheck`
Expected: PASS (types only; no consumers yet).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api/types.ts
git commit -m "feat(web): catalog view/body types"
```

---

## Task 2: Catalog API methods (TDD)

**Files:**

- Modify: `apps/web/src/lib/api/admin.ts`
- Create: `apps/web/src/lib/api/admin.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';

import { makeAdminApi } from './admin';
import type { ApiClient } from './client';

function fakeClient() {
  const calls: { method: 'get' | 'post'; path: string; arg: unknown }[] = [];
  const client = {
    get: vi.fn((path: string, query?: unknown) => {
      calls.push({ method: 'get', path, arg: query });
      return Promise.resolve([]);
    }),
    post: vi.fn((path: string, body?: unknown) => {
      calls.push({ method: 'post', path, arg: body });
      return Promise.resolve({});
    }),
  } as unknown as ApiClient;
  return { client, calls };
}

describe('admin catalog api', () => {
  it('createResource posts to /admin/resources', async () => {
    const { client, calls } = fakeClient();
    await makeAdminApi(client).createResource({
      id: 'r1',
      tenantId: 't1',
      kind: 'model',
      modality: 'text',
      providerType: 'openai',
      execModes: ['blocking'],
      ioSchema: {},
    });
    expect(calls[0]).toEqual({
      method: 'post',
      path: '/admin/resources',
      arg: expect.objectContaining({ id: 'r1' }),
    });
  });

  it('createChannel posts to the resource-scoped channels path', async () => {
    const { client, calls } = fakeClient();
    await makeAdminApi(client).createChannel('r1', { providerType: 'openai', weight: 1 });
    expect(calls[0]?.path).toBe('/admin/resources/r1/channels');
  });

  it('listPricebook gets /admin/pricebook with resourceId', async () => {
    const { client, calls } = fakeClient();
    await makeAdminApi(client).listPricebook('r1');
    expect(calls[0]).toEqual({
      method: 'get',
      path: '/admin/pricebook',
      arg: { resourceId: 'r1' },
    });
  });

  it('listModifiers gets /admin/modifiers', async () => {
    const { client, calls } = fakeClient();
    await makeAdminApi(client).listModifiers();
    expect(calls[0]?.path).toBe('/admin/modifiers');
  });

  it('difyImport posts to /admin/dify/import', async () => {
    const { client, calls } = fakeClient();
    await makeAdminApi(client).difyImport({
      tenantId: 't1',
      resourceId: 'r1',
      yaml: 'x',
      endpoint: 'https://e',
      pricingModel: {},
    });
    expect(calls[0]?.path).toBe('/admin/dify/import');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `pnpm --filter @actionow/web test admin`
Expected: FAIL — `createResource`/`createChannel`/`listPricebook`/`createPricebook`/`listModifiers`/`createModifier`/`difyImport` are not functions.

- [ ] **Step 3: Implement the methods**

In `apps/web/src/lib/api/admin.ts`, add the new imports to the type list:

```ts
import type {
  AccountView,
  ApiKeyCreatedView,
  ApiKeyView,
  ChannelView,
  CreateAccountBody,
  CreateApiKeyBody,
  CreateChannelBody,
  CreateModifierBody,
  CreatePricebookBody,
  CreateResourceBody,
  CreateTenantBody,
  DifyImportBody,
  DifyImportView,
  JobView,
  ModifierView,
  Page,
  PricebookView,
  ResourceView,
  TenantView,
  TopupBody,
} from './types';
```

Inside the object returned by `makeAdminApi`, after `listResources`, add:

```ts
    createResource: (body: CreateResourceBody) => client.post<ResourceView>('/admin/resources', body),
    createChannel: (resourceId: string, body: CreateChannelBody) =>
      client.post<ChannelView>(`/admin/resources/${resourceId}/channels`, body),

    listPricebook: (resourceId: string) =>
      client.get<PricebookView[]>('/admin/pricebook', { resourceId }),
    createPricebook: (body: CreatePricebookBody) =>
      client.post<PricebookView>('/admin/pricebook', body),

    listModifiers: () => client.get<ModifierView[]>('/admin/modifiers'),
    createModifier: (body: CreateModifierBody) => client.post<ModifierView>('/admin/modifiers', body),

    difyImport: (body: DifyImportBody) => client.post<DifyImportView>('/admin/dify/import', body),
```

- [ ] **Step 4: Run it, expect PASS**

Run: `pnpm --filter @actionow/web test admin`
Expected: PASS (all 5 tests green).

- [ ] **Step 5: Lint + commit**

```bash
pnpm --filter @actionow/web exec eslint src/lib/api/admin.ts src/lib/api/admin.test.ts --fix
git add apps/web/src/lib/api/admin.ts apps/web/src/lib/api/admin.test.ts
git commit -m "feat(web): admin catalog api methods"
```

---

## Task 3: `validateJson` helper + `JsonField` (TDD on the helper)

`ioSchema`, pricebook `spec`, and dify `pricingModel` are JSON inputs. A validated JSON textarea keeps them honest without a field-builder.

**Files:**

- Create: `apps/web/src/components/ui/JsonField.tsx`
- Create: `apps/web/src/components/ui/JsonField.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';

import { validateJson } from './JsonField';

describe('validateJson', () => {
  it('returns the parsed value for valid JSON', () => {
    expect(validateJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });
  it('returns ok with undefined for empty input', () => {
    expect(validateJson('   ')).toEqual({ ok: true, value: undefined });
  });
  it('returns an error for malformed JSON', () => {
    const r = validateJson('{bad}');
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `pnpm --filter @actionow/web test JsonField`
Expected: FAIL — cannot import `validateJson`.

- [ ] **Step 3: Implement `JsonField.tsx`**

```tsx
import type { CSSProperties } from 'react';

export type JsonResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Parse a JSON textarea value. Empty → ok/undefined (caller decides if required). */
export function validateJson(raw: string): JsonResult {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid JSON' };
  }
}

const taStyle: CSSProperties = {
  width: '100%',
  minHeight: 120,
  resize: 'vertical',
  fontSize: 12,
  lineHeight: 1.6,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  color: 'var(--text)',
  background: 'var(--panel-bg)',
  border: '1px solid var(--panel-bd)',
  borderRadius: 'var(--r-sm)',
  padding: 'var(--s-3)',
};

export function JsonField({
  label,
  value,
  onChange,
  error,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  placeholder?: string;
}) {
  return (
    <label style={{ display: 'block', fontSize: 12.5 }}>
      <span style={{ display: 'block', color: 'var(--muted)', marginBottom: 6 }}>{label}</span>
      <textarea
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={error ? { ...taStyle, borderColor: 'var(--danger, var(--accent-2))' } : taStyle}
      />
      {error !== undefined && (
        <span style={{ display: 'block', color: 'var(--accent-2)', fontSize: 11, marginTop: 4 }}>
          {error}
        </span>
      )}
    </label>
  );
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `pnpm --filter @actionow/web test JsonField`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
pnpm --filter @actionow/web exec eslint src/components/ui/JsonField.tsx src/components/ui/JsonField.test.ts --fix
git add apps/web/src/components/ui/JsonField.tsx apps/web/src/components/ui/JsonField.test.ts
git commit -m "feat(web): JsonField + validateJson helper"
```

---

## Task 4: Presentational kit — `SectionHeader`, `StatusBadge`, `EmptyState`

**Files:**

- Create: `apps/web/src/components/ui/SectionHeader.tsx`
- Create: `apps/web/src/components/ui/StatusBadge.tsx`
- Create: `apps/web/src/components/ui/EmptyState.tsx`

- [ ] **Step 1: Implement the three components**

`SectionHeader.tsx`:

```tsx
import type { ReactNode } from 'react';

export function SectionHeader({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--s-3)',
      }}
    >
      <h2
        style={{
          fontSize: 15,
          fontWeight: 700,
          letterSpacing: '-0.01em',
          margin: 0,
          whiteSpace: 'nowrap',
        }}
      >
        {title}
      </h2>
      {action}
    </div>
  );
}
```

`StatusBadge.tsx` (warm palette, never blue):

```tsx
export function StatusBadge({ status }: { status: string }) {
  const active = status === 'active';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        fontWeight: 600,
        padding: '2px 9px',
        borderRadius: 'var(--r-pill)',
        whiteSpace: 'nowrap',
        color: active ? 'var(--ink)' : 'var(--muted)',
        background: active
          ? 'linear-gradient(135deg, var(--accent), var(--accent-2))'
          : 'var(--panel-bg)',
        border: active ? 'none' : '1px solid var(--panel-bd)',
      }}
    >
      {status}
    </span>
  );
}
```

`EmptyState.tsx`:

```tsx
import type { ReactNode } from 'react';

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      style={{ padding: 'var(--s-8)', textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}
    >
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck + lint**

Run: `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web exec eslint src/components/ui/SectionHeader.tsx src/components/ui/StatusBadge.tsx src/components/ui/EmptyState.tsx --fix`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/SectionHeader.tsx apps/web/src/components/ui/StatusBadge.tsx apps/web/src/components/ui/EmptyState.tsx
git commit -m "feat(web): SectionHeader, StatusBadge, EmptyState kit"
```

---

## Task 5: i18n — catalog strings (zh + en)

**Files:**

- Modify: `apps/web/src/i18n/locales/zh-CN/console.json`
- Modify: `apps/web/src/i18n/locales/en/console.json`

- [ ] **Step 1: Add the `nav` keys + catalog blocks (zh-CN)**

In `nav`, add: `"resources": "资源", "modifiers": "调价规则", "dify": "Dify 导入"`. In `nav.groups`, add: `"catalog": "目录"`. Then add these top-level blocks:

```json
"resources": {
  "title": "资源", "new": "新建资源", "empty": "暂无资源", "created": "资源已创建", "submit": "创建",
  "cols": { "id": "ID", "modality": "模态", "provider": "Provider", "execModes": "执行模式", "status": "状态" },
  "form": { "id": "资源 ID", "tenant": "租户", "kind": "类型", "modality": "模态", "provider": "Provider 类型", "execModes": "执行模式(逗号分隔)", "ioSchema": "IO Schema (JSON)" },
  "kind": { "model": "模型", "workflow": "工作流" },
  "detail": { "back": "返回资源", "channels": "上游通道", "pricebook": "定价", "addChannel": "添加通道", "channelAdded": "通道已添加", "addPrice": "添加定价", "priceAdded": "定价已添加" }
},
"channels": {
  "form": { "provider": "Provider 类型", "credentialRef": "凭证 Ref (UUID,可空)", "weight": "权重", "status": "状态" },
  "note": "端点/模型/代理/配置目前由后端 seed 数据维护,暂不在此表单中。"
},
"pricebook": {
  "empty": "暂无定价", "cols": { "method": "方式", "timing": "时机", "version": "版本", "active": "启用" },
  "form": { "resourceVersion": "资源版本", "version": "定价版本", "method": "计价方式", "timing": "时机", "spec": "Spec (JSON)", "markup": "加价(可空)" }
},
"modifiers": {
  "title": "调价规则", "new": "新建规则", "empty": "暂无规则", "created": "规则已创建", "submit": "创建",
  "cols": { "scope": "范围", "op": "操作", "value": "值", "priority": "优先级", "active": "启用" },
  "form": { "scope": "范围", "whenExpr": "条件表达式(可空)", "op": "操作", "value": "值(可空)", "priority": "优先级(可空)", "stackable": "可叠加" }
},
"dify": {
  "title": "Dify 导入", "submit": "导入", "imported": "导入成功",
  "form": { "tenant": "租户", "resourceId": "资源 ID", "endpoint": "Dify Endpoint", "yaml": "Workflow YAML", "pricingModel": "定价模型 (JSON)", "allowBlockers": "允许阻塞节点" },
  "report": "兼容性报告"
}
```

- [ ] **Step 2: Add the matching English keys (en)**

In `nav`: `"resources": "Resources", "modifiers": "Modifiers", "dify": "Dify import"`; `nav.groups.catalog`: `"Catalog"`. Then the same blocks with English copy (mirror the zh structure exactly — same keys):

```json
"resources": {
  "title": "Resources", "new": "New resource", "empty": "No resources yet", "created": "Resource created", "submit": "Create",
  "cols": { "id": "ID", "modality": "Modality", "provider": "Provider", "execModes": "Exec modes", "status": "Status" },
  "form": { "id": "Resource ID", "tenant": "Tenant", "kind": "Kind", "modality": "Modality", "provider": "Provider type", "execModes": "Exec modes (comma-separated)", "ioSchema": "IO schema (JSON)" },
  "kind": { "model": "Model", "workflow": "Workflow" },
  "detail": { "back": "Back to resources", "channels": "Upstream channels", "pricebook": "Pricing", "addChannel": "Add channel", "channelAdded": "Channel added", "addPrice": "Add price", "priceAdded": "Price added" }
},
"channels": {
  "form": { "provider": "Provider type", "credentialRef": "Credential ref (UUID, optional)", "weight": "Weight", "status": "Status" },
  "note": "Endpoint/model/proxy/config are maintained as backend seed data for now and not in this form."
},
"pricebook": {
  "empty": "No pricing yet", "cols": { "method": "Method", "timing": "Timing", "version": "Version", "active": "Active" },
  "form": { "resourceVersion": "Resource version", "version": "Price version", "method": "Method", "timing": "Timing", "spec": "Spec (JSON)", "markup": "Markup (optional)" }
},
"modifiers": {
  "title": "Modifiers", "new": "New modifier", "empty": "No modifiers yet", "created": "Modifier created", "submit": "Create",
  "cols": { "scope": "Scope", "op": "Op", "value": "Value", "priority": "Priority", "active": "Active" },
  "form": { "scope": "Scope", "whenExpr": "When expression (optional)", "op": "Op", "value": "Value (optional)", "priority": "Priority (optional)", "stackable": "Stackable" }
},
"dify": {
  "title": "Dify import", "submit": "Import", "imported": "Imported",
  "form": { "tenant": "Tenant", "resourceId": "Resource ID", "endpoint": "Dify endpoint", "yaml": "Workflow YAML", "pricingModel": "Pricing model (JSON)", "allowBlockers": "Allow blocking nodes" },
  "report": "Compatibility report"
}
```

- [ ] **Step 3: Verify JSON parses (build)**

Run: `pnpm --filter @actionow/web build`
Expected: PASS (no JSON syntax errors).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/i18n/locales/zh-CN/console.json apps/web/src/i18n/locales/en/console.json
git commit -m "feat(web): i18n catalog strings (zh+en)"
```

---

## Task 6: Nav — add the "catalog" group

**Files:**

- Modify: `apps/web/src/components/console/nav-config.ts`

- [ ] **Step 1: Add the imports + group**

Add icons to the import: `import { BuildingsIcon, KeyIcon, SlidersHorizontalIcon, SquaresFourIcon, StackIcon, WalletIcon } from '@phosphor-icons/react';`

Insert a `catalog` group into `NAV` after the `ops` group:

```ts
  {
    key: 'catalog',
    icon: StackIcon,
    items: [
      { to: '/console/resources', labelKey: 'resources' },
      { to: '/console/modifiers', labelKey: 'modifiers' },
      { to: '/console/dify', labelKey: 'dify' },
    ],
  },
```

Add one mobile tab to `MOBILE_TABS` (after dashboard): `{ to: '/console/resources', labelKey: 'resources', icon: StackIcon },` — keep `MOBILE_TABS` at 5 items max; if it exceeds, drop `accounts` from the mobile tabs (accounts stays reachable via the rail on desktop and is lower-traffic). Final `MOBILE_TABS`: dashboard, resources, tenants, api-keys, accounts → trim to dashboard, resources, tenants, api-keys.

(`SlidersHorizontalIcon` is reserved for a later modifiers-specific tab; it's imported now to avoid a follow-up edit — if eslint flags it as unused, drop it from the import.)

- [ ] **Step 2: Verify typecheck**

Run: `pnpm --filter @actionow/web typecheck`
Expected: PASS. (`groupForPath`/`activeItem` already handle any group generically.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/console/nav-config.ts
git commit -m "feat(web): console catalog nav group"
```

---

## Task 7: ResourcesPage (list + create)

Mirrors [TenantsPage](apps/web/src/features/console/TenantsPage.tsx) exactly in structure (Query + DataTable + Modal + useAdminApi). Differences are the columns, the create form, and a row link to the detail page.

**Files:**

- Create: `apps/web/src/features/console/ResourcesPage.tsx`

- [ ] **Step 1: Implement the page**

```tsx
import { PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { Button } from '../../components/ui/Button';
import { JsonField, validateJson } from '../../components/ui/JsonField';
import { Modal } from '../../components/ui/Modal';
import { SelectField } from '../../components/ui/SelectField';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { ApiError } from '../../lib/api/errors';
import type { ResourceView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

export function ResourcesPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'resources'],
    queryFn: () => api.listResources(),
  });

  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [kind, setKind] = useState<'model' | 'workflow'>('model');
  const [modality, setModality] = useState('text');
  const [provider, setProvider] = useState('openai');
  const [execModes, setExecModes] = useState('blocking');
  const [ioSchema, setIoSchema] = useState('{\n  "inputs": [],\n  "outputs": []\n}');
  const [jsonErr, setJsonErr] = useState<string | undefined>(undefined);

  const create = useMutation({
    mutationFn: () => {
      const parsed = validateJson(ioSchema);
      if (!parsed.ok) throw new ApiError('invalid_input', parsed.error, 400, false);
      return api.createResource({
        id,
        tenantId,
        kind,
        modality,
        providerType: provider,
        execModes: execModes
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        ioSchema: parsed.value,
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['admin', 'resources'] });
      toast(t('resources.created'));
      setOpen(false);
    },
    onError: (e) =>
      toast(
        e instanceof ApiError ? t(`errors.${e.code}`, e.message) : t('errors.network'),
        'error',
      ),
  });

  const columns: Column<ResourceView>[] = [
    {
      key: 'id',
      header: t('resources.cols.id'),
      cell: (r) => (
        <Link to={`/console/resources/${r.id}`} style={{ color: 'var(--accent)' }}>
          {r.id}
        </Link>
      ),
    },
    { key: 'modality', header: t('resources.cols.modality'), cell: (r) => r.modality },
    { key: 'provider', header: t('resources.cols.provider'), cell: (r) => r.provider_type },
    {
      key: 'execModes',
      header: t('resources.cols.execModes'),
      cell: (r) => r.exec_modes.join(', '),
    },
    {
      key: 'status',
      header: t('resources.cols.status'),
      cell: (r) => <StatusBadge status={r.status} />,
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="cta" onClick={() => setOpen(true)}>
          <PlusIcon size={14} weight="bold" /> {t('resources.new')}
        </Button>
      </div>
      <DataTable
        columns={columns}
        rows={data ?? []}
        rowKey={(r) => r.id}
        loading={isLoading}
        empty={t('resources.empty')}
      />

      <Modal
        open={open}
        title={t('resources.new')}
        onClose={() => setOpen(false)}
        footer={
          <Button variant="cta" onClick={() => create.mutate()}>
            {t('resources.submit')}
          </Button>
        }
      >
        <TextField
          label={t('resources.form.id')}
          value={id}
          onChange={(e) => setId(e.target.value)}
        />
        <TextField
          label={t('resources.form.tenant')}
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
        />
        <SelectField
          label={t('resources.form.kind')}
          value={kind}
          onChange={(v) => setKind(v as 'model' | 'workflow')}
          options={[
            { value: 'model', label: t('resources.kind.model') },
            { value: 'workflow', label: t('resources.kind.workflow') },
          ]}
        />
        <TextField
          label={t('resources.form.modality')}
          value={modality}
          onChange={(e) => setModality(e.target.value)}
        />
        <TextField
          label={t('resources.form.provider')}
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
        />
        <TextField
          label={t('resources.form.execModes')}
          value={execModes}
          onChange={(e) => setExecModes(e.target.value)}
        />
        <JsonField
          label={t('resources.form.ioSchema')}
          value={ioSchema}
          onChange={(v) => {
            setIoSchema(v);
            setJsonErr(validateJson(v).ok ? undefined : 'invalid JSON');
          }}
          error={jsonErr}
        />
      </Modal>
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck + lint**

Run: `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web exec eslint src/features/console/ResourcesPage.tsx --fix`
Expected: PASS. (Confirm `SelectField` prop is `onChange: (value: string) => void` and `Modal` props are `{ open, title, onClose, footer, children }` — mirror TenantsPage. If `TextField`/`SelectField` signatures differ, match their actual props.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/features/console/ResourcesPage.tsx
git commit -m "feat(web): operator resources list + create"
```

---

## Task 8: ResourceDetailPage (pricebook list+add, channel add-form)

Reads the resource from the resources-list cache (no single-resource GET). Lists pricebook (GET) with an add form; provides a channel add-form (POST-only, no list).

**Files:**

- Create: `apps/web/src/features/console/ResourceDetailPage.tsx`

- [ ] **Step 1: Implement the page**

```tsx
import { ArrowLeftIcon, PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';

import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { Button } from '../../components/ui/Button';
import { JsonField, validateJson } from '../../components/ui/JsonField';
import { Modal } from '../../components/ui/Modal';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { ApiError } from '../../lib/api/errors';
import type { PricebookView, ResourceView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

export function ResourceDetailPage() {
  const { t } = useTranslation('console');
  const { id = '' } = useParams();
  const api = useAdminApi();
  const qc = useQueryClient();

  const resources = useQuery({
    queryKey: ['admin', 'resources'],
    queryFn: () => api.listResources(),
  });
  const resource = (resources.data ?? []).find((r) => r.id === id) as ResourceView | undefined;
  const pricebook = useQuery({
    queryKey: ['admin', 'pricebook', id],
    queryFn: () => api.listPricebook(id),
    enabled: id !== '',
  });

  // channel add-form
  const [chOpen, setChOpen] = useState(false);
  const [chProvider, setChProvider] = useState(resource?.provider_type ?? 'openai');
  const [chCred, setChCred] = useState('');
  const [chWeight, setChWeight] = useState('1');
  const addChannel = useMutation({
    mutationFn: () =>
      api.createChannel(id, {
        providerType: chProvider,
        credentialRef: chCred.trim() === '' ? undefined : chCred.trim(),
        weight: Number(chWeight) || 1,
      }),
    onSuccess: () => {
      toast(t('resources.detail.channelAdded'));
      setChOpen(false);
    },
    onError: (e) =>
      toast(
        e instanceof ApiError ? t(`errors.${e.code}`, e.message) : t('errors.network'),
        'error',
      ),
  });

  // pricebook add-form
  const [pbOpen, setPbOpen] = useState(false);
  const [method, setMethod] = useState('unit');
  const [timing, setTiming] = useState('post');
  const [spec, setSpec] = useState('{\n  "method": "unit",\n  "dimensions": {}\n}');
  const [pbErr, setPbErr] = useState<string | undefined>(undefined);
  const addPrice = useMutation({
    mutationFn: () => {
      const parsed = validateJson(spec);
      if (!parsed.ok) throw new ApiError('invalid_input', parsed.error, 400, false);
      return api.createPricebook({
        resourceId: id,
        resourceVersion: resource?.current_version ?? 1,
        version: 1,
        method,
        timing,
        spec: parsed.value,
        active: true,
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['admin', 'pricebook', id] });
      toast(t('resources.detail.priceAdded'));
      setPbOpen(false);
    },
    onError: (e) =>
      toast(
        e instanceof ApiError ? t(`errors.${e.code}`, e.message) : t('errors.network'),
        'error',
      ),
  });

  const pbCols: Column<PricebookView>[] = [
    { key: 'method', header: t('pricebook.cols.method'), cell: (r) => r.method },
    { key: 'timing', header: t('pricebook.cols.timing'), cell: (r) => r.timing },
    { key: 'version', header: t('pricebook.cols.version'), cell: (r) => String(r.version) },
    {
      key: 'active',
      header: t('pricebook.cols.active'),
      cell: (r) => <StatusBadge status={r.active ? 'active' : 'inactive'} />,
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
      <Link
        to="/console/resources"
        style={{
          fontSize: 12.5,
          color: 'var(--muted)',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <ArrowLeftIcon size={14} /> {t('resources.detail.back')}
      </Link>
      <div className="panel" style={{ borderRadius: 'var(--r-md)', padding: 'var(--s-4)' }}>
        <div style={{ fontSize: 17, fontWeight: 700 }}>{id}</div>
        {resource && (
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6 }}>
            {resource.modality} · {resource.provider_type} · {resource.exec_modes.join(', ')} ·{' '}
            <StatusBadge status={resource.status} />
          </div>
        )}
      </div>

      {/* channels (add-only) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <SectionHeader
          title={t('resources.detail.channels')}
          action={
            <Button onClick={() => setChOpen(true)}>
              <PlusIcon size={14} weight="bold" /> {t('resources.detail.addChannel')}
            </Button>
          }
        />
        <div style={{ fontSize: 12, color: 'var(--faint)' }}>{t('channels.note')}</div>
      </div>

      {/* pricebook (list + add) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <SectionHeader
          title={t('resources.detail.pricebook')}
          action={
            <Button onClick={() => setPbOpen(true)}>
              <PlusIcon size={14} weight="bold" /> {t('resources.detail.addPrice')}
            </Button>
          }
        />
        <DataTable
          columns={pbCols}
          rows={pricebook.data ?? []}
          rowKey={(r) => r.id}
          loading={pricebook.isLoading}
          empty={t('pricebook.empty')}
        />
      </div>

      <Modal
        open={chOpen}
        title={t('resources.detail.addChannel')}
        onClose={() => setChOpen(false)}
        footer={
          <Button variant="cta" onClick={() => addChannel.mutate()}>
            {t('resources.detail.addChannel')}
          </Button>
        }
      >
        <TextField
          label={t('channels.form.provider')}
          value={chProvider}
          onChange={(e) => setChProvider(e.target.value)}
        />
        <TextField
          label={t('channels.form.credentialRef')}
          value={chCred}
          onChange={(e) => setChCred(e.target.value)}
        />
        <TextField
          label={t('channels.form.weight')}
          value={chWeight}
          onChange={(e) => setChWeight(e.target.value)}
        />
      </Modal>

      <Modal
        open={pbOpen}
        title={t('resources.detail.addPrice')}
        onClose={() => setPbOpen(false)}
        footer={
          <Button variant="cta" onClick={() => addPrice.mutate()}>
            {t('resources.detail.addPrice')}
          </Button>
        }
      >
        <TextField
          label={t('pricebook.form.method')}
          value={method}
          onChange={(e) => setMethod(e.target.value)}
        />
        <TextField
          label={t('pricebook.form.timing')}
          value={timing}
          onChange={(e) => setTiming(e.target.value)}
        />
        <JsonField
          label={t('pricebook.form.spec')}
          value={spec}
          onChange={(v) => {
            setSpec(v);
            setPbErr(validateJson(v).ok ? undefined : 'invalid JSON');
          }}
          error={pbErr}
        />
      </Modal>
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck + lint**

Run: `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web exec eslint src/features/console/ResourceDetailPage.tsx --fix`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/features/console/ResourceDetailPage.tsx
git commit -m "feat(web): resource detail — pricebook list/add + channel add"
```

---

## Task 9: ModifiersPage (list + create)

**Files:**

- Create: `apps/web/src/features/console/ModifiersPage.tsx`

- [ ] **Step 1: Implement the page** (same shell as ResourcesPage; columns + form below)

```tsx
import { PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { ApiError } from '../../lib/api/errors';
import type { ModifierView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

export function ModifiersPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'modifiers'],
    queryFn: () => api.listModifiers(),
  });

  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState('global');
  const [op, setOp] = useState('discount_pct');
  const [value, setValue] = useState('');
  const [whenExpr, setWhenExpr] = useState('');
  const [priority, setPriority] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.createModifier({
        scope,
        op,
        value: value.trim() === '' ? undefined : Number(value),
        whenExpr: whenExpr.trim() === '' ? undefined : whenExpr.trim(),
        priority: priority.trim() === '' ? undefined : Number(priority),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['admin', 'modifiers'] });
      toast(t('modifiers.created'));
      setOpen(false);
    },
    onError: (e) =>
      toast(
        e instanceof ApiError ? t(`errors.${e.code}`, e.message) : t('errors.network'),
        'error',
      ),
  });

  const columns: Column<ModifierView>[] = [
    { key: 'scope', header: t('modifiers.cols.scope'), cell: (r) => r.scope },
    { key: 'op', header: t('modifiers.cols.op'), cell: (r) => r.op },
    { key: 'value', header: t('modifiers.cols.value'), cell: (r) => r.value ?? '—' },
    { key: 'priority', header: t('modifiers.cols.priority'), cell: (r) => String(r.priority) },
    {
      key: 'active',
      header: t('modifiers.cols.active'),
      cell: (r) => <StatusBadge status={r.active ? 'active' : 'inactive'} />,
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="cta" onClick={() => setOpen(true)}>
          <PlusIcon size={14} weight="bold" /> {t('modifiers.new')}
        </Button>
      </div>
      <DataTable
        columns={columns}
        rows={data ?? []}
        rowKey={(r) => r.id}
        loading={isLoading}
        empty={t('modifiers.empty')}
      />
      <Modal
        open={open}
        title={t('modifiers.new')}
        onClose={() => setOpen(false)}
        footer={
          <Button variant="cta" onClick={() => create.mutate()}>
            {t('modifiers.submit')}
          </Button>
        }
      >
        <TextField
          label={t('modifiers.form.scope')}
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        />
        <TextField
          label={t('modifiers.form.op')}
          value={op}
          onChange={(e) => setOp(e.target.value)}
        />
        <TextField
          label={t('modifiers.form.value')}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <TextField
          label={t('modifiers.form.whenExpr')}
          value={whenExpr}
          onChange={(e) => setWhenExpr(e.target.value)}
        />
        <TextField
          label={t('modifiers.form.priority')}
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        />
      </Modal>
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck + lint**

Run: `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web exec eslint src/features/console/ModifiersPage.tsx --fix`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/features/console/ModifiersPage.tsx
git commit -m "feat(web): operator modifiers list + create"
```

---

## Task 10: DifyImportPage (form + compat report)

**Files:**

- Create: `apps/web/src/features/console/DifyImportPage.tsx`

- [ ] **Step 1: Implement the page**

```tsx
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/ui/Button';
import { JsonField, validateJson } from '../../components/ui/JsonField';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { ApiError } from '../../lib/api/errors';
import type { DifyImportView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

export function DifyImportPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const [tenantId, setTenantId] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [yaml, setYaml] = useState('');
  const [pricing, setPricing] = useState('{\n  "method": "fixed",\n  "timing": "pre"\n}');
  const [pErr, setPErr] = useState<string | undefined>(undefined);
  const [report, setReport] = useState<DifyImportView | null>(null);

  const submit = useMutation({
    mutationFn: () => {
      const parsed = validateJson(pricing);
      if (!parsed.ok) throw new ApiError('invalid_input', parsed.error, 400, false);
      return api.difyImport({ tenantId, resourceId, yaml, endpoint, pricingModel: parsed.value });
    },
    onSuccess: (r) => {
      setReport(r);
      toast(t('dify.imported'));
    },
    onError: (e) =>
      toast(
        e instanceof ApiError ? t(`errors.${e.code}`, e.message) : t('errors.network'),
        'error',
      ),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)', maxWidth: 640 }}>
      <SectionHeader title={t('dify.title')} />
      <TextField
        label={t('dify.form.tenant')}
        value={tenantId}
        onChange={(e) => setTenantId(e.target.value)}
      />
      <TextField
        label={t('dify.form.resourceId')}
        value={resourceId}
        onChange={(e) => setResourceId(e.target.value)}
      />
      <TextField
        label={t('dify.form.endpoint')}
        value={endpoint}
        onChange={(e) => setEndpoint(e.target.value)}
      />
      <JsonField
        label={t('dify.form.yaml')}
        value={yaml}
        onChange={(v) => setYaml(v)}
        placeholder="app: ..."
      />
      <JsonField
        label={t('dify.form.pricingModel')}
        value={pricing}
        onChange={(v) => {
          setPricing(v);
          setPErr(validateJson(v).ok ? undefined : 'invalid JSON');
        }}
        error={pErr}
      />
      <div>
        <Button variant="cta" onClick={() => submit.mutate()}>
          {t('dify.submit')}
        </Button>
      </div>
      {report && (
        <div className="panel" style={{ borderRadius: 'var(--r-md)', padding: 'var(--s-4)' }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
            {t('dify.report')}
          </div>
          <pre
            className="mono"
            style={{ margin: 0, fontSize: 11.5, whiteSpace: 'pre-wrap', color: 'var(--text)' }}
          >
            {JSON.stringify(report.compat_report, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
```

Note: the YAML field uses `JsonField` purely as a monospace textarea (YAML is sent as a raw string via `yaml`); do not run `validateJson` on it.

- [ ] **Step 2: Verify typecheck + lint**

Run: `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web exec eslint src/features/console/DifyImportPage.tsx --fix`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/features/console/DifyImportPage.tsx
git commit -m "feat(web): dify import form + compat report"
```

---

## Task 11: Register routes

**Files:**

- Modify: `apps/web/src/routes.tsx`

- [ ] **Step 1: Add imports + nested routes**

Add imports next to the other console pages:

```ts
import { ResourcesPage } from './features/console/ResourcesPage';
import { ResourceDetailPage } from './features/console/ResourceDetailPage';
import { ModifiersPage } from './features/console/ModifiersPage';
import { DifyImportPage } from './features/console/DifyImportPage';
```

Inside the `<Route path="/console" element={<ConsoleLayout />}>` block, add:

```tsx
          <Route path="resources" element={<ResourcesPage />} />
          <Route path="resources/:id" element={<ResourceDetailPage />} />
          <Route path="modifiers" element={<ModifiersPage />} />
          <Route path="dify" element={<DifyImportPage />} />
```

- [ ] **Step 2: Verify typecheck + lint + build**

Run: `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web lint && pnpm --filter @actionow/web build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes.tsx
git commit -m "feat(web): register operator catalog routes"
```

---

## Task 12: Browser verification against the real API

Verify the catalog end-to-end against the seeded backend (`:3000`).

**Files:** none (verification only).

- [ ] **Step 1: Ensure API + a build/preview are up**

The API runs on `:3000` (seed admin `admin@actionow.local`). Build + serve the web app: `pnpm --filter @actionow/web build` then a `vite preview --port 4173 --host` (proxies `/admin /auth /v1` → `:3000`). Use the `preview_*` tools via a `.claude/launch.json` dev server when driving the browser.

- [ ] **Step 2: Log in as admin and open the catalog**

Log in (`admin@actionow.local` / `actionow-dev-password`) → lands on `/console/dashboard`. Confirm the rail now shows the **目录/Catalog** group with Resources / Modifiers / Dify.

- [ ] **Step 3: Resources create → detail → pricebook**

Open Resources → create a resource (use an existing tenant id from `/console/tenants`; `ioSchema` `{"inputs":[],"outputs":[]}`). Confirm it lists. Click it → on detail, add a pricebook entry (`method: unit`, `timing: post`, `spec {"method":"unit","dimensions":{"tokens":{"rate":1}}}`) → confirm it appears in the pricebook table. Add a channel (`providerType: openai`) → confirm the success toast.

- [ ] **Step 4: Modifiers + Dify**

Create a modifier (`scope: global`, `op: discount_pct`, `value: 10`) → confirm it lists. Open Dify import; submit with a trivial payload → confirm either the compat report renders or a mapped error toast appears (not a crash).

- [ ] **Step 5: Verify the loading state + no console errors**

Confirm `RoseLoader` shows while lists load, error envelope toasts use `errors.*`, and there are no runtime console errors. Capture a screenshot of the Resources list and the Resource detail for the record.

- [ ] **Step 6: No commit** (verification only). If issues are found, fix in the relevant task's file and re-run that task's verify step.

---

## Self-review notes (addressed)

- **Spec coverage:** Resources/channels/pricebook/modifiers/dify all have tasks. Jobs/Ledger/Payments are **Plan 2**; tenant console is **Plan 3** (per the slice split). Channel `endpoint/model/proxy/config` fields are a **backend follow-up** (documented above) — not buildable against the current admin DTO.
- **Type consistency:** `ResourceView` (existing) reused; new `PricebookView`/`ModifierView`/`ChannelView` + bodies defined in Task 1 and consumed in Tasks 2/7/8/9/10. API method names (`createResource`, `createChannel(resourceId, body)`, `listPricebook`, `createPricebook`, `listModifiers`, `createModifier`, `difyImport`) are consistent between Task 2 and the screens.
- **Component API assumption:** screens mirror `TenantsPage` and assume `Modal {open,title,onClose,footer,children}`, `TextField {label, value, onChange:(e)=>}`, `SelectField {label, value, onChange:(v)=>, options}`. Each screen task's verify step says to match the real prop shapes if they differ.
- **No placeholders:** every code step shows complete code; commands have expected outcomes.
