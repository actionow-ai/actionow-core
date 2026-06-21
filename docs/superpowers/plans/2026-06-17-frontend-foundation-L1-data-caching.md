# Frontend Foundation L1 — Data Layer + Caching (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the admin API client match the backend (verbs, methods, fields, enums), and establish correct caching/state conventions (centralized query keys, cache-policy tiers, no-flash list switching, URL-as-truth filters, unified mutation errors) — then migrate existing pages onto them.

**Architecture:** A typed HTTP client gains `patch`/`delete` + header access. A `queryKeys` factory is the single source for cache keys; a `mutationError(t)` helper unifies error toasts; a `useUrlState` hook persists filters/selection in the URL. Admin methods + DTO types are extended to full parity (client layer only — no new feature pages). Existing console pages are migrated onto these.

**Tech Stack:** Vite 6, React 19, TS (strict), TanStack Query v5, react-router v7, react-i18next, vitest.

Spec: `docs/superpowers/specs/2026-06-17-frontend-foundation-consolidation-design.md` (§3 L1 + §4 urgent #2). Conventions: `docs/CONVENTIONS.md`. Working dir: `/Users/alienworm/actionow-web`. Gate: `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web lint && pnpm --filter @actionow/web build`. Tests: `pnpm --filter @actionow/web exec vitest run`.

**Backend source of truth (read to confirm exact shapes):** `/Users/alienworm/actionow-core` — `apps/api/src/admin/dto/admin.dto.ts` (zod request schemas) and `apps/api/src/admin/admin.controller.ts` (route handlers + response mappers, i.e. the `*View` shapes). Do not guess a `*View` shape — read the controller mapper that builds it.

---

## File Structure

- `src/lib/api/client.ts` — **modify**: add `patch`, `delete`; expose response headers.
- `src/lib/api/queryKeys.ts` — **create**: key factory `qk`.
- `src/lib/api/queryKeys.test.ts` — **create**.
- `src/lib/api/mutationError.ts` — **create**: `mutationError(t)`.
- `src/lib/api/mutationError.test.ts` — **create**.
- `src/lib/useUrlState.ts` — **create**: URL-search-param state hook.
- `src/lib/useUrlState.test.ts` — **create**.
- `src/lib/api/types.ts` — **modify**: fix/extend types (channels, secrets, models, codes, usage, ledger, payments; tighten enums).
- `src/lib/api/admin.ts` — **modify**: add methods; route through `qk` is N/A (keys live in pages); add the new endpoint methods.
- `src/lib/query.ts` — **modify**: cache-policy tiers (staleTime constants) if not already; keep `Page`/`useKeyset` and reuse for ledger.
- Console pages (`src/features/console/*` + `ResourceDetailPane.tsx`, `DashboardPage.tsx`, `ApiKeysPage.tsx`, etc.) — **modify**: migrate to `qk`, `mutationError`, `keepPreviousData`, `useUrlState`; remove dead code (`NotAdminError`, unused `EmptyState`); remove stale `channels.note` and render the channel list.
- i18n `src/i18n/locales/{zh-CN,en}/console.json` — **modify**: remove `channels.note`; add any new keys used.

---

## Task 1: HTTP client — `patch`/`delete` + response headers

**Files:** `src/lib/api/client.ts`, `src/lib/api/admin.test.ts` (existing test harness).

- [ ] **Step 1: Read the current client** to match its `request<T>`/`get`/`post` style (`src/lib/api/client.ts`). Note how it builds URL, headers (Bearer via `getToken`), parses the `{error:{code,message,...}}` envelope into `ApiError`, and calls `onUnauthorized` on 401.
- [ ] **Step 2: Write failing tests** (extend `admin.test.ts` or add `client.test.ts`) asserting: `client.patch(path, body)` issues a PATCH with JSON body + auth header and returns parsed JSON; `client.delete(path)` issues a DELETE; both surface `ApiError` on an error envelope. Mock `fetch`.
- [ ] **Step 3: Run tests, verify they fail.** `pnpm --filter @actionow/web exec vitest run` (new cases red).
- [ ] **Step 4: Implement** `patch<T>(path, body)` and `delete<T>(path)` mirroring `post`/`get` (method 'PATCH'/'DELETE', same header + envelope handling; DELETE may have no body). Expose response headers: change the internal `request` to also return headers — add an optional `getWithHeaders<T>(path): Promise<{ data: T; headers: Headers }>` (keep `get`/`post`/etc. returning `T` for back-compat). Update the `ApiClient` type accordingly.
- [ ] **Step 5: Run tests, verify pass.** Then full gate green.
- [ ] **Step 6: Commit** — `git -C /Users/alienworm/actionow-web add apps/web/src/lib/api/client.ts apps/web/src/lib/api/*.test.ts && git -C /Users/alienworm/actionow-web commit -m "feat(web): http client patch/delete + response-header access"`.

---

## Task 2: `queryKeys` factory + migrate all keys

**Files:** `src/lib/api/queryKeys.ts` (+ test); every `src/features/console/*` page and `components/data/TenantSelect.tsx` that calls `useQuery`/`invalidateQueries`.

- [ ] **Step 1: Write failing test** `queryKeys.test.ts`: `qk.resources()` deep-equals `['admin','resources']`; `qk.apiKeys('t1')` deep-equals `['admin','api-keys','t1']`; `qk.channels('r1')` deep-equals `['admin','resources','r1','channels']`; keys are stable (same input → equal array).
- [ ] **Step 2: Verify red.**
- [ ] **Step 3: Implement** `queryKeys.ts`:

```ts
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
  usage: (params: Record<string, unknown>) => ['admin', 'usage', params] as const,
  analyticsUsage: (params: Record<string, unknown>) =>
    ['admin', 'analytics-usage', params] as const,
  ledger: (tenantId: string) => ['admin', 'ledger', tenantId] as const,
  payments: (tenantId: string) => ['admin', 'payments', tenantId] as const,
};
```

- [ ] **Step 4: Verify green.**
- [ ] **Step 5: Migrate every inline key.** Grep `grep -rn "queryKey:\|invalidateQueries" apps/web/src/features apps/web/src/components` and replace each inline array with the matching `qk.*()` call (import `qk` from the right relative path). CRITICAL FIX: `DashboardPage.tsx` currently uses `['resources']`/`['tenants']` while `ResourcesPage`/`ResourceDetailPane` use `['admin','resources']` — point BOTH at `qk.resources()`/`qk.tenants()` so they share one cache entry. Ensure mutation `invalidateQueries({ queryKey: qk.* })` matches the corresponding query key.
- [ ] **Step 6: Verify** full gate green; in `:4173`, create a tenant on Tenants page → Dashboard tenant count updates without manual refresh (shared cache + invalidation).
- [ ] **Step 7: Commit** — `feat(web): centralized query keys (qk) + migrate pages`.

---

## Task 3: Cache-policy tiers + no-flash list switching

**Files:** `src/lib/query.ts` (queryClient defaults), console list pages.

- [ ] **Step 1: Read `src/lib/query.ts`** — confirm current `QueryClient` defaults (`staleTime 15s`, `retry 1`, `refetchOnWindowFocus false`, `gcTime` default 5min).
- [ ] **Step 2: Add staleTime tier constants** in `query.ts`:

```ts
/** Catalog/reference data changes rarely → cache longer. */
export const STALE_REFERENCE = 60_000;
/** Volatile operational data (jobs/usage/ledger) → short. */
export const STALE_VOLATILE = 10_000;
```

Keep the QueryClient defaults as-is (15s baseline). Pages opt into a tier per query via `staleTime`.

- [ ] **Step 3: Apply `placeholderData: keepPreviousData`** to every list query whose key includes a filter/pagination/tenant/tab variable, so switching the filter keeps the prior rows visible (no spinner flash). Import `keepPreviousData` from `@tanstack/react-query`. Sites: `ApiKeysPage` (tenant filter), `DashboardPage` (jobs by tenant), and any future filtered list. Also set `staleTime: STALE_REFERENCE` on tenants/resources/models queries and `STALE_VOLATILE` on jobs/usage/ledger queries.
- [ ] **Step 4: Verify** at `:4173`: on ApiKeys, switch the tenant filter back and forth → rows update without a loading flash (previous rows stay until new arrive).
- [ ] **Step 5: Commit** — `feat(web): cache-policy tiers + keepPreviousData for filtered lists`.

---

## Task 4: `useUrlState` + URL-as-truth filters

**Files:** `src/lib/useUrlState.ts` (+ test); `ApiKeysPage.tsx`, `DashboardPage.tsx` (tenant filter), any sub-tab state.

- [ ] **Step 1: Write failing test** `useUrlState.test.ts` (render hook with a `MemoryRouter`): initial value falls back to the default when the param is absent; setting the value updates the URL search param; reading reflects the param. (Use `@testing-library/react` `renderHook` + `react-router` `MemoryRouter`; if RTL isn't installed, test the pure get/set helpers instead and note it.)
- [ ] **Step 2: Verify red.**
- [ ] **Step 3: Implement** `useUrlState.ts` on top of react-router's `useSearchParams`:

```ts
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/** Persist a single string UI value in the URL query string (back/forward + reload safe). */
export function useUrlState(key: string, fallback = ''): [string, (v: string) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(key) ?? fallback;
  const set = useCallback(
    (v: string) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (v === '' || v === fallback) next.delete(key);
          else next.set(key, v);
          return next;
        },
        { replace: true },
      );
    },
    [key, fallback, setParams],
  );
  return [value, set];
}
```

- [ ] **Step 4: Verify green.**
- [ ] **Step 5: Migrate the tenant filter** on `ApiKeysPage` and `DashboardPage` from `useState('')` to `useUrlState('tenant')`. The selection on Resources already uses the route param (`/console/resources/:id`) — leave it (it's the canonical pattern). Ensure the query `enabled`/key still gate on the value.
- [ ] **Step 6: Verify** at `:4173`: pick a tenant on ApiKeys → URL gains `?tenant=…`; reload → filter persists; browser back → returns to prior selection.
- [ ] **Step 7: Commit** — `feat(web): useUrlState + persist filters in the URL`.

---

## Task 5: `mutationError(t)` helper + migrate all onError

**Files:** `src/lib/api/mutationError.ts` (+ test); all `features/console/*` pages with `useMutation({ onError })`.

- [ ] **Step 1: Write failing test** `mutationError.test.ts`: given a fake `t` that echoes its key, `mutationError(t)(new ApiError('insufficient_credits','msg',402,false))` calls `toast` with `t('errors.insufficient_credits')`; an unknown code falls back to the server message (`e.message`); a non-ApiError calls `toast(t('errors.network'),'error')`. Mock the `toast` module.
- [ ] **Step 2: Verify red.**
- [ ] **Step 3: Implement** `mutationError.ts`:

```ts
import type { TFunction } from 'i18next';

import { ApiError } from './errors';
import { toast } from '../../components/ui/toast';

/** Standard onError for useMutation: localized error toast, server-message fallback. */
export function mutationError(t: TFunction) {
  return (e: unknown) => {
    if (e instanceof ApiError) toast(t(`errors.${e.code}`, e.message), 'error');
    else toast(t('errors.network'), 'error');
  };
}
```

(Confirm the `toast` import path + signature and `TFunction` import; adjust to match the codebase.)

- [ ] **Step 4: Verify green.**
- [ ] **Step 5: Migrate** every `onError: (e) => toast(...)` in `features/console/*` to `onError: mutationError(t)`. This removes the ~7 duplicated lines AND fixes the inconsistency where some pages rendered raw i18n keys for unknown codes.
- [ ] **Step 6: Verify** full gate green.
- [ ] **Step 7: Commit** — `feat(web): mutationError helper + migrate onError handlers`.

---

## Task 6: Type fixes + enum tightening

**Files:** `src/lib/api/types.ts` (confirm each against backend `admin.dto.ts`).

- [ ] **Step 1: Tighten loose `string` types to backend enums** (read `admin.dto.ts` to confirm exact members):
  - `CreateResourceBody.modality` → `'text'|'image'|'video'|'audio'|'composite'`.
  - `CreatePricebookBody.method` → `'unit'|'matrix'|'fixed'|'formula'|'passthrough'`; `.timing` → `'pre'|'post'`; add `fixedCredits?: number`; widen `markup?: unknown`.
  - `CreateModifierBody.op` → `'override_rate'|'percent_off'|'flat_off'|'percent_add'`.
  - `DifyImportBody.pricingModel` → `'fixed'|'matrix'|'metered'`.
- [ ] **Step 2: Fix channel types** (the urgent #2 field gap):
  - `CreateChannelBody`: add `endpoint?: string; model?: string; proxyRef?: string; config?: Record<string, unknown>;` and tighten `status?: 'active'|'disabled'`.
  - Add `UpdateChannelBody` (all optional; nullable where the backend allows clearing): `{ credentialRef?: string|null; endpoint?: string|null; model?: string|null; proxyRef?: string|null; config?: Record<string,unknown>|null; weight?: number; status?: 'active'|'disabled' }`.
  - Extend `ChannelView` with `endpoint: string|null; model: string|null; proxy_ref: string|null; config: Record<string,unknown>|null` (confirm field names against the controller mapper).
- [ ] **Step 3: Fix any call sites** that break from the tightened unions (e.g. a `Select`/`SelectField` `value as X` cast can now be a typed union; a form default must be a valid member). Run typecheck to find them.
- [ ] **Step 4: Verify** full gate green.
- [ ] **Step 5: Commit** — `fix(web): tighten DTO enums + complete channel field types`.

---

## Task 7: New admin client methods + view types

**Files:** `src/lib/api/admin.ts`, `src/lib/api/types.ts`. Confirm every `*View` shape by reading the matching mapper in `admin.controller.ts`.

- [ ] **Step 1: Add methods to `makeAdminApi`** (use the client's `get`/`post`/`patch`):

```ts
listChannels: (resourceId: string) => client.get<ChannelView[]>(`/admin/resources/${resourceId}/channels`),
updateChannel: (resourceId: string, channelId: string, body: UpdateChannelBody) =>
  client.patch<ChannelView>(`/admin/resources/${resourceId}/channels/${channelId}`, body),
createSecret: (body: CreateSecretBody) => client.post<SecretView>('/admin/secrets', body),
listModels: () => client.get<ModelView[]>('/admin/models'),
createModel: (body: CreateModelBody) => client.post<ModelView>('/admin/models', body),
grantModel: (name: string, body: { tenantId: string }) => client.post<{ ok: true }>(`/admin/models/${name}/grants`, body),
generateCodes: (body: GenerateCodesBody) => client.post<{ codes: string[]; credit_amount: string }>('/admin/redemption-codes', body),
listUsage: (params: { limit?: number }) => client.get<{ logs: UsageLogView[] }>('/admin/usage', params),
analyticsUsage: (params: AnalyticsUsageQuery) => client.get<UsageRollupView[]>('/admin/analytics/usage', params),
listLedger: async (p: KeysetParams): Promise<Page<LedgerView>> => {
  const r = await client.get<{ transactions: LedgerView[]; next_cursor: string | null }>('/admin/ledger', p);
  return { rows: r.transactions, nextCursor: r.next_cursor };
},
listPayments: (tenantId: string, limit?: number) => client.get<{ intents: PaymentIntentView[] }>('/admin/payments', { tenantId, limit }),
```

- [ ] **Step 2: Add the body + view types** in `types.ts` (confirm against backend):
  - `CreateSecretBody { value: string; label?: string }`; `SecretView` (read mapper — likely `{ id; provider; label?; created_at }`).
  - `CreateModelBody` (from `createModelSchema`: name, resourceId, display?, modality?, capabilities?: Record<string,boolean>, visibility?: 'public'|'tenant', inputPrice?: number, outputPrice?: number, status?: 'active'|'disabled'); `ModelView` (read mapper).
  - `GenerateCodesBody { count: number; creditsPerCode: number; expiresAt?: string }`.
  - `AnalyticsUsageQuery { groupBy: 'day'|'model'|'tenant'|'channel'|'api_key'; tenantId?: string; from?: string; to?: string }`.
  - `UsageLogView`, `UsageRollupView`, `LedgerView`, `PaymentIntentView` (read each mapper; do not invent fields).
- [ ] **Step 3: Verify** full gate green (these are additive; nothing consumes them yet — that's fine, they're the prerequisite for the feature layers). `tsc` confirms types compile.
- [ ] **Step 4: Commit** — `feat(web): admin client parity (channels/secrets/models/codes/usage/ledger/payments)`.

---

## Task 8: Complete the channels read-side + remove stale note; dead-code cleanup

**Files:** `ResourceDetailPane.tsx`, i18n `console.json` (both locales), `src/lib/api/errors.ts`, `src/components/ui/EmptyState.tsx`.

- [ ] **Step 1: Render the channel list** in `ResourceDetailPane`: add a `useQuery({ queryKey: qk.channels(id), queryFn: () => api.listChannels(id), enabled: id !== '' })` and render the channels (reuse `CardCollection`/`EntityCard` or the existing `DataTable` — match the pane's existing pattern) showing provider/endpoint/model/weight/status. Invalidate `qk.channels(id)` in the existing `addChannel.onSuccess`.
- [ ] **Step 2: Remove the stale note.** Delete the `channels.note` render and the `channels.note` i18n keys in both `zh-CN` and `en` `console.json`. (The create form already collects provider/credentialRef/weight; leave it — extending it with endpoint/model/proxyRef/config is a feature task, out of scope here. Do not add new form fields.)
- [ ] **Step 3: Remove dead code** flagged by the audit: delete `NotAdminError` from `errors.ts` (unused) and delete the unused `EmptyState` component IF no import exists (grep first: `grep -rn "EmptyState" apps/web/src`). If `EmptyState` is imported anywhere, leave it.
- [ ] **Step 4: Verify** at `:4173`: open a resource → its channels list renders (seed resource has channels); add a channel → list refreshes. Full gate + vitest green.
- [ ] **Step 5: Commit** — `feat(web): list channels in resource detail; drop stale note + dead code`.

---

## Final verification (L1 checkpoint)

- [ ] Full gate green; `vitest run` green (incl. new tests for client/queryKeys/mutationError/useUrlState).
- [ ] `grep -rn "queryKey: \[" apps/web/src/features apps/web/src/components` → no inline key arrays remain (all via `qk`).
- [ ] `grep -rn "channels.note" apps/web/src` → none.
- [ ] `:4173` behaviors: shared cache (create tenant → dashboard count updates); no-flash on ApiKeys tenant switch; URL gains `?tenant=` and survives reload/back; resource channels list renders.

## Self-review notes

- Spec L1 coverage: client verbs+headers (T1), query keys (T2), cache tiers + keepPreviousData (T3), useUrlState (T4), mutationError (T5), enum/field fixes incl. urgent #2 channel fields (T6), method/type parity (T7), channel read-side + stale-note + dead-code (T8). All §3-L1 + §4#2 covered.
- Scope guard: new methods/types are added but NOT wired into new feature pages (deferred to F-series). Channel create-form fields are NOT expanded here (feature). Console self-service + /v1 relay clients are explicitly out (per spec).
