# Actionow Admin Frontend — Plan 3: MVP Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Builds on Plan 1 (Foundation) + Plan 2 (Auth + Data). **Task 2 additionally REQUIRES the `coss` skill** (and may consult `coss-particles`) for the exact primitive imports/markup.

**Goal:** Ship the five MVP screens — Login, Dashboard, Tenants, Accounts (+ top-up), API Keys — on the Liquid Glass shell, using coss-backed UI wrappers, the typed `/admin` API, and bilingual (zh-CN | en) copy.

**Architecture:** A thin set of UI wrappers (`Modal`, `TextField`, `SelectField`, `Toaster`/`toast`) isolates coss so every screen consumes a stable in-house API. Shared data components (`DataTable`, `StatusBadge`, `CopyField`, `Money`, `TenantSelect`) are built once. Screens are thin: query via `useAdminApi`, mutate + invalidate via TanStack Query, surface results through toasts/dialogs. All copy is `t()` from per-feature i18n namespaces.

**Tech Stack:** coss (Base UI primitives) + Tailwind v4, TanStack Query v5, react-i18next. No other new deps.

**Backend contracts (verified):** admin endpoints + snake_case views in [`admin.controller.ts`](apps/api/src/admin/admin.controller.ts); request DTOs in [`admin.dto.ts`](apps/api/src/admin/dto/admin.dto.ts) (credits are HUMAN credits); API-key plaintext is returned **once**; `/auth/login` → `{ token }`.

**Source spec:** design spec §8 (components), §10 (login), §12 (i18n), §13 (screens).

---

## Conventions

- TDD; commit per task; don't push. Screen tests mock `useAdminApi` + wrap in `QueryClientProvider` + i18n; force `i18n.changeLanguage('zh-CN')` for deterministic assertions.
- Money: render balances/costs with `<Money micro={...}/>` (BigInt-safe). Inputs are HUMAN credits (numbers).
- After each task: `pnpm --filter @actionow/admin typecheck && lint && test` green.

## File Structure (this plan)

```
apps/admin/src/
  i18n/locales/{zh-CN,en}/{auth,dashboard,tenants,accounts,apiKeys,errors}.json
  components/
    ui/{Modal.tsx, TextField.tsx, SelectField.tsx, Toaster.tsx, toast.ts}
    data/{DataTable.tsx, StatusBadge.tsx, CopyField.tsx, Money.tsx, TenantSelect.tsx}
  features/
    auth/LoginPage.tsx
    dashboard/DashboardPage.tsx
    tenants/TenantsPage.tsx
    accounts/AccountsPage.tsx
    apiKeys/ApiKeysPage.tsx
```

---

## Task 1: Per-feature i18n namespaces

**Files:**

- Create: `apps/admin/src/i18n/locales/{zh-CN,en}/{auth,dashboard,tenants,accounts,apiKeys,errors}.json`
- Modify: `apps/admin/src/i18n/index.ts`
- Test: `apps/admin/src/i18n/namespaces.test.ts`

- [ ] **Step 1: Write the failing test (every ns has zh/en parity)**

`apps/admin/src/i18n/namespaces.test.ts`:

```ts
import { expect, test } from 'vitest';

const NS = ['auth', 'dashboard', 'tenants', 'accounts', 'apiKeys', 'errors'] as const;

function keys(o: Record<string, unknown>, p = ''): string[] {
  return Object.entries(o).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null
      ? keys(v as Record<string, unknown>, `${p}${k}.`)
      : [`${p}${k}`],
  );
}

test.each(NS)('namespace %s has identical zh-CN/en keys', async (ns) => {
  const zh = (await import(`./locales/zh-CN/${ns}.json`)).default;
  const en = (await import(`./locales/en/${ns}.json`)).default;
  expect(keys(zh).sort()).toEqual(keys(en).sort());
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @actionow/admin test namespaces`
Expected: FAIL — cannot resolve the locale modules.

- [ ] **Step 3: Create the locale files**

`zh-CN/auth.json`:

```json
{
  "title": "管理员登录",
  "email": "邮箱",
  "password": "密码",
  "submit": "登录",
  "oauthGoogle": "用 Google 登录",
  "oauthGithub": "用 GitHub 登录",
  "notAdmin": "该账号不是管理员",
  "failed": "登录失败,请检查邮箱或密码"
}
```

`en/auth.json`:

```json
{
  "title": "Admin sign in",
  "email": "Email",
  "password": "Password",
  "submit": "Sign in",
  "oauthGoogle": "Continue with Google",
  "oauthGithub": "Continue with GitHub",
  "notAdmin": "This account is not an admin",
  "failed": "Sign-in failed — check your email or password"
}
```

`zh-CN/dashboard.json`:

```json
{
  "stats": { "tenants": "租户", "resources": "资源", "jobs": "近期任务", "tenantPick": "选择租户" },
  "recentJobs": "最近任务",
  "pickTenant": "请选择一个租户以查看任务",
  "cols": { "resource": "资源", "execMode": "执行模式", "cost": "成本", "status": "状态" }
}
```

`en/dashboard.json`:

```json
{
  "stats": {
    "tenants": "Tenants",
    "resources": "Resources",
    "jobs": "Recent jobs",
    "tenantPick": "Select tenant"
  },
  "recentJobs": "Recent jobs",
  "pickTenant": "Pick a tenant to view jobs",
  "cols": { "resource": "Resource", "execMode": "Exec mode", "cost": "Cost", "status": "Status" }
}
```

`zh-CN/tenants.json`:

```json
{
  "title": "租户",
  "new": "新建租户",
  "cols": { "name": "名称", "isolation": "隔离模式", "created": "创建时间" },
  "form": { "name": "名称", "isolation": "隔离模式" },
  "isolation": { "field": "字段级", "schema": "Schema 级", "db": "库级" },
  "empty": "暂无租户",
  "created": "租户已创建",
  "submit": "创建"
}
```

`en/tenants.json`:

```json
{
  "title": "Tenants",
  "new": "New tenant",
  "cols": { "name": "Name", "isolation": "Isolation", "created": "Created" },
  "form": { "name": "Name", "isolation": "Isolation" },
  "isolation": { "field": "Field", "schema": "Schema", "db": "Database" },
  "empty": "No tenants yet",
  "created": "Tenant created",
  "submit": "Create"
}
```

`zh-CN/accounts.json`:

