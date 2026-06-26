# 租户目录表格化 + 详情页路由 (Console Tenant-Dir Tables) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 租户 directory consistent on a table layout: convert TenantsPage / ApiKeysPage / ServiceTokensPage from card grids to `DataTable` with row-click → a **dedicated detail-page route**; move the 卡密兑换 status-filter label inline-left; and add a Vite `optimizeDeps` mitigation for the dev-only first-load blank.

**Architecture:** Each list page renders a `DataTable` (which already supports `onRowClick`/`selectedKey`) whose row-click `useNavigate`s to a new `/console/<entity>/:id` route. The per-entity detail page (new components) absorbs what the card/drawer used to show: for tenants, extract the existing `TenantDetailDrawer` content into a routed `TenantDetailPage`; for api-keys, the route-group/limit-plan binding + usage; for tokens, info + revoke. The console currently has NO routed detail page (only redirects), so this establishes that pattern.

**Tech Stack:** Vite/React (apps/web), react-router, @tanstack/react-query, vitest. No backend/contracts change (all admin endpoints already exist via `useAdminApi`).

**Branch:** `feat/console-tenant-tables`.

**Conventions (follow exactly):**

- **GIT IS GATED on the Xcode license:** prefix EVERY git command with `DEVELOPER_DIR=/Library/Developer/CommandLineTools`. NEVER sudo / `xcodebuild -license`.
- commitlint: lowercase imperative subject, header ≤100 chars; commit body ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do NOT push / open PRs (the gate is the controller's).
- i18n: EVERY new user-facing string in BOTH `apps/web/src/i18n/locales/zh-CN/console.json` and `/en/console.json`.
- GROUND TRUTH OVER PLAN: read the real files first. The `OAuthSessionsPage` (already DataTable) + `RedemptionCodesPage` (already DataTable, filter in `useSetConsoleAction`) are the in-repo table precedents — mirror them. Reuse `DataTable` (`onRowClick`, `selectedKey`, `columns`, `rowKey`, `loading/error/empty`, `rowActions`), `StatusBadge`/`statusTone`, `Money`, `LoadMore`, `useUrlState`.
- After each task: `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web test` must pass.

---

## Task 1: SelectField inline-label + 卡密兑换 filter label-left + Vite optimizeDeps

**Files:**

- Modify: `apps/web/src/components/ui/FormField.tsx` + `apps/web/src/components/ui/SelectField.tsx` (add an inline/left-label layout option), `apps/web/src/features/console/RedemptionCodesPage.tsx`, `apps/web/vite.config.ts`
- Test: `apps/web/src/features/console/RedemptionCodesPage.test.tsx` (extend)

- [ ] **Step 1: Read** `FormField.tsx`, `SelectField.tsx`, `RedemptionCodesPage.tsx` (the `useSetConsoleAction` filter ~lines 78-92), `vite.config.ts`.
- [ ] **Step 2: Add an inline label layout.** In `FormField` add an optional `inline?: boolean` prop that renders `label` to the LEFT of the control (flex row, `align-items:center`, `gap: var(--s-2)`, label not full-width) instead of above. Thread it through `SelectField` (`inline?: boolean`). Keep default (label above) unchanged so no other field shifts.
- [ ] **Step 3: 卡密兑换 filter.** In `RedemptionCodesPage`, pass `inline` to the status `SelectField` in the action slot so 状态 sits to the LEFT of the select (matches the screenshot ask). Keep the `useUrlState('status')` wiring + the 全部状态 placeholder.
- [ ] **Step 4: Vite optimizeDeps.** In `vite.config.ts` add `optimizeDeps: { include: [...] }` listing the app's common runtime deps so Vite pre-bundles them at startup (eliminates the one-time cold-optimize full-reload that flashes blank on a deep `/console/*` first load). Include at minimum: `react`, `react-dom`, `react-dom/client`, `react-router-dom`, `@tanstack/react-query`, `react-i18next`, `i18next`, `@phosphor-icons/react`. (Dev-only; no production effect.)
- [ ] **Step 5:** extend `RedemptionCodesPage.test.tsx` to assert the status filter renders (and, if practical, the inline layout). Run `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web test`.
- [ ] **Step 6: Commit** `feat(web): inline select-field label + redemption filter label-left + vite optimizeDeps`.

---

## Task 2: TenantsPage → DataTable + `/console/tenants/:id` detail page

**Files:**

- Modify: `apps/web/src/features/console/TenantsPage.tsx`, `apps/web/src/routes.tsx`, i18n
- Create: `apps/web/src/features/console/TenantDetailPage.tsx`
- Test: a `TenantsPage.test.tsx` (new) or extend; basic `TenantDetailPage` render test

- [ ] **Step 1: Read** the WHOLE `TenantsPage.tsx` — note the `TenantDetailDrawer` component (≈ lines 317-end: plan binding, topup, sub-accounts/subjects, keys, usage) and the `accountByTenant` balance map.
- [ ] **Step 2: Extract `TenantDetailPage`.** Create `TenantDetailPage.tsx` that reads `:id` via `useParams`, loads the tenant (reuse the tenants query or a get-by-id) + its account, and renders the FORMER `TenantDetailDrawer` body as a full page (header with tenant name + a back link to `/console/tenants`, then plan binding / sub-wallet topup-transfer / subjects / keys / usage). Move the drawer's logic verbatim where possible; drop the `Drawer` wrapper. Handle loading / not-found (a tenant id not in the list → fetch or show a 未找到 state).
- [ ] **Step 3: List → DataTable.** Replace `CardCollection`/`EntityCard` in `TenantsPage` with `DataTable`:
  - columns: 名称 (`r.name`), 隔离模式 (chip, `t('tenants.isolation.'+r.isolation_mode)`), 创建时间 (`new Date(r.created_at).toLocaleDateString()`, right-aligned), 余额 (`<Money micro={accountByTenant.get(r.id)?.credit_balance} />` or —, right-aligned).
  - `rowKey={(r) => r.id}`, `loading/error/onRetry/empty` from the tenants query, `onRowClick={(r) => navigate('/console/tenants/' + r.id)}` (`useNavigate`).
  - Keep the 新建租户 + 一键开通 actions (the existing `useSetConsoleAction` / page header) intact.
  - Remove the now-unused `TenantDetailDrawer` + `selected` state.
- [ ] **Step 4: Route.** In `routes.tsx`, add `<Route path="tenants/:id" element={<TenantDetailPage />} />` right after the `tenants` route. Import `TenantDetailPage`.
- [ ] **Step 5: i18n** any new strings (detail page title, back link, balance/created headers if not present) in both locales.
- [ ] **Step 6:** `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web test`. **Commit** `feat(web): tenants list as table + routed tenant detail page`.

---

## Task 3: ApiKeysPage → DataTable + `/console/api-keys/:id` detail page

**Files:**

- Modify: `apps/web/src/features/console/ApiKeysPage.tsx`, `apps/web/src/routes.tsx`, i18n
- Create: `apps/web/src/features/console/ApiKeyDetailPage.tsx`
- Test: extend `ApiKeysPage.test.tsx`

- [ ] **Step 1: Read** the WHOLE `ApiKeysPage.tsx` — the `EntityCard` renders key id + status badge + chips (subject/rate/allowlist) + inline 路由组/额度套餐 `SelectField`s (bindGroup/bindPlan mutations) + `KeyLimitUsage` + revoke. Note the tenant-select gate (`tenantId`) in the action slot.
- [ ] **Step 2: Extract `ApiKeyDetailPage`.** Create `ApiKeyDetailPage.tsx` reading `:id` via `useParams`; load the key (the keys list is tenant-scoped — accept the tenant via `?tenant=` query like the screenshots' `/console/api-keys?tenant=…`, or fetch the key by id) and render: key id (CopyField), status, subject, rate/allowlist chips, the 路由组 + 额度套餐 binding `SelectField`s (bindGroup/bindPlan mutations moved here), `KeyLimitUsage`, and a revoke button. Back link to `/console/api-keys`.
- [ ] **Step 3: List → DataTable.** Replace `CardCollection` in `ApiKeysPage` with `DataTable`:
  - columns: Key (`<code>{r.id}</code>` or last8, grow), 终端用户 (subject_id slice or —), 路由组 (group name or 默认), 额度套餐 (plan name or 不限制), 状态 (StatusBadge), 创建时间 (right).
  - `onRowClick` → `navigate('/console/api-keys/' + r.id + '?tenant=' + tenantId)`. Keep the tenant-select gate + 签发 Key action. `rowActions` = a revoke shortcut (optional) — primary binding edits live on the detail page.
- [ ] **Step 4: Route** `<Route path="api-keys/:id" element={<ApiKeyDetailPage />} />`.
- [ ] **Step 5: i18n** both locales. **Step 6:** typecheck + test (update `ApiKeysPage.test.tsx` for the table shape). **Commit** `feat(web): api-keys list as table + routed key detail page`.

---

## Task 4: ServiceTokensPage → DataTable + `/console/tokens/:id` detail page

**Files:**

- Modify: `apps/web/src/features/console/ServiceTokensPage.tsx`, `apps/web/src/routes.tsx`, i18n
- Create: `apps/web/src/features/console/ServiceTokenDetailPage.tsx`
- Test: a small render test

- [ ] **Step 1: Read** the WHOLE `ServiceTokensPage.tsx` (EntityCard: name, status badge, created/expires meta, revoke + the create Modal).
- [ ] **Step 2: List → DataTable** — columns: 名称, 状态 (StatusBadge), 创建时间, 过期时间 (right), with `rowActions` = revoke, and `onRowClick` → `/console/tokens/:id`. Keep the 新建令牌 action + create Modal.
- [ ] **Step 3: Create `ServiceTokenDetailPage`** reading `:id` — token name, status, created/expires, revoke; back link to `/console/tokens`. (Thin but consistent with the chosen detail-page pattern.)
- [ ] **Step 4: Route** `<Route path="tokens/:id" element={<ServiceTokenDetailPage />} />`.
- [ ] **Step 5: i18n** both locales. **Step 6:** typecheck + test. **Commit** `feat(web): service-tokens list as table + routed token detail page`.

---

## Phase Gate (controller's)

- Full `pnpm --filter @actionow/web test` + typecheck + eslint green; live-verify each list renders as a table and row-click opens the detail route; the 卡密兑换 filter label sits left; the oauth-sessions first-load no longer reloads (or note dev-only). Memory + PR squash-merge.

## Self-review notes (addressed)

- **Detail-page pattern is new** to the console — Task 2 establishes it; Tasks 3/4 mirror it. Each adds its route in `routes.tsx` (sequential to avoid conflicts).
- **No backend change** — all binding/topup/revoke/list calls already exist on `useAdminApi`; detail pages reuse them.
- **Don't regress actions** — page-header actions (新建租户/一键开通, 签发 Key + tenant-select, 新建令牌) stay in the `useSetConsoleAction` slot; only the list body changes card→table.
- **Reuse** `DataTable` + `StatusBadge` + `Money` + `LoadMore` + `useUrlState`; mirror `OAuthSessionsPage`/`RedemptionCodesPage`.
- **Naming** `TenantDetailPage` / `ApiKeyDetailPage` / `ServiceTokenDetailPage`; routes `tenants/:id`, `api-keys/:id`, `tokens/:id`.