```json
{
  "title": "账户 / 充值",
  "new": "新建账户",
  "cols": {
    "id": "账户",
    "balance": "余额",
    "held": "冻结",
    "created": "创建时间",
    "actions": "操作"
  },
  "form": { "tenant": "租户", "credits": "开通余额(credits)" },
  "topup": {
    "action": "充值",
    "title": "账户充值",
    "credits": "充值额度(credits)",
    "submit": "充值",
    "done": "充值成功"
  },
  "empty": "请选择租户后查看账户",
  "created": "账户已创建",
  "submit": "创建"
}
```

`en/accounts.json`:

```json
{
  "title": "Accounts",
  "new": "New account",
  "cols": {
    "id": "Account",
    "balance": "Balance",
    "held": "Held",
    "created": "Created",
    "actions": "Actions"
  },
  "form": { "tenant": "Tenant", "credits": "Opening credits" },
  "topup": {
    "action": "Top up",
    "title": "Top up account",
    "credits": "Credits to add",
    "submit": "Top up",
    "done": "Top-up complete"
  },
  "empty": "Pick a tenant to view accounts",
  "created": "Account created",
  "submit": "Create"
}
```

`zh-CN/apiKeys.json`:

```json
{
  "title": "API Keys",
  "new": "签发 Key",
  "cols": {
    "id": "Key ID",
    "allowlist": "资源白名单",
    "rateLimit": "限流",
    "status": "状态",
    "created": "创建时间"
  },
  "form": {
    "tenant": "租户",
    "allowlist": "资源白名单(逗号分隔,可空)",
    "rateLimit": "每分钟请求上限(可空)"
  },
  "empty": "请选择租户后查看 Key",
  "submit": "签发",
  "reveal": {
    "title": "Key 已生成",
    "warn": "明文只显示这一次,请立即复制保存。",
    "copy": "复制",
    "copied": "已复制",
    "done": "完成"
  }
}
```

`en/apiKeys.json`:

```json
{
  "title": "API Keys",
  "new": "Mint key",
  "cols": {
    "id": "Key ID",
    "allowlist": "Allowlist",
    "rateLimit": "Rate limit",
    "status": "Status",
    "created": "Created"
  },
  "form": {
    "tenant": "Tenant",
    "allowlist": "Resource allowlist (comma-separated, optional)",
    "rateLimit": "Requests per minute (optional)"
  },
  "empty": "Pick a tenant to view keys",
  "submit": "Mint",
  "reveal": {
    "title": "Key created",
    "warn": "The plaintext is shown only once — copy it now.",
    "copy": "Copy",
    "copied": "Copied",
    "done": "Done"
  }
}
```

`zh-CN/errors.json`:

```json
{
  "invalid_input": "请求参数有误",
  "unauthorized": "未授权或登录已过期",
  "insufficient_credits": "余额不足",
  "resource_not_found": "未找到资源",
  "rate_limited": "请求过于频繁,请稍后再试",
  "content_filtered": "内容被拦截",
  "upstream_error": "上游服务错误",
  "upstream_timeout": "上游服务超时",
  "job_failed": "任务执行失败",
  "internal_error": "服务器内部错误",
  "forbidden_not_admin": "该账号不是管理员",
  "network": "网络错误,请稍后再试"
}
```

`en/errors.json`:

```json
{
  "invalid_input": "Invalid request",
  "unauthorized": "Unauthorized or session expired",
  "insufficient_credits": "Insufficient credits",
  "resource_not_found": "Resource not found",
  "rate_limited": "Too many requests — try again later",
  "content_filtered": "Content filtered",
  "upstream_error": "Upstream service error",
  "upstream_timeout": "Upstream timeout",
  "job_failed": "Job failed",
  "internal_error": "Internal server error",
  "forbidden_not_admin": "This account is not an admin",
  "network": "Network error — please retry"
}
```

- [ ] **Step 4: Register the namespaces in `i18n/index.ts`**

Replace the `resources` block and add the imports in `apps/admin/src/i18n/index.ts`:

```ts
import enAuth from './locales/en/auth.json';
import enAccounts from './locales/en/accounts.json';
import enApiKeys from './locales/en/apiKeys.json';
import enCommon from './locales/en/common.json';
import enDashboard from './locales/en/dashboard.json';
import enErrors from './locales/en/errors.json';
import enTenants from './locales/en/tenants.json';
import zhAuth from './locales/zh-CN/auth.json';
import zhAccounts from './locales/zh-CN/accounts.json';
import zhApiKeys from './locales/zh-CN/apiKeys.json';
import zhCommon from './locales/zh-CN/common.json';
import zhDashboard from './locales/zh-CN/dashboard.json';
import zhErrors from './locales/zh-CN/errors.json';
import zhTenants from './locales/zh-CN/tenants.json';
```

and set:

```ts
    resources: {
      'zh-CN': {
        common: zhCommon, auth: zhAuth, dashboard: zhDashboard,
        tenants: zhTenants, accounts: zhAccounts, apiKeys: zhApiKeys, errors: zhErrors,
      },
      en: {
        common: enCommon, auth: enAuth, dashboard: enDashboard,
        tenants: enTenants, accounts: enAccounts, apiKeys: enApiKeys, errors: enErrors,
      },
    },
    ns: ['common', 'auth', 'dashboard', 'tenants', 'accounts', 'apiKeys', 'errors'],
    defaultNS: 'common',
```

- [ ] **Step 5: Run it, verify it passes**

Run: `pnpm --filter @actionow/admin test namespaces`
Expected: PASS (6 cases).

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/i18n
git commit -m "feat(admin): per-feature i18n namespaces (zh-CN | en)"
```

---

## Task 2: coss-backed UI wrappers (`Modal`, `TextField`, `SelectField`, `Toaster`/`toast`)

> **Invoke the `coss` skill first.** Implement each wrapper with coss primitives (Dialog, Field/Input, Select, Toast) and the project's Tailwind tokens. The wrapper **API below is fixed** (screens depend on it); the internals use coss. The reference implementations are coss-ready (glass-styled, accessible) — reconcile imports/props with the coss skill's exact API.

**Files:**

- Create: `apps/admin/src/components/ui/Modal.tsx`, `TextField.tsx`, `SelectField.tsx`, `Toaster.tsx`, `toast.ts`
- Test: `apps/admin/src/components/ui/Modal.test.tsx`

- [ ] **Step 1: Invoke the coss skill**

Use the `Skill` tool with `coss` to load the correct imports for Dialog, Field, Select, and Toast. Keep the exported wrapper signatures exactly as specified below.

- [ ] **Step 2: Write the failing test (Modal API contract)**

`apps/admin/src/components/ui/Modal.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { Modal } from './Modal';

test('renders title and children when open; nothing when closed', () => {
  const { rerender } = render(
    <Modal open title="Create" onClose={() => {}}>
      <div>body</div>
    </Modal>,
  );
  expect(screen.getByText('Create')).toBeInTheDocument();
  expect(screen.getByText('body')).toBeInTheDocument();

  rerender(
    <Modal open={false} title="Create" onClose={() => {}}>
      <div>body</div>
    </Modal>,
  );
  expect(screen.queryByText('body')).not.toBeInTheDocument();
});
```

- [ ] **Step 3: Run it, verify it fails**

Run: `pnpm --filter @actionow/admin test ui/Modal`
Expected: FAIL — cannot find `./Modal`.

- [ ] **Step 4: Implement the wrappers (coss primitives inside; glass styling)**

`apps/admin/src/components/ui/Modal.tsx`:

```tsx
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/**
 * Glass modal. API is stable for all screens. Internals SHOULD use coss's
 * Dialog primitive (backdrop, focus trap, ESC) — consult the coss skill. The
 * reference below is a portal + backdrop that satisfies the same contract.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'rgba(0,0,0,.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="glass"
        style={{ width: 'min(440px, 92vw)', borderRadius: 'var(--r-lg)', padding: 'var(--s-5)' }}
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{title}</h2>
        <div
          style={{
            marginTop: 'var(--s-4)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--s-3)',
          }}
        >
          {children}
        </div>
        {footer && (
          <div
            style={{
              marginTop: 'var(--s-5)',
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 'var(--s-2)',
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
```

`apps/admin/src/components/ui/TextField.tsx`:

```tsx
import type { InputHTMLAttributes } from 'react';

/** Labeled text input. Internals SHOULD use coss Field/Input (consult coss skill). */
export function TextField({
  label,
  ...input
}: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        fontSize: 12,
        color: 'var(--muted)',
      }}
    >
      {label}
      <input
        {...input}
        className="panel"
        style={{
          fontSize: 13,
          color: 'var(--text)',
          padding: '9px 11px',
          borderRadius: 'var(--r-sm)',
          outline: 'none',
          ...input.style,
        }}
      />
    </label>
  );
}
```

`apps/admin/src/components/ui/SelectField.tsx`:

```tsx
export interface Option {
  value: string;
  label: string;
}

/** Labeled select. Internals SHOULD use coss Select (consult coss skill). */
export function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  placeholder?: string;
}) {
  return (
    <label
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        fontSize: 12,
        color: 'var(--muted)',
      }}
    >
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="panel"
        style={{
          fontSize: 13,
          color: 'var(--text)',
          padding: '9px 11px',
          borderRadius: 'var(--r-sm)',
          outline: 'none',
        }}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
```

`apps/admin/src/components/ui/toast.ts`:

```ts
export type ToastTone = 'ok' | 'error';
export interface ToastMsg {
  id: number;
  text: string;
  tone: ToastTone;
}

type Listener = (t: ToastMsg) => void;
const listeners = new Set<Listener>();
let seq = 0;

export function toast(text: string, tone: ToastTone = 'ok') {
  const msg: ToastMsg = { id: ++seq, text, tone };
  listeners.forEach((l) => l(msg));
}
export function subscribeToast(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
```

`apps/admin/src/components/ui/Toaster.tsx`:

```tsx
import { useEffect, useState } from 'react';

import { subscribeToast } from './toast';
import type { ToastMsg } from './toast';

/** Mount once near the app root. Internals MAY use coss Toast (consult skill). */
export function Toaster() {
  const [items, setItems] = useState<ToastMsg[]>([]);
  useEffect(
    () =>
      subscribeToast((m) => {
        setItems((xs) => [...xs, m]);
        setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== m.id)), 3500);
      }),
    [],
  );
  return (
    <div
      style={{
        position: 'fixed',
        right: 'var(--s-4)',
        bottom: 'var(--s-4)',
        zIndex: 60,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--s-2)',
      }}
    >
      {items.map((m) => (
        <div
          key={m.id}
          role="status"
          className="glass"
          style={{
            padding: '10px 14px',
            borderRadius: 'var(--r-md)',
            fontSize: 12.5,
            color: m.tone === 'error' ? 'var(--fail)' : 'var(--text)',
            borderColor: m.tone === 'error' ? 'var(--fail)' : undefined,
          }}
        >
          {m.text}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Run it, verify it passes; mount `Toaster`**

Run: `pnpm --filter @actionow/admin test ui/Modal`
Expected: PASS.

Add `<Toaster />` to `App.tsx` inside `AuthProvider` (above `BrowserRouter`):

```tsx
import { Toaster } from './components/ui/Toaster';
// ...
<AuthProvider>
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <Suspense fallback={null}>
        <AppRoutes />
      </Suspense>
    </BrowserRouter>
    <Toaster />
  </QueryClientProvider>
</AuthProvider>;
```

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/components/ui apps/admin/src/App.tsx
git commit -m "feat(admin): coss-backed ui wrappers (modal, fields, toaster)"
```

---

## Task 3: Shared data components (`Money`, `StatusBadge`, `DataTable`, `CopyField`, `TenantSelect`)

**Files:**

- Create: `apps/admin/src/components/data/Money.tsx`, `StatusBadge.tsx`, `DataTable.tsx`, `CopyField.tsx`, `TenantSelect.tsx`
- Test: `apps/admin/src/components/data/DataTable.test.tsx`, `Money.test.tsx`

- [ ] **Step 1: Write the failing tests**

`apps/admin/src/components/data/Money.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { Money } from './Money';

test('renders µcredits as grouped credits', () => {
  render(<Money micro="1234567000000" locale="en" />);
  expect(screen.getByText('1,234,567')).toBeInTheDocument();
});
```

`apps/admin/src/components/data/DataTable.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { DataTable } from './DataTable';

test('renders headers, rows, and an empty state', () => {
  const cols = [{ key: 'name', header: 'Name', cell: (r: { name: string }) => r.name }];
  const { rerender } = render(
    <DataTable columns={cols} rows={[{ name: 'acme' }]} rowKey={(r) => r.name} />,
  );
  expect(screen.getByText('Name')).toBeInTheDocument();
  expect(screen.getByText('acme')).toBeInTheDocument();

  rerender(<DataTable columns={cols} rows={[]} rowKey={(r) => r.name} empty="nothing" />);
  expect(screen.getByText('nothing')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run them, verify they fail**

Run: `pnpm --filter @actionow/admin test data/`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the components**

`apps/admin/src/components/data/Money.tsx`:

```tsx
import { useTranslation } from 'react-i18next';

import { formatCredits } from '../../lib/money';

export function Money({ micro, locale }: { micro: string; locale?: string }) {
  const { i18n } = useTranslation();
  return <span className="tabular">{formatCredits(micro, locale ?? i18n.language)}</span>;
}
```

`apps/admin/src/components/data/StatusBadge.tsx`:

```tsx
const TONE: Record<string, string> = {
  succeeded: 'var(--ok)',
  active: 'var(--ok)',
  ready: 'var(--ok)',
  running: 'var(--run)',
  queued: 'var(--wait)',
  pending: 'var(--wait)',
  failed: 'var(--fail)',
  disabled: 'var(--fail)',
  canceled: 'var(--idle)',
};

export function StatusBadge({ status }: { status: string }) {
  const color = TONE[status] ?? 'var(--idle)';
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 600,
        padding: '3px 9px',
        borderRadius: 12,
        color,
        background: 'color-mix(in srgb, currentColor 16%, transparent)',
      }}
    >
      {status}
    </span>
  );
}
```

`apps/admin/src/components/data/DataTable.tsx`:

```tsx
import type { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  width?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty,
  loading,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
  loading?: boolean;
}) {
  const grid = columns.map((c) => c.width ?? '1fr').join(' ');
  return (
    <div className="panel" style={{ borderRadius: 'var(--r-md)', overflow: 'hidden' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: grid,
          gap: 'var(--s-3)',
          padding: '10px var(--s-4)',
          fontSize: 9,
          textTransform: 'uppercase',
          letterSpacing: '.05em',
          color: 'var(--faint)',
          borderBottom: '1px solid var(--row-bd)',
        }}
      >
        {columns.map((c) => (
          <div key={c.key}>{c.header}</div>
        ))}
      </div>
      {loading ? (
        <div style={{ padding: 'var(--s-5)', color: 'var(--muted)', fontSize: 12 }}>…</div>
      ) : rows.length === 0 ? (
        <div
          style={{
            padding: 'var(--s-6)',
            color: 'var(--muted)',
            fontSize: 12,
            textAlign: 'center',
          }}
        >
          {empty}
        </div>
      ) : (
        rows.map((r) => (
          <div
            key={rowKey(r)}
            style={{
              display: 'grid',
              gridTemplateColumns: grid,
              gap: 'var(--s-3)',
              padding: '10px var(--s-4)',
              fontSize: 11.5,
              alignItems: 'center',
              borderBottom: '1px solid var(--row-bd)',
            }}
          >
            {columns.map((c) => (
              <div key={c.key} style={{ minWidth: 0 }}>
                {c.cell(r)}
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
```

`apps/admin/src/components/data/CopyField.tsx`:

```tsx
import { useState } from 'react';

import { GlassButton } from '../glass/GlassButton';

export function CopyField({
  value,
  copyLabel,
  copiedLabel,
}: {
  value: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'center' }}>
      <code
        className="panel"
        style={{
          flex: 1,
          fontSize: 12,
          padding: '8px 10px',
          borderRadius: 'var(--r-sm)',
          overflow: 'auto',
          wordBreak: 'break-all',
        }}
      >
        {value}
      </code>
      <GlassButton type="button" onClick={() => void copy()}>
        {copied ? copiedLabel : copyLabel}
      </GlassButton>
    </div>
  );
}
```

`apps/admin/src/components/data/TenantSelect.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';

import { useAdminApi } from '../../lib/api/useAdminApi';
import { SelectField } from '../ui/SelectField';

export function TenantSelect({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const api = useAdminApi();
  const { data } = useQuery({ queryKey: ['tenants'], queryFn: () => api.listTenants() });
  const options = (data ?? []).map((t) => ({ value: t.id, label: t.name }));
  return (
    <SelectField
      label={label}
      value={value}
      onChange={onChange}
      options={options}
      placeholder={placeholder}
    />
  );
}
```

- [ ] **Step 4: Run them, verify they pass**

Run: `pnpm --filter @actionow/admin test data/`
Expected: PASS (Money + DataTable).

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/components/data
git commit -m "feat(admin): shared data components — money, badge, table, copy, tenant select"
```

---

## Task 4: Login screen

**Files:**

- Create: `apps/admin/src/features/auth/LoginPage.tsx`
- Modify: `apps/admin/src/routes.tsx` (replace `/login` placeholder)
- Test: `apps/admin/src/features/auth/LoginPage.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/admin/src/features/auth/LoginPage.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, expect, test, vi } from 'vitest';

import i18n from '../../i18n';
import { ThemeProvider } from '../../lib/theme/ThemeProvider';

const login = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/auth/AuthProvider', () => ({ useAuth: () => ({ login, user: null }) }));

import { LoginPage } from './LoginPage';

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

test('submits email + password to auth.login', async () => {
  render(
    <ThemeProvider>
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    </ThemeProvider>,
  );
  await userEvent.type(screen.getByLabelText('邮箱'), 'admin@a.co');
  await userEvent.type(screen.getByLabelText('密码'), 'pw');
  await userEvent.click(screen.getByRole('button', { name: '登录' }));
  await waitFor(() => expect(login).toHaveBeenCalledWith('admin@a.co', 'pw'));
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @actionow/admin test LoginPage`
Expected: FAIL — cannot find `./LoginPage`.

- [ ] **Step 3: Implement `LoginPage.tsx`**

```tsx
import { FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { config } from '../../config';
import { AppBackground } from '../../components/glass/AppBackground';
import { GlassButton } from '../../components/glass/GlassButton';
import { LanguageSwitch } from '../../components/layout/LanguageSwitch';
import { ThemeToggle } from '../../components/layout/ThemeToggle';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { ApiError, NotAdminError } from '../../lib/api/errors';
import { useAuth } from '../../lib/auth/AuthProvider';

export function LoginPage() {
  const { t } = useTranslation(['auth', 'errors']);
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await login(email, password);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      if (err instanceof NotAdminError) toast(t('auth:notAdmin'), 'error');
      else if (err instanceof ApiError) toast(t(`errors:${err.code}`, t('auth:failed')), 'error');
      else toast(t('errors:network'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <AppBackground />
      <div
        style={{
          position: 'absolute',
          top: 'var(--s-4)',
          right: 'var(--s-4)',
          zIndex: 2,
          display: 'flex',
          gap: 'var(--s-2)',
        }}
      >
        <LanguageSwitch />
        <ThemeToggle />
      </div>
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <form
          onSubmit={onSubmit}
          className="glass"
          style={{
            width: 'min(380px, 92vw)',
            padding: 'var(--s-6)',
            borderRadius: 'var(--r-lg)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--s-4)',
          }}
        >
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{t('auth:title')}</h1>
          <TextField
            label={t('auth:email')}
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <TextField
            label={t('auth:password')}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <GlassButton
            variant="cta"
            type="submit"
            disabled={busy}
            style={{ justifyContent: 'center' }}
          >
            {t('auth:submit')}
          </GlassButton>
          {config.oauthEnabled && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
              <a href={`${config.authBase}/oauth/google`}>
                <GlassButton type="button" style={{ width: '100%', justifyContent: 'center' }}>
                  {t('auth:oauthGoogle')}
                </GlassButton>
              </a>
              <a href={`${config.authBase}/oauth/github`}>
                <GlassButton type="button" style={{ width: '100%', justifyContent: 'center' }}>
                  {t('auth:oauthGithub')}
                </GlassButton>
              </a>
            </div>
          )}
        </form>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Wire the route**

In `apps/admin/src/routes.tsx`, replace the `/login` placeholder element with `<LoginPage />` (add `import { LoginPage } from './features/auth/LoginPage';`):

```tsx
<Route path="/login" element={<LoginPage />} />
```

- [ ] **Step 5: Run it, verify it passes**

Run: `pnpm --filter @actionow/admin test LoginPage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/features/auth apps/admin/src/routes.tsx
git commit -m "feat(admin): login screen (/auth/login, role gate, reserved oauth)"
```

---

## Task 5: Tenants screen

**Files:**

- Create: `apps/admin/src/features/tenants/TenantsPage.tsx`
- Modify: `apps/admin/src/routes.tsx`
- Test: `apps/admin/src/features/tenants/TenantsPage.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/admin/src/features/tenants/TenantsPage.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, expect, test, vi } from 'vitest';

import i18n from '../../i18n';

const listTenants = vi
  .fn()
  .mockResolvedValue([
    { id: 't1', name: 'acme', isolation_mode: 'field', created_at: '2026-06-16T00:00:00Z' },
  ]);
vi.mock('../../lib/api/useAdminApi', () => ({
  useAdminApi: () => ({ listTenants, createTenant: vi.fn() }),
}));

import { TenantsPage } from './TenantsPage';

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

test('lists tenants from the api', async () => {
  render(wrap(<TenantsPage />));
  await waitFor(() => expect(screen.getByText('acme')).toBeInTheDocument());
  expect(listTenants).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @actionow/admin test TenantsPage`
Expected: FAIL — cannot find `./TenantsPage`.

- [ ] **Step 3: Implement `TenantsPage.tsx`**

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { GlassButton } from '../../components/glass/GlassButton';
import { DataTable } from '../../components/data/DataTable';
import type { Column } from '../../components/data/DataTable';
import { Modal } from '../../components/ui/Modal';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { PlusIcon } from '../../components/icons';
import { ApiError } from '../../lib/api/errors';
import type { TenantView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

export function TenantsPage() {
  const { t } = useTranslation(['tenants', 'errors']);
  const api = useAdminApi();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['tenants'], queryFn: () => api.listTenants() });

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [isolation, setIsolation] = useState('field');

  const create = useMutation({
    mutationFn: () =>
      api.createTenant({ name, isolationMode: isolation as 'field' | 'schema' | 'db' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tenants'] });
      toast(t('tenants:created'));
      setOpen(false);
      setName('');
    },
    onError: (e) =>
      toast(e instanceof ApiError ? t(`errors:${e.code}`) : t('errors:network'), 'error'),
  });

  const columns: Column<TenantView>[] = [
    { key: 'name', header: t('tenants:cols.name'), cell: (r) => r.name },
    {
      key: 'isolation',
      header: t('tenants:cols.isolation'),
      cell: (r) => t(`tenants:isolation.${r.isolation_mode}`, r.isolation_mode),
    },
    {
      key: 'created',
      header: t('tenants:cols.created'),
      cell: (r) => new Date(r.created_at).toLocaleDateString(),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <GlassButton variant="cta" onClick={() => setOpen(true)}>
          <PlusIcon /> {t('tenants:new')}
        </GlassButton>
      </div>
      <DataTable
        columns={columns}
        rows={data ?? []}
        rowKey={(r) => r.id}
        loading={isLoading}
        empty={t('tenants:empty')}
      />

      <Modal
        open={open}
        title={t('tenants:new')}
        onClose={() => setOpen(false)}
        footer={
          <GlassButton
            variant="cta"
            disabled={!name || create.isPending}
            onClick={() => create.mutate()}
          >
            {t('tenants:submit')}
          </GlassButton>
        }
      >
        <TextField
          label={t('tenants:form.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <SelectField
          label={t('tenants:form.isolation')}
          value={isolation}
          onChange={setIsolation}
          options={[
            { value: 'field', label: t('tenants:isolation.field') },
            { value: 'schema', label: t('tenants:isolation.schema') },
            { value: 'db', label: t('tenants:isolation.db') },
          ]}
        />
      </Modal>
    </div>
  );
}
```

- [ ] **Step 4: Wire the route + run test**

In `routes.tsx`, replace `/tenants` element with `<TenantsPage />` (add import).
Run: `pnpm --filter @actionow/admin test TenantsPage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/features/tenants apps/admin/src/routes.tsx
git commit -m "feat(admin): tenants screen (list + create)"
```

---

## Task 6: Accounts screen (list + create + top-up)

**Files:**

- Create: `apps/admin/src/features/accounts/AccountsPage.tsx`
- Modify: `apps/admin/src/routes.tsx`
- Test: `apps/admin/src/features/accounts/AccountsPage.test.tsx`

> NOTE: `/admin/accounts` has **no list endpoint** — accounts are created/topped-up but not listed by the API. For the MVP this screen lets you **create an account** for a selected tenant and **top up** a known account id. (A list view is added when the backend exposes `GET /admin/accounts?tenantId=`.) The screen surfaces the created account's balance via `<Money/>` after create/top-up.

- [ ] **Step 1: Write the failing test**

`apps/admin/src/features/accounts/AccountsPage.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeAll, expect, test, vi } from 'vitest';

import i18n from '../../i18n';

const createAccount = vi.fn().mockResolvedValue({
  id: 'a1',
  tenant_id: 't1',
  credit_balance: '100000000',
  credit_held: '0',
  created_at: '2026-06-16T00:00:00Z',
});
const listTenants = vi
  .fn()
  .mockResolvedValue([
    { id: 't1', name: 'acme', isolation_mode: 'field', created_at: '2026-06-16T00:00:00Z' },
  ]);
vi.mock('../../lib/api/useAdminApi', () => ({
  useAdminApi: () => ({ createAccount, listTenants, topup: vi.fn() }),
}));

import { AccountsPage } from './AccountsPage';

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

test('creates an account and shows its balance', async () => {
  render(wrap(<AccountsPage />));
  await userEvent.click(screen.getByRole('button', { name: /新建账户/ }));
  // wait for the tenants query to populate the option, then pick it
  await screen.findByRole('option', { name: 'acme' });
  await userEvent.selectOptions(screen.getByLabelText('租户'), 't1');
  await userEvent.type(screen.getByLabelText(/开通余额/), '100');
  await userEvent.click(screen.getByRole('button', { name: '创建' }));
  await waitFor(() => expect(createAccount).toHaveBeenCalledWith({ tenantId: 't1', credits: 100 }));
  await waitFor(() => expect(screen.getByText('100')).toBeInTheDocument());
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @actionow/admin test AccountsPage`
Expected: FAIL — cannot find `./AccountsPage`.

- [ ] **Step 3: Implement `AccountsPage.tsx`**

```tsx
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { GlassButton } from '../../components/glass/GlassButton';
import { GlassPanel } from '../../components/glass/GlassPanel';
import { Money } from '../../components/data/Money';
import { TenantSelect } from '../../components/data/TenantSelect';
import { Modal } from '../../components/ui/Modal';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { PlusIcon } from '../../components/icons';
import { ApiError } from '../../lib/api/errors';
import type { AccountView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

export function AccountsPage() {
  const { t } = useTranslation(['accounts', 'errors']);
  const api = useAdminApi();

  const [createOpen, setCreateOpen] = useState(false);
  const [tenantId, setTenantId] = useState('');
  const [credits, setCredits] = useState('');
  const [account, setAccount] = useState<AccountView | null>(null);

  const [topupOpen, setTopupOpen] = useState(false);
  const [topupCredits, setTopupCredits] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api.createAccount({ tenantId, credits: credits ? Number(credits) : undefined }),
    onSuccess: (acc) => {
      setAccount(acc);
      toast(t('accounts:created'));
      setCreateOpen(false);
      setCredits('');
    },
    onError: (e) =>
      toast(e instanceof ApiError ? t(`errors:${e.code}`) : t('errors:network'), 'error'),
  });

  const topup = useMutation({
    mutationFn: () => api.topup(account!.id, { credits: Number(topupCredits) }),
    onSuccess: (r) => {
      setAccount((a) => (a ? { ...a, credit_balance: r.balance } : a));
      toast(t('accounts:topup.done'));
      setTopupOpen(false);
      setTopupCredits('');
    },
    onError: (e) =>
      toast(e instanceof ApiError ? t(`errors:${e.code}`) : t('errors:network'), 'error'),
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <GlassButton variant="cta" onClick={() => setCreateOpen(true)}>
          <PlusIcon /> {t('accounts:new')}
        </GlassButton>
      </div>

      {account ? (
        <GlassPanel
          style={{
            padding: 'var(--s-5)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <div style={{ fontSize: 9.5, textTransform: 'uppercase', color: 'var(--muted)' }}>
              {t('accounts:cols.balance')}
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 6 }}>
              <Money micro={account.credit_balance} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 4 }}>{account.id}</div>
          </div>
          <GlassButton onClick={() => setTopupOpen(true)}>{t('accounts:topup.action')}</GlassButton>
        </GlassPanel>
      ) : (
        <GlassPanel
          style={{
            padding: 'var(--s-6)',
            textAlign: 'center',
            color: 'var(--muted)',
            fontSize: 12,
          }}
        >
          {t('accounts:empty')}
        </GlassPanel>
      )}

      <Modal
        open={createOpen}
        title={t('accounts:new')}
        onClose={() => setCreateOpen(false)}
        footer={
          <GlassButton
            variant="cta"
            disabled={!tenantId || create.isPending}
            onClick={() => create.mutate()}
          >
            {t('accounts:submit')}
          </GlassButton>
        }
      >
        <TenantSelect
          label={t('accounts:form.tenant')}
          value={tenantId}
          onChange={setTenantId}
          placeholder="—"
        />
        <TextField
          label={t('accounts:form.credits')}
          type="number"
          min="0"
          value={credits}
          onChange={(e) => setCredits(e.target.value)}
        />
      </Modal>

      <Modal
        open={topupOpen}
        title={t('accounts:topup.title')}
        onClose={() => setTopupOpen(false)}
        footer={
          <GlassButton
            variant="cta"
            disabled={!topupCredits || topup.isPending}
            onClick={() => topup.mutate()}
          >
            {t('accounts:topup.submit')}
          </GlassButton>
        }
      >
        <TextField
          label={t('accounts:topup.credits')}
          type="number"
          min="0"
          value={topupCredits}
          onChange={(e) => setTopupCredits(e.target.value)}
        />
      </Modal>
    </div>
  );
}
```

- [ ] **Step 4: Wire the route + run test**

In `routes.tsx`, replace `/accounts` element with `<AccountsPage />` (add import).
Run: `pnpm --filter @actionow/admin test AccountsPage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/features/accounts apps/admin/src/routes.tsx
git commit -m "feat(admin): accounts screen (create + top-up)"
```

---

## Task 7: API Keys screen (list + mint + one-time reveal)

**Files:**

- Create: `apps/admin/src/features/apiKeys/ApiKeysPage.tsx`
- Modify: `apps/admin/src/routes.tsx`
- Test: `apps/admin/src/features/apiKeys/ApiKeysPage.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/admin/src/features/apiKeys/ApiKeysPage.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeAll, expect, test, vi } from 'vitest';

import i18n from '../../i18n';

const listApiKeys = vi.fn().mockResolvedValue([]);
const createApiKey = vi.fn().mockResolvedValue({ id: 'k1', plaintext: 'ak_secret_once' });
const listTenants = vi
  .fn()
  .mockResolvedValue([
    { id: 't1', name: 'acme', isolation_mode: 'field', created_at: '2026-06-16T00:00:00Z' },
  ]);
vi.mock('../../lib/api/useAdminApi', () => ({
  useAdminApi: () => ({ listApiKeys, createApiKey, listTenants }),
}));

import { ApiKeysPage } from './ApiKeysPage';

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

test('mints a key and reveals the plaintext once', async () => {
  render(wrap(<ApiKeysPage />));
  await screen.findByRole('option', { name: 'acme' });
  await userEvent.selectOptions(screen.getByLabelText('租户'), 't1');
  await userEvent.click(screen.getByRole('button', { name: /签发 Key/ }));
  await userEvent.click(screen.getByRole('button', { name: '签发' }));
  await waitFor(() => expect(createApiKey).toHaveBeenCalledWith({ tenantId: 't1' }));
  await waitFor(() => expect(screen.getByText('ak_secret_once')).toBeInTheDocument());
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @actionow/admin test ApiKeysPage`
Expected: FAIL — cannot find `./ApiKeysPage`.

- [ ] **Step 3: Implement `ApiKeysPage.tsx`**

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { GlassButton } from '../../components/glass/GlassButton';
import { CopyField } from '../../components/data/CopyField';
import { DataTable } from '../../components/data/DataTable';
import type { Column } from '../../components/data/DataTable';
import { StatusBadge } from '../../components/data/StatusBadge';
import { TenantSelect } from '../../components/data/TenantSelect';
import { Modal } from '../../components/ui/Modal';
import { TextField } from '../../components/ui/TextField';
import { PlusIcon } from '../../components/icons';
import { ApiError } from '../../lib/api/errors';
import type { ApiKeyView, CreateApiKeyBody } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { toast } from '../../components/ui/toast';

export function ApiKeysPage() {
  const { t } = useTranslation(['apiKeys', 'errors']);
  const api = useAdminApi();
  const qc = useQueryClient();

  const [tenantId, setTenantId] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['api-keys', tenantId],
    queryFn: () => api.listApiKeys(tenantId),
    enabled: tenantId !== '',
  });

  const [formOpen, setFormOpen] = useState(false);
  const [allowlist, setAllowlist] = useState('');
  const [rateLimit, setRateLimit] = useState('');
  const [plaintext, setPlaintext] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const body: CreateApiKeyBody = { tenantId };
      const allow = allowlist
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (allow.length) body.resourceAllowlist = allow;
      if (rateLimit) body.rateLimit = Number(rateLimit);
      return api.createApiKey(body);
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['api-keys', tenantId] });
      setFormOpen(false);
      setAllowlist('');
      setRateLimit('');
      setPlaintext(r.plaintext); // one-time reveal
    },
    onError: (e) =>
      toast(e instanceof ApiError ? t(`errors:${e.code}`) : t('errors:network'), 'error'),
  });

  const columns: Column<ApiKeyView>[] = [
    {
      key: 'id',
      header: t('apiKeys:cols.id'),
      cell: (r) => <code style={{ fontSize: 11 }}>{r.id}</code>,
    },
    {
      key: 'allow',
      header: t('apiKeys:cols.allowlist'),
      cell: (r) => (r.resource_allowlist.length ? r.resource_allowlist.join(', ') : '—'),
    },
    { key: 'rate', header: t('apiKeys:cols.rateLimit'), cell: (r) => r.rate_limit ?? '—' },
    {
      key: 'status',
      header: t('apiKeys:cols.status'),
      cell: (r) => <StatusBadge status={r.status} />,
    },
    {
      key: 'created',
      header: t('apiKeys:cols.created'),
      cell: (r) => new Date(r.created_at).toLocaleDateString(),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <div
        style={{
          display: 'flex',
          gap: 'var(--s-3)',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ width: 220 }}>
          <TenantSelect
            label={t('apiKeys:form.tenant')}
            value={tenantId}
            onChange={setTenantId}
            placeholder="—"
          />
        </div>
        <GlassButton variant="cta" disabled={!tenantId} onClick={() => setFormOpen(true)}>
          <PlusIcon /> {t('apiKeys:new')}
        </GlassButton>
      </div>

      <DataTable
        columns={columns}
        rows={data ?? []}
        rowKey={(r) => r.id}
        loading={isLoading}
        empty={t('apiKeys:empty')}
      />

      <Modal
        open={formOpen}
        title={t('apiKeys:new')}
        onClose={() => setFormOpen(false)}
        footer={
          <GlassButton variant="cta" disabled={create.isPending} onClick={() => create.mutate()}>
            {t('apiKeys:submit')}
          </GlassButton>
        }
      >
        <TextField
          label={t('apiKeys:form.allowlist')}
          value={allowlist}
          onChange={(e) => setAllowlist(e.target.value)}
        />
        <TextField
          label={t('apiKeys:form.rateLimit')}
          type="number"
          min="1"
          value={rateLimit}
          onChange={(e) => setRateLimit(e.target.value)}
        />
      </Modal>

      <Modal
        open={plaintext !== null}
        title={t('apiKeys:reveal.title')}
        onClose={() => setPlaintext(null)}
        footer={
          <GlassButton variant="cta" onClick={() => setPlaintext(null)}>
            {t('apiKeys:reveal.done')}
          </GlassButton>
        }
      >
        <div style={{ fontSize: 12, color: 'var(--run)' }}>{t('apiKeys:reveal.warn')}</div>
        {plaintext && (
          <CopyField
            value={plaintext}
            copyLabel={t('apiKeys:reveal.copy')}
            copiedLabel={t('apiKeys:reveal.copied')}
          />
        )}
      </Modal>
    </div>
  );
}
```

- [ ] **Step 4: Wire the route + run test**

In `routes.tsx`, replace `/api-keys` element with `<ApiKeysPage />` (add import).
Run: `pnpm --filter @actionow/admin test ApiKeysPage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/features/apiKeys apps/admin/src/routes.tsx
git commit -m "feat(admin): api keys screen (list + mint + one-time reveal)"
```

---

## Task 8: Dashboard screen

**Files:**

- Create: `apps/admin/src/features/dashboard/DashboardPage.tsx`
- Modify: `apps/admin/src/routes.tsx`
- Test: `apps/admin/src/features/dashboard/DashboardPage.test.tsx`

> NOTE (spec §17.2): there is no global stats endpoint. The dashboard shows the two counts that **are** globally available — `listTenants().length` and `listResources().length` — plus a recent-jobs panel gated on a `TenantSelect` (jobs are per-tenant). No invented `/admin/stats`.

- [ ] **Step 1: Write the failing test**

`apps/admin/src/features/dashboard/DashboardPage.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeAll, expect, test, vi } from 'vitest';

import i18n from '../../i18n';

const listTenants = vi
  .fn()
  .mockResolvedValue([
    { id: 't1', name: 'acme', isolation_mode: 'field', created_at: '2026-06-16T00:00:00Z' },
  ]);
const listResources = vi.fn().mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
const listJobs = vi.fn().mockResolvedValue({ rows: [], nextCursor: null });
vi.mock('../../lib/api/useAdminApi', () => ({
  useAdminApi: () => ({ listTenants, listResources, listJobs }),
}));
vi.mock('../../lib/motion/useReducedMotion', () => ({ useReducedMotion: () => true }));

import { DashboardPage } from './DashboardPage';

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

test('shows tenant and resource counts', async () => {
  render(wrap(<DashboardPage />));
  await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument()); // tenants
  await waitFor(() => expect(screen.getByText('2')).toBeInTheDocument()); // resources
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @actionow/admin test DashboardPage`
Expected: FAIL — cannot find `./DashboardPage`.

- [ ] **Step 3: Implement `DashboardPage.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { StatCard } from '../../components/glass/StatCard';
import { DataTable } from '../../components/data/DataTable';
import type { Column } from '../../components/data/DataTable';
import { Money } from '../../components/data/Money';
import { StatusBadge } from '../../components/data/StatusBadge';
import { TenantSelect } from '../../components/data/TenantSelect';
import type { JobView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

export function DashboardPage() {
  const { t } = useTranslation('dashboard');
  const api = useAdminApi();

  const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => api.listTenants() });
  const resources = useQuery({ queryKey: ['resources'], queryFn: () => api.listResources() });

  const [tenantId, setTenantId] = useState('');
  const jobs = useQuery({
    queryKey: ['jobs', tenantId],
    queryFn: () => api.listJobs({ tenantId, limit: 8 }),
    enabled: tenantId !== '',
  });

  const columns: Column<JobView>[] = [
    { key: 'resource', header: t('cols.resource'), cell: (r) => r.resource_id },
    {
      key: 'mode',
      header: t('cols.execMode'),
      cell: (r) => <span className="tabular">{r.exec_mode}</span>,
    },
    { key: 'cost', header: t('cols.cost'), cell: (r) => (r.cost ? <Money micro={r.cost} /> : '—') },
    { key: 'status', header: t('cols.status'), cell: (r) => <StatusBadge status={r.status} /> },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 'var(--s-3)' }}>
        <StatCard label={t('stats.tenants')} value={tenants.data?.length ?? 0} />
        <StatCard label={t('stats.resources')} value={resources.data?.length ?? 0} />
      </div>

      <div style={{ width: 220 }}>
        <TenantSelect
          label={t('stats.tenantPick')}
          value={tenantId}
          onChange={setTenantId}
          placeholder="—"
        />
      </div>

      {tenantId ? (
        <DataTable
          columns={columns}
          rows={jobs.data?.rows ?? []}
          rowKey={(r) => r.job_id}
          loading={jobs.isLoading}
          empty={t('recentJobs')}
        />
      ) : (
        <div
          className="panel"
          style={{
            padding: 'var(--s-6)',
            textAlign: 'center',
            color: 'var(--muted)',
            fontSize: 12,
            borderRadius: 'var(--r-md)',
          }}
        >
          {t('pickTenant')}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire the route + run test**

In `routes.tsx`, replace `/dashboard` element with `<DashboardPage />` (add import).
Run: `pnpm --filter @actionow/admin test DashboardPage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/features/dashboard apps/admin/src/routes.tsx
git commit -m "feat(admin): dashboard (tenant/resource counts + recent jobs)"
```

---

## Task 9: Final wiring + verification gate + manual smoke

**Files:**

- Verify: all routes resolve to real screens; `routes.tsx` no longer maps MVP paths to `PlaceholderPage` (only `/ledger`, `/payments`, `/resources` remain placeholders).

- [ ] **Step 1: Confirm `routes.tsx` final state**

`apps/admin/src/routes.tsx` should map: `/login → LoginPage`, and under `ProtectedRoute → AppShell`: `/dashboard → DashboardPage`, `/tenants → TenantsPage`, `/accounts → AccountsPage`, `/api-keys → ApiKeysPage`; `/ledger`, `/payments`, `/resources` stay `PlaceholderPage` (later phases).

- [ ] **Step 2: Run the full gate**

Run: `pnpm --filter @actionow/admin typecheck && pnpm --filter @actionow/admin lint && pnpm --filter @actionow/admin test && pnpm --filter @actionow/admin build`
Expected: all PASS.

- [ ] **Step 3: Manual smoke against a seeded backend**

In one terminal: `pnpm infra:up && pnpm --filter @actionow/api seed && pnpm dev:api` (note the seeded admin email/password from docs).
In another: `pnpm --filter @actionow/admin dev`.
Verify: visit `http://localhost:5173` → redirected to `/login` → sign in with the seeded admin → dashboard shows tenant/resource counts → create a tenant (toast + row) → create an account for it + top up (balance updates) → mint an API key (plaintext shown once, copyable) → theme toggle + language switch work throughout; reduced-motion disables idle animation.

- [ ] **Step 4: Commit any fixups**

```bash
git add -A
git commit -m "chore(admin): mvp screens verification gate green"
```

---

## Plan 3 Definition of Done

- coss-backed UI wrappers (`Modal`, `TextField`, `SelectField`, `Toaster`/`toast`) + shared data components (`DataTable`, `StatusBadge`, `CopyField`, `Money`, `TenantSelect`).
- Five MVP screens live on the shell: **Login** (`/auth/login` + admin gate + reserved OAuth), **Dashboard** (tenant/resource counts + per-tenant recent jobs), **Tenants** (list + create), **Accounts** (create + top-up), **API Keys** (list + mint + one-time plaintext reveal).
- All copy bilingual (zh-CN | en) via per-feature namespaces with key-parity tests; errors localized by `code`.
- `typecheck/lint/test/build` green; manual smoke against the seeded API passes the full create-tenant → account → top-up → mint-key loop.

> **Beyond MVP (future plans):** Catalog (Resources + Channels), Pricebook, Modifiers, Jobs monitor (stream/async-callback-aware), Ledger audit, Payments/对账 (Phase 10), Files (Phase 7), Settings (OAuth identity linking), `GET /admin/accounts` list view, OpenAPI-generated client, Playwright e2e.
