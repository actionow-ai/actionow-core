# Actionow Frontend — Deep Design Analysis

> Multi-agent analysis (29 agents). **Backend authority:** `actionow-core @ feat/billing-group-routing`. **Frontend:** `actionow-web @ feat/admin-frontend` (`apps/web`). Generated 2026-06-18.

> Every claimed endpoint/component was adversarially grep-verified against the source — 0 phantoms.

## Table of Contents

- **Part I — Cross-Cutting Synthesis** (visibility matrix · endpoint→page map · mock-vs-real gaps · caching · design-system gaps · prioritized backlog)

- **Part II — Inventories**: A. Backend API · B. Data Layer & Caching · C. Design System · D. Audience & Visibility

- **Part III — Per-Page Specs**: 1. Landing · 2. Auth (Login/Register) · 3. User Home (Tenant self-service) · 4. Console Dashboard · 5. Catalog (Resources + Models) · 6. Modifiers (Pricing modifiers) · 7. Route Groups (Billing/Routing) · 8. Official Prices · 9. Dify Import · 10. Tenants · 11. Accounts (Credits/Ledger) · 12. API Keys (Admin)

---

# Part I — Cross-Cutting Synthesis

# Actionow Console/Web — Cross-Cutting Frontend Design Analysis

Branch context: `feat/billing-group-routing` (route-groups + official-prices CRUD now exist on the backend; the corresponding console pages are still on `mockBilling.ts`). Frontend lives in worktree `/Users/alienworm/actionow-web` on `feat/admin-frontend`.

The single highest-leverage finding: **the backend has materially outrun the frontend.** Two full backend feature areas (route-groups, official-prices) are now real but the UI still reads in-memory mocks; an entire audience (tenant self-service, `/console/*` API) is fully built server-side and essentially unbuilt client-side (`/app` is a placeholder); and roughly a dozen admin capabilities (relay-traces, analytics, usage, ledger, payments, redemption-codes, secrets, oauth-sessions, jobs, dify list/patch/delete) have working endpoints with no page surfacing them.

---

## 1. PRODUCT AUDIENCES & VISIBILITY MATRIX

Four audiences exist on one unified `user` table (operator = a `user` whose `role === 'admin'`). The frontend `/console/*` routes are the **operator admin console** (do not confuse with the backend `/console/*` API, which is the **tenant self-service** plane).

| Frontend route                                                                 | Audience                                              | Frontend guard              | Backend guard for its data                      | mockStatus                                              |
| ------------------------------------------------------------------------------ | ----------------------------------------------------- | --------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| `/` (Landing)                                                                  | Public / prospective operators                        | none                        | none                                            | static                                                  |
| `/login` (Auth)                                                                | Public → produces operator OR tenant-user             | none                        | `/auth/login`,`/auth/register` (no guard)       | real                                                    |
| `/app` (UserHome)                                                              | Tenant self-service (any authed; admins admitted too) | `ProtectedRoute` (any auth) | _should_ be `/console/*` API → ConsoleGuard     | **static placeholder**                                  |
| `/console` → `/console/dashboard`                                              | Operator                                              | `role="admin"`              | —                                               | —                                                       |
| `/console/dashboard`                                                           | Operator                                              | `role="admin"`              | AdminGuard `@Roles('admin')`                    | real                                                    |
| `/console/catalog` (Models+Resources)                                          | Operator                                              | `role="admin"`              | AdminGuard `@Roles('admin')`                    | real                                                    |
| `/console/resources`,`/resources/:id`,`/models` (legacy → redirect to catalog) | Operator                                              | `role="admin"`              | AdminGuard `@Roles('admin')`                    | real                                                    |
| `/console/modifiers`                                                           | Operator                                              | `role="admin"`              | AdminGuard `@Roles('admin')`                    | real (read+create only; edit/delete unwired)            |
| `/console/groups` (Route Groups)                                               | Operator                                              | `role="admin"`              | AdminGuard `@Roles('admin')` (real CRUD exists) | **full-mock**                                           |
| `/console/official-prices`                                                     | Operator                                              | `role="admin"`              | AdminGuard `@Roles('admin')` (real CRUD exists) | **full-mock**                                           |
| `/console/dify` (Import)                                                       | Operator                                              | `role="admin"`              | AdminGuard `@Roles('admin')`                    | real for import; list/patch/delete unwired              |
| `/console/tenants`                                                             | Operator                                              | `role="admin"`              | AdminGuard `@Roles('admin')`                    | real                                                    |
| `/console/accounts`                                                            | Operator                                              | `role="admin"`              | AdminGuard `@Roles('admin')`                    | real (topup/create only; ledger/payments/codes unwired) |
| `/console/api-keys`                                                            | Operator                                              | `role="admin"`              | AdminGuard `@Roles('admin')`                    | real (mint/list only; group-bind/revoke unwired)        |
| `*`                                                                            | Public                                                | redirect to `/`             | none                                            | —                                                       |
| **(no frontend route)**                                                        | **Developer integrator**                              | —                           | `/v1/*` → ApiKeyGuard (`ak_...`/`x-api-key`)    | n/a — no UI by design                                   |

**Audience clarification:**

- **operator-admin** — owns all `/console/*` frontend; only audience with a shipped UI for managing the platform. Hard `@Roles('admin')` on the whole `AdminController`.
- **tenant-self-service** — `role==='user'`, owns a tenant+account. Full backend plane (`/console/*` API: own keys mint/list/rotate/disable, usage, models, self-topup) but the only frontend is the placeholder `/app`. **Biggest single product gap.**
- **developer-API** — programmatic `/v1/*` only; no UI of its own. Bootstraps from a human UI (operator mints a key today; tenant-self-service could in principle, but that UI doesn't exist).
- **public** — landing + login only.

**Sharp edges to design around:** (a) `ConsoleGuard` ignores `role`, so an admin with a tenant can call the tenant plane; (b) client-side role gating is advisory (JWT decoded, not verified) — every data path is re-guarded server-side, so route gating is cosmetic; (c) the `/console` path-prefix collision (operator frontend vs tenant backend API) must be disambiguated in any docs/onboarding copy.

---

## 2. ENDPOINT → PAGE COVERAGE MAP

### Endpoints actually consumed today

| Page                       | Endpoints consumed                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/login`                   | `POST /auth/login`, `POST /auth/register`, `GET /auth/oauth/:provider` (gated by `VITE_OAUTH_ENABLED`)                                                                                                                                                                                                                  |
| `/console/dashboard`       | `GET /admin/tenants`, `GET /admin/resources`, `GET /admin/jobs?tenantId&limit=8`                                                                                                                                                                                                                                        |
| `/console/catalog`         | 22 endpoints: `GET/POST/PATCH /admin/resources(/:id)`, `GET/POST/PATCH/DELETE /admin/resources/:id/channels(/:cid)`, `POST .../sync-models`, `GET/POST /admin/pricebook`, `GET/POST /admin/secrets`, `GET/POST/GET:name/PATCH/DELETE /admin/models`, `POST/GET/DELETE /admin/models/:name/grants`, `GET /admin/tenants` |
| `/console/modifiers`       | `GET /admin/modifiers`, `POST /admin/modifiers` (no Idempotency-Key sent)                                                                                                                                                                                                                                               |
| `/console/groups`          | **none real** — `mockBilling` only                                                                                                                                                                                                                                                                                      |
| `/console/official-prices` | **none real** — `mockBilling` only                                                                                                                                                                                                                                                                                      |
| `/console/dify`            | `POST /admin/dify/import` only                                                                                                                                                                                                                                                                                          |
| `/console/tenants`         | `GET /admin/tenants`, `POST /admin/tenants`                                                                                                                                                                                                                                                                             |
| `/console/accounts`        | `POST /admin/accounts`, `POST /admin/accounts/:id/topup`, `GET /admin/tenants`                                                                                                                                                                                                                                          |
| `/console/api-keys`        | `GET /admin/api-keys?tenantId`, `POST /admin/api-keys`, `GET /admin/tenants`                                                                                                                                                                                                                                            |

### CRITICAL — backend capabilities surfaced in NO page yet

| Capability / endpoint(s)                                                                              | Status                                                                                          | Recommendation: surface where                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`GET /admin/relay-traces`**                                                                         | Not in `admin.ts` at all (not even a client method); not mocked                                 | **NEW page or detail panel.** High operator value for debugging upstream calls (token-redacted request/response, latency, status, stream flag). Surface as a `/console/relay-traces` page under the **ops** nav group, filterable by `jobId`/`tenantId`/`providerType`/`channelId`/`from`/`to`. Also deep-link from a job row on the Dashboard and from a channel in Catalog. Needs a **trace/timeline viewer** primitive (see §5). |
| **`GET /admin/analytics/usage`** (`groupBy`, raw array)                                               | No client method, no page                                                                       | **NEW Analytics page** under **ops** (or a Dashboard tab). Powers charts grouped by day/model/tenant/channel/api_key. Needs a **chart** primitive (§5). Note the non-envelope raw-array shape.                                                                                                                                                                                                                                      |
| **`GET /admin/usage`** (global per-call `UsageLogView`, keyset)                                       | `listUsage` exists in `admin.ts`, **but no page renders it**                                    | Surface as a tab/table on the new Analytics page (the per-call detail behind the rollups). `useKeyset(qk.usage(params), …)`.                                                                                                                                                                                                                                                                                                        |
| **`GET /admin/ledger`** (keyset)                                                                      | `listLedger` exists, no page                                                                    | **Accounts page** — the transaction-ledger table the page notes already promise. `useKeyset(qk.ledger(tenantId), …)`, `STALE_VOLATILE`.                                                                                                                                                                                                                                                                                             |
| **`GET /admin/payments`** (keyset, separate controller)                                               | `listPayments` exists, no page                                                                  | **Accounts page** — payment-intents panel, tenant-scoped. `useKeyset(qk.payments(tenantId), …)`.                                                                                                                                                                                                                                                                                                                                    |
| **`POST /admin/redemption-codes`** (secret-returning, NOT idempotent) + `GET /admin/redemption-codes` | `generateCodes` exists, list endpoint has no client method, no page                             | **Accounts page** (or a small `/console/redemption-codes` page). Generator must show codes ONCE (do not cache plaintext). Add a `listRedemptionCodes` client method + a list table with `status` filter.                                                                                                                                                                                                                            |
| **`GET/POST/GET:id/DELETE /admin/secrets`**                                                           | `createSecret`/`listSecrets` exist; consumed only indirectly via `SecretSelect` inside Catalog  | A standalone **Secrets management page** under a settings/ops group would let operators view/revoke credentials independent of channel editing (today `DELETE /admin/secrets/:id` is unreachable from any UI). Lower priority than the billing pages.                                                                                                                                                                               |
| **`/admin/oauth-sessions` (+ codex login/start, login/complete)**                                     | No client method, no page, not mocked                                                           | **NEW OAuth-sessions page** (BYO subscription / codex login). Operator value for connecting upstream provider accounts. Surface under a connections/credentials group. The codex `login/start` → `authorize_url` flow needs a redirect + complete step UI. Secret-returning POSTs → never cache.                                                                                                                                    |
| **`GET /admin/jobs`**                                                                                 | `listJobs` exists; consumed only as the Dashboard "recent jobs" preview (`limit=8`, first page) | Promote to a full **Jobs page** (or Dashboard tab) with keyset pagination + filters, plus a job-detail drawer that links to relay-traces. Today the keyset cursor is discarded.                                                                                                                                                                                                                                                     |
| **`/admin/dify` (GET list), `PATCH /admin/dify/:resourceId`, `DELETE /admin/dify/:resourceId`**       | Only `difyImport` wired; list/patch/delete have no client method                                | Extend the **Dify page** to a two-tab layout (Import \| Imported bindings): add `difyList`/`difyUpdate`/`difyDelete` client methods, a binding table, edit Drawer, delete ConfirmDialog. Also add `TenantSelect` + `SecretSelect` to the import form (replace raw-uuid paste + wire optional `serviceKeyRef`).                                                                                                                      |
| **`PATCH /admin/api-keys/:id/group`, `DELETE /admin/api-keys/:id`**                                   | No client method; not wired in api-keys page                                                    | **API Keys page** — add group-bind picker (needs real `GET /admin/route-groups`) and a revoke row action. Also note `POST /admin/api-keys` already accepts `routeGroupId` at mint time (bind-on-create), not currently exposed.                                                                                                                                                                                                     |
| **`GET /admin/tenants/:id`, `PATCH /admin/tenants/:id`**                                              | No `getTenant`/`updateTenant` client methods                                                    | **Tenants page** — add a tenant detail view (read one tenant; inline-edit `isolationMode`) that deep-links to accounts/api-keys/grants for that tenant. (No tenant DELETE by design.)                                                                                                                                                                                                                                               |
| **`GET /admin/accounts/:id`**                                                                         | No `getAccount` client method                                                                   | **Accounts page** — re-fetch a balance by id without first creating the account.                                                                                                                                                                                                                                                                                                                                                    |
| **`/v1/*` developer plane** (chat/run/jobs/files/models/resources/payments/callbacks)                 | No frontend by design                                                                           | **Do NOT build a UI.** Surface as **documentation / code-snippets** only (e.g. on a future tenant home or a docs page): show the base URL, `ak_...` usage, OpenAI/Anthropic/Gemini-compatible curl examples. The only frontend touchpoint is key minting.                                                                                                                                                                           |
| **`/console/*` tenant self-service API** (own keys, usage, models, self-topup, payments/intents)      | No frontend (only placeholder `/app`)                                                           | **Build a real tenant home** (see §6 P1). This is a fully-implemented backend audience with zero client.                                                                                                                                                                                                                                                                                                                            |
| **`POST /auth/link/:provider`, `GET /auth/oauth/:provider/callback`**                                 | Not used                                                                                        | Optional — wire when OAuth SPA redirect handoff lands; not blocking.                                                                                                                                                                                                                                                                                                                                                                |

---

## 3. MOCK-vs-REAL GAP LIST (highest-value section)

Two pages are **100% mock** despite real backends now existing on this branch; several others are **real-but-incomplete** (wired path is real, but promised features are simply unbuilt — that is _missing UI_, not _mock data_). The per-page audits explicitly corrected `partial-mock` → `real` for Dify, Accounts, and API Keys: **the only pages reading mock data are Route Groups and Official Prices.**

### 3a. Route Groups (`/console/groups`) — `full-mock` → REAL available now

- **Today:** imports `listRouteGroups/createRouteGroup/updateRouteGroup/deleteRouteGroup/listGroupChannels/countGroupChannels/addGroupChannel/updateGroupChannel/removeGroupChannel/MOCK_CHANNELS` from `mockBilling.ts`; query keys `['mock','route-groups']` / `['mock','group-channels',id]`; renders `<MockBadge/>`; state resets on reload.
- **Real backend (exists on this branch):**
  - `GET/POST /admin/route-groups`, `GET/PATCH/DELETE /admin/route-groups/:id`
  - `GET /admin/route-groups/:id/channels`, **`PUT`** `/admin/route-groups/:id/channels/:channelId` (idempotent upsert — replaces BOTH mock `addGroupChannel` and `updateGroupChannel`), `DELETE` (hard-delete membership)
  - Channel roster from real `GET /admin/resources` + `GET /admin/resources/:id/channels` (replaces `MOCK_CHANNELS`)
- **Concrete migration actions:**
  1. Add client methods in `admin.ts`: `listRouteGroups`, `createRouteGroup(body, idempotencyKey?)`, `getRouteGroup`, `updateRouteGroup`, `deleteRouteGroup`, `listGroupChannels(groupId)`, `upsertGroupChannel(groupId, channelId, {priority?,weight?})` (PUT), `removeGroupChannel(groupId, channelId)`.
  2. Add `qk.routeGroups()` = `['admin','route-groups']` and `qk.groupChannels(id)` = `['admin','route-groups',id,'channels']` to `queryKeys.ts` (no entries exist today).
  3. Field remaps: body is camelCase (`groupRatioBps`, default `10000`), response is snake_case (`group_ratio_bps`). PUT membership defaults `priority=0`, `weight=1` (the mock seeded `priority=100,weight=100` — adjust seed expectations).
  4. Replace the channel-COUNT column: the mock used a synchronous `countGroupChannels`; the real `GET .../channels` returns a `PageEnvelope` — derive count from the cached membership query or make it a lazy/unfetched column (do NOT add a second sync read).
  5. Replace `MOCK_CHANNELS` add-picker with a per-resource picker (`GET /admin/resources` → `GET /admin/resources/:id/channels`).
  6. Send `Idempotency-Key` on `POST /admin/route-groups` (it's `@Idempotent`); PUT membership is NOT idempotent.
  7. Remove `<MockBadge/>`.

### 3b. Official Prices (`/console/official-prices`) — `full-mock` → REAL available now

- **Today:** imports `listOfficialPrices/createOfficialPrice/updateOfficialPrice/deleteOfficialPrice` from `mockBilling.ts`; key `['mock','official-prices']`; client-side `searchable`/`pageSize={20}` over a flat array; `<MockBadge/>`.
- **Real backend (exists on this branch):** `GET /admin/official-prices` (PageEnvelope, query `provider?/limit?/cursor?`), `POST` (`@Idempotent`), `PATCH /:id` (nullable-clearable; `provider`/`modelSlug` not patchable), `DELETE /:id` (204).
- **Concrete migration actions (note the unit + name remap — this is the tricky one):**
  1. Add client methods + `qk.officialPrices(params)` = `['admin','official-prices',{provider?}]`.
  2. **Name remap:** mock/local `OfficialModelPrice` is snake_case + integer µUSD/1M (`model_slug`, `input_price_per_1m`, `cached_input_price_per_1m`, `source_url`, `effective_at`). Real **create/update body is camelCase + HUMAN USD-per-1M** (`modelSlug`, `inputUsdPer1m`, `outputUsdPer1m`, `cachedInputUsdPer1m`, `sourceUrl`, `effectiveAt`); the service does `round(usd × 1e6)`. Response `OfficialPriceView` is snake_case µUSD strings. Drop the page's client-side `usdLabel` µUSD math; send human USD on write, parse µUSD strings on read.
  3. **`effectiveAt` format bug to fix on wiring:** real schema is `z.string().datetime()` (full ISO-8601), but the page's `DateField` emits bare `yyyy-mm-dd`, which fails `.datetime()` validation. Emit a full timestamp (e.g. append `T00:00:00Z`).
  4. Consume the `PageEnvelope` (cursor paging) instead of the flat array; keep refetch-on-success (no optimism needed for low-frequency catalog edits).
  5. `inputUsdPer1m`/`outputUsdPer1m` are **required** on create.
  6. Remove `<MockBadge/>`.

### 3c. Real-but-incomplete (no mock; just missing UI — wire the existing/near-existing endpoints)

| Page      | Real wired today                    | Missing UI (endpoint exists)                                                                                                   | Action                                                                                                                                                             |
| --------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Modifiers | list + create                       | edit/active-toggle (`PATCH /:id`), delete (`DELETE /:id`), detail (`GET /:id`)                                                 | Add edit Drawer + active Toggle + row delete; also start sending `Idempotency-Key` on create (route is `@Idempotent`). Bump `qk.modifiers()` to `STALE_REFERENCE`. |
| Dify      | import                              | binding list/edit/delete (`GET`/`PATCH`/`DELETE /admin/dify`), `TenantSelect`, `SecretSelect`, `serviceKeyRef`/`allowBlockers` | Two-tab page; add 3 client methods + `['admin','dify']` key; replace raw-uuid paste with `TenantSelect`.                                                           |
| Accounts  | create + topup                      | ledger table, payments panel, redemption-code generator, `getAccount` re-fetch                                                 | Wire `listLedger`/`listPayments` (keyset) + `generateCodes`; add `getAccount` client method.                                                                       |
| API Keys  | mint + list                         | group-bind picker (`PATCH /:id/group`), revoke (`DELETE /:id`), bind-on-create (`routeGroupId` in POST body)                   | Add `bindApiKeyGroup`/`revokeApiKey`/`listRouteGroups` client methods + group picker (depends on 3a real route-groups).                                            |
| Tenants   | list + create                       | tenant detail (`GET /:id`), inline `isolationMode` edit (`PATCH /:id`)                                                         | Add `getTenant`/`updateTenant` + detail view deep-linking to accounts/keys/grants. Also send `Idempotency-Key` on create.                                          |
| Dashboard | tenant/resource counts, recent jobs | full jobs/usage/analytics                                                                                                      | Counts use only `.length` of first keyset page (no totals exist) — acceptable, but link out to dedicated Jobs/Analytics pages.                                     |

---

## 4. CACHING STRATEGY

Current defaults (`query.ts`): `staleTime 15_000`, `retry 1`, `refetchOnWindowFocus false`, `gcTime` default 5min. Overrides: `STALE_REFERENCE = 60_000` (catalog/config), `STALE_VOLATILE = 10_000` (operational). `useKeyset` wraps `useInfiniteQuery` for cursor lists. Mutations carry no invalidation in `admin.ts`; the consuming page invalidates the matching `qk.*` in `onSuccess`. `mutationError(t)` is the standard `onError`.

### 4a. Query-key namespaces (all under `['admin', ...]`)

Existing: `tenants`, `resources`, `resources/:id/channels`, `pricebook/:id`, `modifiers`, `secrets`, `api-keys/:tenantId`, `jobs/:tenantId`, `models`, `models/:name`, `models/:name/grants`, `usage/:params`, `analytics-usage/:params`, `ledger/:tenantId`, `payments/:tenantId`.

**Add these (no entry exists today):**

- `qk.routeGroups()` = `['admin','route-groups']`
- `qk.groupChannels(id)` = `['admin','route-groups',id,'channels']`
- `qk.officialPrices(params)` = `['admin','official-prices',params]`
- `qk.dify()` = `['admin','dify']`
- `qk.relayTraces(params)` = `['admin','relay-traces',params]`
- `qk.redemptionCodes(params)` = `['admin','redemption-codes',params]`
- `qk.oauthSessions()` = `['admin','oauth-sessions']`
- (when tenant home ships, namespace under `['console', ...]` to keep operator vs tenant caches disjoint)

### 4b. staleTime tiers

| Tier                                     | staleTime               | Keys                                                                                                                                                                          |
| ---------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reference / catalog** (rarely changes) | `STALE_REFERENCE` (60s) | `tenants`, `resources`, `models`, `modifiers` (currently default 15s — **bump to 60s**), `routeGroups`, `groupChannels`, `officialPrices`, `secrets`, `dify`, `oauthSessions` |
| **Default**                              | 15s                     | `channels`, `pricebook`, `model(name)`, `modelGrants`, `apiKeys`                                                                                                              |
| **Volatile / operational**               | `STALE_VOLATILE` (10s)  | `jobs`, `usage`, `analyticsUsage`, `ledger`, `payments`, `relayTraces`                                                                                                        |

Use `keepPreviousData` (already done for jobs/api-keys) on any filter-driven list so the table doesn't flash on filter change.

### 4c. Invalidation rules per mutation

| Mutation                                                   | Invalidate                                               |
| ---------------------------------------------------------- | -------------------------------------------------------- |
| createTenant / updateTenant                                | `qk.tenants()` (+ tenant detail key)                     |
| createAccount / topup                                      | account-detail key + `qk.ledger(tenantId)` (after topup) |
| createApiKey / revokeApiKey / bindApiKeyGroup              | `qk.apiKeys(tenantId)`                                   |
| createResource / updateResource                            | `qk.resources()`                                         |
| createChannel / updateChannel / deleteChannel / syncModels | `qk.channels(resourceId)` (sync also → `qk.models()`)    |
| createPricebook                                            | `qk.pricebook(resourceId)`                               |
| createModifier / updateModifier / deleteModifier           | `qk.modifiers()`                                         |
| createModel / updateModel / deleteModel                    | `qk.models()` (+ `qk.model(name)`)                       |
| grantModel / revokeModelGrant                              | `qk.modelGrants(name)`                                   |
| createRouteGroup / update / delete                         | `qk.routeGroups()`                                       |
| upsertGroupChannel / removeGroupChannel                    | `qk.groupChannels(groupId)` (+ recompute count)          |
| createOfficialPrice / update / delete                      | `qk.officialPrices()` (all param variants)               |
| difyImport / difyUpdate / difyDelete                       | `qk.dify()`                                              |
| createSecret / deleteSecret                                | `qk.secrets()`                                           |

Prefer **invalidate the key** over storing the mutation return value (the convention is already this; keep it). The shared TopBar refresh button calls `qc.invalidateQueries()` globally — fine as an escape hatch.

### 4d. What NOT to cache

- **One-shot plaintext secrets:** `POST /admin/api-keys` `{plaintext}`, `POST/PATCH /console/api-keys` rotate, `POST /admin/redemption-codes` `{codes}`. Hold in local `useState`, surface once (CopyField), never write to the query cache. These POSTs are deliberately NOT `@Idempotent` — never send an `Idempotency-Key` and never replay.
- **Other secret-returning POSTs:** `POST /admin/secrets`, `/admin/oauth-sessions` (+ codex login/start/complete) — material/tokens never returned; don't cache.
- **Presigned URLs:** `POST /v1/files/presign-upload` `{upload_url}` and `GET /v1/files/:id/url` `{url, expires_in}` — time-limited; never cache, re-request on demand (only relevant once a files UI exists).
- **One-shot import reports:** `POST /admin/dify/import` `DifyImportView` (compat report tied to a specific run) — keep in local state, not the query cache (page already does this).
- **codex `login/start` `{authorize_url, state}`** — single-use PKCE; ephemeral.
- **Topup response `{account_id, balance}`** — merge into local account state, don't persist as a query.

---

## 5. DESIGN-SYSTEM COVERAGE & GAPS

### Reused well (no new primitives needed for the §3 migrations)

- **Layout chrome:** `ConsoleLayout` + slot contexts (`useSetConsoleAction/Filters/Back`), `Rail`/`SubNav`/`TopBar`/`BottomTabs`, responsive at `BP.md` (768px). New pages drop into existing nav groups (ops/catalog/billing/tenants).
- **Tables/cards:** `DataTable` (sort, client-pagination via `Pager`, search, selection+bulk, column-toggle, sticky pins, mobile stacked cards) and `CardCollection`/`EntityCard` cover every list page. The billing migrations are pure data-source swaps — the table/card UI already exists.
- **Forms:** `Modal`/`Drawer`/`ConfirmDialog`, `TextField`/`NumberField`/`SelectField`/`ComboboxField`/`ChipsField`/`JsonField`/`KeyValueEditor`, `Toggle`/`Checkbox`, `FormField`+`useFieldId`. Domain composites: `TenantSelect`, `SecretSelect`, `CapabilitiesField`, `IoSchemaField`, `PricebookSpecForm`.
- **Money discipline:** `Money` (BigInt µcredit → human credits, no float) — reuse for ledger/payments/account balances.
- **Status:** `StatusBadge` + `statusTone()` maps backend enums; reuse for ledger types, payment status, dify `has_blockers`/`pricing_model`, relay-trace status.
- **Secrets:** `CopyField` (one-time copy), `MockBadge` (remove on real switch).
- **Loaders/motion/theme:** `RoseLoader`/`LoadingScreen`, GSAP tokens + reduced-motion gating, warm-amber token system. All robust.

### MISSING primitives the upcoming pages need

| Needed by                                           | Missing primitive                                                                | Notes                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Analytics page** (`/admin/analytics/usage`)       | **Chart component** (bar/line/area; grouped by day/model/tenant/channel/api_key) | None exists in the design system today. Must respect the warm-amber palette ("never blue"), reduced-motion, light/dark tokens, and `.tabular` numerics. Consumes a raw array (not an envelope) of `UsageRollupView` with decimal-string token/cost sums — chart math must avoid naive `Number()` on large strings. Highest-effort new primitive. |
| **Relay-traces page/panel** (`/admin/relay-traces`) | **Trace / request-detail viewer** (timeline or expandable request↔response pane) | Needs a redacted request/response body viewer (monospace, possibly JSON-pretty), latency display, stream/truncated flags, status pill. Could compose `DataTable` (list) + a `Drawer` with a structured body viewer. The body viewer (collapsible headers + pretty-printed redacted body) is the genuinely new piece.                             |
| **Tenant home** (`/app`, tenant self-service)       | **Balance / credits widget**                                                     | A prominent credit-balance + held-credits card (reuse `Money`), plus a self-topup action and a compact usage sparkline. The `StatCard` (GSAP count-up) is a starting point but a dedicated balance widget with topup CTA is new.                                                                                                                 |
| **Tenant home + Accounts**                          | **Mini usage chart / sparkline**                                                 | Smaller cousin of the analytics chart; could be the same primitive at a smaller size.                                                                                                                                                                                                                                                            |
| **Dify bindings, redemption codes, oauth-sessions** | none new                                                                         | Compose existing `DataTable`/`Drawer`/`ConfirmDialog`/`Tabs`/`Toggle`/`StatusBadge`. (`Tabs` and `Toggle` already exist — the Dify audit under-credited them.)                                                                                                                                                                                   |

The chart primitive and the trace viewer are the only two genuinely new design-system pieces; everything else is composition of existing primitives.

---

## 6. PRIORITIZED RECOMMENDATIONS

Ranked by value/effort. Each lists page · action · endpoint(s).

### P0 — De-mock the two pages whose backend already shipped on this branch

1. **Route Groups → real backend.** Page `/console/groups`. Swap `mockBilling` for real client methods; add `qk.routeGroups()`/`qk.groupChannels(id)`; PUT-upsert membership; per-resource channel picker; send Idempotency-Key on create; drop `MockBadge`. Endpoints: `GET/POST/PATCH/DELETE /admin/route-groups(/:id)`, `GET /admin/route-groups/:id/channels`, `PUT`/`DELETE .../channels/:channelId`, `GET /admin/resources(/:id/channels)`.
2. **Official Prices → real backend.** Page `/console/official-prices`. Swap mock; add `qk.officialPrices`; **remap units (µUSD↔human USD) and field names (snake↔camel)**; fix `effectiveAt` to full ISO; consume `PageEnvelope`; drop `MockBadge`. Endpoints: `GET/POST/PATCH/DELETE /admin/official-prices(/:id)`.
3. **API Keys: group-bind + revoke.** Page `/console/api-keys`. Add `bindApiKeyGroup`/`revokeApiKey`/`listRouteGroups` client methods; group picker (depends on #1) + revoke row action; optionally bind-on-create via `routeGroupId`. Endpoints: `PATCH /admin/api-keys/:id/group`, `DELETE /admin/api-keys/:id`, `GET /admin/route-groups`. (#1 unblocks the real picker.)

### P1 — Surface fully-built backend capabilities with no UI

4. **Tenant self-service home** (replace placeholder `/app`). The entire `/console/*` tenant API is unbuilt on the client. Build: balance/credits widget (new primitive), own-key mint/list/rotate/disable, usage (jobs+ledger), self-topup. Endpoints: `GET /console/usage`, `GET/POST /console/api-keys`, `POST /console/api-keys/:id/rotate`, `DELETE /console/api-keys/:id`, `GET /console/models`, `POST /console/payments/intents`. (Largest scope; highest product value for audience (b).)
5. **Accounts: ledger + payments + redemption codes.** Page `/console/accounts`. Wire `listLedger`/`listPayments` (keyset) into tables; add redemption-code generator (show codes once, never cache); add `getAccount`. Endpoints: `GET /admin/ledger`, `GET /admin/payments`, `POST /admin/redemption-codes`, `GET /admin/accounts/:id`.
6. **Dify: bindings tab.** Page `/console/dify`. Add `difyList`/`difyUpdate`/`difyDelete` + `['admin','dify']` key; two-tab layout (Import \| Imported); add `TenantSelect`/`SecretSelect` to import form; wire optional `serviceKeyRef`/`allowBlockers`. Endpoints: `GET /admin/dify`, `PATCH /admin/dify/:resourceId`, `DELETE /admin/dify/:resourceId`, `GET /admin/tenants`, `GET /admin/secrets`.
7. **Modifiers: edit / delete / active-toggle.** Page `/console/modifiers`. Add edit Drawer + delete + active Toggle; send Idempotency-Key on create; bump `qk.modifiers()` to `STALE_REFERENCE`. Endpoints: `GET/PATCH/DELETE /admin/modifiers/:id`.

### P2 — New operator pages that need new primitives

8. **Analytics / Usage page** (new, under ops). Build the **chart primitive**; grouped rollups + per-call usage table. Endpoints: `GET /admin/analytics/usage` (raw array), `GET /admin/usage` (keyset). New `qk.analyticsUsage`/`qk.usage` already exist as factories.
9. **Relay-traces page/panel** (new, under ops). Build the **trace viewer**; filterable table + redacted request/response Drawer; deep-link from job rows. Endpoint: `GET /admin/relay-traces`. Add client method + `qk.relayTraces`.
10. **Jobs page** (new or Dashboard tab). Promote the Dashboard's `limit=8` preview to a full keyset-paginated jobs view with filters + job-detail drawer linking to relay-traces. Endpoint: `GET /admin/jobs`.
11. **OAuth sessions + Secrets management** (new, credentials/connections group). OAuth-sessions page (BYO + codex login/start→complete flow) and a standalone secrets list with revoke (today `DELETE /admin/secrets/:id` is unreachable). Endpoints: `GET/POST/DELETE /admin/oauth-sessions` (+ codex `login/start`,`login/complete`), `GET/DELETE /admin/secrets`. Never cache secret-returning responses.
12. **Tenants detail view.** Page `/console/tenants`. Add `getTenant`/`updateTenant`; detail panel with inline `isolationMode` edit, deep-linking to that tenant's accounts/keys/grants. Endpoints: `GET/PATCH /admin/tenants/:id`.
13. **Developer-plane docs surface (not a UI).** Provide curl/SDK snippets for `/v1/*` (chat/run/jobs/files/models) keyed off a minted `ak_...`, e.g. on the tenant home or a docs page. No interactive `/v1` UI by design.

---

### Cross-cutting gotchas to enforce in every new binding

- Pagination is **cursor/keyset only** (`{data, next_cursor, has_more}`) — build "load more", never page numbers/totals. Two exceptions: `GET /admin/analytics/usage` (raw array) and `GET /console/usage` (`{jobs, ledger}` with separate `jobs_cursor`/`ledger_cursor`).
- All money is **decimal strings** (µcredits / µUSD-per-1M / amount_minor) — parse as big-decimal (`Money`/BigInt), never naive `Number()`.
- `group_ratio_bps` is an **integer (bps, 10000=1.0×)**, a plain number, not a money string.
- Console DELETE returns **200 `{id, status:'disabled'}`**; admin DELETE returns **204** — handle both.
- Send `Idempotency-Key` only on the non-secret admin POSTs marked `@Idempotent`; never on secret-returning POSTs.
- 401 from any call triggers the global `onUnauthorized()` (logout/redirect) — already wired in `client.ts`.

---

# Part II — Inventories

## A. Backend API Surface

# Actionow Backend HTTP API Surface (branch `feat/billing-group-routing`)

Source root: `/Users/alienworm/actionow-core/apps/api/src`. NestJS. All money is bigint µcredits serialized as **decimal strings** (never floats). Controllers convert HUMAN credits → µcredits on write; the JSON `*View` shapes are snake_case.

---

## 0. CROSS-CUTTING CONVENTIONS (frontend MUST bind to these)

### 0.1 Uniform LIST pagination envelope — KEYSET/CURSOR (NOT page/pageSize/total)

Defined in `/Users/alienworm/actionow-core/apps/api/src/common/pagination.ts`. Every paginated `GET` returns exactly:

```ts
interface PageEnvelope<T> {
  data: T[]; // the page of rows, already trimmed to `limit`
  next_cursor: string | null; // opaque base64url cursor for the next page; null when no more
  has_more: boolean; // true iff a further page exists
}
```

- There is **NO** `page`, `pageSize`, `total`, `count`, or `offset`. It is cursor/keyset only. Do not expect a total count anywhere.
- Request params (query string, all optional): `cursor` (opaque base64url token, pass back verbatim) and `limit`.
- `limit` is clamped server-side to `[1, 200]`; **default 50** when absent or NaN.
- The cursor encodes `"<created_at_iso>|<id>"` base64url; a malformed cursor → `400 invalid_input`. Frontend must treat it as opaque.
- Some list endpoints carry **extra named cursors** rather than the bare `cursor` (e.g. `GET /console/usage` uses `jobs_cursor` + `ledger_cursor`; relay-traces/redemption-codes/official-prices accept `limit`+`cursor` alongside filter params — see each).
- A bounded/non-cursored list (e.g. `GET /console/models`, `GET /admin/analytics/usage` is a raw array — see note) still returns the envelope with `next_cursor: null`, `has_more: false`. EXCEPTION: `GET /admin/analytics/usage` returns a **raw array** `UsageRollupView[]`, NOT an envelope.

### 0.2 Idempotency-Key header

- Header name: **`Idempotency-Key`** (case-insensitive; read as `idempotency-key`). Interceptor: `common/idempotency.interceptor.ts`.
- Only acts on **POST** routes explicitly marked `@Idempotent()` AND carrying a non-empty `Idempotency-Key`. A duplicate POST with the same key replays the first successful response body verbatim.
- **Secret-returning POSTs are deliberately NOT idempotent** (no caching of plaintext): `POST /admin/api-keys`, `/admin/secrets`, `/admin/oauth-sessions` (+ codex `login/start`, `login/complete`), `/admin/redemption-codes`. These ignore the header.
- Idempotent admin POSTs (frontend may safely retry with a key): create tenant, create account, account topup, create resource, create channel, sync-models, create pricebook, create modifier, create model, grant model, create official-price, create route-group, and `POST /admin/dify/import`.

### 0.3 Soft-delete & credential-revoke semantics

- `DELETE` returns **204 No Content** on the admin/dify surfaces (soft-delete) unless noted.
- Soft-deletes (row hidden, name/slug freed for reuse, drops out of routing): channels, pricebook, modifiers, models (stops routing), official-prices (frees `(provider,slug)`), route-groups (frees name), dify bindings.
- Credential-revoke (soft-delete + resolution returns undefined afterward): `DELETE /admin/api-keys/:id` (key then rejected with 401), `DELETE /admin/secrets/:id`, `DELETE /admin/oauth-sessions/:id`.
- **Hard-deletes** (membership rows): `DELETE /admin/models/:name/grants/:tenantId`, `DELETE /admin/route-groups/:id/channels/:channelId`.
- There is intentionally **NO** tenant DELETE and **NO** account PATCH/DELETE (balance is ledger-owned, moves only via topup/settle).

### 0.4 Error envelope

All errors render the unified §4.7 envelope via `UnifiedErrorFilter`. Common codes: `invalid_input`→400, `unauthorized`→401, `insufficient_credits`→402, `resource_not_found`→404, `content_filtered`→422, `internal_error`→500.

---

## 1. OPERATOR ADMIN API — `/admin/*`

Guard: `AdminGuard` + `@Roles('admin')` on every route. Auth = **admin JWT** via `Authorization: Bearer <jwt>` (obtained from `/admin/auth/login`, §4). Controllers: `admin/admin.controller.ts`, `admin/admin-dify.controller.ts`, `payments/admin-payments.controller.ts`. The whole `AdminController` is wrapped in `@UseInterceptors(IdempotencyInterceptor)`.

### 1.1 Tenants

| Method+Path                | Params / Body                                     | Response                     | Notes                                       |
| -------------------------- | ------------------------------------------------- | ---------------------------- | ------------------------------------------- | ------------------ | ------------- |
| `POST /admin/tenants`      | body: `{ name (required), isolationMode?: 'field' | 'schema'                     | 'db' }`                                     | `201` `TenantView` | `@Idempotent` |
| `GET /admin/tenants`       | query: `cursor?`, `limit?`                        | `PageEnvelope<TenantView>`   |                                             |
| `GET /admin/tenants/:id`   | path: `id`                                        | `TenantView` (404 if absent) |                                             |
| `PATCH /admin/tenants/:id` | path: `id`; body: `{ isolationMode? }`            | `TenantView`                 | only `isolationMode` mutable; **no DELETE** |

`TenantView`: `{ id, name, isolation_mode, created_at }`.

### 1.2 Accounts (+ topup)

| Method+Path                      | Params / Body                                                                 | Response                                                     | Notes           |
| -------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------- |
| `POST /admin/accounts`           | body: `{ tenantId (uuid), credits?: number }` (HUMAN credits opening balance) | `201` `AccountView`                                          | `@Idempotent`   |
| `POST /admin/accounts/:id/topup` | path: `id`; body: `{ credits: number>0 }`                                     | `200` `{ account_id, balance }` (`balance` = µcredit string) | `@Idempotent`   |
| `GET /admin/accounts/:id`        | path: `id`                                                                    | `AccountView` (404 if absent)                                | no PATCH/DELETE |

`AccountView`: `{ id, tenant_id, credit_balance (µcredit string), credit_held (µcredit string), created_at }`.

### 1.3 API keys (+ group bind)

| Method+Path                       | Params / Body                                                                                     | Response                     | Notes                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------- | -------------------------------------------- |
| `POST /admin/api-keys`            | body: `{ tenantId (uuid), resourceAllowlist?: string[], rateLimit?: int>0, routeGroupId?: uuid }` | `201` `{ id, plaintext }`    | **plaintext returned ONCE**; NOT idempotent |
| `GET /admin/api-keys`             | query: `tenantId` (required), `cursor?`, `limit?`                                                 | `PageEnvelope<ApiKeyView>`   | no hashes                                   |
| `PATCH /admin/api-keys/:id/group` | path: `id`; body: `{ routeGroupId: uuid                                                           | null }` (required, nullable) | `{ id, route_group_id }`                    | uuid binds, `null` unbinds → `default` group |
| `DELETE /admin/api-keys/:id`      | path: `id`                                                                                        | `204`                        | **revoke/soft-delete**; key → 401 after     |

`ApiKeyView`: `{ id, tenant_id, resource_allowlist: string[], rate_limit: number|null, status, route_group_id: string|null, created_at }`.

### 1.4 Secrets (encrypted credentials)

| Method+Path                 | Params / Body                        | Response                             | Notes                                   |
| --------------------------- | ------------------------------------ | ------------------------------------ | --------------------------------------- |
| `POST /admin/secrets`       | body: `{ value (required), label? }` | `201` `{ id, provider, created_at }` | material NEVER returned; NOT idempotent |
| `GET /admin/secrets`        | query: `cursor?`, `limit?`           | `PageEnvelope<SecretMetadataView>`   | metadata only, NO material              |
| `GET /admin/secrets/:id`    | path: `id`                           | `SecretMetadataView` (404)           |                                         |
| `DELETE /admin/secrets/:id` | path: `id`                           | `204`                                | revoke/soft-delete                      |

`SecretMetadataView`: `{ id, provider, locator, created_at, updated_at }`. `id` is usable as a channel `credentialRef`.

### 1.5 OAuth sessions (BYO subscription + codex login)

| Method+Path                                       | Params / Body                                                                                                                                      | Response                             | Notes                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------- |
| `POST /admin/oauth-sessions`                      | body: `{ providerKind: 'codex-oauth', authJson: {access_token,refresh_token,id_token?,expires_in?,...passthrough}, acknowledgeUpstreamTos: true }` | `201` `OAuthSessionView`             | tokens never returned; NOT idempotent |
| `GET /admin/oauth-sessions`                       | query: `cursor?`, `limit?`                                                                                                                         | `PageEnvelope<OAuthSessionListView>` | token-free                            |
| `DELETE /admin/oauth-sessions/:id`                | path: `id`                                                                                                                                         | `204`                                | revoke/soft-delete                    |
| `POST /admin/oauth-sessions/codex/login/start`    | body: `{ acknowledgeUpstreamTos: true }`                                                                                                           | `200` `{ authorize_url, state }`     | sealed PKCE state; NOT idempotent     |
| `POST /admin/oauth-sessions/codex/login/complete` | body: `{ acknowledgeUpstreamTos: true, code, state, accountLabel? }`                                                                               | `201` `OAuthSessionView`             | tokens never returned; NOT idempotent |

`OAuthSessionView`: `{ id, provider_kind, account_label: string|null, account_id: string|null }`. `OAuthSessionListView` adds `{ status, expires_at: string|null, last_refresh_at: string|null }`. `id` = secret_ref id usable as channel `credentialRef`.

### 1.6 Resources (+ channels + sync-models)

| Method+Path                                                 | Params / Body                                                                                                                      | Response                                                                                        | Notes                                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------- | ------- | ----------------------------------------------------------------------- | -------------------- | ------------- |
| `POST /admin/resources`                                     | body: `{ id, tenantId (uuid), kind: 'model'                                                                                        | 'workflow', modality: 'text'                                                                    | 'image'                                                                                     | 'video'                                      | 'audio' | 'composite', providerType, execModes: string[]≥1, ioSchema, version? }` | `201` `ResourceView` | `@Idempotent` |
| `GET /admin/resources`                                      | query: `cursor?`, `limit?`                                                                                                         | `PageEnvelope<ResourceView>`                                                                    |                                                                                             |
| `GET /admin/resources/:id`                                  | path: `id`                                                                                                                         | `ResourceView` (404)                                                                            |                                                                                             |
| `PATCH /admin/resources/:id`                                | path: `id`; body: `{ status?: 'active'                                                                                             | 'disabled' }`                                                                                   | `ResourceView`                                                                              | only `status` mutable (key fields immutable) |
| `POST /admin/resources/:id/channels`                        | path: `id`; body: `{ providerType, credentialRef?(uuid), endpoint?, model?, proxyRef?, config?(record), weight?(int>0), status? }` | `201` `ChannelView`                                                                             | `@Idempotent`                                                                               |
| `GET /admin/resources/:id/channels`                         | path: `id`; query: `cursor?`, `limit?`                                                                                             | `PageEnvelope<ChannelView>`                                                                     | incl. disabled                                                                              |
| `GET /admin/resources/:id/channels/:channelId`              | path: `id`,`channelId`                                                                                                             | `ChannelView` (channel∉resource → 404)                                                          |                                                                                             |
| `PATCH /admin/resources/:id/channels/:channelId`            | body: all-optional `{ credentialRef?(uuid                                                                                          | null), endpoint?(null), model?(null), proxyRef?(null), config?(null), weight?, status? }`       | `ChannelView`                                                                               | nullable fields clearable                    |
| `DELETE /admin/resources/:id/channels/:channelId`           | path                                                                                                                               | `204`                                                                                           | soft-delete (channel∉resource → 404)                                                        |
| `POST /admin/resources/:id/channels/:channelId/sync-models` | body: `{ defaultInputPrice?(int≥0 µUSD/1M), defaultOutputPrice?(int≥0 µUSD/1M) }`                                                  | `200` `{ resource_id, created: string[], updated: string[], total, summary: {name, priced}[] }` | `@Idempotent`; when both prices omitted, unmatched model created `disabled`+`needs_pricing` |

`ResourceView`: `{ id, tenant_id, kind, modality, provider_type, exec_modes: string[], status, current_version, created_at }`.
`ChannelView`: `{ id, resource_id, provider_type, credential_ref: string|null, endpoint: string|null, model: string|null, proxy_ref: string|null, config: object|null, weight, status }`.

### 1.7 Pricebook

| Method+Path                   | Params / Body                                                                     | Response                      | Notes       |
| ----------------------------- | --------------------------------------------------------------------------------- | ----------------------------- | ----------- | --------- | ---------------------------- | --------------------------------------------------------------------------- | --------------------- | ------------- |
| `POST /admin/pricebook`       | body: `{ resourceId, resourceVersion(int>0), version(int>0), method: 'unit'       | 'matrix'                      | 'fixed'     | 'formula' | 'passthrough', timing: 'pre' | 'post', spec, fixedCredits?(HUMAN→µcredit spec.amount), markup?, active? }` | `201` `PricebookView` | `@Idempotent` |
| `GET /admin/pricebook`        | query: `resourceId` (required), `cursor?`, `limit?`                               | `PageEnvelope<PricebookView>` |             |
| `GET /admin/pricebook/:id`    | path: `id`                                                                        | `PricebookView` (404)         |             |
| `PATCH /admin/pricebook/:id`  | body all-optional: `{ method?, timing?, spec?, fixedCredits?, markup?, active? }` | `PricebookView`               |             |
| `DELETE /admin/pricebook/:id` | path: `id`                                                                        | `204`                         | soft-delete |

`PricebookView`: `{ id, resource_id, resource_version, version, method, timing, spec, markup, active }`.

### 1.8 Modifiers

| Method+Path                   | Params / Body                                                                         | Response                     | Notes                 |
| ----------------------------- | ------------------------------------------------------------------------------------- | ---------------------------- | --------------------- | ------------------------------------------------ | ------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------- |
| `POST /admin/modifiers`       | body: `{ scope (e.g. 'global'                                                         | 'tenant:<id>'                | 'capability:<id>'     | 'resource:<id>'), whenExpr?, op: 'override_rate' | 'percent_off' | 'flat_off' | 'percent_add', value?(percent int OR HUMAN credits for credit-ops), stackable?, priority?(int), version?, active? }` | `201` `ModifierView` | `@Idempotent` |
| `GET /admin/modifiers`        | query: `cursor?`, `limit?`                                                            | `PageEnvelope<ModifierView>` |                       |
| `GET /admin/modifiers/:id`    | path: `id`                                                                            | `ModifierView` (404)         |                       |
| `PATCH /admin/modifiers/:id`  | body all-optional: `{ whenExpr?(null), op?, value?, stackable?, priority?, active? }` | `ModifierView`               | `scope` NOT patchable |
| `DELETE /admin/modifiers/:id` | path: `id`                                                                            | `204`                        | soft-delete           |

`ModifierView`: `{ id, scope, when_expr: string|null, op, value: string|null (µcredit or whole-percent), stackable, priority, version, active }`.

### 1.9 Models (+ grants)

| Method+Path                                   | Params / Body                                                                                                         | Response                                                                | Notes                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------- | ------------- |
| `POST /admin/models`                          | body: `{ name, resourceId, display?, modality?(def 'chat'), capabilities?(record<string,bool>), visibility?: 'public' | 'tenant', inputPrice?(int µcredit/token), outputPrice?(int), status? }` | `201` `ModelView`          | `@Idempotent` |
| `GET /admin/models`                           | query: `cursor?`, `limit?`                                                                                            | `PageEnvelope<ModelView>`                                               |                            |
| `GET /admin/models/:name`                     | path: `name`                                                                                                          | `ModelView` (404)                                                       | keyed by **name**          |
| `PATCH /admin/models/:name`                   | body all-optional: `{ display?(null), capabilities?, inputPrice?, outputPrice?, visibility?, status? }`               | `ModelView`                                                             |                            |
| `DELETE /admin/models/:name`                  | path: `name`                                                                                                          | `204`                                                                   | soft-delete; stops routing |
| `POST /admin/models/:name/grants`             | path: `name`; body: `{ tenantId (uuid) }`                                                                             | `201` `{ ok: true }`                                                    | `@Idempotent`              |
| `GET /admin/models/:name/grants`              | path: `name`; query: `cursor?`, `limit?`                                                                              | `PageEnvelope<ModelGrantView>`                                          | 404 if model unknown       |
| `DELETE /admin/models/:name/grants/:tenantId` | path                                                                                                                  | `204`                                                                   | **hard-delete** grant      |

`ModelView`: `{ id, name, display: string|null, modality, capabilities: Record<string,bool>, visibility, resource_id, input_price (string), output_price (string), status, created_at }`. `ModelGrantView`: `{ id, model_id, tenant_id, created_at }`.

### 1.10 Jobs / Ledger (read-only, keyset)

| Method+Path         | Params / Body                                     | Response                   |
| ------------------- | ------------------------------------------------- | -------------------------- |
| `GET /admin/jobs`   | query: `tenantId` (required), `cursor?`, `limit?` | `PageEnvelope<JobView>`    |
| `GET /admin/ledger` | query: `tenantId` (required), `cursor?`, `limit?` | `PageEnvelope<LedgerView>` |

Admin `JobView`: `{ job_id, tenant_id, resource_id, status, exec_mode, cost: string|null, created_at }`.
`LedgerView`: `{ id, tenant_id, account_id, type, credits_delta (string), balance_after (string), resource_id: string|null, job_id: string|null, created_at }`.

### 1.11 Redemption codes

| Method+Path                    | Params / Body                                                        | Response                                           | Notes                              |
| ------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------- | --- |
| `POST /admin/redemption-codes` | body: `{ count(1..1000), creditsPerCode(HUMAN>0), expiresAt?(ISO) }` | `201` `{ codes: string[], credit_amount: string }` | NOT idempotent (secret-returning)  |
| `GET /admin/redemption-codes`  | query: `status?: 'unused'                                            | 'redeemed'`, `limit?`, `cursor?`                   | `PageEnvelope<RedemptionCodeView>` |     |

`RedemptionCodeView`: `{ code, credit_amount (string), status, redeemed_by_tenant: string|null, redeemed_at: string|null, expires_at: string|null, created_at }`.

### 1.12 Official model prices (Track 2 catalog)

| Method+Path                         | Params / Body                                                                                                                                                                    | Response                          | Notes                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------- |
| `POST /admin/official-prices`       | body: `{ provider, modelSlug, displayName?, inputUsdPer1m(HUMAN USD>0), outputUsdPer1m, cachedInputUsdPer1m?, sourceUrl?(url), effectiveAt?(ISO), notes? }`                      | `201` `OfficialPriceView`         | `@Idempotent`; `(provider,slug)` unique; USD→µUSD/1M in service |
| `GET /admin/official-prices`        | query: `provider?`, `limit?`, `cursor?`                                                                                                                                          | `PageEnvelope<OfficialPriceView>` |                                                                 |
| `GET /admin/official-prices/:id`    | path: `id`                                                                                                                                                                       | `OfficialPriceView` (404)         |                                                                 |
| `PATCH /admin/official-prices/:id`  | body all-optional, nullable-clearable: `{ displayName?(null), inputUsdPer1m?, outputUsdPer1m?, cachedInputUsdPer1m?(null), sourceUrl?(null), effectiveAt?(null), notes?(null) }` | `OfficialPriceView`               | `provider`/`modelSlug` NOT patchable                            |
| `DELETE /admin/official-prices/:id` | path: `id`                                                                                                                                                                       | `204`                             | soft-delete; frees `(provider,slug)`                            |

`OfficialPriceView`: `{ id, provider, model_slug, display_name: string|null, input_price_per_1m (µUSD string), output_price_per_1m (string), cached_input_price_per_1m: string|null, source_url: string|null, effective_at: string|null, notes: string|null, updated_by: string|null, created_at, updated_at }`.

### 1.13 Route groups (分组, Track 3) (+ channel membership)

| Method+Path                                          | Params / Body                                                                                        | Response                              | Notes                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------- |
| `POST /admin/route-groups`                           | body: `{ name, groupRatioBps?(int>0, default 10000 = 1.0×), description?, status? }`                 | `201` `RouteGroupView`                | `@Idempotent`; name unique among live       |
| `GET /admin/route-groups`                            | query: `cursor?`, `limit?`                                                                           | `PageEnvelope<RouteGroupView>`        |                                             |
| `GET /admin/route-groups/:id`                        | path: `id`                                                                                           | `RouteGroupView` (404)                |                                             |
| `PATCH /admin/route-groups/:id`                      | body all-optional: `{ name?, groupRatioBps?, status?, description?(null) }`                          | `RouteGroupView`                      |                                             |
| `DELETE /admin/route-groups/:id`                     | path: `id`                                                                                           | `204`                                 | soft-delete; frees name; drops from routing |
| `PUT /admin/route-groups/:id/channels/:channelId`    | path: `id`,`channelId`; body: `{ priority?(int, def 0; HIGHER=tried first), weight?(int>0, def 1) }` | `RouteGroupChannelView`               | **PUT** = idempotent upsert of membership   |
| `GET /admin/route-groups/:id/channels`               | path: `id`; query: `cursor?`, `limit?`                                                               | `PageEnvelope<RouteGroupChannelView>` |                                             |
| `DELETE /admin/route-groups/:id/channels/:channelId` | path                                                                                                 | `204`                                 | **hard-delete** membership                  |

`RouteGroupView`: `{ id, name, group_ratio_bps: number (bps, 10000=1.0×), status, description: string|null, created_at, updated_at }`.
`RouteGroupChannelView`: `{ group_id, channel_id, priority: number, weight: number, created_at }`.

### 1.14 Usage / Relay traces / Analytics

| Method+Path                  | Params / Body                                                                                                             | Response                       | Notes                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------- | --------- | ---------------------------------------------------------- | ---------------------------------------------------- | --- |
| `GET /admin/usage`           | query: `cursor?`, `limit?`                                                                                                | `PageEnvelope<UsageLogView>`   | global per-call log, all tenants |
| `GET /admin/relay-traces`    | query (all optional): `jobId?`, `tenantId?`, `providerType?`, `channelId?`, `from?(ISO)`, `to?(ISO)`, `limit?`, `cursor?` | `PageEnvelope<RelayTraceView>` | token-redacted                   |
| `GET /admin/analytics/usage` | query: `groupBy: 'day'                                                                                                    | 'model'                        | 'tenant'                         | 'channel' | 'api_key'`(required),`tenantId?`, `from?(ISO)`, `to?(ISO)` | **`UsageRollupView[]` (RAW ARRAY, not an envelope)** |     |

`UsageLogView`: `{ id, tenant_id, model, input_tokens: number, output_tokens: number, cost (string), latency_ms: number|null, status, created_at }`.
`RelayTraceView`: `{ id, created_at, tenant_id: string|null, job_id: string|null, channel_id: string|null, provider_type: string|null, method, url, request_headers: Record<string,string>|null (redacted), request_body: string|null, response_status: number|null, response_body: string|null, is_stream: bool, latency_ms: number|null, error: string|null, truncated: bool }`.
`UsageRollupView`: `{ bucket, requests: number, input_tokens (string), output_tokens (string), cost (string), errors: number }`.

### 1.15 Dify (admin-dify.controller.ts, prefix `/admin/dify`)

| Method+Path                      | Params / Body                                                                 | Response                        | Notes             |
| -------------------------------- | ----------------------------------------------------------------------------- | ------------------------------- | ----------------- | ---------------------------- | -------------------------- | ------------------------------------------------------------- |
| `POST /admin/dify/import`        | body: `{ tenantId(uuid), resourceId, yaml, endpoint(url), serviceKeyRef?(uuid | null), pricingModel: 'fixed'    | 'matrix'          | 'metered', allowBlockers? }` | **`200`** `DifyImportView` | `@Idempotent`; BYO+metered→400; blocked w/o allowBlockers→422 |
| `GET /admin/dify`                | query: `cursor?`, `limit?`                                                    | `PageEnvelope<DifyBindingView>` |                   |
| `PATCH /admin/dify/:resourceId`  | path: `resourceId`; body all-optional: `{ endpoint?(url), serviceKeyRef?(uuid | null), pricingModel? }`         | `DifyBindingView` |                              |
| `DELETE /admin/dify/:resourceId` | path: `resourceId`                                                            | `204`                           | soft-delete       |

`DifyImportView`: `{ resource_id, version, io_schema: { inputs: [], outputs: [] }, compat_report: { items: [], has_blockers: bool } }`.
`DifyBindingView`: `{ resource_id, resource_version, mode, endpoint, service_key_ref: string|null, pricing_model, provision_mode, created_at }`.

### 1.16 Admin payments (admin-payments.controller.ts, prefix `/admin/payments`)

| Method+Path           | Params / Body                                     | Response                          |
| --------------------- | ------------------------------------------------- | --------------------------------- |
| `GET /admin/payments` | query: `tenantId` (required), `cursor?`, `limit?` | `PageEnvelope<PaymentIntentView>` |

`PaymentIntentView`: `{ id, tenant_id, provider, provider_ref, purpose, target_ref: string|null, amount_minor (string), currency, credit_amount: string|null, status, created_at, updated_at }`.

---

## 2. TENANT SELF-SERVICE API — `/console/*`

Controller: `console/console.controller.ts`. Guard: `ConsoleGuard` (USER JWT via `Authorization: Bearer <jwt>`, from `/auth/login` or `/auth/register`). Tenant is taken from the JWT principal `{userId, tenantId, accountId}` — **never** from body/query. NOT idempotency-wrapped.

| Method+Path                         | Params / Body                                                             | Response                                                            | Notes                                                       |
| ----------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| `POST /console/api-keys`            | body: `{ resourceAllowlist?: string[], rateLimit?: int>0 }` (NO tenantId) | `201` `{ id, plaintext }`                                           | plaintext once                                              |
| `GET /console/api-keys`             | query: `cursor?`, `limit?`                                                | `PageEnvelope<ApiKeyView>`                                          | no hashes; tenant-scoped                                    |
| `POST /console/api-keys/:id/rotate` | path: `id`                                                                | `201` `{ id, plaintext }`                                           | new plaintext; old key disabled                             |
| `DELETE /console/api-keys/:id`      | path: `id`                                                                | **`200`** `{ id, status: 'disabled' }`                              | disable (NOT 204)                                           |
| `GET /console/usage`                | query: `jobs_cursor?`, `ledger_cursor?`, `limit?`                         | `{ jobs: PageEnvelope<JobView>, ledger: PageEnvelope<LedgerView> }` | **two independent envelopes**, each its own cursor          |
| `GET /console/models`               | (none)                                                                    | `PageEnvelope<ModelListItem>`                                       | single bounded page: `next_cursor: null`, `has_more: false` |
| `POST /console/payments/intents`    | body: `{ provider, amount_minor (int>0, ≤MAX_SAFE_INT), currency }`       | `201` `{ intent_id, redirect_url?, qr? }`                           | purpose hardcoded `topup`                                   |

Console `ApiKeyView`: `{ id, resource_allowlist: string[], rate_limit: number|null, status, created_at }` (no `tenant_id`/`route_group_id` vs admin).
Console `JobView`: `{ job_id, resource_id, status, exec_mode, cost: string|null, created_at }`.
Console `LedgerView`: `{ id, type, credits_delta (string), balance_after (string), job_id: string|null, created_at }`.
`ModelListItem`: `{ name, display, modality, capabilities, visibility }`.

---

## 3. DEVELOPER DATA-PLANE API — `/v1/*` (and `/v1beta`)

Auth: `ApiKeyGuard` — `Authorization: Bearer ak_...` **or** `x-api-key` header. Chat/run also use `RateLimitGuard` (runs second). Dev-only fallback: `x-tenant-id` header when `ALLOW_DEV_TENANT_HEADER` and non-prod. Optional `x-tenant-id` is otherwise ignored.

### 3.1 Chat relays (OpenAI / Anthropic / Gemini dialects)

| Method+Path                                        | Auth             | Body                                                        | Response                                                                                                                                        |
| -------------------------------------------------- | ---------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/chat/completions`                        | ApiKey+RateLimit | OpenAI chat body (`model`, `messages`, `stream?`...)        | `200` OpenAI `chat.completion` JSON, or SSE `chat.completion.chunk` ending `data: [DONE]` when `stream:true`. Sets `x-actionow-channel` header. |
| `POST /v1/messages`                                | ApiKey+RateLimit | Anthropic messages body (`model`, `messages`, `stream?`...) | `200` Anthropic `type:'message'` JSON, or typed SSE events `message_start`…`message_stop`.                                                      |
| `POST /v1beta/models/:model:generateContent`       | ApiKey+RateLimit | Gemini body (model in path)                                 | `200` Gemini `candidates[]` JSON                                                                                                                |
| `POST /v1beta/models/:model:streamGenerateContent` | ApiKey+RateLimit | Gemini body                                                 | SSE `data:` candidate frames                                                                                                                    |

(The literal `:` in Gemini paths is escaped in the route; `:model` captures only the model name.)

### 3.2 Models discovery

| Method+Path      | Response                                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/models` | OpenAI list shape: `{ object: 'list', data: [{ id: <name>, object: 'model', owned_by: 'actionow' }] }` (visibility-filtered to tenant) |

### 3.3 Run (`v1/run`)

| Method+Path                | Auth             | Body                                                                                                       | Response                                                                                                                                                                                                               |
| -------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/run/:resourceId` | ApiKey+RateLimit | `RunBody`: `{ inputs?: Record, exec_mode?, callback_url?, idempotency_key?, end_user?, estimated_usage? }` | Blocking → `200` `{ job_id, status:'succeeded', output, usage, cost: { credits: string } }`; async → `202` `{ job_id, status:'queued' }`; with `Accept: text/event-stream` → SSE `delta`/`usage`/`done`/`error` frames |

### 3.4 Resources discovery (`v1/resources`)

ApiKeyGuard only (no rate-limit). Scoped to tenant + API key `resourceAllowlist`.
| Method+Path | Params | Response |
|---|---|---|
| `GET /v1/resources` | query: `cursor?`, `limit?` | `PageEnvelope<ResourceSummary>` |
| `GET /v1/resources/:id` | path: `id` | `ResourceDetail` (404 if not visible) |

`ResourceSummary`: `{ id, kind, modality, provider_type, exec_modes: string[] }`. `ResourceDetail` = summary + `{ io_schema, pricing?: { method, timing, spec } }`.

### 3.5 Files (`v1/files`)

ApiKeyGuard. S3-compatible presign flow, tenant-scoped.
| Method+Path | Body / Params | Response |
|---|---|---|
| `POST /v1/files/presign-upload` | `{ filename, content_type, size(int>0) }` | `200` `{ file_id, upload_url, key, expires_in }` |
| `POST /v1/files/:id/confirm` | path: `id` | `200` `FileView` |
| `GET /v1/files/:id/url` | path: `id` | `{ url, expires_in }` |

`FileView`: `{ id, status, size: number|null, content_type: string|null, etag: string|null }`.

### 3.6 Jobs (`v1/jobs`)

ApiKeyGuard, caller-scoped.
| Method+Path | Params | Response |
|---|---|---|
| `GET /v1/jobs` | query: `cursor?`, `limit?` | `PageEnvelope<JobView>` (newest-first) |
| `GET /v1/jobs/:id` | path: `id` | `JobView` (404 if not caller's) |
| `POST /v1/jobs/:id/cancel` | path: `id` | `200` `JobView` (queued → canceled, releases hold) |

Data-plane `JobView`: `{ job_id, status, resource_id, exec_mode, inputs, output, usage, cost: { credits: string }|null, error, created_at, updated_at }`.

### 3.7 Payments (`v1/payments`)

| Method+Path                            | Auth                                                    | Body / Params                                                                     | Response                                                                                        |
| -------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `POST /v1/payments/intents`            | ApiKeyGuard                                             | `{ provider, purpose, amount_minor(int>0,≤MAX_SAFE_INT), currency, target_ref? }` | `201` `{ intent_id, redirect_url?, qr? }`                                                       |
| `POST /v1/payments/webhooks/:provider` | **NONE** (provider signature over raw body is the auth) | raw signed body; signature headers                                                | `200` `{ status:'ok', fulfilled: bool }`; bad/missing sig → 401. Fulfillment happens ONLY here. |
| `GET /v1/payments/intents/:id`         | ApiKeyGuard                                             | path: `id`                                                                        | `PaymentIntentView` (cross-tenant → 404)                                                        |

### 3.8 Callbacks (`v1/callbacks`)

| Method+Path                    | Auth                                                  | Response                                                            |
| ------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------- |
| `POST /v1/callbacks/:provider` | **NONE** (per-channel HMAC over raw body is the auth) | `200` `{ status:'accepted', settled: bool }`; bad/missing sig → 401 |

---

## 4. AUTH

| Method+Path                          | Controller                          | Guard              | Body                              | Response                                                                                    |
| ------------------------------------ | ----------------------------------- | ------------------ | --------------------------------- | ------------------------------------------------------------------------------------------- |
| `POST /auth/register`                | local-auth.controller.ts            | none               | `{ email, password }`             | `200` `{ token }` (provisions tenant + account)                                             |
| `POST /auth/login`                   | local-auth.controller.ts            | none               | `{ email, password }`             | `200` `{ token }` (bad creds → 401)                                                         |
| `GET /auth/oauth/:provider`          | oauth.controller.ts                 | none               | —                                 | `302` redirect to provider; sets HttpOnly `oauth_state` (+ Google `oauth_verifier`) cookies |
| `GET /auth/oauth/:provider/callback` | oauth.controller.ts                 | none               | query: `code`, `state`            | `200` `{ token }` (state mismatch / missing code → 400)                                     |
| `POST /auth/link/:provider`          | oauth.controller.ts                 | `AdminGuard` (JWT) | `{ code, codeVerifier?, state? }` | `200` `{ linked: true }` (links identity to current user)                                   |
| `POST /admin/auth/login`             | admin/auth/admin-auth.controller.ts | none               | `{ email, password }`             | `200` `{ token }` (admin JWT; bad creds → 401)                                              |

Notes: `/auth/register` and `/auth/login` return **200** (not 201). The malformed-body case is `400 invalid_input` for all three login/register endpoints. `POST /auth/link/:provider` is unusual — it reuses `AdminGuard` to identify the current user (`req.admin.adminId`), not a console guard.

---

## 5. HEALTH (no guard, for completeness)

- `GET /health` → `{ status: 'ok' }`
- `GET /ready` → `{ status: 'ready' }`
  (`health/health.controller.ts`, root `@Controller()`.)

---

## Key frontend-binding gotchas

1. **Pagination is cursor-only**: `{ data, next_cursor, has_more }`. No totals/page numbers. Build "load more" off `next_cursor`/`has_more`, not page math.
2. **Two endpoints break the envelope pattern**: `GET /admin/analytics/usage` returns a raw array; `GET /console/usage` returns `{ jobs: PageEnvelope, ledger: PageEnvelope }` with separate `jobs_cursor`/`ledger_cursor`.
3. **Plaintext secrets are returned ONCE** on key mint/rotate (`POST /admin/api-keys`, `POST/PATCH console api-keys`, redemption-codes). Capture immediately; subsequent lists never include them.
4. **Console DELETE returns 200** (`{id, status:'disabled'}`); admin DELETEs return **204**.
5. **Money fields are decimal strings** everywhere (µcredits / µUSD-per-1M / amount_minor). Parse as big-decimal, never `Number()` naively for display precision.
6. **Route group ratio** is `group_ratio_bps` integer basis points (`10000` = 1.0×), a plain number, not a money string.
7. **`Idempotency-Key` header** is honored only on the non-secret admin POSTs listed in §0.2; safe to send on retries there.

## B. Frontend Data Layer & Caching

# Actionow Frontend — Data Layer & Caching Strategy

All paths absolute under `/Users/alienworm/actionow-web/apps/web/src/lib/`.

---

## 1. HTTP Client — `api/client.ts`

**Base URL / config.** Imports `config` from `../../config`. Every request URL is built as `config.apiBase + path` in `buildUrl()`. Query params are appended only for non-`undefined`/non-empty values, URL-encoded, joined with `&`.

**Construction.** `createClient(deps: ClientDeps)` is a factory taking two callbacks:

- `getToken: () => string | null`
- `onUnauthorized: () => void`

It returns an `ApiClient` (`export type ApiClient = ReturnType<typeof createClient>`). In practice the client is obtained via `useAuth().client` (see `useAdminApi.ts`), so the auth provider wires `getToken`/`onUnauthorized`.

**Auth header injection.** Default headers are `{ 'content-type': 'application/json' }`. If `deps.getToken()` returns a truthy token, it adds `Authorization: Bearer ${token}`. So auth is a **JWT bearer token sourced from the AuthProvider** (`useAuth`), not from client.ts directly. Per-request `init.headers` are merged AFTER the defaults/auth (can override).

**Method surface (all generic over response type `T`):**

- `get<T>(path, query?)` → GET, returns parsed body.
- `getWithHeaders<T>(path, query?)` → GET, returns `{ data, headers }` (used to read response headers like `x-actionow-channel`).
- `post<T>(path, body?, opts?)` → POST; `opts.idempotencyKey` adds an `Idempotency-Key` header.
- `patch<T>(path, body?)` → PATCH (no idempotency-key option by design).
- `delete<T>(path)` → DELETE.
- `getPage<T>(path, query?)` → GET that unwraps the list envelope `PageEnvelope<T>` (`{ data, next_cursor, has_more }`) into a `Page<T>` = `{ rows: env.data, nextCursor: env.next_cursor }`.

**Body handling.** `body === undefined` → no body sent; otherwise `JSON.stringify(body)`. `204 No Content` → returns `undefined as T`.

**Error normalization** (`toApiError(res)` → throws `ApiError`):

- On `!res.ok`, parses the response JSON expecting the §4.7 envelope shape `{ error: { code, message, retryable, retry_after_ms } }`.
- If `error.code` present → `new ApiError(code, message ?? code, status, retryable ?? false, retry_after_ms)`.
- If parsing fails or no code → fallback `new ApiError('internal_error', 'HTTP <status>', status, false)`.
- **On HTTP 401** it calls `deps.onUnauthorized()` before throwing (global logout/redirect hook).

**`ApiError` class — `api/errors.ts`.** Extends `Error`; fields: `code` (string), `message`, `status` (number), `retryable` (default false), `retryAfterMs?` (number). `name = 'ApiError'`. Mirrors the §4.7 error envelope.

**Mutation error helper — `api/mutationError.ts`.** `mutationError(t: TFunction)` returns an `onError` handler for `useMutation`:

- `instanceof ApiError` → `toast(t('errors.' + e.code, e.message), 'error')` (localized by error code, server message as i18n fallback).
- otherwise → `toast(t('errors.network'), 'error')`.

This is the standard mutation `onError` across the admin UI; i18n keys are namespaced `errors.<code>` and `errors.network`.

---

## 2. TanStack Query Defaults — `query.ts`

`queryClient = new QueryClient({ defaultOptions: { queries: { ... } } })`:

| Option                 | Value                                |
| ---------------------- | ------------------------------------ |
| `staleTime`            | `15_000` (15 s)                      |
| `retry`                | `1`                                  |
| `refetchOnWindowFocus` | `false`                              |
| `gcTime`               | **not set** (TanStack default 5 min) |

**Per-query staleTime overrides exported as constants** (queries pass these explicitly):

- `STALE_REFERENCE = 60_000` (60 s) — catalog/reference data that changes rarely.
- `STALE_VOLATILE = 10_000` (10 s) — jobs/usage/ledger operational data.

**Keyset pagination hook** `useKeyset<T>(key, fetchPage)`: wraps `useInfiniteQuery` with `initialPageParam: undefined`, `getNextPageParam: (last) => last.nextCursor ?? undefined`. Returns `{ rows, hasNext, isLoading, isFetchingNext, fetchNext }` (flattens all loaded pages' `rows`).

---

## 3. Cache Key Map — `api/queryKeys.ts`

Exported as `qk`. Every key is prefixed `['admin', ...]`. **Full enumeration:**

| Factory                     | Key produced                                                   |
| --------------------------- | -------------------------------------------------------------- |
| `qk.tenants()`              | `['admin','tenants']`                                          |
| `qk.resources()`            | `['admin','resources']`                                        |
| `qk.channels(resourceId)`   | `['admin','resources',resourceId,'channels']`                  |
| `qk.pricebook(resourceId)`  | `['admin','pricebook',resourceId]`                             |
| `qk.modifiers()`            | `['admin','modifiers']`                                        |
| `qk.secrets()`              | `['admin','secrets']`                                          |
| `qk.apiKeys(tenantId)`      | `['admin','api-keys',tenantId]`                                |
| `qk.jobs(tenantId)`         | `['admin','jobs',tenantId]`                                    |
| `qk.models()`               | `['admin','models']`                                           |
| `qk.model(name)`            | `['admin','models',name]`                                      |
| `qk.modelGrants(name)`      | `['admin','models',name,'grants']`                             |
| `qk.usage(params)`          | `['admin','usage',params]` (params = `Record<string,unknown>`) |
| `qk.analyticsUsage(params)` | `['admin','analytics-usage',params]`                           |
| `qk.ledger(tenantId)`       | `['admin','ledger',tenantId]`                                  |
| `qk.payments(tenantId)`     | `['admin','payments',tenantId]`                                |

**Note:** there is NO `qk` entry for the billing/routing mock pages (official-prices, route-groups, group-channels). Those pages either inline their own keys or use the mock module directly — they are not in this central map.

---

## 4. Entity Types — `api/types.ts`

**Real backend view shapes (UI binds these):**

- `TenantView` — `{ id, name, isolation_mode, created_at }`
- `AccountView` — `{ id, tenant_id, credit_balance, credit_held, created_at }` (credits are decimal strings)
- `ApiKeyView` — `{ id, tenant_id, resource_allowlist: string[], rate_limit: number|null, status, created_at }`
- `ApiKeyCreatedView` — `{ id, plaintext }` (one-time plaintext on creation)
- `ResourceView` — `{ id, tenant_id, kind, modality, provider_type, exec_modes: string[], status, current_version, created_at }`
- `JobView` — `{ job_id, tenant_id, resource_id, status, exec_mode, cost: string|null, created_at }`
- `PricebookView` — `{ id, resource_id, resource_version, version, method, timing, spec: unknown, markup: unknown, active }`
- `ModifierView` — `{ id, scope, when_expr: string|null, op, value: string|null, stackable, priority, version, active }`
- `ChannelView` — `{ id, resource_id, provider_type, credential_ref|null, endpoint|null, model|null, proxy_ref|null, config: Record<string,unknown>|null, weight, status }`
- `DifyImportView` — `{ resource_id, version, io_schema: unknown, compat_report: unknown }`
- `SecretView` — `{ id, provider, created_at }` (no plaintext by construction)
- `ModelView` — `{ id, name, display: string|null, modality, capabilities: Record<string,boolean>, visibility, resource_id, input_price: string, output_price: string, status, created_at }`
- `ModelGrantView` — `{ id, model_id, tenant_id, created_at }`
- `UsageLogView` — `{ id, tenant_id, model, input_tokens, output_tokens, cost: string, latency_ms: number|null, status, created_at }`
- `UsageRollupView` — `{ bucket, requests, input_tokens: string, output_tokens: string, cost: string, errors }` (one aggregated bucket; token/cost sums are decimal strings)
- `LedgerView` — `{ id, tenant_id, account_id, type, credits_delta: string, balance_after: string, resource_id: string|null, job_id: string|null, created_at }`
- `PaymentIntentView` — `{ id, tenant_id, provider, provider_ref, purpose, target_ref: string|null, amount_minor: string, currency, credit_amount: string|null, status, created_at, updated_at }`

**Pagination type:** `Page<T>` = `{ rows: T[]; nextCursor: string | null }`.

**MOCK / design-only billing shapes** (units = integer µUSD per 1M tokens; `$1 = 1,000,000 µUSD`; decoupled from the live µcredit/token registry):

- `OfficialModelPrice` — `{ id, provider, model_slug, display_name, input_price_per_1m: number, output_price_per_1m: number, cached_input_price_per_1m?: number, source_url?, effective_at?, notes?, updated_by?, created_at }`
- `RouteGroup` — `{ id, name, group_ratio_bps: number, status: 'active'|'disabled', description?, created_at }` (ratio in basis points: `10000 = ×1.00`, `15000 = ×1.50`)
- `RouteGroupChannel` — `{ group_id, channel_id, priority, weight }`

**Union/literal types:**

- `Modality` = `'text'|'image'|'video'|'audio'|'composite'`
- `PricebookMethod` = `'unit'|'matrix'|'fixed'|'formula'|'passthrough'`
- `PricebookTiming` = `'pre'|'post'`
- `ModifierOp` = `'override_rate'|'percent_off'|'flat_off'|'percent_add'`
- `DifyPricingModel` = `'fixed'|'matrix'|'metered'`
- `ChannelStatus` = `'active'|'disabled'`

**Request body types:** `CreateTenantBody`, `CreateAccountBody`, `TopupBody`, `CreateApiKeyBody`, `UpdateResourceBody` (only `status` mutable), `SyncChannelModelsBody`, `SyncChannelModelsResult`, `CreateResourceBody`, `CreateChannelBody`, `UpdateChannelBody` (omit = unchanged, `null` = clear), `CreatePricebookBody`, `CreateModifierBody`, `DifyImportBody`, `CreateSecretBody`, `CreateModelBody`, `UpdateModelBody` (omit = unchanged; `name`/`resourceId`/`modality` immutable), `GenerateCodesBody`, `AnalyticsUsageQuery` (`groupBy: 'day'|'model'|'tenant'|'channel'|'api_key'`, optional `tenantId`/`from`/`to`).

---

## 5. Admin API Layer — `api/admin.ts` + `api/useAdminApi.ts`

**`useAdminApi(): AdminApi`** — calls `useAuth()` to get the `client`, returns `useMemo(() => makeAdminApi(client), [client])`. This is the hook every page calls to get the typed method bundle.

**`makeAdminApi(client)`** returns the method bundle below. These are **plain async methods, not TanStack hooks** — pages wrap them in `useQuery`/`useInfiniteQuery`/`useMutation` themselves, pairing each with a `qk.*` key. Invalidation is therefore done by the calling components against `qk.*` (not inside admin.ts; admin.ts has no `queryClient` reference). Methods and endpoints:

| Method                                             | HTTP               | Endpoint                                                           | Notes                                           |
| -------------------------------------------------- | ------------------ | ------------------------------------------------------------------ | ----------------------------------------------- |
| `listTenants()`                                    | GET (getPage→rows) | `/admin/tenants`                                                   |                                                 |
| `createTenant(body, idempotencyKey?)`              | POST               | `/admin/tenants`                                                   | idempotency-key                                 |
| `listResources()`                                  | GET→rows           | `/admin/resources`                                                 |                                                 |
| `createResource(body, idempotencyKey?)`            | POST               | `/admin/resources`                                                 | idempotency-key                                 |
| `updateResource(id, body)`                         | PATCH              | `/admin/resources/${id}`                                           |                                                 |
| `createChannel(resourceId, body, idempotencyKey?)` | POST               | `/admin/resources/${resourceId}/channels`                          | idempotency-key                                 |
| `listChannels(resourceId)`                         | GET→rows           | `/admin/resources/${resourceId}/channels`                          |                                                 |
| `updateChannel(resourceId, channelId, body)`       | PATCH              | `/admin/resources/${resourceId}/channels/${channelId}`             |                                                 |
| `deleteChannel(resourceId, channelId)`             | DELETE             | `/admin/resources/${resourceId}/channels/${channelId}`             | returns void                                    |
| `syncChannelModels(resourceId, channelId, body)`   | POST               | `/admin/resources/${resourceId}/channels/${channelId}/sync-models` | → `SyncChannelModelsResult`                     |
| `listPricebook(resourceId)`                        | GET→rows           | `/admin/pricebook?resourceId=`                                     |                                                 |
| `createPricebook(body, idempotencyKey?)`           | POST               | `/admin/pricebook`                                                 | idempotency-key                                 |
| `listModifiers()`                                  | GET→rows           | `/admin/modifiers`                                                 |                                                 |
| `createModifier(body)`                             | POST               | `/admin/modifiers`                                                 |                                                 |
| `difyImport(body)`                                 | POST               | `/admin/dify/import`                                               | → `DifyImportView`                              |
| `createAccount(body)`                              | POST               | `/admin/accounts`                                                  |                                                 |
| `topup(accountId, body)`                           | POST               | `/admin/accounts/${accountId}/topup`                               | → `{ account_id, balance }`                     |
| `listApiKeys(tenantId)`                            | GET→rows           | `/admin/api-keys?tenantId=`                                        |                                                 |
| `createApiKey(body)`                               | POST               | `/admin/api-keys`                                                  | → `ApiKeyCreatedView` (plaintext)               |
| `listJobs({tenantId,cursor,limit})`                | GET (getPage)      | `/admin/jobs`                                                      | returns `Page<JobView>` (keyset)                |
| `createSecret(body)`                               | POST               | `/admin/secrets`                                                   | → `SecretView`                                  |
| `listSecrets()`                                    | GET→rows           | `/admin/secrets`                                                   |                                                 |
| `listModels()`                                     | GET→rows           | `/admin/models`                                                    |                                                 |
| `createModel(body, idempotencyKey?)`               | POST               | `/admin/models`                                                    | idempotency-key                                 |
| `getModel(name)`                                   | GET                | `/admin/models/${encodeURIComponent(name)}`                        |                                                 |
| `updateModel(name, body)`                          | PATCH              | `/admin/models/${name}`                                            | no idempotency-key (PATCH naturally idempotent) |
| `deleteModel(name)`                                | DELETE             | `/admin/models/${name}`                                            | void                                            |
| `grantModel(name, {tenantId}, idempotencyKey?)`    | POST               | `/admin/models/${name}/grants`                                     | → `{ ok: true }`                                |
| `listModelGrants(name)`                            | GET→rows           | `/admin/models/${name}/grants`                                     |                                                 |
| `revokeModelGrant(name, tenantId)`                 | DELETE             | `/admin/models/${name}/grants/${tenantId}`                         | void                                            |
| `generateCodes(body)`                              | POST               | `/admin/redemption-codes`                                          | → `{ codes: string[], credit_amount }`          |
| `listUsage({tenantId?,cursor?,limit?})`            | GET (getPage)      | `/admin/usage`                                                     | `Page<UsageLogView>` (keyset)                   |
| `analyticsUsage(params)`                           | GET                | `/admin/analytics/usage`                                           | → `UsageRollupView[]` (array, NOT paginated)    |
| `listLedger({tenantId,cursor,limit})`              | GET (getPage)      | `/admin/ledger`                                                    | `Page<LedgerView>` (keyset)                     |
| `listPayments(tenantId, limit?)`                   | GET (getPage)      | `/admin/payments`                                                  | `Page<PaymentIntentView>` (keyset)              |

`AdminApi = ReturnType<typeof makeAdminApi>`.

**Invalidation pattern:** mutations live in admin.ts only as raw POST/PATCH/DELETE callers. They carry no `queryClient.invalidateQueries`. The convention is that the consuming page's `useMutation({ onSuccess })` invalidates the matching `qk.*` key (e.g. `createModel` → invalidate `qk.models()`; `grantModel`/`revokeModelGrant` → `qk.modelGrants(name)`; `createChannel`/`updateChannel`/`deleteChannel` → `qk.channels(resourceId)`). Per-page agents should confirm the exact `onSuccess` invalidation in each page component, but the key to invalidate is dictated by the `qk` factory listed in §3.

---

## 6. Real-vs-Mock Boundary — `api/mockBilling.ts`

This is the precise boundary. The file header states the billing/channel-routing backend is **DESIGN-ONLY** (not built); the live relay backend is "mid-rework." The 官方价格 (official-prices) and 分组 (route-group) console pages run entirely on this in-memory module.

**MOCKED (in-memory, no network — `mockBilling.ts`):**

- **Official prices** (`OfficialModelPrice`): `listOfficialPrices()`, `createOfficialPrice(body)`, `updateOfficialPrice(id, patch)`, `deleteOfficialPrice(id)`. Backed by a module-level `officialPrices[]` array seeded with 5 rows (openai gpt-4o, gpt-4o-mini; anthropic claude-3-5-sonnet, claude-3-5-haiku; gemini gemini-1.5-pro).
- **Route groups** (`RouteGroup`): `listRouteGroups()`, `createRouteGroup(body)`, `updateRouteGroup(id, patch)`, `deleteRouteGroup(id)` (cascades membership removal), plus `countGroupChannels(groupId)` (sync count for the table column). Seeded with 3 groups: `default` (10000 bps, active), `premium` (15000 bps, active), `economy` (8000 bps, disabled).
- **Group channel membership** (`RouteGroupChannel`): `listGroupChannels(groupId)`, `addGroupChannel(groupId, channelId, priority=100, weight=100)`, `updateGroupChannel(groupId, channelId, patch)`, `removeGroupChannel(groupId, channelId)`. Seeded with 3 memberships against `rg_0006`/`rg_0007`.
- **Channel roster for the membership picker** — `MOCK_CHANNELS` (`MockChannel[]`, exported): 5 fixed entries (`ch_openai_primary`, `ch_openai_backup`, `ch_anthropic_primary`, `ch_gemini_primary`, `ch_azure_eastus`). The header note says in the real backend these would come from `listChannels` per resource.

**Mock mechanics:** all reads/writes mutate module-level arrays; every method returns through `delay(value)` with `LATENCY_MS = 120` to simulate a network round-trip (exercises loading states). IDs are a deterministic counter `nextId(prefix)` (`op_0001`, `rg_0006`, …) — NOT `Date.now()`/`Math.random()`/UUID. `usd(dollars)` converts dollars → integer µUSD per 1M. Mock methods mirror the async/plain-view shape of real client methods so the future swap to `/admin/official-prices` + `/admin/groups` (and per-resource `listChannels`) is a single-file change. Note state is in-memory only — it resets on page reload.

**REAL (live backend via `admin.ts` / `client.ts`):**

- Usage logs (`listUsage` → `/admin/usage`), analytics rollups (`analyticsUsage` → `/admin/analytics/usage`), ledger (`listLedger`), payments (`listPayments`), jobs (`listJobs`), tenants/accounts/api-keys/resources/channels/pricebook/modifiers/secrets/models/grants/redemption-codes/dify-import — all hit the real `/admin/...` API.
- **Relay-traces:** NOT present in this data layer at all. There is no relay-traces method in `admin.ts` and nothing mocked for it in `mockBilling.ts` (the MEMORY note mentions a "relay-traces read" backend addition, but no client method exists in these files). Per-page agents needing relay traces should treat it as not yet wired into this api layer.

**Summary boundary:** route-groups = MOCK · official-prices = MOCK · group-channel membership = MOCK · channel picker roster = MOCK (`MOCK_CHANNELS`). usage/analytics/ledger/payments/jobs = REAL. relay-traces = absent (neither real nor mocked here).

---

## 7. Shared Enums — `api/enums.ts`

`EnumOption<V>` = `{ value: V; labelKey: string }`. `toOptions(opts, t)` maps each to `{ value, label: t(labelKey) }` for `Select`/`SelectField`. Sets (value list → i18n key root `enums.*`):

- `MODALITIES` (`Modality`): `text`, `image`, `video`, `audio`, `composite` → `enums.modality.*`
- `RESOURCE_KINDS` (`'model'|'workflow'`): `model`, `workflow` → `enums.kind.*`
- `PRICEBOOK_METHODS` (`PricebookMethod`): `unit`, `matrix`, `fixed`, `formula`, `passthrough` → `enums.method.*`
- `PRICEBOOK_TIMINGS` (`PricebookTiming`): `pre`, `post` → `enums.timing.*`
- `CHANNEL_STATUSES` (`ChannelStatus`): `active`, `disabled` → `enums.channelStatus.*`
- `MARKUP_TYPES` (`'percent'|'flat'`): `percent`, `flat` → `enums.markupType.*`
- `VISIBILITIES` (`'public'|'tenant'`): `public`, `tenant` → `enums.visibility.*`
- `MODEL_STATUSES` (`'active'|'disabled'`): `active`, `disabled` → `enums.modelStatus.*`

Non-`EnumOption` constants:

- `CapabilityDef` = `{ key; labelKey }`; `CAPABILITIES`: `tools`, `vision`, `audio`, `json`, `stream` → `enums.capability.*` (open-ended set; unknown flags shown by raw key).
- `COMMON_PROVIDERS` (free-text suggestions, `as const`): `openai`, `anthropic`, `gemini`, `azure`, `bedrock`, `cohere`, `mistral`.
- `EXEC_MODES` (free-text suggestions, `as const`): `blocking`, `stream`, `async-poll`, `async-callback`.

---

## Key takeaways for per-page agents

- Get the API via `const api = useAdminApi();` then wrap `api.<method>` in `useQuery`/`useKeyset`/`useMutation`.
- Cache keys are always `qk.<factory>(...)` from §3 — reuse verbatim; invalidate the same key in mutation `onSuccess`.
- Keyset lists (`jobs`, `usage`, `ledger`, `payments`) → use `useKeyset(qk.X(...), (cursor) => api.listX({..., cursor}))`.
- `analyticsUsage` returns a plain `UsageRollupView[]` (not a `Page`) → use `useQuery(qk.analyticsUsage(params), ...)`.
- Billing pages (official-prices, route-groups, memberships) → import functions directly from `mockBilling.ts`; they have NO `qk` entry and NO real endpoint yet.
- Default cache: 15 s stale, 1 retry, no focus-refetch; use `STALE_REFERENCE` (60 s) for catalog, `STALE_VOLATILE` (10 s) for operational lists.
- Mutations use `mutationError(t)` as `onError`; auth is JWT bearer from `useAuth`; 401 triggers `onUnauthorized()`.

## C. Design System

# Actionow Frontend Design System

Project: `/Users/alienworm/actionow-web/apps/web` — a Vite + React + react-router + react-i18next SPA. **No `tailwind.config`**: Tailwind v4 is imported via CSS (`@import 'tailwindcss'`) but the design system is essentially a **CSS-custom-property token system** plus inline-styled React components. Almost every component styles itself with `style={{ ... 'var(--token)' }}` and a handful of utility classes (`.glass`, `.panel`, `.ico-btn`, `.entity-card`, `.chip`, etc.). Visual language: warm amber/gold accent ("never blue"), Liquid-Glass surfaces, dark-default with a light theme, GSAP-driven ambient/route motion that universally respects `prefers-reduced-motion`.

Key source roots:

- Tokens / CSS: `/Users/alienworm/actionow-web/apps/web/src/styles/theme.css`, `glass.css`, `index.css`
- Layout chrome: `/Users/alienworm/actionow-web/apps/web/src/components/console/`
- UI primitives: `.../components/ui/`
- Data components: `.../components/data/`
- Glass/motion/theme/brand: `.../components/glass/`, `.../lib/motion/`, `.../lib/theme/`, `.../components/brand/`

---

## 1. LAYOUT CHROME (the console shell)

### `console/ConsoleLayout.tsx`

Composition root and **context provider** for the console shell. Wraps everything in three React contexts (defined in `ConsoleChrome.tsx`) so routed pages can publish slot content into the chrome: `ConsoleActionContext` (top-bar action button), `ConsoleFiltersContext` (top-bar filter controls), `ConsoleBackContext` (top-bar back target). Renders `<AppBackground/>` (z-0 aurora) then a flex shell at `zIndex:1`, `height:100dvh`, `padding: var(--s-4)`, `gap: var(--s-3)`. **Responsive split driven by `useMediaQuery(BP.md)` (≥768px = "isDesktop"):**

- Desktop: `<Rail/>` + `<SubNav/>` (both side columns) + `<main>` containing `<TopBar/>` and the scrollable `<Outlet/>`.
- Mobile: no Rail/SubNav; `<main>` + `<TopBar/>` + `<Outlet/>` (with `paddingBottom:76` to clear the tab bar) + a fixed `<BottomTabs/>`.

The routed `<Outlet/>` lives in `viewRef` and gets a **per-route enter animation** (GSAP `fromTo opacity:0,y:8 → 1,0`, `DUR.base`, `EASE.out`) re-run on `pathname` change via `useGSAP({ dependencies:[pathname], revertOnUpdate:true })`, gated to `prefers-reduced-motion: no-preference`.

### `console/ConsoleChrome.tsx`

No JSX — defines the slot contracts + publishing hooks. Exports: `ConsoleActionContext`, `ConsoleFiltersContext`, `ConsoleBackContext`; the `ConsoleBack` type `{ to, label }`; and three hooks pages call to publish into the chrome: `useSetConsoleAction(render, deps)`, `useSetConsoleFilters(render, deps)`, `useSetConsoleBack(back)`. Each memoizes the node internally (`useMemo(render, deps)`) and clears the slot on unmount — the documented guard against infinite publish loops.

### `console/chrome/Rail.tsx`

Desktop **left rail**: `width:64`, `.glass`, `r-lg`. Top = brand hexagon button (gradient `--grad-accent` glyph) → navigates to `/`. Middle = the **nav-group switcher**: one `IconButton` per `NAV` group with a **sliding active indicator** — an absolutely-positioned gradient pill (`--grad-accent`, `--shadow-cta`) translated by `activeIdx * RAIL_STEP` (`RAIL_STEP = 52` = 40px button + 12px gap), `transition: transform 0.32s cubic-bezier(0.2,0.8,0.2,1)` (disabled under reduced motion). Active icon switches to `weight="fill"` and `--ink` color. Bottom cluster = language toggle, theme toggle, logout (all `IconButton` with `tooltip`).

### `console/chrome/TopBar.tsx`

`.glass`, `r-md`. Left: optional back `IconButton` (when a page published `ConsoleBack`), then page **title** (`t('nav.{labelKey}')`, `--fs-lg`, `fw-semibold`, `track-snug`) and desktop-only **subtitle** (`t('subtitles.{labelKey}')`, `--fs-sm`, `--muted`). Title/subtitle derive from `activeItem(pathname)`. Right: page `filters` slot, page `action` slot, a **refresh** `.ico-btn` (calls `qc.invalidateQueries()`; spins via `.refresh-spin` when `useIsFetching() > 0` and not reduced-motion). On **mobile only** it also renders `LanguageSwitch`, `ThemeToggle`, home, logout (since the Rail is hidden).

### `console/chrome/SubNav.tsx`

Desktop **second column** (`width:200`, `.glass`, `r-lg`) listing the active group's leaf items. Uppercase group label header (`--fs-caption`, letter-spacing `.1em`, `--faint`). Items are `NavLink`s (height 34) with a **sliding highlight** behind the active item: absolutely-positioned `--hover-bg`/`--hover-bd` box translated `activeIdx * SUBNAV_STEP` (`SUBNAV_STEP = 38`), `transition: transform 0.26s` (off under reduced motion). Active item text = `--text`, others `--muted`.

### `console/chrome/BottomTabs.tsx`

**Mobile bottom tab bar** (phone-app pattern). `position:fixed`, inset by `--s-3` on left/right/bottom, `z:30`, `.glass`, `r-lg`, `justify-content:space-around`. One `NavLink` per `MOBILE_TABS` entry: stacked icon + micro label (`--fs-micro`). Active tab = `--accent` color + `weight="fill"` icon; via `pathname.startsWith(tab.to)`.

### `console/nav-config.ts` — Navigation IA

Types: `NavItem { to, labelKey }`, `NavGroup { key, icon, items[] }`, `MobileTab { to, labelKey, icon }`. Helpers: `groupForPath(pathname)`, `activeItem(pathname)` (both match by `pathname.startsWith(it.to)`, falling back to the first group/item).

Group icons are Phosphor: ops=`SquaresFourIcon`, catalog=`StackIcon`, billing=`CoinsIcon`, tenants=`BuildingsIcon`.

**Full `NAV` (group → route → English label → desktop subtitle):**

| Group (icon)                                    | Route                      | Label (`nav.*`)                 | Subtitle                                  |
| ----------------------------------------------- | -------------------------- | ------------------------------- | ----------------------------------------- |
| **ops** — "Operations" (`SquaresFourIcon`)      | `/console/dashboard`       | Dashboard                       | Tenants & resources overview, recent jobs |
| **catalog** — "Catalog" (`StackIcon`)           | `/console/catalog`         | Catalog                         | Models & resources — channels and pricing |
|                                                 | `/console/dify`            | Dify import                     | Import a Dify workflow as a resource      |
| **billing** — "Billing & Routing" (`CoinsIcon`) | `/console/groups`          | Groups (labelKey `routeGroups`) | Route groups & channel membership         |
|                                                 | `/console/official-prices` | Official prices                 | Reference model prices                    |
|                                                 | `/console/modifiers`       | Modifiers                       | Global and scoped pricing rules           |
| **tenants** — "Tenants" (`BuildingsIcon`)       | `/console/tenants`         | Tenants                         | Create and view tenants                   |
|                                                 | `/console/accounts`        | Accounts                        | Account balance & top-up                  |
|                                                 | `/console/api-keys`        | API Keys                        | Issue and manage API keys                 |

Note: `labelKey` for the groups route is intentionally `routeGroups` (not `groups`) to avoid colliding with the `nav.groups.*` group-label namespace. Billing pages (`groups`, `official-prices`) are documented as mock-skeleton pages backed by `mockBilling.ts`.

**`MOBILE_TABS`** (flattened, 4 leaves, each with its own icon): `/console/dashboard` (Dashboard, `SquaresFourIcon`), `/console/catalog` (Catalog, `StackIcon`), `/console/tenants` (Tenants, `BuildingsIcon`), `/console/api-keys` (API Keys, `KeyIcon`).

### In-page tab patterns

Two distinct mechanisms exist for in-page tabs:

1. **`ui/Tabs`** (see primitives) — the canonical controlled ARIA tab strip with a warm underline.
2. **`ui/SegmentedControl`** — pill radiogroup; used e.g. in `features/auth/AuthPage.tsx:201` (login/register switch).
3. **Bespoke URL-synced strip** — `features/console/CatalogPage.tsx` builds its own 模型|资源 (Models|Resources) tab strip that **mirrors `ui/Tabs`** (warm underline, roving tabindex, arrow/Home/End keys) but syncs the active tab to the URL rather than local state. The `catalog` nav holds a single `/console/catalog` leaf because the page owns its own internal tabs.

---

## 2. UI PRIMITIVES (`components/ui/*`) — one line each

- **Button** — pill button, variants `cta` (gradient `--grad-accent`+`--ink`+`--shadow-cta`), `ghost` (glass), `link` (text-only accent), `danger` (outlined `--fail`); sizes `sm|md|lg`; renders `<Link>`/`<a>`/`<button>` by props; `loading` shows a `CircleNotchIcon` spinner + `aria-busy`; `.btn-tactile` push (translateY hover/active) on non-link variants.
- **IconButton** — shared square `.ico-btn` (40×40); mandatory `aria-label`, optional sliding `.ico-tip` tooltip on hover/focus, `active`/`current` (→ `aria-current="page"`), Phosphor `icon` with `size`/`weight`.
- **Modal** — portaled centered dialog (`role="dialog" aria-modal`), `.glass` + `--overlay-bg`, `width: min(440px,92vw)`, `--scrim` backdrop; focus-trap (`useFocusTrap`), Escape/backdrop close; GSAP enter (`opacity/scale 0.96/y 8`) and **deferred unmount** on exit; optional `footer`.
- **Drawer** — right-slide side panel (heavier Modal sibling for long forms), full `100dvh`, `width: min(480px,96vw)`, header with title + close `IconButton`, slides `x:40→0`; same focus-trap/Escape/deferred-unmount lifecycle and `--overlay-bg` surface.
- **Tabs** — controlled ARIA `role="tablist"` strip with warm `--grad-accent` underline on the active tab; roving tabindex, Arrow/Home/End keyboard nav; renders the active panel via `children`; `{ value, label }` tab shape.
- **SegmentedControl** — `role="radiogroup"` pill set (`.panel`, `r-pill`) with a **sliding gradient indicator**; unified `onChange(value)`, roving tabindex, Arrow/Home/End; active label `--ink`, off `--muted`; reduced-motion disables slide.
- **Select** — system-styled (never-native) select: glass `.panel` trigger + **portaled** `--overlay-bg` listbox (escapes modal overflow, closes on outside-click/Escape/scroll); full keyboard incl. type-ahead, `aria-activedescendant`; check mark on selected.
- **SelectField** — labelled `Select` composed on `FormField` (label/error/hint/tooltip render once; `htmlFor` → trigger).
- **ComboboxField** — typeable free-form dropdown (`role="combobox"`): text input + portaled suggestion listbox filtered by case-insensitive substring; commits typed text or highlighted suggestion; same glass/`--overlay-bg` styling as Select.
- **ChipsField** — add/remove string-list editor producing `string[]`; Enter/comma adds (trimmed, dedup), Backspace removes last, each chip has an ✕; optional `suggestions` render as dashed add-chips; wrapped in `FormField`.
- **FormField** — the shared field shell: label (optional `required` `*` and `Tooltip`), the control (`children`), and a single error-or-hint line (error wins, `--fail`; hint `--faint`). Exports `useFieldId(explicit?)` for stable label↔control association.
- **TextField** — single-line text input (`text|email|password|url|tel|search`) on `onChange(value)`, `.panel` styled, composed on `FormField`; `aria-invalid` on error.
- **NumberField** — numeric input on `onChange(number)` (empty/invalid → `0`, never `NaN`); `min/max/step`; composed on `FormField`.
- **JsonField** — monospace `<textarea>` for raw JSON; ships `validateJson(raw): JsonResult` ({ ok, value } | { ok:false, error }); red border on error; composed on `FormField`.
- **KeyValueEditor** — controlled add/remove key→value row editor producing ordered `KvRow[]` (helpers `rowsFromObject`/`objectFromRows` in `kvRows.ts`); empty value shows one blank row; optional ghost `presets`; per-input indexed aria-labels.
- **Checkbox** — `role="checkbox"` button on `onChange(boolean)`; warm `--grad-accent` fill when checked; `indeterminate` → dash + `aria-checked="mixed"` (for select-all); `label` or `ariaLabel`.
- **Toggle** — `role="switch"` button on `onChange(boolean)`; 38×22 track, warm `--grad-accent` when on, sliding `--ink` knob; optional `label`.
- **Tooltip** — info affordance: `InfoIcon` (or custom `children`) trigger that reveals a `role="tooltip"` bubble on hover/focus; `--overlay-bg`, `--fs-caption`, `aria-describedby`.
- **ConfirmDialog** — destructive-confirm built on `Modal`; footer `[Cancel, Confirm]`; `danger` styles Confirm with the `danger` Button variant; `loading` disables + spins.
- **RowAction** — compact 30×30 icon-only button (`.row-action`) for `DataTable` row-action cells; `aria-label`+native `title`; `danger` tints hover red, `loading` swaps to spinner.
- **SectionHeader** — simple `<h2>` title (`--fs-base`, bold) + optional right-aligned `action` node, space-between.
- **Toaster / toast** — `toast(text, tone)` is a module-level pub/sub (`toast.ts`, tones `ok|error`); `Toaster.tsx` is the fixed bottom-right stack; each toast is its own live region (`role=alert/assertive` for error, `status/polite` otherwise), 3500ms lifetime, enter/exit translate+fade (reduced-motion → instant).
- **LoadingScreen** — full-viewport (`100dvh`) brand loader for route/Suspense waits: `RoseLoader` (size 132) + uppercase tracked label (defaults to `t('loading')`).
- **RoseLoader** — animated brand mark: a parametric rose curve `r=a·cos4θ` traced by a fading particle trail with slow rotation + breathing pulse, drawn imperatively in one rAF loop (no per-frame React render); `--accent` color + `--glow-accent` drop-shadow; reduced-motion draws a static rose.

---

## 3. DATA COMPONENTS (`components/data/*`)

- **DataTable** (`DataTable.tsx`, logic in `tableState.ts`) — generic table. **Column API:** `Column<T> { key, header, cell(row), width?, sticky?:'left'|'right', hideable?, sortable?, sortValue?(row) }`. **Props:** `columns, rows, rowKey, empty?, loading?, fill?, onRowClick?, selectedKey?, pageSize?, searchable?, filterKeys?, rowActions?, actionsWidth?, selectable?, bulkActions?, columnToggle?`. **Sort:** sortable headers cycle asc→desc→none (`nextSortDirection`), sorted by `sortValue` (numeric or locale-aware string), caret indicator (`--accent` when active). **Pagination:** client-side when `pageSize` set and rows exceed it; `Pager` shows total + page X/Y + prev/next; auto-clamps page on shrink and resets to page 1 on search. **Selection:** leading `Checkbox` column + select-all (indeterminate), `bulkActions(selected, clear)` bar appears when ≥1 selected. **Search:** global `searchable` box filters over stringified visible cells (or `filterKeys`). **Columns menu:** `columnToggle` portaled checkbox group hides/shows `hideable` columns. **Responsive:** desktop renders a real `<table>` (sticky header + sticky `left`/`right` pinned columns with `--overlay-bg` and edge shadows); **mobile renders stacked label/value cards** instead. `fill` makes it flex/scroll to fill height. Loading state = `RoseLoader`. Clickable rows adopt `role="button"` only when there are no nested interactive controls (selection/row-actions force a plain clickable row to keep ARIA valid).
- **CardCollection** — renders a set of `EntityCard`s as a responsive **grid** (`repeat(auto-fill, minmax(280px,1fr))`) or vertical **list** (master pane); shared loading (`RoseLoader`) + empty states; stagger-reveal on row-set change (GSAP `fromTo`, `stagger:0.04`, reduced-motion skips). The card-based replacement for `DataTable` on non-tabular pages.
- **EntityCard** — the console's primary unit (cards over rows). Leading gradient `.card-glyph` (or custom `glyph` e.g. a `ProviderIcon`) + `title` + optional `badge` (`StatusBadge`), optional `.chip` row, a definition-style `meta` grid (`{label,value}[]`), trailing `actions`. Clickable/selectable for master-detail (`role="button"`, `aria-pressed`, `.is-selected` accent ring).
- **StatusBadge** — status pill. `Tone = ok|run|wait|fail|idle` mapped to `--ok/--run/--wait/--fail/--idle`; background is `color-mix(currentColor 16%)`. Helper `statusTone(status)` maps backend enums (succeeded/active/ready→ok, running→run, queued/pending→wait, failed/disabled/inactive→fail, canceled→idle, unknown→idle). Takes a pre-translated `label`.
- **Money** — renders a µcredit decimal string as locale-grouped human credits (via `lib/money.ts` `formatCredits`, BigInt math, no JS float), `.tabular` numerics.
- **ProviderIcon** — real vendor brand marks (local SVGs under `assets/providers`, inlined base64). Resolves a `provider` string to a brand by normalized-substring `match` (20 vendors incl. OpenAI, Anthropic, Gemini, xAI, DeepSeek + many CN vendors, Kling/Vidu, Cloudflare, Dify). Renders on a soft `.provider-tile` app-tile (or `.provider-tile--dark` for white-on-dark marks like Kimi); unknown providers fall back to a first-letter glyph; optional `showLabel`.
- **SecretSelect** — credential picker: TanStack-query loads secrets (`qk.secrets()`), options labelled `id · provider`; always surfaces the currently-set value even if not in the loaded page; with `label` → `SelectField`, without → bare `Select` (TopBar filter).
- **TenantSelect** — tenant picker (`qk.tenants()`); options = `{ id, name }`; with `label` → stacked `SelectField`, without → compact bare `Select` for the TopBar filter slot.
- **CapabilitiesField** — controlled toggle group over a `Record<string, boolean>` model `capabilities` map; one `Toggle` per known `CAPABILITIES` flag (i18n-labelled) plus a toggle per unknown extra key (so synced flags aren't dropped); `onChange` returns the full record; composed on `FormField`.
- **IoSchemaField** — structured `ioSchema` builder: two `FieldSection`s (Inputs/Outputs), each an add/remove list of field rows (key `TextField`, type `SelectField`, `required` `Toggle`, optional label/maxLength, and for `enum` an options `ChipsField`); emits `{ inputs, outputs }` of raw `IoField[]` (shape/helpers in `ioSchemaShape.ts`).
- **PricebookSpecForm** — per-method pricing `spec` builder; renders only the branch for the chosen `PricebookMethod`: `unit` (dimension name+rate rows), `matrix` (key `ChipsField` + cell rows + multiplier/perItem), `formula` (expr `TextField` with `validateFormula`), `passthrough` (markup toggle + percent/flat type+value), `fixed` (note pointing to the pricing modal). Rates are µcredits (1 credit = 1,000,000 µcredits). Logic/types in `pricebookSpec.ts`.
- **CopyField** — read-only `<code>` value (`.panel`) + ghost copy `Button` that writes to `navigator.clipboard` and flips to `copiedLabel` for 2s.
- **MockBadge** — small warm "演示数据 (mock)" pill (`FlaskIcon` + `--wait` tone, `color-mix 16%` bg) shown near a title so pre-backend billing mock pages aren't mistaken for live data; `title` carries the longer note.

---

## 4. GLASS / MOTION / THEME

### `glass/AppBackground.tsx`

Ambient **aurora background** behind the glass chrome: three warm blurred radial-gradient blobs (`--b1/--b2/--b3`, blur `var(--blur)`) that (a) idle-drift autonomously (GSAP yoyo sine tweens), (b) **parallax** to the pointer (depth-scaled `quickTo`), and (c) drive a cursor **spotlight** (`--spot`). All ambient motion is gated to `prefers-reduced-motion: no-preference` via `gsap.matchMedia` (nothing moves when reduced). Fixed, `z:0`, `pointer-events:none`, `aria-hidden`. Optional `grid` prop adds the masked `.bg-grid` dot grid.

### `glass/SpotlightCard.tsx`

`.glass .glass-hover .spotlight-card` card with a **cursor-following warm radial glow** (`--mx/--my` CSS custom props set on pointer-move; CSS `.spotlight-glow` draws a `--accent`-tinted radial). Pointer-driven only, so it needs no animation and works fine under reduced motion.

### `lib/motion/` — GSAP tokens + reduced-motion

- `gsap.ts` registers `useGSAP` + `ScrollTrigger` and sets global defaults `{ ease:'power3.out', duration: DUR.slow }`. Re-exports `gsap`, `ScrollTrigger`, `useGSAP`.
- `tokens.ts` — `DUR { instant:0.12, fast:0.18, base:0.26, slow:0.42, slower:0.7 }` (seconds, mirroring `--dur-*` CSS vars) and `EASE { out:'power3.out', in:'power2.in', inOut:'power2.inOut', spring:'elastic.out(1,0.45)' }`.
- `useReducedMotion.ts` — `useReducedMotion(): boolean` subscribing to `(prefers-reduced-motion: reduce)`. The convention across the codebase: **autonomous/decorative** motion is gated via `gsap.matchMedia('(prefers-reduced-motion: no-preference)')`; **interactive** components read `useReducedMotion()` to drop transitions; and `index.css` has a global reduced-motion safety net collapsing all CSS animations/transitions.

### `lib/theme/ThemeProvider.tsx` — light/dark mechanism

`Theme = 'dark' | 'light'`. Initial theme: `localStorage['actionow.theme']` else `prefers-color-scheme`. On change it sets `document.documentElement[data-theme]` and persists to localStorage. Exposes `useTheme(): { theme, toggle }`. The actual palette swap is pure CSS: `theme.css` defines dark tokens under `:root` and overrides under `[data-theme='light']`. `body` has a 0.5s background/color transition. Surfaced in the UI by `Rail` (rail cluster), `TopBar` (mobile), and the standalone `layout/ThemeToggle.tsx` (glass pill, Moon/Sun) and `layout/LanguageSwitch.tsx`.

### `brand/Logo.tsx`

Single geometric brand mark: a gradient (`--grad-accent`) rounded square containing a hexagon SVG (`M12 3l8 4.5v9L12 21l-8-4.5v-9z`, `--ink` stroke, `--shadow-accent-sm`) + the `t('brand')` wordmark (`fw 700`, `--fs-md`). Parametric `size` (default 26). The same hexagon glyph appears as the Rail home button.

---

## 5. DESIGN TOKENS (`styles/theme.css`)

All tokens are CSS custom properties on `:root` (dark) with a `[data-theme='light']` override block. `color-scheme` flips dark↔light.

**Accent / brand (constant across themes):** `--accent:#ffd60a`, `--accent-2:#ff9f0a`, `--ink:#1c1500`, `--grad-accent: linear-gradient(135deg, var(--accent), var(--accent-2))`.

**Typography scale (`--fs-*`):** `nano 9px`, `micro 10px`, `caption 11px`, `sm 13px`, `base 15px`, `md 16px`, `lg 18px`, `xl 24px`, `2xl 30px`; fluid: `h2 clamp(26,3.4vw,40)`, `h1 clamp(28,3.4vw,46)`, `display clamp(40,8vw,104)`. Weights: `--fw-medium:600`, `--fw-semibold:700`, `--fw-bold:800`. Letter-spacing: `--track-tight:-0.03em`, `--track-snug:-0.015em`. Font stack: `-apple-system, system-ui, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif`; helpers `.tabular` (tabular-nums) and `.mono` (`ui-monospace, 'SF Mono', Menlo…`).

**Spacing (8px grid, `--s-*`):** `1=4`, `2=8`, `3=12`, `4=16`, `5=20`, `6=24`, `8=32`, `10=40`, `16=64`. Layout: `--content-max:1200px`.

**Radii:** `--r-xs:8`, `--r-sm:11`, `--r-md:14`, `--r-lg:18`, `--r-pill:999px`.

**Motion tokens:** `--dur-instant:.12s` … `--dur-slower:.7s`; `--ease-out: cubic-bezier(0.2,0.8,0.2,1)`, `--ease-in: cubic-bezier(0.4,0,1,1)`.

**Color tokens (dark / light):** `--bg` (#0c0b09 / #f3f0e7), `--text` (#f2efe6 / #272219), `--muted`, `--faint`; status `--ok/--run/--wait/--fail/--idle` (theme-tuned). Surfaces: `--glass-bg/-bd/-hl`, `--panel-bg`, `--panel-bd`, `--overlay-bg` (near-opaque for menus/modals/sticky cells), `--nav-bg`, `--hover-bg`/`--hover-bd`, `--row-bd`, `--scrim`, `--grid-dot`. Aurora blobs `--b1/--b2/--b3`, spotlight `--spot`, blur `--blur` (70px / 60px).

**Shadows / glows:** `--glass-shadow` (inset highlight + drop), `--shadow-lift` (tight list-card lift), `--shadow-cta`/`--shadow-cta-hover` (warm CTA glow, no dark contact ring), `--glow-accent`/`--glow-accent-strong`, `--shadow-accent-sm/-md/-card`.

**Utility classes (`glass.css`):** `.glass` (blur(22px) saturate(170%) + glass border/shadow), `.panel` (blur(10px), `--panel-bg`/`--panel-bd`), `.glass-hover` (warm-tinted lift), `.btn-tactile` (physical push), `.ico-btn`/`.ico-tip` (console icon button + slide-out tooltip), `.row-action`, `.entity-card` (+ `.is-clickable`/`.is-selected`), `.card-glyph`, `.chip`, `.provider-tile`(`--dark`), `.bg-grid`, `.spotlight-card`/`.spotlight-glow`, `.dt-row`, `.logo-marquee*`, `.refresh-spin`. **Global rules** (`index.css`/`theme.css`): focus-visible ring is always `2px solid var(--accent)` (never browser blue), warm tap-highlight and `::selection`, smooth-scroll only under no-preference, a reduced-motion safety net, and a `prefers-reduced-transparency: reduce` fallback that drops backdrop-filters to opaque surfaces.

**Color discipline:** the entire system deliberately uses **warm amber/gold** for every accent/active/focus/hover state — comments throughout repeatedly note "never blue."

---

## 6. RESPONSIVE BREAKPOINTS & `useMediaQuery`

### `lib/breakpoints.ts`

Canonical `matchMedia` strings in `BP`:

- `sm: (min-width: 640px)`
- `md: (min-width: 768px)` — **the console desktop/mobile boundary** (Rail+SubNav+TopBar cluster vs BottomTabs; DataTable table vs stacked cards; LanguageSwitch label visibility)
- `wide: (min-width: 880px)`
- `lg: (min-width: 960px)` — hero/bento two-column (also hard-coded `@media (min-width:960px)` in `glass.css`)
- `xl: (min-width: 1100px)`
- `xxl: (min-width: 1280px)` — master-detail side-by-side (list column + data table)

### `lib/useMediaQuery.ts`

`useMediaQuery(query): boolean` — SSR-safe initial read from `window.matchMedia(query).matches`, subscribes to `change`, cleans up on unmount. It is the single switch that drives the entire console layout: `ConsoleLayout`, `TopBar`, `DataTable`, and `LanguageSwitch` all call `useMediaQuery(BP.md)` to flip between desktop and mobile chrome; `DataTable`'s sticky-pin logic and `LanguageSwitch`'s inline label/padding also key off it. Note: some hero/landing layout (`hero-grid`, `hero-bento`, `how-rail`, `headline-nowrap`) is done purely in CSS `@media` queries rather than via the hook.

## D. Audience & Visibility Model

# Actionow — Audience & Visibility Model

This report documents who the Actionow frontend (`actionow-web`) and backend (`actionow-core`) are built for, how each audience is gated, and where the model has gaps. Key source files:

- Frontend auth: `/Users/alienworm/actionow-web/apps/web/src/lib/auth/{AuthProvider.tsx,ProtectedRoute.tsx,jwt.ts}`
- Frontend routing/nav: `/Users/alienworm/actionow-web/apps/web/src/routes.tsx`, `/Users/alienworm/actionow-web/apps/web/src/components/console/nav-config.ts`
- Post-auth redirect: `/Users/alienworm/actionow-web/apps/web/src/features/auth/AuthPage.tsx`
- Backend guards: `/Users/alienworm/actionow-core/apps/api/src/admin/auth/{admin.guard.ts,roles.decorator.ts,admin-auth.service.ts}`, `/Users/alienworm/actionow-core/apps/api/src/console/console.guard.ts`, `/Users/alienworm/actionow-core/apps/api/src/auth/{api-key.guard.ts,local-auth.service.ts,auth.service.ts}`

---

## 1. The distinct product audiences

There are four audiences. Critically, the auth substrate is **one unified `user` table with a `role` column** — the operator is _not_ a separate identity system; an operator is just a `user` whose `role === 'admin'`.

### (a) Operator / Admin — runs the platform

- **Definition:** The person operating the Actionow instance. Owns the entire `/console/*` admin console UI (dashboard, catalog of models/resources, route groups, official prices, pricing modifiers, Dify import, tenants, accounts, and platform-wide API-key administration).
- **Identity:** a `user` row with `role === 'admin'`. Authenticates at `/login` (same page as everyone). Login is also accepted by the dedicated backend admin-auth path (`admin-auth.service.ts`), which additionally _requires_ `user.role === 'admin'` and an active account before minting a token.
- **Token:** `{sub, role}` JWT signed with `ADMIN_JWT_SECRET`.
- **Backend data plane:** `/admin/*` endpoints.

### (b) Tenant self-service end-user

- **Definition:** A self-registered user who owns their own tenant + billing account. On `register` (`local-auth.service.ts`), the backend provisions a fresh `tenant` + `account` and creates the user with `role === 'user'` pointing at that tenant. Their UI is the single `/app` page.
- **Identity:** a `user` row with `role === 'user'` (or any non-`admin` role) and a non-null `tenant_id`.
- **Token:** the SAME `{sub, role}` JWT shape, also signed with `ADMIN_JWT_SECRET` (admin and user JWTs are signature-interchangeable; they differ only by the `role` claim and which user the `sub` resolves to).
- **Backend data plane:** the `/console/*` API (note: this is a _different_ surface from the operator's `/console/*` **frontend** route — see the naming-collision note in Gaps). The `/console` API is tenant-self-service: mint/list/rotate/disable **your own** tenant's API keys, view your usage (jobs + ledger), list models visible to you, and self-top-up credits. Tenant is always taken from the guard, never from the request body.

### (c) Developer integrators

- **Definition:** Programs/integrations that consume the `/v1/*` data plane using a tenant API key (`ak_...`). These are OpenAI/Anthropic/Gemini-compatible chat, run, jobs, files, models, payments, and callbacks endpoints.
- **Identity:** a hashed API key bound to a tenant (and optionally a `routeGroupId`, a resource allowlist, and a rate limit).
- **UI:** **None of their own.** Developers are purely programmatic. They obtain keys through one of the two human UIs (operator's admin console, or — in principle — the tenant console API), but the `/v1/*` consumption itself has no frontend.
- **Backend data plane:** all `/v1/*` controllers (`v1/chat`, `v1`, `v1beta/models`, `v1/models`, `v1/run`, `v1/jobs`, `v1/resources`, `v1/files`, `v1/payments`, `v1/callbacks`).

### (d) Public / unauthenticated

- **Definition:** Anyone not logged in. Sees the marketing landing page (`/`) and the combined login/register page (`/login`).
- **Identity:** none.

### Audience overlaps

- **Operator ⊂ users.** The operator is just an admin-role tenant user; there is no separate operator account model. The same `/login` page authenticates both, and `AuthPage.tsx` redirects post-auth purely on the role claim: `user.role === 'admin' → /console/dashboard`, else `→ /app`.
- **Tenant user ↔ developer.** They are two faces of the same tenant: the human logs into `/console` API to mint a key; the key then drives `/v1` as a "developer." A self-registered user therefore can bootstrap from human UI to programmatic access entirely on their own.
- Admins also have a `tenant_id`/account if seeded that way, so an admin token can technically also satisfy the ConsoleGuard — see Gaps.

---

## 2. Frontend route gating

### `ProtectedRoute` (`ProtectedRoute.tsx`)

Two modes, driven by the optional `role` prop:

- **No `role`** → any authenticated user. Unauthenticated → `<Navigate to="/login">`.
- **`role="admin"`** → must be authenticated AND `user.role === role`. A logged-in non-admin is **bounced to `/app`** (not to login); an unauthenticated visitor goes to `/login`.

### `role` values on the principal

The principal (`AuthUser = { id, role }`) carries a free-form string `role`. In practice two values exist: **`admin`** (operator) and **`user`** (self-service tenant). `register` always issues `user`; admin seeding issues `admin`. The frontend only ever compares against the literal `'admin'`, so any non-`admin` role is treated as a plain authenticated user.

### JWT storage & reading (`jwt.ts` + `AuthProvider.tsx`)

- **Stored** in `localStorage` under key `actionow.token`.
- **Decoded, not verified** client-side: `decodeJwt` base64-decodes the payload segment and reads `{sub, role, exp}` (UI gating only — "The server verifies; this is for UI gating only").
- **Expiry handled client-side:** `loadToken` drops an expired/malformed token on boot; a `window` `focus` listener re-checks expiry and clears the token if stale. The API client also clears the token on any `401` (`onUnauthorized`).
- `user` is derived from the token: `{ id: claims.sub, role: claims.role }`. `isAuthed = token !== null`.

---

## 3. Backend guard → audience mapping

| Guard                              | File                                              | Token / credential                            | Verifies                                                                                                                                                                | Attaches                                                                                 | Audience served                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **AdminGuard + `@Roles('admin')`** | `admin/auth/admin.guard.ts`, `roles.decorator.ts` | Bearer JWT                                    | signature against `ADMIN_JWT_SECRET`; then `@Roles` metadata (empty/absent → any admin; present → role must be in list)                                                 | `req.admin = {adminId, role}`                                                            | (a) Operator/Admin. The whole `admin.controller.ts` is `@UseGuards(AdminGuard)` + `@Roles('admin')` at the class level.                                      |
| **ConsoleGuard**                   | `console/console.guard.ts`                        | Bearer **user** JWT                           | signature against `ADMIN_JWT_SECRET` (same secret), then loads user by `sub` and requires `status==='active'` AND non-null `tenant_id` AND a resolvable billing account | `req.console = {userId, tenantId, accountId}`                                            | (b) Tenant self-service. Note it does **not** check `role` — any active user with a tenant passes.                                                           |
| **ApiKeyGuard**                    | `auth/api-key.guard.ts`                           | `Authorization: Bearer ak_...` or `x-api-key` | sha256-hash lookup of an `active` key; enforces the key's `resourceAllowlist` against `:resourceId`                                                                     | `req.auth = {tenantId, accountId, apiKeyId, resourceAllowlist, rateLimit, routeGroupId}` | (c) Developer integrators (`/v1/*`). Has a **dev-only `x-tenant-id` fallback**, gated to `NODE_ENV !== 'production'` AND explicit `ALLOW_DEV_TENANT_HEADER`. |

Supporting note: `auth/auth.service.ts` is **not** a guard — it projects the `ApiKeyGuard`-populated `req.auth` into the narrower `TenantContext` the run/jobs/relay services consume, failing closed if `req.auth` is absent (a wiring bug). Token issuance for audiences (a)/(b) lives in `admin-auth.service.ts` and `local-auth.service.ts`; both sign the same `{sub, role}` shape with `ADMIN_JWT_SECRET`.

---

## 4. Visibility matrix (frontend route → audience → data guard)

| Frontend route                                                                                     | Frontend gate                 | Audience(s)                                              | Backend guard for its data                                                              |
| -------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `/` (LandingPage)                                                                                  | none                          | (d) Public                                               | none                                                                                    |
| `/login` (AuthPage)                                                                                | none                          | (d) Public; produces (a) or (b)                          | `local-auth.controller` / `admin-auth.controller` (login/register; no guard)            |
| `/app` (UserHome)                                                                                  | `ProtectedRoute` (any auth)   | (b) Tenant user (and any logged-in admin who lands here) | `/console/*` API → **ConsoleGuard** (note: `/app` is currently a placeholder, see Gaps) |
| `/console` → redirect to `/console/dashboard`                                                      | `ProtectedRoute role="admin"` | (a) Operator                                             | —                                                                                       |
| `/console/dashboard`                                                                               | `role="admin"`                | (a) Operator                                             | **AdminGuard + @Roles('admin')** (`/admin/*`)                                           |
| `/console/catalog` (models + resources tabs)                                                       | `role="admin"`                | (a) Operator                                             | AdminGuard + @Roles('admin')                                                            |
| `/console/resources`, `/console/resources/:id`, `/console/models` (legacy → redirect into catalog) | `role="admin"`                | (a) Operator                                             | AdminGuard + @Roles('admin')                                                            |
| `/console/modifiers`                                                                               | `role="admin"`                | (a) Operator                                             | AdminGuard + @Roles('admin')                                                            |
| `/console/groups` (route groups — mock-skeleton)                                                   | `role="admin"`                | (a) Operator                                             | AdminGuard + @Roles('admin') (route-group CRUD exists; page wired to `mockBilling.ts`)  |
| `/console/official-prices` (mock-skeleton)                                                         | `role="admin"`                | (a) Operator                                             | AdminGuard + @Roles('admin')                                                            |
| `/console/dify` (Dify import)                                                                      | `role="admin"`                | (a) Operator                                             | AdminGuard + @Roles('admin') (`admin-dify.controller`)                                  |
| `/console/tenants`                                                                                 | `role="admin"`                | (a) Operator                                             | AdminGuard + @Roles('admin')                                                            |
| `/console/accounts`                                                                                | `role="admin"`                | (a) Operator                                             | AdminGuard + @Roles('admin')                                                            |
| `/console/api-keys`                                                                                | `role="admin"`                | (a) Operator                                             | AdminGuard + @Roles('admin') (admin api-key CRUD)                                       |
| `*` (anything else)                                                                                | redirect to `/`               | (d) Public                                               | none                                                                                    |
| — (no frontend route)                                                                              | —                             | (c) Developer                                            | `/v1/*` → **ApiKeyGuard**                                                               |

The console frontend nav (`nav-config.ts`) groups these admin leaves into four responsibility groups: **ops** (dashboard), **catalog** (catalog, dify), **billing** (groups, official-prices, modifiers), **tenants** (tenants, accounts, api-keys). Mobile tabs surface dashboard / catalog / tenants / api-keys.

---

## 5. Gaps & sharp edges

**1. There is NO real tenant-facing UI beyond a placeholder `/app`.** `UserHome.tsx` renders only an `app.soon` / `app.hint` "coming soon" glass card with Back-home and Logout buttons. It makes **zero** API calls. So although the backend has a complete tenant self-service plane (the `/console` API + ConsoleGuard: mint/list/rotate/disable own keys, usage, models, self-top-up), **the frontend exposes none of it.** Audience (b) is fully implemented on the server and essentially unbuilt on the client.

**2. Two parallel API-key surfaces exist, and they are asymmetric:**

- **Operator-managed:** `admin.controller.ts` (`@Roles('admin')`) — `POST/GET /admin/api-keys`, `PATCH /admin/api-keys/:id/group`, `DELETE /admin/api-keys/:id`. The operator creates keys _for any tenant_ (tenant supplied in the body) and binds them to route groups. This is the **only** api-key UI that actually ships, at `/console/api-keys`.
- **Tenant self-service:** `console.controller.ts` (ConsoleGuard) — `POST/GET /console/api-keys`, `POST /console/api-keys/:id/rotate`, `DELETE /console/api-keys/:id`. Always scoped to _your own_ tenant from the guard. The controller doc explicitly frames this as closing an audited gap so a self-registered user can mint its own key and call `/v1`. **But there is no frontend for it** (see gap 1). So developer api-key self-service is implemented on the backend but, in the shipped UI, keys are **operator-managed only.** Note the tenant self-service surface lacks a group-bind endpoint (only the admin surface can bind a key to a route group).

**3. Naming collision: `/console` means two different things.** Frontend `/console/*` = the **operator** admin console (gated `role="admin"`, talks to `/admin/*`). Backend `/console/*` = the **tenant self-service** API (ConsoleGuard). They share a path prefix but serve opposite audiences. Anyone reading the codebase must disambiguate frontend-route-`/console` (operator) from backend-API-`/console` (tenant).

**4. ConsoleGuard ignores `role`.** It admits any active user with a tenant + account, so an admin who also has a tenant could call the tenant `/console` API. Conversely, `/app`'s frontend gate is "any authenticated," so an admin who navigates to `/app` is allowed in (and the `role="admin"` console gate bounces non-admins to `/app`). Authorization boundaries are therefore tenant/role-correct on the _admin_ plane (hard `@Roles('admin')`) but role-agnostic on the _console/tenant_ plane.

**5. Client-side role gating is advisory only.** `jwt.ts` decodes without verifying and `ProtectedRoute` trusts the decoded `role`. This is fine because every data path is re-checked by a server guard (AdminGuard verifies the signature and re-enforces `@Roles`), but it means the frontend route gating is cosmetic — security rests entirely on the three backend guards.

**6. Billing/routing pages are mock skeletons.** `/console/groups` and `/console/official-prices` are wired to `src/lib/api/mockBilling.ts` per `nav-config.ts` and `routes.tsx` comments, even though the backend has real route-group CRUD and an official-price catalog. The UI is design-only ahead of backend wiring there.

---

# Part III — Per-Page Specs

## 1. Landing — `/`

**Audience:** Public / unauthenticated visitors, Prospective operators (self-host evaluators), Returning operators/tenants (via Console / Login entry) · **Data status:** `static` · **Verify severity:** `clean`

**Backend endpoints**

_(no backend endpoints — static/client-only)_

**Components:** `AppBackground`, `SpotlightCard`, `Logo`, `Button`, `LanguageSwitch`, `ThemeToggle`, `ProviderIcon`, `FlipWords`, `ProviderLogos`, `Reveal`

## Landing page (`/`) — design + data spec

### 1. PURPOSE & AUDIENCE

- **Who:** Audience (d) Public / unauthenticated visitors. The marketing front door for the Actionow product, pitched at prospective **operators** who will self-host the gateway/relay.
- **Guard:** **None.** `routes.tsx:29` mounts `<Route path="/" element={<LandingPage />} />` outside every `ProtectedRoute`. No auth, no JWT, no API client is touched.
- **Positioning (from copy in `i18n/locales/en/landing.json`):** "Self-host your own AI gateway & relay" — multi-tenant accounts, credit billing, payments, and OpenAI/Anthropic/Gemini-compatible endpoints out of the box. The two scenarios are "back your own app" and "run a model relay."
- **Conversion paths (3 CTAs, all to auth):**
  - `Nav` "Console" button → `Button to="/console"` (`Nav.tsx:70,123`). Because `/console` is gated `role="admin"`, an unauthenticated click resolves to `<Navigate to="/login">` via `ProtectedRoute`. So in practice this lands on `/login`.
  - Hero primary "Deploy now" → `Button to="/login"` (`ImmersiveHero.tsx:72`).
  - Hero secondary "Read the docs" → `Button href="#features"` (anchor scroll, `ImmersiveHero.tsx:75`).
  - `CTASection` "Open the console" → `Button to="/login"` (`CTASection.tsx:39`).
  - `Footer` "Console" link → `to="/login"` (`Footer.tsx:27`); "Docs" → `href="#"` (dead anchor).

### 2. CONTENT / INFORMATION ARCHITECTURE

Composition is fixed in `LandingPage.tsx`: `<AppBackground grid />` (z-0 aurora + dot grid) then a `zIndex:1` column of `<Nav/>` + `<main>` holding the seven scroll sections + `<Footer/>`. Section order and content:

1. **Nav** (`Nav.tsx`) — sticky glass header (`z:40`). Left: `<Logo/>`. Desktop (`useMediaQuery(BP.md)`): three in-page anchor links — Use cases (`#scenarios`), Capabilities (`#features`), **Docs label mapped to `#pricing`** (note the mismatch: `links[2]` uses `t('nav.docs')` text but `href:'#pricing'`, `Nav.tsx:27`). Right cluster: `LanguageSwitch`, `ThemeToggle`, CTA `Button to="/console"`. On scroll past 8px the nav background flips `--glass-bg` → `--nav-bg` (opaque) via a `scroll` listener. Mobile: hamburger toggles a glass dropdown with the same links + controls.
2. **ImmersiveHero** (`ImmersiveHero.tsx`) — full-viewport (`calc(100dvh - 84px)`), centered. `--fs-display` H1 with a gradient-clipped `FlipWords` kinetic word cycling `hero.flip` `["AI gateway","a model relay","credit billing","self-service"]`; lead paragraph; two CTAs; `<ProviderLogos/>` marquee; an `aria-hidden` scroll-down hint reading `live.title`. GSAP `fromTo` stagger reveal of `[data-r]` elements, gated to no-preference.
3. **LiveConsole** (`LiveConsole.tsx`) — a **faux** console window. Three stat tiles with GSAP **count-up** animations to **hard-coded** values: `tenants=128`, `calls=3402`, `spend=18.6k` (`STATS` array, lines 8–12). A `--log-ok`-colored mono "Live call log" panel of six **hard-coded** strings (`LOG` array, lines 15–22, e.g. `POST /v1/chat/completions · gpt-4o · 200 · 142ms`) whose opacity cycles like a live tail. Reduced motion → counts set to final immediately, no loop.
4. **Scenarios** (`Scenarios.tsx`, `#scenarios`) — two `SpotlightCard` tiles ("Back your own app" / "Run a model relay") with gradient glyph icons.
5. **FeaturePan** (`FeaturePan.tsx`, `#features`) — six capability panels (`protocol, selfservice, pricing, routing, billing, logs`). Desktop ≥`BP.wide` & not-reduced: a **pinned, horizontally-scrubbed** GSAP ScrollTrigger pan (`pin:true, scrub:1`). Mobile/reduced: plain vertical stack of the same `Panel`s.
6. **HowItWorks** (`HowItWorks.tsx`) — three numbered steps (deploy / configure / self-onboard) on a desktop flow rail.
7. **Pricing** (`Pricing.tsx`, `#pricing`) — **two static cards**: `self` (featured, "Open source", CTA "Read the docs", `href:'#'`) and `support` ("Contact us", `href:'#'`). The featured card gets `--shadow-accent-card`. **No live prices.**
8. **CTASection** (`CTASection.tsx`) — closing glass banner with radial glow + single CTA to `/login`.
9. **Footer** (`Footer.tsx`) — `Logo` + tagline, two link columns (Product: Capabilities/Pricing anchors; Resources: Docs `#`, Console `/login`), hard-coded `© 2026` line.

**Empty / loading / error states:** none exist and none are needed — there is no async data, no `useQuery`, no Suspense boundary, no skeletons. Every value is an i18n string or a literal array.

### 3. BACKEND ENDPOINTS

**None.** This page makes **zero** HTTP requests. It does not import `useAdminApi`, `useAuth`, `client.ts`, or `mockBilling.ts`. There are no reads and no writes. (Hence `endpoints[]` is empty.) The only "endpoint-like" strings are the cosmetic `LOG` literals inside `LiveConsole`, which are display text, not fetches.

### 4. DATA & CACHING

- **Entities fetched:** none. **TanStack Query keys used:** none. Nothing is cached and nothing **should** be cached for the current static design.
- **i18n** is the only data source: `useTranslation('landing')` across all components; `Footer` also pulls `common:brand`. Theme/locale come from `ThemeProvider`/`LanguageSwitch` (localStorage), not query cache.
- If live data were ever introduced (see §7), it must use **public, unauthenticated** endpoints only — but **no such endpoint exists** in the inventory. `GET /v1/models` and `GET /console/models` both require auth (ApiKeyGuard / ConsoleGuard). `STALE_REFERENCE` (60s) would be the correct tier for any catalog/pricing pull _if_ a public route is added. For now, `cached[]` is intentionally empty.

### 5. COMPONENTS & COMPOSITION

This page deliberately **bypasses the console design-system data components** (`DataTable`, `CardCollection`, `EntityCard`, `Modal`, `Drawer`, `StatusBadge`, `Money`, `FormField` set) — it is bespoke marketing markup. Components actually used:

- **From the design system:** `AppBackground` (with `grid`), `SpotlightCard` (Scenarios tiles), `Logo` (Nav + Footer), `Button` (`cta`/`ghost` variants, `to`/`href` routing), `LanguageSwitch`, `ThemeToggle`, `ProviderIcon` (vendor brand marks).
- **Landing-local components:** `FlipWords` (GSAP kinetic headline word), `ProviderLogos` (auto-scrolling `.logo-marquee` strip duplicating a 20-vendor `ProviderIcon` group), `Reveal` (scroll-triggered fade/lift wrapper used by Scenarios/HowItWorks/Pricing/CTASection).
- **Composition:** single-column scroll narrative (no master/detail, no table/drawer). Glass/`.panel` surfaces throughout; warm `--grad-accent` glyph chips; mono accents for eyebrows and log.

### 6. LAYOUT & TYPOGRAPHY

- **No console chrome.** Does NOT use `ConsoleLayout`/`Rail`/`SubNav`/`TopBar`/`BottomTabs` — it renders its own sticky `Nav` + `Footer`.
- **Section rhythm:** content sections are `maxWidth` 980–1080px, centered, `padding: var(--s-16) var(--s-4)` (64px vertical). Hero is full-bleed `100dvh`.
- **Heading hierarchy:** one H1 (`--fs-display`, weight 850) in the hero; every section uses H2 at `--fs-h2` (`clamp(26,3.4vw,40)`), weight ~780. Body copy `--fs-base`, `--muted`, `line-height` ~1.6.
- **Responsive:** driven by `useMediaQuery(BP.md)` (Nav desktop links vs hamburger) and `useMediaQuery(BP.wide)` (FeaturePan pinned pan vs vertical stack). Grids use intrinsic `repeat(auto-fit, minmax(...))` — no hook needed. Several effects use raw CSS `@media` (`.headline-nowrap`, `.how-rail`, `.logo-marquee`).
- **Motion:** GSAP everywhere, **universally gated** to `prefers-reduced-motion: no-preference` via `gsap.matchMedia` (hero/LiveConsole/Reveal/FlipWords) or `useReducedMotion()` (FeaturePan). Reduced motion degrades gracefully (static reveals, final counts, first flip word, scrollable marquee).

### 7. MOCK-vs-REAL & GAPS

- **Status: fully STATIC** (`mockStatus: static`). Not mockBilling, not real API — pure i18n strings + hard-coded literals. The note's hypothesis that pricing/model-list/provider-logos "could/should pull live data" is **not** wired anywhere today.
- **Hard-coded values that look live but aren't:**
  - `LiveConsole` stats `128 / 3402 / 18.6k` and the six `LOG` lines — purely decorative.
  - `Pricing` cards — two static tiers, both CTAs are dead `href:'#'`; **no `OfficialModelPrice` / `/admin/official-prices` data**.
  - `ProviderLogos` — a **static 20-string array** (`openai, anthropic, gemini, xai, deepseek, qwen, ...`), not derived from the model/channel registry.
- **What backend could it switch to?** Critically, **the inventory exposes no public/unauthenticated data endpoint.** `GET /v1/models` (ApiKeyGuard) and `GET /console/models` (ConsoleGuard) both need credentials; `/admin/official-prices` needs admin JWT. So the provider list and any "real" pricing **cannot** be fetched from the landing page without a new anonymous endpoint. Keeping these static is the **correct** current design.
- **Prioritized recommendations:**
  1. **Keep provider logos, stats, and pricing static** until a deliberately public, cache-friendly, unauthenticated read (e.g. a public marketing/`GET /public/models` or a build-time JSON) exists. Do **not** call guarded `/v1`, `/console`, or `/admin` endpoints from `/`.
  2. **Fix the `Nav` Docs link bug:** `links[2]` shows `t('nav.docs')` ("Docs") but scrolls to `#pricing` (`Nav.tsx:27`). Either relabel to "Pricing" or point a real docs link; the dead `href:'#'` Docs entries in `Footer`/`Pricing` should target real docs once they exist.
  3. **Console CTA target:** `Nav` sends to `/console` (admin-gated → redirects to `/login`), while hero/CTA send to `/login` directly. Consider unifying on `/login` for unauthenticated visitors to avoid an extra redirect hop.
  4. If "social proof" stats are ever made real, they need a public aggregate endpoint (none exists) — otherwise label them clearly as illustrative; today they risk reading as live metrics.

> **🔎 Verification notes:** **accurate** — spec checks out with minor refinements.
>
> **Components (10/10 exist):** all resolve to real files, though spread across multiple component subdirs, not just `landing/`:
>
> - `AppBackground` → `components/glass/AppBackground.tsx` (the page imports it from here, line 1 of LandingPage.tsx)
> - `SpotlightCard` → `components/glass/SpotlightCard.tsx`
> - `Logo` → `components/brand/Logo.tsx`
> - `Button` → `components/ui/Button.tsx`
> - `LanguageSwitch` → `components/layout/LanguageSwitch.tsx`
> - `ThemeToggle` → `components/layout/ThemeToggle.tsx`
> - `ProviderIcon` → `components/data/ProviderIcon.tsx`
> - `FlipWords` → `components/landing/FlipWords.tsx`
> - `ProviderLogos` → `components/landing/ProviderLogos.tsx`
> - `Reveal` → `components/landing/Reveal.tsx`
>
> **Endpoints:** spec correctly claims none. The landing page is a pure marketing/static page — `LandingPage.tsx` renders only presentational sections (Nav, ImmersiveHero, LiveConsole, Scenarios, FeaturePan, HowItWorks, Pricing, CTASection, Footer) with zero data fetching.
>
> **mockStatus = static — CONFIRMED, not even mock.** Verified across all landing components: no `fetch`, no `useQuery`/`useMutation`, no apiClient/axios, and **no import of `mockBilling.ts`**. Content is hardcoded:
>
> - `LiveConsole.tsx` — `STATS` (tenants/calls/spend) and the request `LOG` lines are hardcoded constants animated via GSAP count-up; the `/v1/...` strings in `LOG` are decorative display copy, NOT real HTTP calls.
> - `Pricing.tsx` — two hardcoded cards (`self`, `support`) with `href: '#'`, all text from i18n `landing` namespace. No price data fetched.
>
> `mockBilling.ts` (`lib/api/mockBilling.ts`) exists but is consumed only by console pages (`RouteGroupsPage`, `OfficialPricesPage`, `routes.tsx`, nav-config, types) — never by the landing page.
>
> **Refinement:** the LiveConsole's hardcoded log lines (e.g. `POST /v1/chat/completions`, `/v1/images/generations`, `/v1/video/generations`, `/v1/audio/speech`, `/v1/embeddings`) are illustrative and do not all map to verified backend routes — but since they are static text rather than endpoints the page invokes, they are correctly excluded from phantomEndpoints.

## 2. Auth (Login/Register) — `/login`

**Audience:** Public / unauthenticated visitors, Operator / Admin (role=admin), Tenant self-service end-user (role=user) · **Data status:** `real` · **Verify severity:** `minor`

**Backend endpoints**

| Method | Path                 | Purpose                                                                                                                                  |
| ------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/auth/login`        | Tenant + admin login. Body {email,password}; returns 200 {token} (JWT). Bad creds → 401. Called via AuthProvider.login().                |
| `POST` | `/auth/register`     | Self-registration; provisions tenant+account, role=user. Body {email,password}; returns 200 {token}. Called via AuthProvider.register(). |
| `GET`  | `/auth/oauth/google` | OAuth start (full-page <a href> navigation). Only rendered when config.oauthEnabled (VITE_OAUTH_ENABLED='true'). 302 to provider.        |
| `GET`  | `/auth/oauth/github` | OAuth start (full-page <a href> navigation). Gated behind config.oauthEnabled. 302 to provider.                                          |

**Cached entities:** NOTHING cached here — auth is the un-TanStack-Query'd entry point. login/register go through a throwaway createClient({getToken:()=>null}).post, NOT the queryClient. No qk.\* key, no useQuery/useMutation. The minted JWT is persisted to localStorage['actionow.token'] (NOT the query cache) and the AuthProvider derives user={id:claims.sub,role:claims.role} from it.

**Components:** `AppBackground (grid)`, `Logo`, `FlipWords`, `LanguageSwitch`, `ThemeToggle`, `SegmentedControl`, `TextField`, `Button (cta + ghost + link variants)`, `toast / Toaster`, `useGSAP / gsap.matchMedia motion`

## Auth (Login / Register) — `/login`

Primary file: `/Users/alienworm/actionow-web/apps/web/src/features/auth/AuthPage.tsx`. Auth substrate: `/Users/alienworm/actionow-web/apps/web/src/lib/auth/AuthProvider.tsx`, `/Users/alienworm/actionow-web/apps/web/src/lib/auth/jwt.ts`. Config: `/Users/alienworm/actionow-web/apps/web/src/config.ts`. HTTP: `/Users/alienworm/actionow-web/apps/web/src/lib/api/client.ts`.

### 1. PURPOSE & AUDIENCE

- The single combined **login + register** screen. It is the only credential-minting UI in the whole app — both operators (admins) and tenant self-service users authenticate here. There is no separate admin login page.
- **Guard:** none. In `routes.tsx` it is a bare public route: `<Route path="/login" element={<AuthPage />} />`, a sibling of `/` (LandingPage). It is NOT wrapped in `ProtectedRoute`. Anyone may reach it.
- **It produces audience identity, it does not consume it.** On success the page mints a `{sub, role}` JWT and dispatches purely on the `role` claim (`AuthPage.tsx:177`): `navigate(user.role === 'admin' ? '/console/dashboard' : '/app', { replace: true })`. Admins land in the operator console; everyone else lands on `/app` (the placeholder tenant home).
- **Admin vs tenant flow is NOT distinguished by endpoint.** This is the key finding for the NOTES question: the SPA calls a single pair of endpoints — `POST /auth/login` and `POST /auth/register` — via `config.authBase = '/auth'`. It never calls `/admin/auth/login`. Admin-ness is decided _server-side_ (the unified `user` table has a `role` column) and surfaced to the client only through the `role` claim inside the returned JWT. So "admin login" and "tenant login" are the same HTTP call with the same body shape; only the role embedded in the response token differs, and the post-auth redirect branches on it.

### 2. CONTENT / INFORMATION ARCHITECTURE

**Current state (fully built, not a skeleton):** Two-column responsive layout.

**Left column — `BrandPanel` (desktop only, ≥880px / `BP.wide`):** marketing/brand content, no inputs. Contains `Logo` (size 30), a fluid `--fs-h1` headline mixing `landing:hero.title1` + a `FlipWords` animated gradient word-cycler (`landing:hero.flip` array) + `landing:hero.title2`, a lead paragraph (`auth.brandLead`), a 3-item check-bulleted value list (`auth.b1/b2/b3` with filled `CheckCircleIcon`), and a **fake "live mini console"** glass card showing a hardcoded `LOG` array of 4 sample relay lines (`chat.completions · gpt-4o · 200`, etc.) with an animated opacity tail. This telemetry is purely decorative/static — not fetched.

**Right column — the auth card (`<form className="glass auth-form">`, width `min(400px,92vw)`):**

- On mobile only, a `Logo` (size 28) sits at the top of the card (since the BrandPanel is hidden).
- A `SegmentedControl` toggling `login` ⟷ `register` (`auth.loginTab` / `auth.registerTab`).
- A mode-dependent body (`bodyRef`) that GSAP cross-fades on toggle:
  - `TextField` — Email, `type="email"`, `autoComplete="username"`, `required`.
  - `TextField` — Password, `type="password"`, `autoComplete` switches `current-password` (login) ↔ `new-password` (register), `required`.
  - Submit `Button` (`variant="cta" size="lg" type="submit"`, `loading={busy}`) with a trailing `ArrowRightIcon`; label switches `auth.loginSubmit` ↔ `auth.registerSubmit`.
  - **OAuth block, conditionally rendered behind `config.oauthEnabled`** (`VITE_OAUTH_ENABLED === 'true'`, default off): an "or" divider + two `Button variant="ghost"` anchors → `<a href="/auth/oauth/google">` and `<a href="/auth/oauth/github">`. These are full-page navigations, not fetch calls. Default build hides them.
  - A footer line with an inline `Button variant="link"` that flips mode (`auth.toRegister`/`auth.toRegisterCta` ↔ `auth.toLogin`/`auth.toLoginCta`) — a redundant second path to the same toggle as the SegmentedControl.
- Top-right floating cluster (`position:absolute`): `LanguageSwitch` + `ThemeToggle`.

**States:**

- **Loading/submitting:** local `busy` boolean → the CTA Button shows its spinner + `aria-busy`; there is no page-level skeleton (no data is fetched on mount).
- **Success:** `toast(auth.registered | auth.loggedIn)`, a brief GSAP scale "successCue" on the submit button, then redirect.
- **Error:** `shake()` (GSAP elastic x-shake + a `--fail` border pulse on the card) + a toast. On `ApiError` it localizes `errors.<code>` (e.g. `errors.unauthorized` for 401 bad creds, `errors.invalid_input` for 400 malformed body) with `auth.failed` as i18n fallback; otherwise `errors.network`. Note: the `errors.*` namespace exists in `console.json` (includes `unauthorized`, `invalid_input`, `internal_error`, `network`).
- **Empty:** N/A — no lists.

**What it SHOULD additionally contain (gaps):** no client-side field validation beyond the native `required`/`type=email` (no password-strength meter on register, no inline error props passed to `TextField` even though it supports `error`); no "forgot password" affordance (no backend endpoint exists for it either); no rate-limit/`retry_after_ms` surfacing despite `ApiError` carrying `retryAfterMs`. The OAuth callback (`GET /auth/oauth/:provider/callback` → `{token}`) has **no SPA route** to receive the token, so even with `oauthEnabled` the round-trip is incomplete on the frontend side.

### 3. BACKEND ENDPOINTS

- `POST /auth/login` — body `{ email, password }`; `200 { token }`; bad creds → 401, malformed → 400 `invalid_input`. (Inventory §4.)
- `POST /auth/register` — body `{ email, password }`; `200 { token }`; provisions tenant + account, role=`user`.
- `GET /auth/oauth/google` / `GET /auth/oauth/github` — full-page `<a href>` redirects, gated behind `oauthEnabled`.
- **NOT used by this page:** `POST /admin/auth/login` (admin login goes through the same `/auth/login`); `GET /auth/oauth/:provider/callback`; `POST /auth/link/:provider`.

Wiring: `AuthProvider.authenticate(path,…)` builds the URL as `config.authBase + path` (`/auth/login` or `/auth/register`) and POSTs via a **throwaway** `createClient({ getToken: () => null, onUnauthorized: () => undefined })` so no stale token is attached and a 401 here does NOT trigger the global logout hook. It then `decodeJwt(r.token)` (throwing a synthetic `ApiError('invalid_input','malformed token',200)` if unparseable), persists to `localStorage['actionow.token']`, and `setToken`.

### 4. DATA & CACHING

- **No TanStack Query usage at all on this page.** No `qk.*` key, no `useQuery`/`useMutation`/`useInfiniteQuery`, no `staleTime` tier. Auth is deliberately outside the query cache.
- The only persisted state is the **JWT in `localStorage['actionow.token']`** (key `TOKEN_KEY`). `AuthProvider` holds it in React state + a `tokenRef`; `user` is derived via `userFromToken` → `{ id: claims.sub, role: claims.role }`; `isAuthed = token !== null`.
- **Token lifecycle (relevant to caching/auth correctness):** `loadToken()` on boot drops expired/malformed tokens (`decodeJwt`+`isExpired`, where `exp` is seconds → compared `exp*1000 <= Date.now()`); a `window` `focus` listener re-checks expiry and clears if stale; and the _authenticated_ client (the one used everywhere else) calls `onUnauthorized → clearToken` on any 401. The token is **decoded, never verified** client-side (`jwt.ts` comment: "The server verifies; this is for UI gating only").
- **Optimistic updates:** none. **What must NOT be cached:** credentials, and the token must not leak into the query cache — it lives only in localStorage + AuthProvider state. No invalidation occurs because no entities are read.

### 5. COMPONENTS & COMPOSITION

- Layout/ambience: `AppBackground` (with `grid` dot-grid prop), floating `LanguageSwitch` + `ThemeToggle`.
- Brand panel: `Logo`, `FlipWords`, filled Phosphor `CheckCircleIcon`s, a raw `.glass` card for the mock log.
- Form: a single `<form className="glass auth-form">` card (NOT a `Modal`/`Drawer` — this is a standalone page, not an overlay), composed of `SegmentedControl` (the canonical login/register switch — design-system note explicitly cites `AuthPage.tsx:201`), two `TextField`s, and `Button` in `cta`/`ghost`/`link` variants.
- Feedback: module-level `toast()` + the global `Toaster`. Motion: `useGSAP` + `gsap.matchMedia('(prefers-reduced-motion: no-preference)')` for the staggered `[data-reveal]` entrance, the mode cross-fade, the `[data-log]` tail, the error `shake`, and the success scale — all reduced-motion-gated.
- **No `DataTable`/`CardCollection`/`StatusBadge`/`Money`/`FormField`-driven validation/`SelectField`** — this is a pure form page, the lightest in the app. `TextField` does internally compose `FormField`, but no `error`/`hint` props are supplied.

### 6. LAYOUT & TYPOGRAPHY

- **Not inside the console chrome.** It renders `AppBackground` directly and its own centered flex shell (`minHeight:100dvh`, centered), bypassing `ConsoleLayout`/`Rail`/`TopBar`/`SubNav` entirely — appropriate since it's a public page.
- **Responsive boundary is `BP.wide` (≥880px), NOT the usual `BP.md` (768px)** that the rest of the console uses. `isDesktop = useMediaQuery(BP.wide)`:
  - Desktop: a 2-col CSS grid `1.05fr 0.95fr`, `maxWidth 1040`, `gap var(--s-10)`, BrandPanel left + card right.
  - Mobile (<880px): single column, `maxWidth 440`, `gap var(--s-6)`, BrandPanel hidden, the in-card `Logo` shown instead.
- Heading hierarchy: one `<h1>` (`--fs-h1`, weight 850, tight `-0.035em` tracking) in the BrandPanel; the card itself has no heading (the SegmentedControl is the de-facto title). Density is airy — generous `var(--s-6)` card padding, `var(--s-4)` gaps.
- Warm-amber design discipline throughout (gradient FlipWords, `--grad-accent` CTA/SegmentedControl indicator, `--fail` shake border) — never blue.

### 7. MOCK-vs-REAL & GAPS

- **Data is REAL.** Both `POST /auth/login` and `POST /auth/register` hit the live backend (inventory §4). This page has nothing to do with `mockBilling.ts` — `mockStatus: real`. The only _fake_ element is the decorative `LOG` telemetry array in the BrandPanel (cosmetic, not data).
- **Already on the right endpoints** — no migration needed for the core flow. The page correctly relies on role-claim dispatch rather than a separate admin endpoint, which matches the backend's unified-user-table model.
- **Prioritized recommendations:**
  1. **OAuth is half-wired.** Buttons exist + are gated behind `VITE_OAUTH_ENABLED`, and the backend exposes `GET /auth/oauth/:provider` + `…/callback → {token}`, but there is **no SPA route to consume the callback token** (no `/auth/oauth/callback` route in `routes.tsx`). Either add a callback-handling route that reads `{token}` and feeds it into `AuthProvider`, or keep OAuth disabled. This is the biggest functional gap.
  2. **Surface field-level validation** — pass `error` to the `TextField`s (e.g. email format, password length on register) using the already-supported `FormField` error slot, instead of relying solely on native `required`/toast-after-submit.
  3. **Honor `retry_after_ms`** on `429`/rate-limited login attempts (the `ApiError.retryAfterMs` is parsed but ignored) — disable the submit button and show a countdown.
  4. **Add a 'forgot password' path** — currently impossible (no backend endpoint), but worth flagging since it is the conspicuous missing affordance on a login screen.
  5. Minor: the footer `link` toggle and the `SegmentedControl` are redundant mode switches; harmless but could be consolidated.

> **🔎 Verification notes:** **Verdict: accurate.** All four endpoints exist and resolve correctly; all components exist; the page genuinely hits real endpoints (no mocks). Severity is minor only because of one route-shape nuance and one wording sharpening worth recording.
>
> ### Endpoints — all real
>
> - **POST `/auth/login`** — `local-auth.controller.ts` (`@Controller('auth')` + `@Post('login')`, `@HttpCode(200)`). Body `{email,password}`, returns `{token}` (`AuthResult`). Bad creds → `engineUnauthorized` → 401. Confirmed called via `AuthProvider.authenticate('/login', …)` reading `r.token`. Accurate.
> - **POST `/auth/register`** — same controller, `@Post('register')`, 200, returns `{token}`. Provisions tenant+account and persists user with `role: 'user'`. Duplicate email → 400 `invalid_input` (not surfaced in spec, minor). Accurate.
> - **GET `/auth/oauth/google`** and **GET `/auth/oauth/github`** — **functionally real but NOT registered as two literal paths.** The backend exposes a single parameterized route `GET /auth/oauth/:provider` (`oauth.controller.ts`), validated against `['google','github']` (`oauth.service.ts`). The frontend `<a href>` of `/auth/oauth/google` + `/auth/oauth/github` resolves against `:provider`, and `start()` does `res.redirect(302, url)`. So both spec strings work end-to-end; they just aren't distinct route declarations. Left OFF phantom list since they resolve and 302 as described.
>
> ### Audience/guard refinement (the one substantive correction)
>
> The spec labels `/auth/login` as "Tenant + admin login." This is **correct but subtle**: `LocalAuthService.login` gates only on `status === 'active'` + valid password — it does NOT require `role`. An admin user logging in here gets a JWT with their real `role: 'admin'`, and `AuthPage.submit()` routes `role === 'admin'` → `/console/dashboard`, else → `/app`. A **separate** stricter endpoint `POST /admin/auth/login` (`admin/auth/admin-auth.controller.ts`, `@Controller('admin/auth')`) additionally enforces `role === 'admin'` — but the auth page does NOT call it. Both endpoints share the unified user table (`findUserByEmail`) and sign with `ADMIN_JWT_SECRET`.
>
> ### Mock status — correct (`real`)
>
> `AuthPage.tsx` + `AuthProvider.tsx` import no mock. `mockBilling.ts` is scoped to billing/route-group console pages (its header says billing backend is DESIGN-ONLY) and is **not** imported by auth. Real network calls via `createClient().post(config.authBase + path)` where `authBase = '/auth'` and `apiBase` defaults to `''` (same-origin / Vite proxy). `mockStatus = real` is accurate.
>
> ### Components — all present
>
> All under `apps/web/src/components`: `glass/AppBackground.tsx`, `brand/Logo.tsx`, `landing/FlipWords.tsx`, `layout/LanguageSwitch.tsx`, `layout/ThemeToggle.tsx`, `ui/SegmentedControl.tsx`, `ui/TextField.tsx`, `ui/Button.tsx` (used with `variant="cta"|"ghost"|"link"` + `href` — matches spec), `ui/toast.ts` + `ui/Toaster.tsx`. `useGSAP`/`gsap.matchMedia` motion confirmed in the page (entrance reveal, mode cross-fade, shake, success cue). Nothing phantom.
>
> ### Minor extras the spec omits (non-blocking)
>
> - OAuth buttons are gated by `config.oauthEnabled` (`VITE_OAUTH_ENABLED === 'true'`) — spec captured this correctly.
> - Backend OAuth also has `GET /auth/oauth/:provider/callback` (returns `{token}` JSON; SPA redirect handoff is a stated follow-up — config comment: "Reserve OAuth buttons until the backend wires the SPA redirect handoff") and `POST /auth/link/:provider` (behind `AdminGuard`). The page doesn't use these; not spec'd, fine.

## 3. User Home (Tenant self-service) — `/app`

**Audience:** Tenant self-service end-user (role=user), Any authenticated user (admins also admitted by the gate), Developer integrator (the human owner who mints ak\_ keys) · **Data status:** `static` · **Verify severity:** `clean`

**Backend endpoints**

_(no backend endpoints — static/client-only)_

**Components:** `AppBackground`, `Logo`, `LanguageSwitch`, `ThemeToggle`, `Button`, `glass (utility class)`

## User Home — `/app` (Tenant self-service)

Primary file: `/Users/alienworm/actionow-web/apps/web/src/features/app/UserHome.tsx` (48 lines, the entire page).

> **Headline finding:** This page is a **static placeholder**. It makes **zero** API calls, imports **no** TanStack Query / `useAdminApi` / `mockBilling`, and uses **no** `qk.*` key. It renders one centered glass "coming soon" card with two buttons. The backend tenant self-service plane (`/console/*`, `ConsoleGuard`) is fully built, but **nothing on the frontend is wired to it** — there is not a single `/console/api-keys|usage|models|payments` reference anywhere in `apps/web/src` (verified by grep; the only `/console/*` hits in the frontend are the _operator_ admin routes, an unrelated path-prefix collision). `mockStatus = static`.

---

### 1. PURPOSE & AUDIENCE

- **Who sees it:** Any authenticated user landing on `/app`. After login, `AuthPage.tsx:177` routes `user.role === 'admin' → /console/dashboard`, **else → `/app`**. So the intended audience is the **tenant self-service end-user** (`role === 'user'`, provisioned with their own tenant + account on `/auth/register`).
- **Guard (frontend):** `routes.tsx:33-35` wraps it in `<ProtectedRoute />` with **no `role` prop**. Per `ProtectedRoute.tsx`: unauthenticated → `<Navigate to="/login">`; authenticated → render. It does **not** check role, so a logged-in **admin can also reach `/app`** (and the admin-gated `/console/*` bounces non-admins here via `Navigate to="/app"`).
- **Guard (backend, for the data it _should_ call):** The tenant `/console/*` API is protected by `ConsoleGuard` (user JWT, signed with `ADMIN_JWT_SECRET`, requires `status==='active'` + non-null `tenant_id` + resolvable account). Tenant is taken from the JWT principal `{userId, tenantId, accountId}` — **never** from body/query.
- **Auth wiring already present:** `useAuth()` (from `AuthProvider.tsx`) exposes `client` (an `ApiClient` with the bearer JWT already injected) plus `logout`. The page currently only uses `logout`. **The same `client` is exactly what a future data layer would call `/console/*` with** — no new auth plumbing is needed.

### 2. CONTENT / INFORMATION ARCHITECTURE

**NOW (literal current content, `UserHome.tsx`):**

- `<AppBackground />` (ambient aurora, no `grid`).
- Top-left absolute: `<Logo />`.
- Top-right absolute: `<LanguageSwitch />` + `<ThemeToggle />` (flex, gap `--s-2`).
- Centered `.glass` card (`maxWidth: 460`, `padding --s-8`, `textAlign center`):
  - Title: `t('app.soon')` → "Self-service console coming soon" (`--fs-lg`, `fw 700`).
  - Paragraph: `t('app.hint')` → "Your tenant and account are ready. Self-service keys, usage, and top-ups open in a later phase." (`--fs-base`, `--muted`).
  - Two buttons: `Button href="/" variant="ghost"` → `t('app.backHome')` ("Website"); `Button variant="cta"` → `SignOutIcon` + `t('app.logout')` ("Sign out"), `onClick` calls `logout()` then `navigate('/login', { replace: true })`.
- i18n keys live under `app.*` in `/Users/alienworm/actionow-web/apps/web/src/i18n/locales/{en,zh-CN}/console.json` (`console` namespace). Note `app.title` ("Tenant self-service") already exists but is **unused** on the page.
- **No loading / empty / error states** exist because there is no data.

**SHOULD contain (a real tenant dashboard, mapped to the live `/console/*` plane):**

1. **Balance & credits header** — current credit balance + held credits, with a primary **Top up** CTA. (Note gap: `/console` has no GET-account endpoint; see §7.)
2. **Top-up flow** — amount entry → `POST /console/payments/intents` → render returned `redirect_url`/`qr`. Status polling via `GET /v1/payments/intents/:id` is API-key-scoped (not console), so console-side this is fire-and-redirect.
3. **API keys panel** — list this tenant's keys (id, status, rate_limit, resource_allowlist, created_at) with row actions **Create**, **Rotate**, **Disable**. Plaintext is returned **once** on create/rotate → must show a one-time `CopyField` modal.
4. **Usage panel** — recent jobs + ledger entries (cost, type, balance_after, created_at), "load more" off cursors.
5. **Available models** — names/modality/capabilities visible to this tenant (read-only catalog), so the user knows what to call.
6. **Empty states** (no keys yet → "Create your first key"), **loading** (`RoseLoader` via `DataTable`/`CardCollection`), **error** (toast via `mutationError`).

### 3. BACKEND ENDPOINTS

**Currently called by this page: NONE.** (The only network action is the chrome's logout, which is client-side localStorage clearing — no HTTP call.)

**Endpoints it SHOULD bind to** (all tenant-scoped `/console/*`, `ConsoleGuard`, tenant from JWT — never pass `tenantId`):

- `GET /console/api-keys?cursor&limit` → `PageEnvelope<ApiKeyView>` where console `ApiKeyView = { id, resource_allowlist: string[], rate_limit: number|null, status, created_at }` (NO `tenant_id`/`route_group_id`).
- `POST /console/api-keys` body `{ resourceAllowlist?: string[], rateLimit?: int>0 }` → `201 { id, plaintext }` (plaintext ONCE).
- `POST /console/api-keys/:id/rotate` → `201 { id, plaintext }` (old key disabled).
- `DELETE /console/api-keys/:id` → **`200 { id, status: 'disabled' }`** (NOT 204 — differs from admin DELETE).
- `GET /console/usage?jobs_cursor&ledger_cursor&limit` → `{ jobs: PageEnvelope<JobView>, ledger: PageEnvelope<LedgerView> }` — **two independent envelopes, two cursors** (breaks the single-`cursor` pattern). Console `JobView = { job_id, resource_id, status, exec_mode, cost: string|null, created_at }`; console `LedgerView = { id, type, credits_delta, balance_after, job_id: string|null, created_at }`.
- `GET /console/models` → `PageEnvelope<ModelListItem>` single bounded page (`next_cursor: null, has_more: false`); `ModelListItem = { name, display, modality, capabilities, visibility }`.
- `POST /console/payments/intents` body `{ provider, amount_minor: int>0, currency }` → `201 { intent_id, redirect_url?, qr? }` (purpose hardcoded `topup`).

All money fields are **decimal µcredit strings** — render with `Money` (BigInt math), never `Number()`.

### 4. DATA & CACHING

**NOW:** nothing cached; no query keys; no entities fetched. `cached[] = []` and `endpoints[] = []` are intentionally empty because the page is static.

**SHOULD (proposed, since no `qk.*` entry exists for the tenant plane — these must be created):**

- API keys: a new `console`-namespaced key (e.g. `['console','api-keys']`), `staleTime: STALE_VOLATILE` (10s) or `STALE_REFERENCE` is fine since it changes only on user action; invalidate on create/rotate/disable `onSuccess`.
- Usage (jobs+ledger): `STALE_VOLATILE` (10s, operational) — but the dual-cursor envelope can't use the standard `useKeyset(qk, cursor=>...)` helper as-is (it assumes a single `nextCursor`); needs a bespoke infinite-query or two separate keyset hooks reading `jobs_cursor`/`ledger_cursor`.
- Models: `STALE_REFERENCE` (60s, catalog/reference).
- Balance/account: **should NOT be cached stale** — fetch fresh after any top-up; ideally `staleTime: 0` or invalidate immediately post-intent.
- **Must NOT cache:** the one-time `plaintext` from `POST/POST-rotate /console/api-keys` — it is shown once in a `CopyField` and never re-fetchable; capture it in local state, never in the query cache.
- The whole frontend data layer (`api/admin.ts`, `api/queryKeys.ts` = `qk` prefixed `['admin',...]`) is **admin-only today**; there is no `makeConsoleApi`/console `qk` factory. Adding tenant self-service means either extending `admin.ts` or adding a parallel `console.ts` method bundle + `qk.console*` keys.

### 5. COMPONENTS & COMPOSITION

**NOW (actual imports):** `AppBackground`, `Logo`, `LanguageSwitch`, `ThemeToggle`, `Button` (variants `ghost` + `cta`), `SignOutIcon`, plus the `.glass` utility class. It does **not** use the console shell (`ConsoleLayout`/`Rail`/`TopBar`/`SubNav`/`BottomTabs`) — it is a standalone full-viewport page, structurally a sibling of `AuthPage.tsx` (same `AppBackground` + absolute Logo + top-right `LanguageSwitch`/`ThemeToggle` + centered `.glass` card pattern).

**SHOULD (design-system components, matching established page patterns like `DashboardPage`/`ApiKeysPage`):**

- API keys → **`DataTable`** (columns: id/`CopyField`, status `StatusBadge` via `statusTone`, rate_limit, resource_allowlist as `.chip` row, created_at; `rowActions` = `RowAction` rotate + disable via `ConfirmDialog`) OR **`CardCollection`+`EntityCard`** for the card-first console aesthetic.
- Create/rotate key → **`Modal`** (short form) or **`Drawer`** (longer), with `ChipsField` (resourceAllowlist) + `NumberField` (rateLimit), `mutationError(t)` as `onError`, and a one-time-plaintext `CopyField` in a follow-up `Modal`.
- Balance → **`StatCard`** (already used on Dashboard) + **`Money`** for the credit string.
- Top-up → **`Modal`** with `NumberField` + provider `SelectField`; on success open `redirect_url`/render `qr`.
- Usage → **`DataTable`** or **`CardCollection`** with `StatusBadge` + `Money(micro=cost)`.
- Models → **`CardCollection`+`EntityCard`** (read-only).
- Standard `Toaster`/`toast` for success/error; `SectionHeader` for panel titles.

### 6. LAYOUT & TYPOGRAPHY

**NOW:** Full-viewport (`minHeight: 100dvh`), flex centered. Absolute-positioned `Logo` (top-left) and `LanguageSwitch`+`ThemeToggle` (top-right), both at `var(--s-4)` inset, `zIndex 2`. `AppBackground` at z0, content at z1. Single `.glass` card (`--r-lg`, `--s-8` padding, centered text, `maxWidth 460`). Heading hierarchy is shallow: one `--fs-lg` bold title + one `--fs-base --muted` paragraph + a button row. **No responsive branching** (no `useMediaQuery`) — it is centered and identical on desktop and mobile. **Crucially it does not enter the console chrome** (`ConsoleLayout`), so it has no Rail/SubNav/TopBar/BottomTabs, no per-route GSAP enter, and no `useSetConsoleAction/Filters/Back` slot publishing.

**SHOULD:** A real tenant dashboard likely stays **outside** the operator `ConsoleLayout` (that shell's nav IA is admin-only and gated `role="admin"`). Recommended: a lightweight tenant shell (reuse `AppBackground` + Logo + theme/lang toggles like now) hosting a responsive grid — balance/StatCards row on top, then API-keys + usage panels (two-column ≥`BP.md`/768px, stacked below), models as a `CardCollection` grid (`minmax(280px,1fr)`). Use the same warm-amber token system (`--accent`, `--grad-accent`, `.glass`/`.panel`), `--fs-lg`/`--fs-base` hierarchy, 8px spacing grid, and the global reduced-motion safety net.

### 7. MOCK-vs-REAL & GAPS

- **Data source:** `static` — neither real network nor `mockBilling`. The page is a hard-coded "coming soon" card. (Contrast: the billing mock pages use `mockBilling.ts`; this page uses nothing at all.)
- **The backend is ready; the frontend is the gap.** Per the audience model, audience (b) tenant self-service is **fully implemented server-side** (`/console/*` + `ConsoleGuard`: mint/list/rotate/disable own keys, usage jobs+ledger, list visible models, self top-up) and **essentially unbuilt on the client**. This single placeholder is the _only_ tenant-facing page.
- **Prioritized recommendations (concrete):**
  1. **Build the data layer first** — add a `makeConsoleApi(client)` bundle (parallel to `makeAdminApi`) wired to `useAuth().client`, plus `qk.console*` keys. The auth/client/error/toast infra already works unchanged.
  2. **Ship API keys self-service** (highest value): `GET/POST/rotate/DELETE /console/api-keys`, with the **one-time plaintext** `CopyField` modal and the **DELETE→200 `{status:'disabled'}`** quirk handled (not 204).
  3. **Add balance + top-up**: `POST /console/payments/intents`. **Gap to flag:** there is **no tenant GET-account/balance endpoint** in the `/console/*` inventory (account reads are admin-only: `GET /admin/accounts/:id`). A displayed balance would require either a new console endpoint or deriving the latest `balance_after` from `GET /console/usage`'s ledger envelope. Recommend deriving from ledger short-term, or adding `GET /console/account` server-side.
  4. **Add usage + models** panels (`GET /console/usage` dual-cursor handling; `GET /console/models`).
- **Sharp edges to respect when implementing:** (a) `GET /console/usage` returns `{ jobs, ledger }` — two envelopes/cursors, incompatible with the bare `useKeyset` helper; (b) console DELETE returns 200 not 204; (c) plaintext is returned once and never cached; (d) tenant is always from the JWT — never send `tenantId` in body/query; (e) all money is µcredit decimal strings → `Money`/BigInt, never float.

> **🔎 Verification notes:** **accurate** — minor refinements only.
>
> The spec for User Home (`/app`) is correct. `UserHome.tsx` is a static "coming soon" placeholder:
>
> - **Endpoints**: spec lists `[]` (none). Confirmed — the page imports nothing from any API client, has no `fetch`/`useQuery`/`client.*` calls, and does not touch `mockBilling.ts`. Correct.
> - **mockStatus = static**: Confirmed accurate. The page renders translated copy (`app.soon`, `app.hint`, `app.backHome`, `app.logout` from the `console` i18n namespace) and a logout button (`useAuth().logout()` + redirect to `/login`). No mock data and no real endpoints — it is genuinely static. Note: `mockBilling.ts` exists but is unrelated to this page (it backs the official-prices / route-group console pages, not `/app`).
> - **Components**: all 6 resolve to real files:
>   - `AppBackground` → `components/glass/AppBackground.tsx`
>   - `Logo` → `components/brand/Logo.tsx`
>   - `LanguageSwitch` → `components/layout/LanguageSwitch.tsx`
>   - `ThemeToggle` → `components/layout/ThemeToggle.tsx`
>   - `Button` → `components/ui/Button.tsx`
>   - `glass (utility class)` → defined in `styles/glass.css` (`.glass`)
>
> Small refinements the spec omits (not errors): the page also imports `SignOutIcon` from `@phosphor-icons/react`, and uses hooks `useTranslation('console')`, `useNavigate` (react-router), and `useAuth` (`lib/auth/AuthProvider`). Audience is correctly "Tenant self-service" — the only real behavior is the logout action.

## 4. Console Dashboard — `/console/dashboard`

**Audience:** Operator / Admin (user.role === 'admin') · **Data status:** `real` · **Verify severity:** `clean`

**Backend endpoints**

| Method | Path                                | Purpose                                                                                                                |
| ------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/admin/tenants`                    | Tenant count stat (uses .length of the first keyset page only) + feeds the TenantSelect TopBar filter via qk.tenants() |
| `GET`  | `/admin/resources`                  | Resource count stat (uses .length of the first keyset page only)                                                       |
| `GET`  | `/admin/jobs?tenantId=<id>&limit=8` | Recent jobs list for the tenant chosen in the TopBar filter; only fires when a tenant is selected                      |

**Cached entities:** qk.tenants() = ['admin','tenants'] — staleTime STALE_REFERENCE (60s); shared with TenantSelect; qk.resources() = ['admin','resources'] — staleTime STALE_REFERENCE (60s); qk.jobs(tenantId) = ['admin','jobs',tenantId] — staleTime STALE_VOLATILE (10s), keepPreviousData, enabled only when tenantId !== ''

**Components:** `StatCard (console/StatCard.tsx — GSAP count-up)`, `SectionHeader`, `CardCollection (layout="list")`, `EntityCard (icon=CubeIcon)`, `StatusBadge + statusTone`, `Money`, `TenantSelect (TopBar filter slot)`, `useSetConsoleFilters (ConsoleChrome)`, `RoseLoader (via CardCollection loading)`

## Console Dashboard — `/console/dashboard`

Primary files: `/Users/alienworm/actionow-web/apps/web/src/features/console/DashboardPage.tsx`, `/Users/alienworm/actionow-web/apps/web/src/components/console/StatCard.tsx`. Route registered in `routes.tsx:41`.

---

### 1. PURPOSE & AUDIENCE

- **Who:** Operator / Admin only. The route lives under `<ProtectedRoute role="admin">` → `<ConsoleLayout>` (`routes.tsx:38-41`). A logged-in non-admin is bounced to `/app`; an unauthenticated visitor to `/login`. It is the post-login landing page for admins (`AuthPage` redirects `role==='admin' → /console/dashboard`) and the **ops** nav group's only leaf.
- **Backend guard:** every read hits `/admin/*`, protected by `AdminGuard + @Roles('admin')` (admin JWT bearer). Client-side role gating is advisory; the server re-enforces.
- **Intent (per `subtitles.dashboard`):** "Tenants & resources overview, recent jobs." It is meant to be the operator's at-a-glance overview. As built it is thin — two count tiles plus a tenant-scoped recent-jobs list.

### 2. CONTENT / INFORMATION ARCHITECTURE

**NOW (exactly what ships):**

- **Stat tiles row** — a CSS grid `repeat(auto-fit, minmax(180px,1fr))` of exactly **two** `StatCard`s:
  1. `dashboard.stats.tenants` ("Tenants") = `tenants.data?.length ?? 0`
  2. `dashboard.stats.resources` ("Resources") = `resources.data?.length ?? 0`
- **Recent jobs section** — `SectionHeader title={t('dashboard.recentJobs')}` ("Recent jobs"), then:
  - **No tenant selected** (default): a `.panel` empty placeholder centered with `dashboard.pickTenant` ("Pick a tenant to view jobs").
  - **Tenant selected:** a scrollable `CardCollection layout="list"` of up to **8** jobs, each an `EntityCard`:
    - `icon`: `CubeIcon`
    - `title`: `r.resource_id`
    - `badge`: `StatusBadge tone={statusTone(r.status)} label={t('status.'+r.status, r.status)}`
    - `chips`: `[r.exec_mode]`
    - `meta`: two cells — `cols.cost` → `<Money micro={r.cost}/>` or `—` when null; `cols.status` → `new Date(r.created_at).toLocaleTimeString()`.
- **TopBar filter slot:** a 200px-wide `TenantSelect` published via `useSetConsoleFilters`, placeholder `dashboard.stats.pickTenant` ("Select tenant"). Selection is persisted to the URL `?tenant=` via `useUrlState('tenant')`.

**States:** loading → `CardCollection` shows `RoseLoader` (`jobs.isLoading`); empty (tenant chosen, no jobs) → `dashboard.noJobs`; empty (no tenant) → the panel placeholder. **There is no explicit error state** — a failed `/admin/jobs`/`/admin/tenants`/`/admin/resources` query surfaces only as a perpetual `0`/empty (no `isError` branch, no toast on these reads).

**Known labeling bug:** the second meta cell is labeled `dashboard.cols.status` ("Status") but renders `created_at` as a local time string, not status (status is already the badge). The label should be a "Time"/"Created" key. The unused `dashboard.cols.resource` / `dashboard.cols.execMode` keys exist but are surfaced only as title/chip.

**SHOULD contain (gap vs. the inventory's candidate data):**

- **More stat tiles**, ideally tenant-agnostic and time-windowed: total requests, total errors, total spend, active models/channels. The inventory exposes the data: `GET /admin/analytics/usage?groupBy=day` (raw `UsageRollupView[]` with `requests`, `input_tokens`, `output_tokens`, `cost`, `errors`) is the natural source for an aggregate "requests / spend / errors (24h or 7d)" hero row — no `tenantId` required.
- **A models count tile** from `GET /admin/models` (`qk.models()`), since catalog size is core operator context.
- **Global recent activity not gated on a tenant** — `GET /admin/usage` (global per-call `UsageLogView[]`, all tenants) would let the recent-activity feed render without first forcing a tenant pick; today the whole jobs panel is dark until a tenant is chosen.
- **Relay-traces panel** (recent relay errors): the backend has `GET /admin/relay-traces`, but it is **not wired into the frontend data layer at all** (no `admin.ts` method, no `qk`), so it cannot be added without first adding a client method.

### 3. BACKEND ENDPOINTS

Reads only — the dashboard performs **no writes/mutations**.

- `GET /admin/tenants` (via `api.listTenants()` → `client.getPage` → `.rows`). Returns `TenantView[]` from the **first keyset page** (envelope `{data,next_cursor,has_more}`, default limit 50). `.length` is therefore a **page count, capped at 50, not a true total** — there is no total in the cursor envelope.
- `GET /admin/resources` (via `api.listResources()`). Same first-page-only caveat: `ResourceView[]`, max 50.
- `GET /admin/jobs?tenantId=<id>&limit=8` (via `api.listJobs({tenantId, limit:8})` → `Page<JobView>`). Admin `JobView`: `{ job_id, tenant_id, resource_id, status, exec_mode, cost: string|null (µcredit), created_at }`. `tenantId` is a required query param; the page does not paginate (no fetchNext) — it shows only the newest 8.

### 4. DATA & CACHING

- **tenants** → `useQuery(qk.tenants(), api.listTenants, staleTime: STALE_REFERENCE=60s)`. Shared cache key with `TenantSelect`, so the filter dropdown and the stat tile dedupe to one request.
- **resources** → `useQuery(qk.resources(), api.listResources, staleTime: STALE_REFERENCE=60s)`.
- **jobs** → `useQuery(qk.jobs(tenantId), () => api.listJobs({tenantId, limit:8}), enabled: tenantId !== '', staleTime: STALE_VOLATILE=10s, placeholderData: keepPreviousData)`. Volatile tier is correct for operational data; `keepPreviousData` avoids a flash when switching tenants.
- **Invalidation / optimistic:** none — this is a read-only page, no mutations, so no `invalidateQueries` and no optimistic updates originate here. It relies on staleTime + the TopBar global refresh button (`qc.invalidateQueries()`).
- **What should NOT be cached long:** the jobs feed is correctly short-lived (10s). If aggregate-usage tiles are added, `qk.analyticsUsage(params)` should also use a short/volatile tier (usage moves), whereas `qk.models()` can use `STALE_REFERENCE`.

### 5. COMPONENTS & COMPOSITION

- **StatCard** (`components/console/StatCard.tsx`) — bespoke glass tile (not a generic UI primitive). GSAP count-up animation tweening `textContent` from the last value to target over 1.4s (`EASE.out`); reduced-motion snaps to final; non-numeric values render as-is. Tracks `fromRef` so a live refetch animates from the current display, not 0.
- **SectionHeader** — `<h2>` + optional right action (unused here).
- **CardCollection** `layout="list"` — vertical flex stack; owns loading (`RoseLoader`) and empty states and the stagger-reveal on row-count change. This is the **table/list composition** (cards-over-rows, the console's primary pattern) — **not** `DataTable`, deliberately, since it's a short bounded feed.
- **EntityCard** — glyph (`CubeIcon`) + title + `StatusBadge` + chip + 2-cell meta grid. Read-only here (no `onClick`, so not clickable/selectable).
- **StatusBadge** + `statusTone()` — maps job status enums to tones (succeeded→ok, running→run, queued/pending→wait, failed→fail, canceled→idle).
- **Money** — renders the µcredit `cost` string as grouped human credits via `formatCredits` (BigInt, no float).
- **TenantSelect** (no `label`) — bare `Select` for the TopBar filter slot, fed by `qk.tenants()`.
- **Chrome integration:** `useSetConsoleFilters(render, [t, tenantId, setTenantId])` publishes the filter into `TopBar`; title/subtitle come from `nav-config` (`nav.dashboard` / `subtitles.dashboard`). No `ConsoleAction` or `ConsoleBack` is published (no top-bar action button, no back arrow).

### 6. LAYOUT & TYPOGRAPHY

- Root is a full-height (`height:100%`) flex column, `gap: var(--s-5)`. Top = stat grid (auto-fit, min 180px); bottom = `flex:1, minHeight:0` jobs region with its own `overflowY:auto` scroll area (`padding: var(--s-2)`).
- **StatCard type:** label `--fs-nano`, uppercase, `letter-spacing .06em`, `--muted`; value `--fs-xl`, weight 700, `.tabular`, `-.02em` tracking.
- **EntityCard type:** title `--fs-base`/semibold/`--track-snug`/ellipsis; meta labels `--fs-caption` uppercase `--faint`; meta values `--fs-sm` `.tabular`.
- **Responsive:** layout is driven by `ConsoleLayout`'s `useMediaQuery(BP.md)`, not the page. Desktop = Rail + SubNav + TopBar (with the TenantSelect filter); mobile = BottomTabs (Dashboard is a mobile tab) + TopBar (which on mobile also hosts theme/lang/logout). The page body itself is fluid — the stat grid reflows from 2-up to 1-up under ~360px, and `CardCollection layout="list"` is single-column at all widths. The per-route enter animation (GSAP opacity/y) is applied by `ConsoleLayout`'s `viewRef`.
- **Density:** intentionally sparse — heading hierarchy is just the TopBar page title (h1-equivalent) + one `SectionHeader` h2.

### 7. MOCK-vs-REAL & GAPS

- **Data is 100% REAL.** All three reads hit live `/admin/*` via `admin.ts`/`client.ts`. **Nothing on this page touches `mockBilling.ts`** (unlike `/console/groups` and `/console/official-prices`). `mockStatus: real`.
- **Prioritized recommendations:**
  1. **Fix the "Status" meta label bug** — the second meta cell shows `created_at` time but is labeled `cols.status`. Add a `cols.time`/`cols.created` key.
  2. **Counts are page-capped, not totals.** `tenants.length`/`resources.length` reflect only the first ≤50-row page. Either label them "shown" or, better, switch to an aggregate that reflects truth. Keyset envelopes carry no total, so an accurate count needs either a dedicated count endpoint (does not exist) or accepting the cap and labeling it honestly.
  3. **Add tenant-agnostic overview tiles** using `GET /admin/analytics/usage?groupBy=day` (requests / cost / errors over a window) and `GET /admin/models` (model count) so the dashboard is useful before a tenant is chosen.
  4. **Surface global recent activity** via `GET /admin/usage` (`listUsage`, already in `admin.ts` + `qk.usage`) so the lower panel isn't blank until a tenant is selected.
  5. **Add an error state** — the three queries have no `isError` handling; a failed fetch silently shows `0`/empty. Add an error affordance (toast via `mutationError`-style handling or an inline retry).
  6. **Relay-traces** (recent relay failures) is a strong dashboard candidate per the notes, but `GET /admin/relay-traces` is **not yet wired into the frontend** (no `admin.ts` method, no `qk` entry); adding it requires a new client method first.

> **🔎 Verification notes:** **Verdict: accurate.** All three endpoints, all nine components, and mockStatus=real check out against the code.
>
> **Endpoints — all real:**
>
> - `GET /admin/tenants` → `admin.controller.ts` `@Controller('admin')` + `@Get('tenants')` (line 416). Frontend `listTenants` does `getPage('/admin/tenants')` then `.rows`; page reads `tenants.data?.length`. Spec's ".length of the first keyset page only" caveat is correct (the API returns a paginated envelope; the client unwraps to `{rows, nextCursor}` and the page ignores the cursor).
> - `GET /admin/resources` → `@Get('resources')` (line 634). Same `.rows` + `.length` pattern. Correct.
> - `GET /admin/jobs?tenantId=<id>&limit=8` → `@Get('jobs')` (line 897), takes `@Query('tenantId')`, `cursor`, `limit`. Frontend `listJobs` passes `{tenantId, cursor, limit}`. Query is gated by `enabled: tenantId !== ''`, so "only fires when a tenant is selected" is accurate.
>
> **Components — all 9 exist** under `apps/web/src/components/`: `console/StatCard.tsx` (GSAP count-up via `useGSAP` + matchMedia — confirmed), `ui/SectionHeader.tsx`, `data/CardCollection.tsx` (used with `layout="list"`, renders `RoseLoader size={64}` on loading — confirmed), `data/EntityCard.tsx` (`icon={CubeIcon}` from @phosphor-icons — confirmed), `data/StatusBadge.tsx` (exports `StatusBadge` + `statusTone` — confirmed), `data/Money.tsx`, `data/TenantSelect.tsx`, `console/ConsoleChrome.tsx` (exports `useSetConsoleFilters`, line 41), and `ui/RoseLoader.tsx`.
>
> **mockStatus = real → CORRECT.** `DashboardPage.tsx` imports `useAdminApi` (the real authenticated client) and has zero mock imports. `mockBilling.ts` is imported only by `routes.tsx`, `RouteGroupsPage.tsx`, `OfficialPricesPage.tsx`, `nav-config.ts`, `types.ts` — never by this page. All three queries hit live endpoints.
>
> **Field names match exactly.** Backend `toJobView` (line 1334) emits `job_id`, `tenant_id`, `resource_id`, `status`, `exec_mode`, `cost` (string|null), `created_at` — identical to the frontend `JobView` type and to every field the page renders (`r.job_id`, `r.resource_id`, `r.status`, `r.exec_mode`, `r.cost`, `r.created_at`). `cost` is a `string|null`; page guards `r.cost !== null` before `<Money micro={r.cost} />` and `Money` takes `micro: string`. Consistent.
>
> **Minor refinements (not errors):**
>
> - There is a _separate_ `jobs.controller.ts` with `@Controller('v1/jobs')` and a `console.controller.ts` `@Get('usage')` that returns tenant jobs — but the admin page correctly targets `/admin/jobs`, not those. No collision; spec is right.
> - These are all admin-plane endpoints (the page lives at `/console/dashboard` but consumes the `/admin/*` API via the admin client). Audience/guard labeling in the spec is fine.

## 5. Catalog (Resources + Models) — `/console/catalog`

**Audience:** Operator / Admin (user.role === 'admin') · **Data status:** `real` · **Verify severity:** `clean`

**Backend endpoints**

| Method   | Path                                                   | Purpose                                                                                                       |
| -------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/admin/resources`                                     | List resources for the Resources-tab master card list and the ModelEditor resource picker (qk.resources())    |
| `POST`   | `/admin/resources`                                     | Create a resource from the 新建资源 Modal (idempotency-key per modal open)                                    |
| `PATCH`  | `/admin/resources/:id`                                 | Set resource status active/disabled from the detail overview SelectField                                      |
| `GET`    | `/admin/resources/:id/channels`                        | List a resource's channels in the detail-pane Channels DataTable (qk.channels(id))                            |
| `POST`   | `/admin/resources/:id/channels`                        | Create a channel from ChannelEditor Drawer (idempotency-key)                                                  |
| `PATCH`  | `/admin/resources/:id/channels/:channelId`             | Edit channel / toggle status / bulk enable-disable from ChannelEditor and row actions                         |
| `DELETE` | `/admin/resources/:id/channels/:channelId`             | Soft-delete a channel via row TrashIcon + ConfirmDialog                                                       |
| `POST`   | `/admin/resources/:id/channels/:channelId/sync-models` | Sync upstream models for a channel via the ArrowsClockwise row action (empty body)                            |
| `GET`    | `/admin/pricebook`                                     | List a resource's pricebook entries in the detail-pane Pricing DataTable (qk.pricebook(id), query resourceId) |
| `POST`   | `/admin/pricebook`                                     | Create a price entry from PricingModal (idempotency-key; fixedCredits human→µcredit)                          |
| `POST`   | `/admin/secrets`                                       | Create an encrypted credential inline in ChannelEditor and backfill credentialRef                             |
| `GET`    | `/admin/secrets`                                       | Populate the SecretSelect credential picker in ChannelEditor (qk.secrets())                                   |
| `GET`    | `/admin/models`                                        | List models for the Models-tab DataTable and the ChannelEditor model-name suggestions (qk.models())           |
| `POST`   | `/admin/models`                                        | Create a model from ModelEditor Drawer (create branch, idempotency-key)                                       |
| `GET`    | `/admin/models/:name`                                  | Fetch canonical model to seed the ModelEditor edit form (qk.model(name))                                      |
| `PATCH`  | `/admin/models/:name`                                  | Update a model from ModelEditor and bulk enable/disable status from the table                                 |
| `DELETE` | `/admin/models/:name`                                  | Soft-delete a model via row TrashIcon + ConfirmDialog                                                         |
| `POST`   | `/admin/models/:name/grants`                           | Grant a tenant access to a tenant-visibility model from ModelGrantsDrawer (idempotency-key)                   |
| `GET`    | `/admin/models/:name/grants`                           | List a model's tenant grants in the ModelGrantsDrawer DataTable (qk.modelGrants(name))                        |
| `DELETE` | `/admin/models/:name/grants/:tenantId`                 | Hard-delete (revoke) a tenant grant via row action + ConfirmDialog                                            |
| `GET`    | `/admin/tenants`                                       | Resolve tenant names/ids for TenantSelect in the create-resource Modal and ModelGrantsDrawer (qk.tenants())   |

**Cached entities:** resources → qk.resources() → STALE_REFERENCE (60s); channels → qk.channels(resourceId) → default 15s; pricebook → qk.pricebook(resourceId) → default 15s; models → qk.models() → STALE_REFERENCE (60s); model (single, edit-seed) → qk.model(name) → default 15s; modelGrants → qk.modelGrants(name) → default 15s; secrets → qk.secrets() → component default (SecretSelect); tenants → qk.tenants() → STALE_REFERENCE (60s); NOT cached: one-time secret plaintext (never returned), idempotency keys (per-open crypto.randomUUID, component-local state)

**Components:** `CatalogPage bespoke URL-synced tab strip (mirrors ui/Tabs)`, `CardCollection (layout=list)`, `EntityCard`, `ProviderIcon`, `StatusBadge / statusTone`, `DataTable`, `RowAction`, `Button`, `Modal`, `Drawer`, `ConfirmDialog`, `TextField`, `SelectField`, `ComboboxField`, `ChipsField`, `NumberField`, `Toggle`, `TenantSelect`, `SecretSelect`, `CapabilitiesField`, `IoSchemaField`, `KeyValueEditor`, `PricebookSpecForm`, `toast`, `useSetConsoleAction / useSetConsoleBack (ConsoleChrome slots)`

## Catalog (Resources + Models) — `/console/catalog`

Composition root: `features/console/CatalogPage.tsx`. Bodies: `ResourcesPage.tsx`, `ModelsPage.tsx`. Detail/overlays: `ResourceDetailPane.tsx`, `ChannelEditor.tsx`, `PricingModal.tsx`, `ModelEditor.tsx`, `ModelGrantsDrawer.tsx`.

---

### 1. PURPOSE & AUDIENCE

The unified operator catalog: the single richest admin surface combining the **model registry** (the 对外/customer-facing product) and the **resource capability hub** (provider channels + pricing). Audience is **Operator / Admin only** — a `user` row with `role === 'admin'`.

- **Frontend gate:** `routes.tsx` nests this under `<ProtectedRoute role="admin">` → `<ConsoleLayout>`. A logged-in non-admin is bounced to `/app`; an unauthenticated visitor to `/login`. This gating is _advisory only_ (`jwt.ts` decodes without verifying).
- **Backend guard:** every read/write hits `/admin/*` behind `AdminGuard` + `@Roles('admin')` (admin JWT bearer, `ADMIN_JWT_SECRET`). The whole `AdminController` is wrapped in `IdempotencyInterceptor`.
- **Single route, internal tabs:** `nav-config.ts` holds one `catalog` leaf (`/console/catalog`); the page owns its own `?tab=models|resources` strip. Legacy `/console/resources`, `/console/resources/:id`, `/console/models` redirect here (the `:id` form maps to `?tab=resources&id=<id>`).

---

### 2. CONTENT / INFORMATION ARCHITECTURE

**Page shell (`CatalogPage`)** — a flex column: a `role="tablist"` strip (模型 | 资源, i.e. `nav.models` / `nav.resources`) over a single `role="tabpanel"` that mounts **only the active body**. Tab state is in the URL via `useUrlState('tab','models')` (default `models`). Because only one body mounts, only that body's `useSetConsoleAction` is live, so the TopBar action button (新建模型 / 新建资源) follows the tab automatically.

**Tab A — Models (`ModelsPage`)** — full-width `DataTable` of relay models. Columns:

- `name` — sortable; `ProviderIcon(provider=resource_id)` + bold `name`, optional ` · display` muted suffix.
- `modality` — raw value, width 96px.
- `capabilities` — icon chips for active flags only (`tools→Wrench, vision→Eye, audio→Waveform, json→BracketsCurly, stream→Lightning`); `—` if none; width 128px.
- `inputPrice` / `outputPrice` — `Number(input_price)` + ` /tok` muted suffix, sortable on numeric value, `.tabular`, width 116px each. (NOTE: prices are µcredit/token integers rendered via `Number()`, _not_ the `Money` component.)
- `visibility` — custom pill (`enums.visibility.*`), width 110px.
- `status` — `StatusBadge`, width 100px.

Table features: `searchable`, `selectable`, `pageSize={20}`, `actionsWidth="132px"`. Per-row actions: Edit (Pencil → opens `ModelEditor`), Grants (Users → opens `ModelGrantsDrawer`), Delete (Trash, danger → `ConfirmDialog`). Bulk actions bar: Enable / Disable (PATCH each selected model's `status`; selection cleared only on success). Empty state `models.empty`; loading = `RoseLoader` (DataTable internal).

**Tab B — Resources (`ResourcesPage`)** — master/detail. Master is a `CardCollection layout="list"` of `EntityCard`s: glyph `ProviderIcon(provider_type)`, title = resource `id`, `StatusBadge`, chips `[modality, provider_type, ...exec_modes]`, click → `setId(r.id)` (URL `?id=`). Empty `resources.empty`; loading via CardCollection. Detail = `ResourceDetailPane` (or a placeholder panel `resources.detail.pick` when nothing is selected).

**Detail pane (`ResourceDetailPane`)** — one scrolling column of three uppercase `Section`s (no inner tabs):

1. **Overview** — glyph + resource id + meta line (`modality · provider_type · exec_modes`, `StatusBadge`, `v{current_version}`) + a `SelectField` to set resource status active/disabled (PATCH `/admin/resources/:id`).
2. **Channels** — "Add channel" Button (opens `ChannelEditor`) + `DataTable` (cols: provider w/ icon, endpoint, model, weight 64px, status 96px). Row actions: Edit, Pause/Play toggle status, Sync-models (ArrowsClockwise, per-row loading), Delete (Trash danger → ConfirmDialog). Bulk enable/disable. Empty `channels.empty`.
3. **Pricing** — "Add price" Button (opens `PricingModal`) + `DataTable` (cols: method, timing, version, active→StatusBadge), `pageSize={10}`. Empty `pricebook.empty`.

**Overlays:**

- `ModelEditor` (**Drawer**) — create vs edit. Create: name/resource(`SelectField`)/modality editable. Edit: name/resource/modality rendered **read-only/disabled** (backend `UpdateModelDto` excludes them); form seeded from `getModel`. Shared fields: display (`TextField`), `CapabilitiesField` toggle group, visibility `SelectField` (tenant hint), inputPrice/outputPrice `NumberField` (µcredit/token, with credits-per-1M hint), status `SelectField`.
- `ModelGrantsDrawer` (**Drawer**) — note that grants only gate `tenant`-visibility models; `TenantSelect` + Add button; `DataTable` of grants (tenant name+id, granted date); per-row revoke (Trash danger → ConfirmDialog).
- `ChannelEditor` (**Drawer**) — provider `ComboboxField` (disabled on edit — immutable), endpoint `TextField`, model `ComboboxField` (suggestions = this resource's registered model names), proxyRef, weight `NumberField` (min 1), status `SelectField`, credential `SecretSelect` with an inline "new credential" panel that POSTs `/admin/secrets` and backfills `credentialRef`, and a `KeyValueEditor` config (no raw JSON; async-media preset).
- `PricingModal` (**Modal**) — method/timing `SelectField`, resourceVersion/version `NumberField`, conditional `fixedCredits` NumberField (only `method='fixed'`, human credits), `PricebookSpecForm` (per-method branch), active `Toggle`.
- Create-resource (**Modal**, in `ResourcesPage`) — id `TextField`, `TenantSelect`, kind/modality `SelectField`, provider `ComboboxField`, execModes `ChipsField`, `IoSchemaField`.

---

### 3. BACKEND ENDPOINTS

All under `/admin/*` (AdminGuard). Reads: `GET /admin/resources`, `GET /admin/resources/:id/channels`, `GET /admin/pricebook?resourceId=`, `GET /admin/models`, `GET /admin/models/:name`, `GET /admin/models/:name/grants`, `GET /admin/secrets`, `GET /admin/tenants`. Writes: `POST/PATCH /admin/resources` (+`:id`), `POST/PATCH/DELETE /admin/resources/:id/channels[/:channelId]`, `POST /admin/resources/:id/channels/:channelId/sync-models`, `POST /admin/pricebook`, `POST /admin/secrets`, `POST/PATCH/DELETE /admin/models[/:name]`, `POST /admin/models/:name/grants`, `DELETE /admin/models/:name/grants/:tenantId`. All map to `useAdminApi()` methods (`listResources`, `createResource`, `updateResource`, `listChannels`, `createChannel`, `updateChannel`, `deleteChannel`, `syncChannelModels`, `listPricebook`, `createPricebook`, `createSecret`, `listSecrets`, `listModels`, `getModel`, `createModel`, `updateModel`, `deleteModel`, `grantModel`, `listModelGrants`, `revokeModelGrant`, `listTenants`). See the `endpoints[]` field for the exact method/path/purpose set. Admin DELETEs return **204** (soft-delete for channels/models; hard-delete for grants).

**Idempotency:** create-resource, create-channel, sync-models, create-pricebook, create-model, grant-model all pass `Idempotency-Key`. The key strategy: ResourcesPage create-modal regenerates `crypto.randomUUID()` per open; ModelEditor/ChannelEditor/PricingModal hold one stable key per mounted instance (remounted via `key={...}` per open); ModelGrantsDrawer mints a fresh UUID per grant call. `createSecret` is deliberately NOT idempotent (secret-returning) and sends no key.

---

### 4. DATA & CACHING

Entities and keys (all `qk.*` from `queryKeys.ts`):

- `qk.resources()` — `STALE_REFERENCE` (60s). Used by ResourcesPage master, ResourceDetailPane (resolves the selected resource by `find`), and ModelEditor's create-mode resource picker.
- `qk.channels(id)` — default 15s, `enabled: id!==''`. Invalidated on channel create/update/toggle/bulk/delete.
- `qk.pricebook(id)` — default 15s, `enabled: id!==''`. Invalidated on PricingModal create.
- `qk.models()` — `STALE_REFERENCE` (60s). Backs the Models table + ChannelEditor model suggestions. Invalidated on model create/update/delete, bulk status, AND on channel sync-models (sync mints models).
- `qk.model(name)` — default 15s, `enabled: open && editing`. Invalidated on model update.
- `qk.modelGrants(name)` — default 15s, `enabled: open && name!==''`. Invalidated on grant/revoke.
- `qk.secrets()` — component default (SecretSelect). Invalidated when ChannelEditor creates a credential.
- `qk.tenants()` — `STALE_REFERENCE` (60s). For TenantSelect + grant tenant-name resolution.

**Invalidation is per-page** (admin.ts carries no `queryClient`): each `useMutation.onSuccess` calls `qc.invalidateQueries` against the matching `qk`. **No optimistic updates** anywhere — all mutations invalidate-and-refetch; bulk-status clears the table selection only after the batch resolves so a failed batch keeps rows selected for retry. **Must NOT be cached:** one-time secret plaintext (never returned by design) and idempotency keys (component-local UUID state). Global query defaults: `retry:1`, `refetchOnWindowFocus:false`, base 15s stale; `mutationError(t)` is the shared `onError` (localized `errors.<code>` toast, 401 → `onUnauthorized`).

---

### 5. COMPONENTS & COMPOSITION

- **Models tab:** `DataTable` (search + select + bulk + row actions + client pagination) → `ModelEditor` **Drawer** for edit, `ModelGrantsDrawer` **Drawer** for grants, `ConfirmDialog` for delete. Cells use `ProviderIcon`, `StatusBadge`/`statusTone`, capability `Icon` chips.
- **Resources tab:** `CardCollection`(list) + `EntityCard` master → `ResourceDetailPane` detail; create via `Modal` (`TextField`, `TenantSelect`, `SelectField`, `ComboboxField`, `ChipsField`, `IoSchemaField`).
- **Detail pane:** stacked `Section`s, two `DataTable`s, `SelectField`, `Button` → `ChannelEditor` Drawer, `PricingModal` Modal, `ConfirmDialog`.
- **Editors:** Channel/Model use **Drawer** (long forms, `key`-remount per target); Pricing/Create-resource use **Modal**. Form primitives: `FormField`-based `TextField`/`SelectField`/`ComboboxField`/`NumberField`/`ChipsField`/`Toggle` plus composite `CapabilitiesField`, `IoSchemaField`, `KeyValueEditor`, `PricebookSpecForm`, `SecretSelect`, `TenantSelect`. Feedback via `toast`. **Convention:** Drawer = edit/long-form; Modal = create/short-form; ConfirmDialog = destructive.

---

### 6. LAYOUT & TYPOGRAPHY

Lives inside `ConsoleLayout` chrome (Rail + SubNav + TopBar on desktop; BottomTabs on mobile). The page action slot (新建…) and back slot are published via `useSetConsoleAction`/`useSetConsoleBack`.

- **Tab strip:** bespoke flex strip mirroring `ui/Tabs` — warm `--grad-accent` underline, roving tabindex, Arrow/Home/End keys, `role=tab/tabpanel` — but syncs to the URL instead of local state. `--fs-sm`, `fw 600`, active `--text` else `--muted`, motion gated by `useReducedMotion`.
- **Resources master/detail:** keys off `useMediaQuery(BP.xxl)` (1280px). Wide → two-column grid `minmax(280px,0.9fr) minmax(420px,1.4fr)` with independent scroll columns. Narrow → detail _replaces_ list when `?id` is set, and a TopBar back target appears (clears `?id`). `DataTable` itself flips to stacked label/value cards under `BP.md` (768px).
- **Detail sections:** uppercase `--fs-caption` tracked muted headers; overview uses `--fs-lg` semibold title. Density: compact tables, fixed-width numeric/status/weight columns, `.tabular` numerics.

---

### 7. MOCK-vs-REAL & GAPS

**This page is fully REAL (`mockStatus: real`).** Unlike the sibling billing pages (`/console/groups`, `/console/official-prices` → `mockBilling.ts`), every read and write here hits the live `/admin/*` backend through `admin.ts`/`client.ts`. There is no `mockBilling` import in any of the eight files.

Concrete, prioritized recommendations:

1. **Money precision (high):** input/output prices use `Number(m.input_price)` for display, sort, and form seeding. Backend money is bigint µcredit decimal strings; `Number()` risks precision loss on large values and diverges from the `Money` component used elsewhere. Consider rendering prices via a money-aware formatter even though the unit is µcredit/token (not whole credits).
2. **Sync-models pricing args (medium):** `syncChannelModels(id, c.id, {})` always sends an empty body, so unmatched models are created `disabled`+`needs_pricing`. There's no UI to pass `defaultInputPrice`/`defaultOutputPrice`; an operator must then hand-price each via ModelEditor. A small "sync with default price" affordance (Modal before sync) would close this loop, and the toast could surface `created`/`updated`/`needs_pricing` counts (currently only `total` is shown).
3. **Keyset pagination not wired (medium):** Models/channels/pricebook lists call `listResources/listModels/listChannels/listPricebook` which return a single `getPage→rows` page (server default 50, clamp 200). The UI paginates client-side only (`DataTable pageSize`). For tenants with >50 channels/models a page will silently truncate; wire `useKeyset` + `has_more`/`next_cursor` for these lists.
4. **Grants list assumes single page (low):** `listModelGrants` returns one page; large grant sets would truncate. Same keyset fix applies.
5. **`statusTone` semantics:** pricebook "inactive" and resource/channel "disabled" both map to the `fail` tone — visually flags a deliberately-disabled row as an error. Consider an `idle`/neutral tone for intentional disable vs failure.

> **🔎 Verification notes:** **accurate** — every claimed endpoint and component is real; the page fetches real `/admin/*` endpoints via React Query (no mock).
>
> **Endpoints (22/22 real).** All map to the single `@Controller('admin')` (`admin/admin.controller.ts`, fully `@Roles('admin')`-guarded). Verified method+path matches, including the trickier ones: `GET /admin/pricebook` reads `@Query('resourceId')` (matches `qk.pricebook(id)` + `?resourceId`), and the `:name` model routes are real with `encodeURIComponent` on the client. Frontend client mapping is in `/Users/alienworm/actionow-web/apps/web/src/lib/api/admin.ts`.
>
> **Components (24/24 real).** All exist under `.../components/`:
>
> - `ui/`: Button, Modal, Drawer, ConfirmDialog, TextField, SelectField, ComboboxField, ChipsField, NumberField, Toggle, RowAction, KeyValueEditor, toast (`ui/toast.ts`).
> - `data/`: CardCollection, EntityCard, ProviderIcon, StatusBadge (`statusTone` exported from `data/StatusBadge.tsx`), DataTable, TenantSelect, SecretSelect, CapabilitiesField, IoSchemaField, PricebookSpecForm.
> - `console/ConsoleChrome.tsx` exports both `useSetConsoleAction` and `useSetConsoleBack`.
> - The "bespoke URL-synced tab strip" is real — hand-rolled `role=tablist` in `CatalogPage.tsx` driven by `useUrlState('tab')`, mirroring `ui/Tabs`.
>
> **mockStatus = real — confirmed correct.** Catalog feature files (`ResourcesPage`, `ModelsPage`, `ResourceDetailPane`, `ChannelEditor`, `ModelEditor`, `ModelGrantsDrawer`, `PricingModal`) contain zero references to `mockBilling`/mock data; all use `@tanstack/react-query` `useQuery`/`useMutation` against `useAdminApi()` → `makeAdminApi` real HTTP client.
>
> **Minor refinements (not errors):**
>
> 1. The `POST /admin/resources/:id/channels/:channelId/sync-models` purpose says "empty body". The backend validates the body with `syncChannelModelsSchema` (`admin/dto/admin.dto.ts:139`), which accepts optional `defaultInputPrice` / `defaultOutputPrice` (non-negative ints), and the client passes a `SyncChannelModelsBody`. So "empty body" is an oversimplification — the body is optional-fields, not strictly empty.
> 2. `PATCH /admin/resources/:id` purpose ("status active/disabled") is accurate; the handler's `@ApiOperation` notes "status only — key fields are immutable", matching the SelectField-only intent.
> 3. Spec omits `GET /admin/resources/:id/channels/:channelId` (single-channel GET exists at line 681). No page code references it, so this is a correct omission, not a miss.

## 6. Modifiers (Pricing modifiers) — `/console/modifiers`

**Audience:** Operator / Admin (user.role === 'admin') · **Data status:** `real` · **Verify severity:** `clean`

**Backend endpoints**

| Method   | Path                   | Purpose                                                                                                                                                                   |
| -------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/admin/modifiers`     | List pricing modifiers (paginated envelope, page unwrapped to rows via getPage). Currently the only read the page issues.                                                 |
| `POST`   | `/admin/modifiers`     | Create a modifier (scope, op, value, whenExpr, priority). The only write the page issues. Page sends NO Idempotency-Key even though backend marks this route @Idempotent. |
| `GET`    | `/admin/modifiers/:id` | NOT USED YET — backend exists; would back a detail/edit drawer.                                                                                                           |
| `PATCH`  | `/admin/modifiers/:id` | NOT USED YET — backend exists (whenExpr/op/value/stackable/priority/active; scope NOT patchable); needed for edit + active toggle.                                        |
| `DELETE` | `/admin/modifiers/:id` | NOT USED YET — backend exists (204 soft-delete); needed for per-row delete.                                                                                               |

**Cached entities:** ModifierView[] under qk.modifiers() = ['admin','modifiers'] — default 15s staleTime (no explicit override; should be STALE_REFERENCE 60s as catalog/reference data); Invalidated on create via qc.invalidateQueries({ queryKey: qk.modifiers() }) in onSuccess; No optimistic update; no per-row caching; nothing here should be uncached (all reference data)

**Components:** `CardCollection (grid layout)`, `EntityCard (icon=SlidersHorizontalIcon, title, badge, chips, meta)`, `StatusBadge + statusTone`, `Modal (create form)`, `Button (variant ghost = TopBar action; variant cta = modal submit)`, `TextField`, `SelectField`, `useSetConsoleAction (publishes TopBar action button)`, `toast / mutationError(t)`, `RoseLoader (CardCollection loading state)`

## 1. Purpose & Audience

`/console/modifiers` is the operator-facing admin page for the **pricing modifier stack** — global and scoped rules that adjust resolved prices (markup / percent-off / flat-off / rate-override). Source: `/Users/alienworm/actionow-web/apps/web/src/features/console/ModifiersPage.tsx`.

- **Audience:** Operator / Admin only. It is one of the `billing` nav group leaves (`nav-config.ts`: group "Billing & Routing", subtitle "Global and scoped pricing rules").
- **Frontend gate:** the whole `/console/*` tree is wrapped in `ProtectedRoute role="admin"`; a logged-in non-admin is bounced to `/app`, an unauthenticated visitor to `/login`.
- **Backend gate:** all reads/writes hit `/admin/*` behind `AdminGuard + @Roles('admin')` (admin JWT bearer from `useAuth().client`).
- It is a **real, live page** (NOT a mockBilling skeleton) — unlike its two billing-group siblings `/console/groups` and `/console/official-prices`, which are mock-backed.

## 2. Content / Information Architecture

### What exists NOW

The page is intentionally minimal — a read-only card grid plus a create-only modal.

**A. TopBar action slot** — published via `useSetConsoleAction`: a `ghost` `Button` ("New modifier", `PlusIcon`) that opens the create `Modal`. Title/subtitle come from console chrome (`nav.modifiers` / `subtitles.modifiers`).

**B. Card grid** — `CardCollection` (grid layout, `minmax(280px,1fr)`) of `EntityCard`s, one per `ModifierView`. Each card shows:

- Glyph: `SlidersHorizontalIcon` (duotone gradient `.card-glyph`).
- Title: **`r.scope`** (e.g. `global`, `tenant:<id>`, `capability:<id>`, `resource:<id>`).
- Badge: `StatusBadge` — `r.active ? 'active' : 'inactive'`. Via `statusTone`, `active`→`ok` (green), `inactive`→`fail` (red). Label `t('status.active'|'status.inactive')`.
- Chips: single chip = **`r.op`** (raw op string, e.g. `percent_off`).
- Meta grid (2 cells): **Value** (`r.value ?? '—'` — raw µcredit/whole-percent string, UNFORMATTED) and **Priority** (`String(r.priority)`).

**C. Create Modal** — title `t('modifiers.new')`, footer `cta` Button "Create" (`loading` while pending). Fields (all `TextField` except op):

- `scope` — `TextField`, default `'global'`.
- `op` — `SelectField` over `OPS = ['override_rate','percent_off','flat_off','percent_add']` (default `percent_off`); options are raw op strings (no i18n label).
- `value` — `TextField`; blank → `undefined`, else coerced `Number(value)`.
- `whenExpr` — `TextField`; blank → `undefined`, else trimmed.
- `priority` — `TextField`; blank → `undefined`, else `Number(priority)`.

**States:** loading → `CardCollection` shows centered `RoseLoader` (size 64). Empty → centered muted text `t('modifiers.empty')` ("No modifiers yet"). Error → no dedicated error UI on the list query (`isError` unused); create errors surface via `mutationError(t)` → `toast` keyed `errors.<code>`.

### What it SHOULD contain (gaps vs backend)

The backend `ModifierView` carries `when_expr`, `stackable`, and `version` that the UI never shows, and exposes GET-one/PATCH/DELETE that the UI never calls. It should be upgraded to the **DataTable + Drawer + RowAction + ConfirmDialog** pattern already shipped on the sibling `OfficialPricesPage.tsx`:

- **Display the full shape:** add `when_expr` (currently hidden), `stackable` (Toggle/badge), and `version`. Render `value` semantically: for `percent_off`/`percent_add`/`override_rate`-percent ops show `N%`; for credit ops (`flat_off`) format via the `Money` component (value is a µcredit string), not raw.
- **Edit:** open a `Drawer` bound to `GET /admin/modifiers/:id` → `PATCH /admin/modifiers/:id` (note `scope` is immutable server-side; the edit form must lock it). Add a `stackable` Toggle and an `active` Toggle.
- **Delete / disable:** per-row `RowAction` (trash) → `ConfirmDialog` → `DELETE /admin/modifiers/:id` (204 soft-delete).
- **Active filter / search:** the page lists ALL modifiers incl. inactive with no filter; a `DataTable` would give search over scope/op + sort by priority.
- **i18n is already prepared** for the richer form: `modifiers.form.stackable` and `modifiers.cols.active` keys exist (en/zh) but are unused.

## 3. Backend Endpoints

Wired via `useAdminApi()` → `makeAdminApi(client)` (`/Users/alienworm/actionow-web/apps/web/src/lib/api/admin.ts`):

- **`GET /admin/modifiers`** — `api.listModifiers()` = `client.getPage<ModifierView>('/admin/modifiers')` then `.rows`. Returns the keyset envelope `{ data, next_cursor, has_more }` but the page consumes only `rows` and **ignores pagination** (no load-more; a long modifier list silently truncates at the server default limit 50).
- **`POST /admin/modifiers`** — `api.createModifier(body: CreateModifierBody)` = `client.post<ModifierView>('/admin/modifiers', body)`. Body sent: `{ scope, op, value?: number, whenExpr?: string, priority?: number }`. The page does **not** pass `stackable`, `version`, or `active`, and does **not** pass an `idempotencyKey` (the admin route is `@Idempotent`, so retries are unprotected from the client side).

**Available but UNUSED** (per inventory §1.8): `GET /admin/modifiers/:id`, `PATCH /admin/modifiers/:id` (all-optional `whenExpr?/op?/value?/stackable?/priority?/active?`; `scope` not patchable), `DELETE /admin/modifiers/:id` (204 soft-delete). `admin.ts` has **no** `getModifier`/`updateModifier`/`deleteModifier` methods — adding them is the first implementation step.

## 4. Data & Caching

- **Entity:** `ModifierView` (`/Users/alienworm/actionow-web/apps/web/src/lib/api/types.ts`): `{ id, scope, when_expr: string|null, op, value: string|null, stackable, priority, version, active }`. Note `value` is a **string** off the wire (µcredit or whole-percent) but the create form sends a `number`.
- **Query:** `useQuery({ queryKey: qk.modifiers(), queryFn: () => api.listModifiers() })`. Key = `['admin','modifiers']` (verbatim from `qk` in `queryKeys.ts`).
- **staleTime tier:** none passed → falls to the global default **15 s** (`query.ts`). This is **reference/catalog data**; it SHOULD pass `STALE_REFERENCE = 60_000` for consistency with other catalog queries.
- **Invalidation:** create `onSuccess` calls `qc.invalidateQueries({ queryKey: qk.modifiers() })` then toasts `modifiers.created` and closes the modal. Correct and the only mutation today.
- **Optimistic updates:** none. **No caching exceptions** — everything here is reference data safe to cache; nothing secret/one-time is returned.
- When edit/delete land, their `onSuccess` must also invalidate `qk.modifiers()` (and, if a detail drawer is added, fetch under a new per-id key — there is currently NO `qk.modifier(id)` factory, so one must be added).

## 5. Components & Composition

Current composition is **card-grid + create-modal** (no master/detail, no table, no row actions):

- `CardCollection` (grid) → `EntityCard` (icon `SlidersHorizontalIcon`, `title`, `badge`, `chips`, `meta`; no `actions`, not clickable).
- `StatusBadge` + `statusTone` for the active/inactive pill.
- `Modal` for create (NOT `Drawer`) — short 5-field form fits a modal; footer single `cta` Button.
- Form primitives: `TextField` (scope/value/whenExpr/priority) + `SelectField` (op). No `NumberField` despite numeric fields — values are kept as strings and coerced with `Number()` at submit.
- Chrome: `useSetConsoleAction` publishes the ghost "New modifier" button into the TopBar action slot.
- Errors: `mutationError(t)` + `toast`.

**Recommended target composition** (mirroring `OfficialPricesPage.tsx`): swap `CardCollection`→`DataTable` (searchable, sortable by priority, `RowAction` edit+delete cells), create→`Drawer` (also reused for edit, `row === undefined` = create), and `ConfirmDialog` for delete. Use `NumberField` for `value`/`priority`, `Toggle` for `stackable`/`active`, `ComboboxField` for `scope` with `global`/`tenant:`/`capability:`/`resource:` suggestions.

## 6. Layout & Typography

- Outer wrapper is `height:100%`; cards flow in `CardCollection`'s responsive grid (`repeat(auto-fill, minmax(280px,1fr))`, gap `--s-4`), with a GSAP stagger-reveal (`fromTo opacity/y`, stagger 0.04) gated to no-reduced-motion.
- Sits inside `ConsoleLayout`: desktop = Rail + SubNav (billing group) + TopBar; mobile = BottomTabs (modifiers is NOT a mobile tab, so reachable only via SubNav on desktop / direct URL). The page itself adds no in-page Tabs/SegmentedControl — it is a single flat view.
- Typography is card-driven: title `--fs-base`/`fw-semibold`/`track-snug` truncated; meta labels `--fs-caption` uppercase `--faint`; meta values `--fs-sm` `.tabular`. No page-level `<h1>` (the title lives in TopBar chrome). Density is low (one rule per card); a `DataTable` upgrade would raise density substantially for operators managing many rules.

## 7. Mock-vs-Real & Gaps

- **Data is REAL.** Reads/writes hit live `/admin/modifiers` via `client.ts`/`admin.ts`. There is **no** `mockBilling.ts` involvement and **no** `MockBadge` (correctly — this page is not a billing-group mock skeleton despite sitting in the billing nav group alongside the two mocked pages).
- **Prioritized recommendations:**
  1. **Add edit + delete.** Backend has `GET/PATCH/DELETE /admin/modifiers/:id`; the UI is create-only and can never modify or remove a rule. Add `getModifier`/`updateModifier`/`deleteModifier` to `admin.ts` and a `Drawer` + `RowAction` + `ConfirmDialog` (copy `OfficialPricesPage.tsx`). Highest impact — modifiers are currently write-once from the UI.
  2. **Surface hidden fields** `when_expr`, `stackable`, `version` (all returned, none shown). Add `stackable` to the create body (i18n key already exists).
  3. **Format `value`** by op type — render percents as `N%` and credit values via `Money` (it is a µcredit string), instead of the raw string shown today.
  4. **Honor pagination** — `listModifiers()` drops `next_cursor`/`has_more`; lists beyond the server default (50) silently truncate. Either switch to `useKeyset(qk.modifiers(), …)` or move to a `DataTable` with load-more.
  5. **Pass an `Idempotency-Key`** on create (route is `@Idempotent`) to make retries safe, matching the convention used for other idempotent admin POSTs.
  6. **Bump staleTime to `STALE_REFERENCE` (60 s)** — this is catalog/reference data, not operational/live-usage.

> **🔎 Verification notes:** **Verdict: accurate.** Every endpoint, component, field claim, and the mock/real status check out against real code.
>
> **Endpoints — all 5 confirmed** in `apps/api/src/admin/admin.controller.ts` under `@Controller('admin')` (lines 776–816):
>
> - `POST /admin/modifiers` → `@HttpCode(201)` + `@Idempotent()` (line 776–778). ✔
> - `GET /admin/modifiers` → paginated `PageEnvelope<ModifierView>` (line 786). ✔
> - `GET /admin/modifiers/:id` → `getModifier`, 404 on miss (line 796). ✔
> - `PATCH /admin/modifiers/:id` → `updateModifier` (line 802). ✔
> - `DELETE /admin/modifiers/:id` → `@HttpCode(204)` soft-delete (line 811). ✔
> - Guard/audience: class-level `@UseGuards(AdminGuard)` + `@Roles('admin')` — admin JWT. The spec doesn't mislabel this.
>
> **PATCH patchable fields confirmed** in `apps/api/src/admin/dto/admin.dto.ts:213` `updateModifierSchema`: `whenExpr` (nullable), `op`, `value`, `stackable`, `priority`, `active`. `scope` is NOT in the schema. Exactly as the spec states.
>
> **Idempotency claim confirmed.** `ModifiersPage.tsx` calls `api.createModifier({...})` with no key, and `useAdminApi`/`admin.ts:78` defines `createModifier: (body) => client.post('/admin/modifiers', body)` — no `idempotencyKey` arg, no options passed. So the page sends NO `Idempotency-Key` even though the route is `@Idempotent()`. (Sibling writes like `createTenant`/`createModel` DO accept/forward a key; modifier create is the outlier — spec correctly flags this.)
>
> **mockStatus = real → CORRECT.** `mockBilling.ts` contains mock data only for OfficialPrices, RouteGroups, and Channels — there is no modifier mock. `ModifiersPage.tsx` does not import `mockBilling`; it goes `useAdminApi` → `admin.ts` → real `client.getPage`/`client.post`. The list read unwraps the envelope via `client.getPage` (`{ rows: env.data, nextCursor: env.next_cursor }`, `client.ts:81`), matching "page unwrapped to rows via getPage."
>
> **Minor field-name refinements (not errors in the spec, but worth noting):**
>
> - Backend `ModifierView` (types.ts:80 / `toModifierView` admin.controller.ts:1306) returns snake_case `when_expr` and `value` as a **decimal string | null** (µcredits serialized as string), not a number. The create form sends camelCase `whenExpr` (the DTO accepts camelCase) and `value` as a number — asymmetry is intentional per the DTO docs.
> - The page reads `r.scope` (as card title), `r.op` (chip), `r.value`, `r.priority`, `r.active` — all present on `ModifierView`. No phantom fields.
>
> **Component note:** `RoseLoader` lives at `components/ui/RoseLoader.tsx` (the spec lists it as the CardCollection loading state; CardCollection receives `loading={isLoading}` — consistent). All 10 components resolve to real files.

## 7. Route Groups (Billing/Routing) — `/console/groups`

**Audience:** Operator / Admin (role === 'admin') · **Data status:** `full-mock` · **Verify severity:** `clean`

**Backend endpoints**

| Method   | Path                                          | Purpose                                                                                                                                                                               |
| -------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/admin/route-groups`                         | List route groups (PageEnvelope<RouteGroupView>) — replaces mock listRouteGroups()                                                                                                    |
| `POST`   | `/admin/route-groups`                         | Create a route group {name, groupRatioBps?, description?, status?} → RouteGroupView; @Idempotent (send Idempotency-Key) — replaces mock createRouteGroup()                            |
| `GET`    | `/admin/route-groups/:id`                     | Get one route group by id (404 if absent) — optional detail fetch                                                                                                                     |
| `PATCH`  | `/admin/route-groups/:id`                     | Update {name?, groupRatioBps?, status?, description?(nullable)} → RouteGroupView — replaces mock updateRouteGroup()                                                                   |
| `DELETE` | `/admin/route-groups/:id`                     | Soft-delete group → 204 (frees name, drops from routing) — replaces mock deleteRouteGroup()                                                                                           |
| `GET`    | `/admin/route-groups/:id/channels`            | List a group's channel memberships (PageEnvelope<RouteGroupChannelView>: group_id, channel_id, priority, weight, created_at) — replaces mock listGroupChannels()/countGroupChannels() |
| `PUT`    | `/admin/route-groups/:id/channels/:channelId` | Upsert membership; body {priority?(def 0), weight?(def 1)} → RouteGroupChannelView — replaces BOTH mock addGroupChannel() and updateGroupChannel()                                    |
| `DELETE` | `/admin/route-groups/:id/channels/:channelId` | Hard-delete membership → 204 — replaces mock removeGroupChannel()                                                                                                                     |
| `GET`    | `/admin/resources`                            | List resources to drive a per-resource channel picker (replaces MOCK_CHANNELS roster)                                                                                                 |
| `GET`    | `/admin/resources/:id/channels`               | List real channels of a resource (ChannelView) for the membership add-picker — replaces MOCK_CHANNELS                                                                                 |
| `PATCH`  | `/admin/api-keys/:id/group`                   | (Adjacent) Bind/unbind an API key to a route group {routeGroupId: uuid                                                                                                                | null} — the consumer side of route groups; lives on the api-keys page but conceptually pairs with this feature |

**Cached entities:** RouteGroup list → key qk.routeGroups() = ['admin','route-groups'] (NEW factory needed; today ['mock','route-groups']), staleTime STALE_REFERENCE (60s) — catalog/config data; RouteGroupChannel memberships per group → qk.groupChannels(id) = ['admin','route-groups',id,'channels'] (NEW; today ['mock','group-channels',id]), staleTime STALE_REFERENCE (60s); Channel roster for the add-picker → qk.channels(resourceId) (EXISTING factory) once switched off MOCK_CHANNELS, staleTime STALE_REFERENCE (60s); DO NOT cache: one-time plaintext (n/a here), and the mutation responses themselves — invalidate keys instead of storing returns; Channel COUNT column must NOT use a separate sync read (today countGroupChannels is a sync mock call); derive from the cached membership query or accept it as an unfetched/lazy column

**Components:** `DataTable`, `Column<RouteGroup>`, `RowAction`, `Button`, `Drawer`, `TextField`, `NumberField`, `SelectField`, `ConfirmDialog`, `StatusBadge`, `statusTone`, `MockBadge (REMOVE on real switch)`, `toast`, `mutationError`, `useSetConsoleAction`, `useQuery / useMutation / useQueryClient`

## Route Groups (分组) — `/console/groups`

Primary file: `/Users/alienworm/actionow-web/apps/web/src/features/console/RouteGroupsPage.tsx`
Data module (current): `/Users/alienworm/actionow-web/apps/web/src/lib/api/mockBilling.ts`
Types: `/Users/alienworm/actionow-web/apps/web/src/lib/api/types.ts` (`RouteGroup`, `RouteGroupChannel`, `MockChannel`)

---

### 1. PURPOSE & AUDIENCE

Operator-only page for managing **route groups** — named channel pools that carry a global customer-price **ratio** (basis points; `10000 = ×1.00`) and a routing membership of channels with per-membership **priority** (higher = tried first) and **weight** (weighted-random within a tier). API keys get bound to a group (via the separate api-keys page / `PATCH /admin/api-keys/:id/group`), so this page defines the billing-multiplier + failover topology that those keys route through.

- **Frontend gate:** `ProtectedRoute role="admin"` (a logged-in non-admin is bounced to `/app`; unauthenticated → `/login`). Nav leaf is the **billing** group, route `/console/groups`, `labelKey: routeGroups` (deliberately not `groups`, to avoid colliding with the `nav.groups.*` group-label namespace).
- **Backend guard for the data it SHOULD use:** `AdminGuard` + `@Roles('admin')` on the whole `admin.controller.ts`; auth = admin JWT bearer. Client-side gating is advisory; every `/admin/*` call is re-checked server-side.

---

### 2. CONTENT / INFORMATION ARCHITECTURE

**Page shell (current):** a plain scrollable `<div>` (`overflowY:auto`, padding `var(--s-2) var(--s-3) var(--s-4)`). Heading row = an `<h1>` (`--fs-md`, `--fw-semibold`) reading `groups.title` + a `<MockBadge/>` ("演示数据") pill. The page does **not** use the chrome TopBar title for its own H1 — it renders its own header inline. It DOES publish a TopBar action via `useSetConsoleAction`: a ghost `Button` (`PlusIcon` + `groups.new`) that opens the create Drawer.

**Main table — `DataTable<RouteGroup>`** (`searchable`, `pageSize={20}`, client-side paged, `actionsWidth="132px"`). Columns:
| key | header (i18n) | cell | width | sortable |
|---|---|---|---|---|
| `name` | `groups.cols.name` | `<strong>{name}</strong>` | 180px | yes (`sortValue: name`) |
| `ratio` | `groups.cols.ratio` | `×N.NN` (bold, `.tabular`) + signed `±P%` delta vs ×1.00 baseline; delta `var(--faint)` at 0 else `var(--muted)` | 140px | yes (`sortValue: group_ratio_bps`) |
| `status` | `groups.cols.status` | `<StatusBadge tone={statusTone(status)} label={t('status.'+status)}/>` | 100px | no |
| `description` | `groups.cols.description` | `description ?? '—'` | flex | no |
| `channels` | `groups.cols.channels` | `.tabular` count via `countGroupChannels(id)` (sync mock call) | 96px | no |

**Per-row actions** (`rowActions`): `RowAction` ✎ edit (`groups.actions`→opens edit Drawer), `RowAction` ⬚ `StackIcon` manage-channels (`groups.actions.manageChannels`→opens membership Drawer), `RowAction` 🗑 delete (`danger`→opens ConfirmDialog).

**Create/Edit Drawer — `RouteGroupEditor`** (`row===undefined`→create). Fields:

- `TextField` **name** (required, tooltip `groups.tip.name`)
- `NumberField` **ratioPercent** (min 0, step 5; baseline 100 = ×1.00). Live hint `groups.ratioEquiv` renders `×N.NN (+P%) · BBBB bps`. Internally `bps = round(ratioPct*100)`.
- `SelectField` **status** (`active`/`disabled`, options from local `GROUP_STATUSES`)
- `TextField` **description** (optional)
- Footer: `Button variant="cta"` save (loading-bound to `save.isPending`).

**Manage-Channels Drawer — `GroupChannelsDrawer`** (`width="min(560px,96vw)"`). Contents:

- **Add-channel picker row:** `SelectField` (`groups.channels.add`) of channels NOT already in the group (`MOCK_CHANNELS` minus current `memberIds`); placeholder switches to `groups.channels.allAdded` when none left. Adjacent `Button variant="cta"` (+) adds the picked channel.
- **Membership list:** one `.panel` card per member. Card header = channel label (`channelLabel(channel_id)` resolved against `MOCK_CHANNELS`) + a ghost remove `Button` (`TrashIcon`). Card body = two `NumberField`s side by side: **priority** (min 0, step 10, hint `groups.channels.priorityHint`) and **weight** (min 0, step 10, hint `groups.channels.weightHint`). Each `onChange` immediately fires the update mutation (no save button — inline persist).
- **States:** `isLoading` → renders nothing in the list region; empty → a centered `.panel` empty card (`groups.channels.empty`).

**Delete confirm — `ConfirmDialog`** (`danger`, loading-bound), message `groups.confirm.deleteMsg` interpolating the group name.

**States that exist:** table `loading` (RoseLoader inside DataTable), table `empty` (`groups.empty`), drawer-level loading. **States MISSING / TO ADD on real switch:** there is **no error state** anywhere (mock never rejects); list/membership query errors are silently swallowed. Real wiring must surface query errors (the page only handles mutation errors via `mutationError(t)`). The channels count column has no loading/error affordance because it is a synchronous mock read today.

---

### 3. BACKEND ENDPOINTS (exact, from `admin.controller.ts` lines 1001–1074 + DTO `admin.dto.ts` 469–506)

Reads:

- `GET /admin/route-groups?cursor&limit` → `PageEnvelope<RouteGroupView>`. `RouteGroupView = { id, name, group_ratio_bps:number, status, description:string|null, created_at, updated_at }`.
- `GET /admin/route-groups/:id` → `RouteGroupView` (404 if absent).
- `GET /admin/route-groups/:id/channels?cursor&limit` → `PageEnvelope<RouteGroupChannelView>`. `RouteGroupChannelView = { group_id, channel_id, priority:number, weight:number, created_at }`.
- (picker) `GET /admin/resources` then `GET /admin/resources/:id/channels` → `PageEnvelope<ChannelView>` to replace the fixed `MOCK_CHANNELS` roster.

Writes:

- `POST /admin/route-groups` `{ name, groupRatioBps?, description?, status? }` → `201 RouteGroupView`. **@Idempotent** — pass `Idempotency-Key` via `client.post(path, body, { idempotencyKey })`. Name unique among live groups.
- `PATCH /admin/route-groups/:id` `{ name?, groupRatioBps?, status?, description?(nullable) }` → `RouteGroupView`.
- `DELETE /admin/route-groups/:id` → **204** (soft-delete; frees name; drops from routing).
- `PUT /admin/route-groups/:id/channels/:channelId` body `{ priority?(int, default 0), weight?(int>0, default 1) }` → `RouteGroupChannelView`. **Idempotent upsert** — this single PUT replaces BOTH the mock `addGroupChannel` AND `updateGroupChannel`.
- `DELETE /admin/route-groups/:id/channels/:channelId` → **204** (hard-delete membership).

Adjacent (consumer side, lives on api-keys page): `PATCH /admin/api-keys/:id/group` `{ routeGroupId: uuid|null }` → `{ id, route_group_id }`.

**CRITICAL field-mapping gotchas for the swap:**

1. Mock `createRouteGroup`/`updateRouteGroup` send snake_case **`group_ratio_bps`**; the real DTO expects camelCase **`groupRatioBps`**. The save mutation body must be re-keyed.
2. Mock seed bodies pass `description: undefined`; real PATCH supports `description: null` to clear — wire null-clearing.
3. Mock `addGroupChannel(groupId, channelId, priority=100, weight=100)` defaults to **100/100**; real PUT defaults to **0/1**. New memberships should pass explicit `{priority, weight}` to preserve intended behavior (don't rely on defaults).
4. List responses are **cursor/keyset envelopes** (`{data,next_cursor,has_more}`), not arrays — use `client.getPage` (→ `{rows,nextCursor}`) and either `useKeyset` for load-more or accept the default 50-row first page. The mock returns plain arrays today.

---

### 4. DATA & CACHING

**Current (mock):** `useQuery({ queryKey: ['mock','route-groups'], queryFn: listRouteGroups })` and per-group `['mock','group-channels',id]`. Channel count uses a **synchronous** `countGroupChannels(id)` call inside the cell (not a query) — re-renders only when the page re-renders, and is invalidated indirectly by membership add/remove invalidating `QK_GROUPS`. No staleTime override (inherits 15s default). Mutations: delete/save invalidate `['mock','route-groups']`; membership add/remove invalidate both the per-group key AND `QK_GROUPS` (so the count column refreshes); inline priority/weight update invalidates only the per-group key.

**Real target:**

- Add `qk.routeGroups()` = `['admin','route-groups']` and `qk.groupChannels(id)` = `['admin','route-groups',id,'channels']` to `queryKeys.ts` (no `qk` entry exists today). Add `listRouteGroups/createRouteGroup/updateRouteGroup/deleteRouteGroup/listGroupChannels/upsertGroupChannel/removeGroupChannel` methods to `admin.ts`.
- **staleTime tier:** route groups + memberships are **config/catalog** data → `STALE_REFERENCE` (60s), not volatile usage. They change only on explicit admin mutation.
- **Invalidation on mutation:** save/delete → invalidate `qk.routeGroups()`; membership add(PUT)/remove(DELETE) → invalidate `qk.groupChannels(id)` AND `qk.routeGroups()` (count column); inline priority/weight PUT → invalidate `qk.groupChannels(id)`.
- **Optimistic updates:** good candidate for the inline priority/weight `NumberField`s (PUT upsert is idempotent and cheap) to avoid the per-keystroke round-trip flicker; otherwise debounce the `onChange`→PUT since today every keystroke fires a mutation.
- **Channel-count column:** must stop being a sync call. Either (a) derive from a cached `qk.groupChannels(id)` query (N+1 small queries, acceptable at `STALE_REFERENCE`), or (b) drop the count from the list and show it only inside the manage Drawer. There is no count field on `RouteGroupView`, so a count requires fetching memberships.
- **Do NOT cache:** mutation return values (invalidate instead); no secret/plaintext exists on this surface.

---

### 5. COMPONENTS & COMPOSITION

Composition pattern = **DataTable (master list) + Drawer (edit form) + Drawer (membership editor) + ConfirmDialog (destructive)** — table/drawer, not master-detail cards. This matches the catalog conventions. Exact design-system components in use:

- `DataTable` with typed `Column<RouteGroup>[]`, `searchable`, `pageSize`, `rowActions`, `actionsWidth`.
- `RowAction` (3 per row: edit / manage-channels / delete-danger).
- `Drawer` (heavier-than-Modal side panel) for BOTH the create/edit form and the membership editor — correct choice for multi-field + list-heavy forms.
- Form set: `TextField`, `NumberField`, `SelectField` (all composed on `FormField`, all with `tooltip`).
- `ConfirmDialog` (built on `Modal`) for delete.
- `StatusBadge` + `statusTone` for active/disabled.
- `Button` (`variant="cta"` for primary save/add, `variant="ghost"` for the TopBar action and remove).
- `MockBadge` (REMOVE when switched to real backend), `toast`, `mutationError(t)`, `useSetConsoleAction`.
- **NOT used / candidates to add:** no `Money` (ratio is a plain bps number, not a µcredit string — correctly avoids `Money`); no `ProviderIcon` on channel rows (could add when switching to real `ChannelView` to show provider brand); membership rows are bespoke `.panel` cards rather than a nested `DataTable` (intentional, for the inline editors).

---

### 6. LAYOUT & TYPOGRAPHY

- **Chrome:** standard `ConsoleLayout` (Rail + SubNav + TopBar on desktop ≥768px; BottomTabs on mobile). The billing group is the `CoinsIcon` rail group; SubNav lists Groups / Official prices / Modifiers. TopBar shows `nav.routeGroups` title + `subtitles.routeGroups` ("Route groups & channel membership") and the page-published New action + refresh button.
- **In-page heading:** the page renders its OWN `<h1>` (`--fs-md`, `--fw-semibold`) next to the MockBadge — a second heading below the TopBar title, slightly redundant; on real switch consider dropping the inline H1 in favor of the chrome title or keep it as a section header.
- **Density:** standard DataTable density, 20-row client pages, global search box. Ratio + count columns use `.tabular` numerics.
- **Responsive:** DataTable auto-switches to stacked label/value cards on mobile (<768px, driven by `useMediaQuery(BP.md)`); Drawers are `min(480px,96vw)` (edit) and `min(560px,96vw)` (membership), full `100dvh`, right-slide. No bespoke responsive logic in the page itself.
- **Heading hierarchy:** TopBar title (page) → inline `<h1>` (`--fs-md`) → Drawer titles → membership `.panel` card `<strong>` channel labels + `FormField` labels.

---

### 7. MOCK-vs-REAL & GAPS → mockStatus = **full-mock**

**Everything on this page is mock.** It imports exclusively from `mockBilling.ts` (`listRouteGroups`, `createRouteGroup`, `updateRouteGroup`, `deleteRouteGroup`, `countGroupChannels`, `listGroupChannels`, `addGroupChannel`, `updateGroupChannel`, `removeGroupChannel`, `MOCK_CHANNELS`). State is in-memory module arrays seeded with 3 groups (`default` 10000/active, `premium` 15000/active, `economy` 8000/disabled) and 3 memberships; IDs are a deterministic `rg_NNNN`/counter; every call goes through a 120ms `delay()`; **state resets on page reload**. Zero network traffic.

**The real backend NOW EXISTS on this branch (track 3)** and maps 1:1 — confirmed in `admin.controller.ts` (`POST/GET/GET:id/PATCH/DELETE /admin/route-groups`, `PUT/GET/DELETE /admin/route-groups/:id/channels/:channelId`) and `admin.dto.ts` (createRouteGroupSchema/updateRouteGroupSchema/addGroupChannelSchema). This is the prime candidate to flip from mock to real.

**Prioritized recommendations:**

1. **Add API layer + keys (P0):** add the 7 route-group methods to `admin.ts`, add `qk.routeGroups()` and `qk.groupChannels(id)` to `queryKeys.ts`, mark POST `@Idempotent`-capable via the `{idempotencyKey}` post option.
2. **Re-key the save body (P0):** `group_ratio_bps` → `groupRatioBps`; support `description: null` clearing on PATCH. This is the single highest-risk transformation in the swap.
3. **Collapse add+update membership onto the single PUT (P0):** the real `PUT .../channels/:channelId` is an idempotent upsert — use it for both the add-picker and the inline priority/weight edits. Pass explicit priority/weight (real defaults are 0/1, not the mock's 100/100). Delete uses the real DELETE (204).
4. **Replace `MOCK_CHANNELS` with real channels (P1):** the add-picker must list real `ChannelView`s. Backend channels are scoped per-resource (`GET /admin/resources/:id/channels`), so the picker needs a resource selector first, or an aggregate fetch across resources. This is the only piece without a drop-in 1:1 endpoint and warrants its own design decision (the membership `:channelId` is a global channel id, so any resource's channels can be added).
5. **Channel-count column (P1):** stop using the sync `countGroupChannels`; either derive from a `qk.groupChannels(id)` query per row or move the count into the Drawer (no count field exists on `RouteGroupView`).
6. **Add list/membership error states (P1):** real queries can reject (401/404/500); today only mutations are error-handled. Surface query errors (empty-with-retry) since the mock never fails.
7. **Cosmetic (P2):** remove `<MockBadge/>`; switch staleTime to `STALE_REFERENCE`; optionally debounce or make optimistic the per-keystroke priority/weight PUTs; consider `ProviderIcon` on channel membership rows.
8. **Cross-link the consumer (P2):** route groups are only meaningful once API keys are bound via `PATCH /admin/api-keys/:id/group`. Consider surfacing "keys bound to this group" or linking to the api-keys page, since that binding is the actual effect of a group.

> **🔎 Verification notes:** **Verdict: accurate.** All 11 endpoints, all components, and the mockStatus are correct as specified.
>
> **Endpoints (all real).** Every claimed path exists in `apps/api/src/admin/admin.controller.ts` under `@Controller('admin')` (route-groups block lines 999-1074, resources lines 622-707, api-key group binding lines 498-506). Verb + path all match:
>
> - `GET/POST /admin/route-groups`, `GET/PATCH/DELETE /admin/route-groups/:id`
> - `GET /admin/route-groups/:id/channels`, `PUT`/`DELETE /admin/route-groups/:id/channels/:channelId`
> - `GET /admin/resources`, `GET /admin/resources/:id/channels`
> - `PATCH /admin/api-keys/:id/group`
>
> **Field-name accuracy (verified against `admin/dto/admin.dto.ts`):**
>
> - Create/Update body uses camelCase `groupRatioBps` (lines 472, 485) — spec writes `groupRatioBps?` correctly. Note: the _response_ `RouteGroupView` returns it snake_cased as `group_ratio_bps` (controller line 351/1213). PATCH `description` is `.nullable().optional()` (line 487) — spec's "description?(nullable)" is right.
> - `PUT .../channels/:channelId` body `{priority?, weight?}` (lines 500-505). Defaults: `priority` default **0**, `weight` default **1** — spec says "priority?(def 0), weight?(def 1)" — correct.
> - `RouteGroupChannelView` = `{group_id, channel_id, priority, weight, created_at}` (controller lines 362-368, mapper 1221-1229) — exactly as spec claims.
> - `PATCH /admin/api-keys/:id/group` body `{routeGroupId: uuid|null}` (`updateApiKeyGroupSchema`, lines 66-68) — correct.
> - `@Idempotent()` is present on `POST /admin/route-groups` (controller line 1003) — spec's "@Idempotent (send Idempotency-Key)" is right. (`PUT .../channels/:channelId` is NOT @Idempotent — but spec doesn't claim it is.)
>
> **Guard/audience:** whole controller is `@UseGuards(AdminGuard) @Roles('admin')` (lines 394-395) — admin-JWT only. Spec's "admin" framing is correct.
>
> **Mock status: confirmed `full-mock`.** `RouteGroupsPage.tsx` imports `listRouteGroups, createRouteGroup, updateRouteGroup, deleteRouteGroup, listGroupChannels, countGroupChannels, addGroupChannel, updateGroupChannel, removeGroupChannel, MOCK_CHANNELS` from `../../lib/api/mockBilling` (lines 19-30), uses mock query keys `['mock','route-groups']` (line 35), and renders `<MockBadge/>` (line 158). `mockBilling.ts` header explicitly states the routing backend is "DESIGN-ONLY today." So although the real `/admin/route-groups` endpoints now exist on the backend, the page does NOT call them yet — it is still 100% mock. Spec is correct.
>
> **Minor refinements (not errors):**
>
> - Components: all live under `apps/web/src/components` — `data/{DataTable,MockBadge,StatusBadge}.tsx`, `ui/{Button,Drawer,TextField,NumberField,SelectField,ConfirmDialog,RowAction}.tsx`, `ui/toast.ts`, `console/ConsoleChrome.tsx` (provides `useSetConsoleAction`). `Column<RouteGroup>` is a type exported from `data/DataTable` and `statusTone` is a fn in `data/StatusBadge` (line 25) — not standalone files, but both real exports. `mutationError` lives at `lib/api/mutationError.ts` (a lib helper, not under `components`, but the spec lists it as a "component" loosely — it exists).
> - The spec's note that the api-key group-bind endpoint "lives on the api-keys page" is accurate framing; it is the one route in this list the RouteGroups page itself does not consume.
> - On the real switch, the page must drop `countGroupChannels` (mock-only synchronous count) — the real `GET .../channels` returns a `PageEnvelope` whose count comes from pagination meta, not a separate call. Spec already anticipates this ("replaces mock listGroupChannels()/countGroupChannels()").

## 8. Official Prices — `/console/official-prices`

**Audience:** Operator / Admin (role === 'admin') · **Data status:** `full-mock` · **Verify severity:** `clean`

**Backend endpoints**

| Method   | Path                                                 | Purpose                                                                                                                                                                                    |
| -------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`    | `(none — currently mockBilling.listOfficialPrices)`  | List official prices. SHOULD be GET /admin/official-prices (PageEnvelope<OfficialPriceView>, query provider?/limit?/cursor?)                                                               |
| `POST`   | `(none — currently mockBilling.createOfficialPrice)` | Create a price. SHOULD be POST /admin/official-prices (@Idempotent; body provider/modelSlug/displayName?/inputUsdPer1m/outputUsdPer1m/cachedInputUsdPer1m?/sourceUrl?/effectiveAt?/notes?) |
| `PATCH`  | `(none — currently mockBilling.updateOfficialPrice)` | Edit a price. SHOULD be PATCH /admin/official-prices/:id (nullable-clearable fields; provider/modelSlug NOT patchable)                                                                     |
| `DELETE` | `(none — currently mockBilling.deleteOfficialPrice)` | Soft-delete a price. SHOULD be DELETE /admin/official-prices/:id → 204; frees (provider,slug)                                                                                              |
| `GET`    | `(unused) GET /admin/official-prices/:id`            | Single-row fetch exists in backend but page never needs it (edits read from the in-memory list cache)                                                                                      |

**Cached entities:** OfficialModelPrice list under key ['mock','official-prices'] (queryFn=mockBilling.listOfficialPrices). REAL TARGET: key should become qk-style ['admin','official-prices', {provider?}] with STALE_REFERENCE (60s) — this is rarely-changing catalog data.; Invalidate that key on create/update/delete success (page already does qc.invalidateQueries({queryKey: QK}) in all three mutations).; Do NOT cache the one-time create/edit Drawer form state in TanStack (kept in local useState, re-seeded via useEffect on row change).; No optimistic updates today (mutations refetch on success). When wired to real backend, keep refetch-on-success; optimism is unnecessary for low-frequency catalog edits.

**Components:** `DataTable`, `Column<T>`, `RowAction`, `Button`, `Drawer`, `FormField`, `TextField`, `NumberField`, `ComboboxField`, `ConfirmDialog`, `ProviderIcon`, `MockBadge`, `toast`, `useSetConsoleAction`, `mutationError`, `useFieldId`

## Official Prices — `/console/official-prices`

Primary file: `/Users/alienworm/actionow-web/apps/web/src/features/console/OfficialPricesPage.tsx` (single file; exports `OfficialPricesPage`, plus two private subcomponents `DateField` and `OfficialPriceEditor`). Data module: `/Users/alienworm/actionow-web/apps/web/src/lib/api/mockBilling.ts`. Type: `OfficialModelPrice` in `/Users/alienworm/actionow-web/apps/web/src/lib/api/types.ts:197`.

### 1. Purpose & Audience

Operator/admin reference catalog of **upstream published model prices** (USD per 1M tokens) — e.g. OpenAI gpt-4o, Anthropic claude-3-5-sonnet. It is the human-readable price book operators consult/curate; it is deliberately decoupled from the live µcredit/token billing registry (units here are µUSD-per-1M, not µcredits).

- **Audience:** operator only. Lives in the `billing` nav group (`CoinsIcon`), nav label `nav.officialPrices` ("Official prices"), subtitle "Reference model prices".
- **Frontend gate:** `ProtectedRoute role="admin"` (a logged-in non-admin is bounced to `/app`; unauthenticated → `/login`). Client gate is advisory only (decoded-not-verified JWT).
- **Backend gate (when wired):** `AdminGuard` + `@Roles('admin')` over `/admin/official-prices`, admin JWT bearer signed with `ADMIN_JWT_SECRET`.

### 2. Content / Information Architecture

**NOW (as built):**

- **Page header row:** an in-page `<h1>` (`--fs-md`, `--fw-semibold`) reading `t('officialPrices.title')` followed inline by a `<MockBadge/>` (the warm "演示数据 (mock)" pill). Note: the page renders its own `<h1>` _in addition to_ the chrome `TopBar` title — a double-title quirk worth flagging.
- **TopBar action slot:** published via `useSetConsoleAction` — a `ghost` `Button` with `PlusIcon` + `t('officialPrices.new')` that opens the create Drawer.
- **Main table — `DataTable`** of `OfficialModelPrice` rows. Columns (exact):
  1. `provider` — `ProviderIcon size={18}` + raw provider string; sortable by `provider`; width 160px.
  2. `model_slug` — bold slug; sortable.
  3. `display_name` — plain text (no sort).
  4. `input` (input price) — `$X.XX /1M` tabular; sortable by `input_price_per_1m`; width 128px.
  5. `output` (output price) — `$X.XX /1M` tabular; sortable; width 128px.
  6. `effective_at` — ISO date or `—`; sortable; width 120px.
  7. `source` — if `source_url` set, an accent external link (`t('officialPrices.source')` + `ArrowSquareOutIcon`, `target=_blank rel=noreferrer noopener`); else `—`; width 104px.
  - Table props: `searchable` (global box over stringified visible cells), `pageSize={20}` (client-side pager), `loading={isLoading}` (RoseLoader), `empty={t('officialPrices.empty')}`, `actionsWidth="92px"`.
  - **Row actions** (`rowActions`): two `RowAction` icon buttons — edit (`PencilSimpleIcon`) → opens edit Drawer; delete (`TrashIcon`, `danger`) → opens ConfirmDialog.
- **Create/Edit Drawer (`OfficialPriceEditor`):** right-slide `Drawer` (title `officialPrices.editTitle` vs `officialPrices.new`), footer = single `cta` Save button with `loading`. Fields top-to-bottom:
  - `provider` — `ComboboxField`, required, suggestions = `COMMON_PROVIDERS` (`openai/anthropic/gemini/azure/bedrock/cohere/mistral`), hint shows them joined by `·`.
  - `model_slug` — `TextField`, required.
  - `display_name` — `TextField`.
  - `input_price` — `NumberField` (µUSD/1M, `min=0 step=1000`), hint `= $X.XX/1M` via `usdLabel`.
  - `output_price` — `NumberField`, same.
  - `cached_input_price` — `NumberField`, same; sent only when `> 0`.
  - `effective_at` — bespoke `DateField` (native `type="date"` on the `FormField` shell, because `TextField` has no date type).
  - `source_url` — `TextField type="url"`.
  - `notes` — `TextField`.
  - Form state is local `useState`, re-seeded by a `useEffect` keyed on `row` (page also remounts via `key={editId}`). Empty strings/zeros are normalized to `undefined` before submit.
- **Delete confirm:** `ConfirmDialog` (`danger`, `loading={del.isPending}`), message interpolates `model_slug`.

**States:** loading → DataTable RoseLoader; empty → `officialPrices.empty`; error → mutation errors surface via `mutationError(t)` → localized `toast(..., 'error')`; there is **no list-level error UI** (a failed `listOfficialPrices` would just leave `data` undefined → empty table — acceptable for mock, but real wiring should add a retry/error affordance).

**SHOULD additionally contain (gaps):** server-side `provider` filter (TopBar `Select`), keyset "load more" (real list is paginated, not a bounded array), a `cached_input_price_per_1m` column (currently captured in the form but never shown in the table), `notes`/`updated_by`/`updated_at` surfacing, and an error state for the list query.

### 3. Backend Endpoints

The page calls **zero HTTP** today — all four operations go through in-memory `mockBilling.ts`. The real backend is fully built and seeded (`/Users/alienworm/actionow-core/apps/api/src/admin/admin.controller.ts:950-996`, seed `/Users/alienworm/actionow-core/apps/api/src/seed/seed-official-prices.ts`). Target mapping:

- `listOfficialPrices()` → `GET /admin/official-prices?provider=&limit=&cursor=` → `PageEnvelope<OfficialPriceView>`.
- `createOfficialPrice(body)` → `POST /admin/official-prices` (`@Idempotent`; `(provider,modelSlug)` unique; service converts HUMAN USD → µUSD/1M).
- `updateOfficialPrice(id, patch)` → `PATCH /admin/official-prices/:id` (nullable-clearable; `provider`/`modelSlug` NOT patchable).
- `deleteOfficialPrice(id)` → `DELETE /admin/official-prices/:id` → 204 (soft-delete; frees `(provider,slug)`).
- (`GET /admin/official-prices/:id` exists but is unused by this UI.)

**Critical shape impedance** (must be handled in the swap): `OfficialPriceView` returns money as **decimal STRINGS in µUSD** (`input_price_per_1m: string`, `cached_input_price_per_1m: string|null`), and write DTOs take **HUMAN USD numbers** (`inputUsdPer1m`). The mock/UI uses **integer µUSD numbers** for read AND write (`input_price_per_1m: number`, step 1000). Also `display_name`/`source_url`/`effective_at`/`notes` are nullable in the view but non-null/optional in the mock type. The wiring layer must (a) parse view strings→numbers (big-decimal-safe, not naive `Number()`), (b) convert µUSD↔USD for the write DTO, and (c) map `null`↔`undefined`.

### 4. Data & Caching

- **Entity:** `OfficialModelPrice[]` via `useQuery({ queryKey: ['mock','official-prices'], queryFn: listOfficialPrices })` (the `QK` const). NOT in the central `qk` map — billing mock pages inline their own keys.
- **staleTime:** none set → falls to global 15s default. **Should be `STALE_REFERENCE` (60s)** — this is rarely-changing catalog data.
- **Invalidation:** all three mutations (`del`, and `save` for both create+edit) call `qc.invalidateQueries({ queryKey: QK })` on success, then `toast` + close. Correct pattern; carries over verbatim to the real key.
- **Optimistic updates:** none (refetch-on-success). Fine for low-frequency edits.
- **Do NOT cache:** Drawer form state (local `useState`), and when wired, the write DTO conversions. The list itself is safe to cache (reference data).
- **When real:** switch key to a `qk`-style `['admin','official-prices', { provider }]`, use `getPage`/`useKeyset` for cursor pagination (drop `pageSize={20}` client pager in favor of "load more"), and keep the same `onSuccess` invalidate.

### 5. Components & Composition

Table-with-Drawer (NOT master/detail, NOT CardCollection): `DataTable` (`Column<OfficialModelPrice>[]`) for the list + `RowAction` cells, a right-slide `Drawer` for create/edit, and `ConfirmDialog` for delete. Form built from `FormField`-based primitives: `ComboboxField` (provider), `TextField` (slug/displayName/sourceUrl[url]/notes), `NumberField` (3 price fields), and a bespoke `DateField` (native date `<input>` on the `FormField` shell via `useFieldId`). `Button` (ghost in TopBar action, cta in Drawer footer). `ProviderIcon` resolves vendor brand marks; `MockBadge` flags mock data; `toast` + `mutationError(t)` for feedback; `useSetConsoleAction` publishes the TopBar action. No `StatusBadge`/`Money` (this catalog has no status enum and uses a custom `usdLabel` dollar formatter, NOT the µcredit `Money` component — correct, since units are µUSD not µcredits).

### 6. Layout & Typography

Outer `div` is `height:100%; overflowY:auto; padding: var(--s-2) var(--s-3) var(--s-4)` — the page owns its own scroll within the chrome `<Outlet/>`. Header is a flex row (`gap var(--s-3)`, `marginBottom var(--s-3)`) with `<h1>` (`--fs-md`, `--fw-semibold`) + `MockBadge`. Heading hierarchy is shallow (single h1 inside, plus the chrome TopBar title/subtitle). Density: medium — a 7-column table at `pageSize 20`. Responsive: handled entirely by `DataTable` — desktop renders a real `<table>` (sticky header, pinned actions column); mobile (<768px, `BP.md`) renders stacked label/value cards. The `Drawer` is `width: min(480px,96vw)`, full `100dvh`. No in-page tabs/sub-nav. All motion respects `prefers-reduced-motion`.

### 7. Mock-vs-Real & Gaps

**Status: FULL MOCK.** Every read/write hits the in-memory `mockBilling.ts` arrays (seeded with 5 rows: openai gpt-4o + gpt-4o-mini, anthropic claude-3-5-sonnet + claude-3-5-haiku, gemini gemini-1.5-pro), with a 120ms artificial `delay` and counter ids (`op_0001…`). **State resets on page reload.** The `MockBadge` correctly advertises this.

**The backend is ALREADY built and seeded — this page is the highest-value mock-to-real swap on the billing surface.** `admin.controller.ts:950-996` ships full CRUD; `seed-official-prices.ts` seeds ~19 rows with **real prices cited from each provider's official pricing page read 2026-06-18** (today), grouped openai/anthropic/google, idempotent find-then-create on `(provider, slug)`. The data layer (`mockBilling.ts` header) explicitly designed this as a single-file swap to `/admin/official-prices`.

**Prioritized recommendations:**

1. **Add real client methods** to `api/admin.ts` (`listOfficialPrices`/`createOfficialPrice`/`updateOfficialPrice`/`deleteOfficialPrice`) + a `qk.officialPrices(provider?)` key, and repoint `OfficialPricesPage` imports off `mockBilling`. Remove `MockBadge`.
2. **Handle the unit/shape impedance** (see §3): view returns µUSD **strings** + nullable fields; write DTO takes **HUMAN USD**. Either convert in the client layer or change the form to enter USD directly and keep µUSD only for display.
3. **Provider-value mismatch to reconcile:** UI/mock use `gemini` (from `COMMON_PROVIDERS`) but the backend seed uses `google`. The combobox suggestions and the seeded `(provider,slug)` keys won't line up — pick one canonical provider vocabulary before wiring.
4. **Replace the client pager** (`pageSize={20}`) with keyset pagination (`useKeyset` + `next_cursor`/`has_more`) and add a TopBar `provider` filter `Select` (backend supports `?provider=`).
5. **Set `STALE_REFERENCE` (60s)** on the list query and add a list-level error/retry state (none today).
6. **Idempotency:** pass an `Idempotency-Key` on the create POST (it's `@Idempotent`); PATCH/DELETE need none.

> **🔎 Verification notes:** **Verdict: accurate.** The spec correctly identifies every "SHOULD be" backend endpoint, and the mock status is right.
>
> **Endpoints** — all five exist under `@Controller('admin')` (`/Users/alienworm/actionow-core/apps/api/src/admin/admin.controller.ts`), so the spec's `SHOULD be` paths are exact:
>
> - `GET /admin/official-prices` (L962) → `PageEnvelope<OfficialPriceView>`, query `provider?/limit?/cursor?` — matches `officialPricesQuerySchema` (dto L456).
> - `POST /admin/official-prices` (L950) → `@HttpCode(201)` + `@Idempotent()` (L951-952) confirmed. Body matches `createOfficialPriceSchema` (dto L418): `provider`, `modelSlug`, `displayName?`, `inputUsdPer1m`, `outputUsdPer1m`, `cachedInputUsdPer1m?`, `sourceUrl?`, `effectiveAt?`, `notes?`. (Note: `inputUsdPer1m`/`outputUsdPer1m` are **required** in create, not optional — spec implies this correctly by omitting `?`.)
> - `PATCH /admin/official-prices/:id` (L983) → matches `updateOfficialPriceSchema` (dto L441): nullable-clearable on `displayName`/`cachedInputUsdPer1m`/`sourceUrl`/`effectiveAt`/`notes`; `provider`/`modelSlug` absent (not patchable). Matches spec exactly.
> - `DELETE /admin/official-prices/:id` (L992) → `@HttpCode(204)`, soft-delete, frees (provider,slug). Matches.
> - `GET /admin/official-prices/:id` (L977) exists; spec correctly notes the page never uses it (edits read from the in-memory list via `(data ?? []).find(...)`, page L212).
>
> **Components** — all 16 resolve to real files: `components/data/{DataTable(+Column<T>),MockBadge,ProviderIcon}`, `components/ui/{Button,Drawer,FormField(+useFieldId),TextField,NumberField,ComboboxField,ConfirmDialog,RowAction,toast}`, `components/console/ConsoleChrome` (exports `useSetConsoleAction`), `lib/api/mutationError` (exports `mutationError`). None phantom.
>
> **mockStatus = full-mock — correct.** `OfficialPricesPage.tsx` imports `listOfficialPrices`/`createOfficialPrice`/`updateOfficialPrice`/`deleteOfficialPrice` from `lib/api/mockBilling.ts`, which is a `setTimeout`-backed in-memory store (no `fetch`/network). Query key is `['mock','official-prices']`. Page renders a `<MockBadge/>`.
>
> **Refinements (non-blocking, for whoever wires this up):**
>
> - The page's local model (`OfficialModelPrice` in `lib/api/types`) uses snake_case + integer µUSD/1M (`model_slug`, `input_price_per_1m`, `cached_input_price_per_1m`, `source_url`, `effective_at`). The real DTO contract uses camelCase + **human USD-per-1M** (`modelSlug`, `inputUsdPer1m`, …), with the service doing `round(usd × 1e6)`. So real wiring needs a name + units remap (the page currently does µUSD math client-side via `usdLabel`). The spec's body field list reflects the real backend names, which is the right thing to document.
> - Real GET returns a `PageEnvelope` (cursor paging); the mock returns a flat array and the page does client-side `searchable`/`pageSize={20}`. Wiring will need to consume the envelope.
> - `effectiveAt` real schema is `z.string().datetime()` (ISO 8601 / full timestamp), but the page's `DateField` emits a bare `yyyy-mm-dd` date — that would fail `.datetime()` validation as-is.
>
> **Audience/guard:** route group is `admin` (not `console`/`v1`), consistent with the page living at `/console/official-prices` but targeting the admin API surface — spec's "SHOULD be `/admin/...`" is correct.

## 9. Dify Import — `/console/dify`

**Audience:** Operator / Admin (role === 'admin') · **Data status:** `partial-mock` · **Verify severity:** `minor`

**Backend endpoints**

| Method   | Path                      | Purpose                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `POST`   | `/admin/dify/import`      | WIRED NOW. Import a Dify workflow YAML as an Actionow resource. Body { tenantId, resourceId, yaml, endpoint, pricingModel } (page never sends serviceKeyRef or allowBlockers though both are supported). Returns 200 DifyImportView { resource_id, version, io_schema:{inputs,outputs}, compat_report:{items,has_blockers} }. Is @Idempotent; BYO+metered -> 400; has_blockers without allowBlockers -> 422. |
| `GET`    | `/admin/dify`             | NOT WIRED (should be). PageEnvelope<DifyBindingView> — list of imported Dify bindings { resource_id, resource_version, mode, endpoint, service_key_ref, pricing_model, provision_mode, created_at }. Needed for the 'list' the task describes; no admin.ts method exists yet.                                                                                                                                |
| `PATCH`  | `/admin/dify/:resourceId` | NOT WIRED (should be). All-optional { endpoint?(url), serviceKeyRef?(uuid                                                                                                                                                                                                                                                                                                                                    | null), pricingModel? } -> DifyBindingView. The 'patch' the task describes; no admin.ts method exists yet. |
| `DELETE` | `/admin/dify/:resourceId` | NOT WIRED (should be). Soft-delete a binding, returns 204. The 'delete' the task describes; no admin.ts method exists yet.                                                                                                                                                                                                                                                                                   |
| `GET`    | `/admin/tenants`          | NOT WIRED on this page (should be). Backs a TenantSelect so the operator picks a tenant instead of pasting a raw uuid. qk.tenants(), STALE_REFERENCE.                                                                                                                                                                                                                                                        |
| `GET`    | `/admin/secrets`          | NOT WIRED on this page (should be). Backs a SecretSelect for the optional serviceKeyRef (BYO Dify service key). qk.secrets(), STALE_REFERENCE.                                                                                                                                                                                                                                                               |

**Cached entities:** NONE cached today: the page holds zero TanStack queries. Only useMutation(api.difyImport). The compat report is held in local useState (report), not in the query cache.; SHOULD cache: qk.tenants() (STALE_REFERENCE 60s) when adding TenantSelect; SHOULD cache: qk.secrets() (STALE_REFERENCE 60s) when adding SecretSelect for serviceKeyRef; SHOULD ADD a new key (no qk entry exists) e.g. ['admin','dify'] for the GET /admin/dify binding list (STALE_REFERENCE 60s); invalidate it on successful import / patch / delete; DO NOT cache: the DifyImportView result of POST /admin/dify/import (one-shot compatibility report tied to a specific import run; keep in local state, not query cache)

**Components:** `SectionHeader`, `TextField`, `JsonField (currently misused for YAML)`, `SelectField`, `Button (variant cta, loading)`, `toast`, `mutationError`, `useAdminApi`, `useMutation`, `RECOMMENDED ADD: TenantSelect`, `RECOMMENDED ADD: SecretSelect`, `RECOMMENDED ADD: DataTable or CardCollection (binding list)`, `RECOMMENDED ADD: StatusBadge (has_blockers / pricing_model)`, `RECOMMENDED ADD: Drawer (edit binding)`, `RECOMMENDED ADD: ConfirmDialog (delete binding)`, `RECOMMENDED ADD: Toggle (allowBlockers)`, `RECOMMENDED ADD: Tabs (Import | Imported bindings)`

## Dify Import — `/console/dify`

> Primary file: `/Users/alienworm/actionow-web/apps/web/src/features/console/DifyImportPage.tsx` (70 lines, single component `DifyImportPage`). Route registered in `/Users/alienworm/actionow-web/apps/web/src/routes.tsx:55`. i18n under `console.dify.*` in `/Users/alienworm/actionow-web/apps/web/src/i18n/locales/{en,zh-CN}/console.json`.

### 1. PURPOSE & AUDIENCE

- **Who:** Operator / Admin only — `user.role === 'admin'`. The route lives inside `<Route element={<ProtectedRoute role="admin" />}>` → `<ConsoleLayout>` (`routes.tsx:38-55`). A logged-in non-admin is bounced to `/app`; unauthenticated → `/login`.
- **Why:** Onboard a third-party **Dify workflow** (exported YAML) into Actionow's catalog as a runnable **resource** so it can be priced and called through the platform. This is the "import a Dify workflow as a resource" leaf under the **Catalog** nav group (`nav-config.ts`; subtitle "Import a Dify workflow as a resource").
- **Backend guard:** `AdminGuard` + `@Roles('admin')` on `admin-dify.controller.ts` (prefix `/admin/dify`). Frontend gating is advisory only; the server re-verifies the admin JWT signature (`ADMIN_JWT_SECRET`) and role.

### 2. CONTENT / INFORMATION ARCHITECTURE

**What exists NOW** — a single vertical form (`flex column`, `gap var(--s-4)`, `maxWidth 640`) plus a conditional result panel. There is **no list, no edit, no delete** despite the task framing ("import + list + patch + delete"). Concretely:

| Element              | Component                                                | Binds to                             | Notes                                                                                                                                                     |
| -------------------- | -------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dify.title` heading | `SectionHeader`                                          | —                                    | no right-side action node                                                                                                                                 |
| Tenant               | `TextField`                                              | `tenantId` state                     | **raw free-text uuid paste** — no `TenantSelect`                                                                                                          |
| Resource ID          | `TextField`                                              | `resourceId` state                   | free text; becomes the new resource's id                                                                                                                  |
| Dify endpoint        | `TextField`                                              | `endpoint` state                     | plain text input — **no `type="url"`**, no client validation (backend requires a URL)                                                                     |
| Workflow YAML        | `JsonField` (`dify.form.yaml`, placeholder `"app: ..."`) | `yaml` state                         | **misuse**: `JsonField` is a monospace textarea whose `validateJson` is **not invoked here**, so YAML is sent raw (correct effect, wrong-named component) |
| Pricing model        | `SelectField`                                            | `pricingModel` state (`'fixed'`)     | options `fixed` / `matrix` / `metered` from `console.dify.pricing.*`                                                                                      |
| Import               | `Button variant="cta"` `loading={submit.isPending}`      | fires `submit.mutate()`              | label `dify.submit` ("Import")                                                                                                                            |
| Compatibility report | `.panel` with `<pre className="mono">`                   | `report.compat_report` (local state) | only renders after a successful import; dumps `JSON.stringify(compat_report, null, 2)` raw                                                                |

**States:**

- **Loading:** the CTA `Button` shows its built-in `CircleNotchIcon` spinner (`loading` prop) during the POST. No skeletons elsewhere.
- **Success:** `onSuccess` → `setReport(r)` + `toast(t('dify.imported'))` ("Imported"). Report panel appears.
- **Error:** `mutationError(t)` → localized `toast('errors.'+code)`; notably `422` (`content_filtered`/blockers) and `400` (BYO+metered, malformed) surface only as a generic toast — there is **no inline field validation and no surfacing of `compat_report.has_blockers` on failure**.
- **Empty:** before first import, no report panel; the form is the whole page.

**What it SHOULD contain** (to match the stated import + list + patch + delete scope):

1. **Tabs** (`ui/Tabs`): `Import` | `Imported bindings`.
2. **Import tab** — keep the form but: replace tenant `TextField` with `TenantSelect`; add a `SecretSelect` for the optional **`serviceKeyRef`** (BYO Dify service key — currently never sent); add a `Toggle` for **`allowBlockers`** (i18n key `dify.form.allowBlockers` already exists in en/zh but is unused) so a `422 has_blockers` import can be retried; render the compat report as a structured list of `compat_report.items` with a `has_blockers` `StatusBadge` and the resolved `io_schema.inputs/outputs`, not a raw `<pre>`.
3. **Imported bindings tab** — a `DataTable<DifyBindingView>` (columns: resource_id, resource_version, mode, pricing_model `StatusBadge`-ish chip, endpoint, service_key_ref, provision_mode, created_at) with **row actions**: Edit (Drawer → PATCH endpoint/serviceKeyRef/pricingModel) and Delete (`ConfirmDialog` → DELETE, 204 soft-delete).

### 3. BACKEND ENDPOINTS

**Wired now (1 of 4 Dify endpoints):**

- `POST /admin/dify/import` via `api.difyImport(body)` (`admin.ts:81`, `client.post<DifyImportView>('/admin/dify/import', body)`). Body sent = `{ tenantId, resourceId, yaml, endpoint, pricingModel }`. **`serviceKeyRef` and `allowBlockers` are in `DifyImportBody` (`types.ts:316-324`) but never populated by the page.** Returns **200** `DifyImportView { resource_id, version, io_schema:{inputs,outputs}, compat_report:{items,has_blockers} }`. Endpoint is `@Idempotent` server-side, but `admin.ts:difyImport` does **not** pass an `idempotencyKey` (unlike `createResource`/`createModel`), so duplicate submits are not de-duplicated client-side. Server rules: BYO + `metered` → 400; blockers present without `allowBlockers` → 422.

**Available in inventory but NOT wired (no method in `admin.ts`):**

- `GET /admin/dify` → `PageEnvelope<DifyBindingView>` — the **list**.
- `PATCH /admin/dify/:resourceId` (`{ endpoint?, serviceKeyRef?(uuid|null), pricingModel? }`) → `DifyBindingView` — the **patch**.
- `DELETE /admin/dify/:resourceId` → **204** soft-delete — the **delete**.

**Supporting reads to add:** `GET /admin/tenants` (TenantSelect) and `GET /admin/secrets` (SecretSelect for `serviceKeyRef`).

### 4. DATA & CACHING

- **Today: zero TanStack queries.** The only data hook is `useMutation({ mutationFn: api.difyImport, onSuccess, onError })`. The compat report lives in `useState<DifyImportView | null>` — **not** in the query cache. Nothing is cached, nothing is invalidated.
- **`queryKeys.ts` has NO `dify` factory** (confirmed: `qk` has no Dify entry). Adding the binding list requires a new key, e.g. `qk.dify()` → `['admin','dify']`, at **`STALE_REFERENCE` (60s)** since bindings change rarely (catalog-tier data, not live-usage).
- **Invalidation:** once the list exists, `difyImport` `onSuccess`, plus future PATCH/DELETE mutations, should `queryClient.invalidateQueries({ queryKey: qk.dify() })` (per the codebase convention that pages — not `admin.ts` — own invalidation).
- **TenantSelect/SecretSelect** reuse existing `qk.tenants()` / `qk.secrets()` (both `STALE_REFERENCE`).
- **Optimistic updates:** not warranted — import returns a compat report (server-computed) and PATCH/DELETE are infrequent admin actions; prefer invalidate-on-success over optimistic.
- **Do NOT cache:** the `DifyImportView` POST result — it's a one-shot report bound to a specific import run; keep it in local state.

### 5. COMPONENTS & COMPOSITION

- **Used now:** `SectionHeader`, `TextField` ×3, `JsonField` (for YAML — semantically the wrong primitive; a generic mono `<textarea>`/`CodeField` would be more honest), `SelectField`, `Button`, `toast`, `mutationError`, `useAdminApi`. No `DataTable`, no `Drawer`/`Modal`, no `StatusBadge`, no `Money` (no money on this page), no `TenantSelect`/`SecretSelect`.
- **Composition now:** flat single-column form, no master/detail, no table.
- **Recommended composition:** `Tabs` strip → (Import form) + (`DataTable<DifyBindingView>` with `rowActions`). Edit = right-slide **`Drawer`** (long form pattern) → PATCH. Delete = **`ConfirmDialog`** → DELETE. Add **`TenantSelect`**, **`SecretSelect`**, and a **`Toggle`** (allowBlockers). Render compat items with **`StatusBadge`** (`statusTone`) for blocker/non-blocker.

### 6. LAYOUT & TYPOGRAPHY

- Renders inside the standard `ConsoleLayout` chrome: desktop = `Rail` + `SubNav` (Catalog group) + `TopBar` (title `nav.dify`="Dify import", subtitle "Import a Dify workflow as a resource") + scrollable `Outlet`. Mobile = `TopBar` + `BottomTabs` (note: Dify is **not** in `MOBILE_TABS`, so on mobile it's reachable only via deep link / catalog, not the tab bar).
- The page itself publishes **nothing** into the chrome slots — no `useSetConsoleAction` (the Import CTA is inline in the body, not the TopBar action slot), no `useSetConsoleFilters`, no `useSetConsoleBack`.
- Body is a fixed `maxWidth: 640` column, `gap var(--s-4)` (16px). Single `SectionHeader` `<h2>` (`--fs-base`, bold). Report panel uses `.panel` + `--r-md` + `--s-4` padding; report label `--fs-sm`/`--muted`; the `<pre>` is `mono`, `--fs-sm`, `whiteSpace:pre-wrap`. Low density, no responsive divergence (the form already fits mobile at 640 max-width). Heading hierarchy is shallow (one h2).

### 7. MOCK-vs-REAL & GAPS

- **Real, not mock.** Unlike the sibling billing pages (`/console/groups`, `/console/official-prices`) which run on `mockBilling.ts`, this page hits the **live** `/admin/dify/import` through `client.ts`. `mockStatus: partial-mock` is assigned because the **write path is real but the list/patch/delete surface the task names is entirely absent** — those three endpoints exist in the backend inventory yet have **no `admin.ts` method and no UI**, so the page silently implements only ~25% of the documented Dify surface.
- **Prioritized recommendations:**
  1. **Add the binding list** — add `listDify()` (`GET /admin/dify` via `getPage`), a `qk.dify()` key, a `Tabs` strip, and a `DataTable<DifyBindingView>`. This is the biggest gap vs. the stated scope.
  2. **Add edit + delete** — `patchDify(resourceId, body)` (PATCH) in a `Drawer`, `deleteDify(resourceId)` (DELETE) behind `ConfirmDialog`; invalidate `qk.dify()` on success.
  3. **Wire `serviceKeyRef` + `allowBlockers`** — add a `SecretSelect` and a `Toggle`; both are already in `DifyImportBody`/i18n but unused. `allowBlockers` is the only path to recover from a `422 has_blockers` import without leaving the page.
  4. **Replace tenant `TextField` with `TenantSelect`** — pasting a raw uuid is error-prone; the select already exists and caches `qk.tenants()`.
  5. **Surface the compat report structurally** — parse `compat_report.items` / `io_schema` into a readable list with `has_blockers` badging instead of a raw `JSON.stringify` `<pre>`; show it on `422` failures too (currently only a generic error toast).
  6. **Minor:** `endpoint` field should be `type="url"`; pass an `idempotencyKey` on `difyImport` (the endpoint is `@Idempotent`) to make accidental double-submits safe; the YAML field uses `JsonField` (whose `validateJson` is dead code here) — swap to a plainly-named mono textarea to avoid the misleading "JSON" affordance.

> **🔎 Verification notes:** ## Verdict: spec is largely accurate; main error is `mockStatus`.
>
> ### Endpoints — all 6 REALLY exist in the backend (0 phantom)
>
> Backend controller `/Users/alienworm/actionow-core/apps/api/src/admin/admin-dify.controller.ts` is `@Controller('admin/dify')` and defines **all four** dify routes:
>
> - `POST /admin/dify/import` — `@Idempotent()`, `@HttpCode(200)`, returns `DifyImportView { resource_id, version, io_schema:{inputs,outputs}, compat_report:{items,has_blockers} }`. Confirmed.
> - `GET /admin/dify` — `list()` returns `PageEnvelope<DifyBindingView>`. The `DifyBindingView` field list in the spec (`resource_id, resource_version, mode, endpoint, service_key_ref, pricing_model, provision_mode, created_at`) matches `toDifyBindingView` **exactly**. Confirmed.
> - `PATCH /admin/dify/:resourceId` — `update()`, all-optional `updateDifySchema { endpoint?(url), serviceKeyRef?(uuid|null), pricingModel? }`. Confirmed (dto admin.dto.ts:240).
> - `DELETE /admin/dify/:resourceId` — `@HttpCode(204)`, soft-delete. Confirmed.
> - `GET /admin/tenants` (admin.controller.ts:416) and `GET /admin/secrets` (admin.controller.ts:527) both exist. Confirmed.
>
> ### "NOT WIRED" label is about the FRONTEND client, and that's correct
>
> The spec's "NOT WIRED (no admin.ts method exists yet)" claims refer to the web client, not the backend. Verified: `/Users/alienworm/actionow-web/apps/web/src/lib/api/admin.ts` has **only** `difyImport` (line 81) — no `difyList`/`difyUpdate`/`difyDelete`. So GET/PATCH/DELETE are genuinely unconsumed by the SPA even though the API serves them. queryKeys `qk.tenants()` (queryKeys.ts:3) and `qk.secrets()` (line 8) exist but the page doesn't import them. All accurate.
>
> ### `import` body — spec's parenthetical is correct
>
> `difyImportSchema` (admin.dto.ts:224) supports `serviceKeyRef` (uuid|null, optional) and `allowBlockers` (bool, optional); the page's `submit` mutation (DifyImportPage.tsx:27-33) sends only `{tenantId, resourceId, yaml, endpoint, pricingModel}` — never `serviceKeyRef`/`allowBlockers`. The web `DifyImportBody` type (types.ts:316) declares both as optional, so they CAN be sent but the page omits them. Spec is right.
>
> ### mockStatus is WRONG → should be `real` (not `partial-mock`)
>
> The page (`DifyImportPage.tsx`) calls `useAdminApi()` → `api.difyImport(...)` → `client.post('/admin/dify/import')`. No mock import, no `mockBilling` reference (grep returned none). `mockBilling.ts` only mocks official-prices and route-groups, not dify. For the single endpoint the page actually uses, it is fully real-wired. Correct value: **real** (with the caveat that list/patch/delete are simply not implemented in the page at all — that's "missing feature," not "mock").
>
> ### Component notes (minor)
>
> - All claimed real component files exist under `/Users/alienworm/actionow-web/apps/web/src/components/ui/`: SectionHeader, TextField, JsonField, SelectField, Button, toast (toast.ts). `JsonField` misuse-for-YAML claim is accurate (DifyImportPage.tsx:44 uses `<JsonField>` for the YAML field with placeholder `app: ...`).
> - `toast`, `mutationError`, `useAdminApi`, `useMutation` aren't `components/` — `mutationError` is `lib/api/mutationError.ts`, `useAdminApi` is `lib/api/useAdminApi.ts`, `useMutation` is from `@tanstack/react-query`. Listing them under "components" is loose but they are real symbols the page imports.
> - Several "RECOMMENDED ADD" components already exist as files (not phantom, just unused here): `Drawer.tsx`, `ConfirmDialog.tsx`, `Toggle.tsx`, `Tabs.tsx`. So the spec under-credits available primitives. `TenantSelect`, `SecretSelect`, `DataTable`/`CardCollection`, `StatusBadge` do NOT exist — but they are framed as recommendations, not existence claims, so not phantom.
>
> ### One real type-shape refinement
>
> The web `DifyImportView` (types.ts:103) types `io_schema` and `compat_report` as `unknown` (vs the backend's structured shape). The page only renders `report.compat_report` as raw JSON, so this is harmless but worth noting if a future UI wants typed `has_blockers`.

## 10. Tenants — `/console/tenants`

**Audience:** Operator / Admin (role === 'admin') · **Data status:** `real` · **Verify severity:** `clean`

**Backend endpoints**

| Method  | Path                         | Purpose                                                                                                                                                                                                                     |
| ------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`   | `/admin/tenants`             | List all tenants (first keyset page, 50 rows). Page calls api.listTenants() which unwraps PageEnvelope<TenantView> and keeps only env.data rows — next_cursor/has_more are discarded, so only the first page is ever shown. |
| `POST`  | `/admin/tenants`             | Create a tenant. Body { name (required), isolationMode?: 'field'                                                                                                                                                            | 'schema' | 'db' }. Returns 201 TenantView. @Idempotent on backend but the page passes NO Idempotency-Key (createTenant(body) called with one arg). |
| `GET`   | `/admin/tenants/:id`         | AVAILABLE but UNUSED. Single TenantView (404 if absent). No getTenant method exists in admin.ts; would back a future detail view.                                                                                           |
| `PATCH` | `/admin/tenants/:id`         | AVAILABLE but UNUSED. Body { isolationMode? } — only isolation_mode is mutable. No updateTenant method exists in admin.ts; would back an inline edit. There is intentionally NO tenant DELETE.                              |
| `POST`  | `/admin/accounts`            | RELATED, on sibling /console/accounts page. Creates a billing account for a tenant { tenantId, credits? }. Belongs to the per-tenant relationship a detail view should surface.                                             |
| `GET`   | `/admin/api-keys`            | RELATED, on sibling /console/api-keys page. query tenantId required; PageEnvelope<ApiKeyView>. Per-tenant key management a tenant detail view should deep-link to.                                                          |
| `GET`   | `/admin/models/:name/grants` | RELATED. Model grants are keyed by tenant (ModelGrantView.tenant_id). A tenant detail view would summarize which models a tenant is granted; today this is only reachable from the Catalog/Models page.                     |

**Cached entities:** TenantView[] @ qk.tenants() = ['admin','tenants'], staleTime STALE_REFERENCE (60s) — reference/catalog tier; Mutation createTenant invalidates qk.tenants() in onSuccess (await qc.invalidateQueries({ queryKey: qk.tenants() })); no optimistic update; Plaintext / secrets: none on this page (no key minting here) — nothing to keep out of cache; No detail-entity caching: there is no qk.tenant(id); accounts/api-keys/grants caches live on sibling pages keyed by tenantId

**Components:** `CardCollection (grid layout)`, `EntityCard (BuildingsIcon glyph, title, chips, meta grid)`, `Modal (create form)`, `Button (variant ghost top-bar action; variant cta submit)`, `TextField`, `SelectField`, `toast`, `RoseLoader (loading state inside CardCollection)`, `useSetConsoleAction (publishes the New-tenant button into TopBar)`, `PlusIcon / BuildingsIcon (Phosphor)`

## Tenants — `/console/tenants`

Primary file: `/Users/alienworm/actionow-web/apps/web/src/features/console/TenantsPage.tsx` (94 lines, single component, no child page-components beyond shared primitives).

---

### 1. PURPOSE & AUDIENCE

- **Who:** Operator / Admin only. The route is registered in `routes.tsx` under the `ProtectedRoute role="admin"` console subtree (`<Route path="tenants" element={<TenantsPage />} />`). A logged-in non-admin is bounced to `/app`; an unauthenticated visitor to `/login`.
- **Why:** The first stop in multi-tenant administration — create new tenants and view the roster. A tenant is the billing/isolation boundary that accounts, API keys, resources, and model grants all hang off of.
- **Guard chain:** Frontend `ProtectedRoute role="admin"` (cosmetic, decodes JWT without verifying). Backend `AdminGuard` + `@Roles('admin')` on the whole `AdminController`, verified against `ADMIN_JWT_SECRET`. Auth is the admin JWT bearer token sourced from `useAuth().client`.
- **Nav placement:** group `tenants` (`BuildingsIcon`), leaf `/console/tenants`, label `nav.tenants` = "Tenants", subtitle `subtitles.tenants` = "Create and view tenants". Also a mobile bottom tab (`BuildingsIcon`).

---

### 2. CONTENT / INFORMATION ARCHITECTURE

**Currently implemented (exactly what ships):**

- A single **card grid** (`CardCollection`, default `layout='grid'`) of all tenants. Each tenant is an `EntityCard`:
  - **glyph:** `BuildingsIcon` (gradient `.card-glyph`).
  - **title:** `r.name`.
  - **chips:** one chip = the isolation mode, localized via `t('tenants.isolation.${r.isolation_mode}', r.isolation_mode)` → "Field" / "Schema" / "Database" (raw value as fallback for unknown modes).
  - **meta grid:** one entry, label `t('tenants.cols.created')` = "Created", value `new Date(r.created_at).toLocaleDateString()` (date only, no time).
  - No `badge`, no `actions`, **card is not clickable** (no `onClick`) — purely a read tile.
- **Top-bar action** (published via `useSetConsoleAction`): a `ghost` Button "New tenant" (`PlusIcon` + `t('tenants.new')`) that opens the create modal. Lives in the TopBar action slot, not in the page body.
- **Create Modal** (`tenants.new` title) with:
  - `TextField` — Name (`t('tenants.form.name')`), bound to local `name` state. **No validation** (empty name is submittable; server returns `invalid_input` 400).
  - `SelectField` — Isolation (`t('tenants.form.isolation')`), options `field`/`schema`/`db`, default `'field'`.
  - Footer: `cta` Button "Create" (`tenants.submit`), `loading={create.isPending}`.
- **States:**
  - **Loading:** `CardCollection loading={isLoading}` renders a centered `RoseLoader` (size 64) in `var(--s-8)` padding.
  - **Empty:** centered muted text `t('tenants.empty')` = "No tenants yet".
  - **Error (query):** none rendered — a failed list query silently shows nothing/empty (no error boundary or retry UI on this page).
  - **Error (mutation):** `mutationError(t)` → localized `toast('errors.<code>', serverMessage, 'error')`; network failures → `toast('errors.network')`.
  - **Success (create):** invalidate `qk.tenants()`, `toast(t('tenants.created'))` = "Tenant created", close modal, reset `name` (note: `isolation` is **not** reset — keeps last selection on the next open).

**What it SHOULD contain (gaps vs the multi-tenant mandate in the notes):**

- **Pagination / load-more is missing.** `listTenants()` discards `next_cursor`/`has_more`; only the first 50 tenants ever render. For a multi-tenant platform this silently truncates. Should adopt `useKeyset(qk.tenants(), …)` with a "Load more" affordance, or document the 50-row cap.
- **No detail view.** Cards are non-clickable and there is no `/console/tenants/:id` route. A tenant detail (drawer or sub-route) should surface the related entities the page is supposed to relate to: the tenant's **account balance** (GET `/admin/accounts/:id` → `AccountView`, via `Money`), its **API keys** (GET `/admin/api-keys?tenantId=`), and its **model grants**. Today an operator must hop to `/console/accounts`, `/console/api-keys`, and the Catalog separately and re-select the tenant each time.
- **No edit / isolation change.** Backend supports `PATCH /admin/tenants/:id { isolationMode }` but there is no UI; isolation is fixed at create time in the console. A `RowAction`/edit affordance + `PATCH` would close this.
- **No copy-id, no search/filter.** With many tenants the operator can't search by name or copy a tenant UUID (needed to paste into account/key creation). A `DataTable searchable` or a `CopyField` per card would help.
- **No DELETE** — and that is correct: the backend intentionally has no tenant DELETE (balance is ledger-owned). The UI should keep omitting it.

---

### 3. BACKEND ENDPOINTS

**Read (used):**

- `GET /admin/tenants?cursor=&limit=` → `PageEnvelope<TenantView>`. `TenantView = { id, name, isolation_mode, created_at }`. The page calls `api.listTenants()` = `client.getPage<TenantView>('/admin/tenants')` then `.rows`; cursor/limit are never passed, so it's the default first page (limit 50, server-clamped [1,200]).

**Write (used):**

- `POST /admin/tenants` body `{ name (required), isolationMode?: 'field'|'schema'|'db' }` → `201 TenantView`. Backend marks it `@Idempotent`, but the page calls `createTenant(body)` with no idempotency key, so retries are NOT deduped here (a double-submit could create two tenants — though the submit button disables via `loading` while pending).

**Available but UNUSED (no admin.ts method, no UI):**

- `GET /admin/tenants/:id` → `TenantView` (404 if absent) — would back a detail view.
- `PATCH /admin/tenants/:id` body `{ isolationMode? }` → `TenantView` — only `isolation_mode` mutable; would back an edit.
- No tenant DELETE exists by design.

**Related (on sibling pages, relevant to a future tenant detail):** `POST/GET /admin/accounts*`, `GET /admin/api-keys?tenantId=`, `GET /admin/models/:name/grants`.

All money returned anywhere downstream is bigint µcredit **decimal strings** — but note this page itself touches no money.

---

### 4. DATA & CACHING

- **Entity:** `TenantView[]`.
- **Query key:** `qk.tenants()` = `['admin','tenants']` (verbatim from `queryKeys.ts`).
- **staleTime tier:** `STALE_REFERENCE` (60s) — correct, tenants are reference/catalog data that change rarely. (Global defaults otherwise: 15s stale, retry 1, no focus-refetch, 5-min gcTime.)
- **Invalidation:** `createTenant.onSuccess` does `await qc.invalidateQueries({ queryKey: qk.tenants() })` — the canonical pattern (mutation invalidates the same `qk` it reads). No optimistic update; the new tenant appears only after the refetch resolves.
- **Should NOT be cached:** nothing sensitive on this page — `TenantView` has no secrets/balances. (Plaintext-once concerns live on the api-keys page, not here.)
- **Caching gap:** because only the first page is fetched and `next_cursor` is dropped, the cache can never represent the full tenant set. If a detail view is added, use a dedicated `qk.tenant(id)` (does not yet exist) so per-tenant refetches don't blow the whole list cache.

---

### 5. COMPONENTS & COMPOSITION

The page is a **card-collection + create-modal** composition (NOT a `DataTable`, NOT a Drawer):

- **`CardCollection`** (grid, `repeat(auto-fill, minmax(280px,1fr))`, gap `--s-4`) — wraps loading (`RoseLoader`) + empty states and stagger-reveals cards via GSAP `fromTo opacity/y` (reduced-motion skips).
- **`EntityCard`** — the per-tenant tile: `icon=BuildingsIcon`, `title`, `chips`, `meta`. It supports `badge`, `actions`, `onClick`, `selected` — **all unused here**, so the card is a static read tile.
- **`Modal`** (portaled, focus-trapped, GSAP enter/deferred-unmount) holds the create form with a `cta` footer Button.
- **Form fields:** `TextField` (on `FormField`) + `SelectField` (system-styled never-native `Select` on `FormField`).
- **`Button`** — `ghost` for the TopBar action, `cta` for submit (with `loading` spinner / `aria-busy`).
- **`toast`** — success + (via `mutationError`) error notifications.
- **Chrome integration:** `useSetConsoleAction` publishes the "New tenant" button into the shared `TopBar` action slot (memoized on `[t]`, cleared on unmount). The page does **not** use `useSetConsoleFilters` (no filter slot) or `useSetConsoleBack`.

**Recommended composition for the missing detail:** make `EntityCard` clickable → open a **`Drawer`** (the heavier Modal sibling intended for long forms / detail) showing account balance (`Money`), api-keys, grants, and an isolation `SelectField` wired to `PATCH /admin/tenants/:id`. A `Drawer` (not Modal) is the system convention for detail panes.

---

### 6. LAYOUT & TYPOGRAPHY

- **Page root:** `<div style={{ height: '100%' }}>` containing the `CardCollection`; the page owns no header (title/subtitle come from the console `TopBar` via `activeItem(pathname)`).
- **Console chrome:** standard shell — desktop shows `Rail` (64px) + `SubNav` (200px, lists the `tenants` group's leaves: Tenants / Accounts / API Keys) + `main` (`TopBar` + scrollable `Outlet`). The "New tenant" button sits in the TopBar's right action slot beside the refresh icon. Mobile drops Rail/SubNav for `BottomTabs`; Tenants is one of the 4 mobile tabs.
- **Grid density:** auto-fill cards at min 280px, so 1 column on phones up to ~4 on wide desktop. Cards are low-density (one chip + one meta field) — lots of whitespace per tenant.
- **Typography:** card title `--fs-base` / `--fw-semibold` / `--track-snug`, ellipsified; chip uses `.chip`; meta label `--fs-caption` uppercase `--faint`, value `--fs-sm` `--text` `.tabular`. Empty text `--fs-sm` `--muted`. All warm-amber accent system (focus ring `2px solid var(--accent)`, never blue).
- **Responsive:** purely CSS grid auto-fill — no `useMediaQuery` branch inside the page itself; responsiveness is inherited from `CardCollection` + the console shell. Reduced-motion disables the card stagger.
- **Heading hierarchy:** page has no in-page `<h1>`/`<h2>`; the TopBar title (`--fs-lg`) is the only heading. The Modal title is the form heading.

---

### 7. MOCK-vs-REAL & GAPS

- **Data is fully REAL.** This page hits the live `/admin/tenants` API via `useAdminApi()` → `admin.ts` → `client.ts`. It is **not** part of the `mockBilling.ts` design-only surface (which only covers route-groups / official-prices / group-channels). `mockStatus: real`.
- **No switch needed for the core list/create** — it's already on the right endpoints. The work is additive, not a mock-to-real migration.
- **Prioritized recommendations:**
  1. **Add keyset pagination / Load-more** (HIGH): `listTenants()` truncates to the first 50 tenants because it discards `next_cursor`/`has_more`. For a multi-tenant platform this is a correctness bug, not just polish. Switch to `useKeyset(qk.tenants(), (cursor) => listTenantsPage({cursor}))` (a paged variant of `listTenants` must be added to `admin.ts`).
  2. **Add a tenant detail view** (HIGH): wire `GET /admin/tenants/:id`, `GET /admin/accounts/:id` (`Money` balance), `GET /admin/api-keys?tenantId=`, and model grants into a clickable `EntityCard` → `Drawer`, fulfilling the "relates to accounts, api-keys, model grants per tenant" mandate. Today these relationships exist only as separate top-level pages.
  3. **Add isolation edit** (MED): expose `PATCH /admin/tenants/:id { isolationMode }` via an edit `RowAction`/SelectField. Backend already supports it; UI omits it.
  4. **Pass an Idempotency-Key on create** (MED): the create POST is `@Idempotent` server-side but the page sends no key, so a flaky-network retry can mint a duplicate tenant. Generate a per-open UUID and pass `createTenant(body, key)`.
  5. **Add search + copy-id** (LOW): a name filter and per-card `CopyField` for the UUID would speed the common operator flow of pasting a tenant id into account/key creation.
  6. **Reset `isolation` on modal close** (LOW polish): currently only `name` resets in `onSuccess`, so the isolation select retains the prior choice on next open.

> **🔎 Verification notes:** **Verdict: accurate.** All 7 endpoints exist on `AdminController` (`@Controller('admin')`, guarded by `@UseGuards(AdminGuard)` + `@ApiTags('admin')`) in `/Users/alienworm/actionow-core/apps/api/src/admin/admin.controller.ts`, and `mockStatus = real` is correct.
>
> **Endpoint confirmations (all real):**
>
> - `GET /admin/tenants` — L416, returns `PageEnvelope<TenantView>`. Page-discards-cursor claim is accurate: admin.ts L49 `listTenants` does `(await client.getPage('/admin/tenants')).rows` — keeps only `rows`, drops `nextCursor`. So only first page shown. ✔
> - `POST /admin/tenants` — L406, `@HttpCode(201)` + `@Idempotent()`. ✔ Spec's idempotency claim is _slightly off_: admin.ts L50 `createTenant(body, idempotencyKey?)` DOES accept an optional second arg, but `TenantsPage.tsx` calls it as `createTenant({ name, isolationMode })` with one arg, so no Idempotency-Key header is sent. Net effect matches spec ("page passes NO Idempotency-Key"), but the rationale "createTenant(body) called with one arg [because the method only takes one]" is wrong — the method supports a key; the page just omits it.
> - `GET /admin/tenants/:id` — L426 `getTenant` exists. AVAILABLE/UNUSED correct: 0 `getTenant` matches in admin.ts. ✔
> - `PATCH /admin/tenants/:id` — L432 `updateTenant` exists (`updateTenantSchema`, isolation only). AVAILABLE/UNUSED correct: 0 `updateTenant` matches in admin.ts. No tenant DELETE exists (controller has tenants Post/Get/Get/Patch only). ✔
> - `POST /admin/accounts` — L443. Body `{ tenantId, credits? }` confirmed (`createAccountSchema`: `tenantId` uuid + optional `credits`). ✔
> - `GET /admin/api-keys` — L487, `tenantId` query required, `PageEnvelope<ApiKeyView>`. ✔
> - `GET /admin/models/:name/grants` — L872, `PageEnvelope<ModelGrantView>`. `ModelGrantView.tenant_id` field confirmed (types.ts L135). ✔
>
> **Components:** all 11 exist under `/Users/alienworm/actionow-web/apps/web/src/components/` (CardCollection.tsx, EntityCard.tsx, Modal.tsx, Button.tsx, TextField.tsx, SelectField.tsx, toast.ts, RoseLoader.tsx, ConsoleChrome.tsx for `useSetConsoleAction`). RoseLoader IS rendered inside CardCollection's loading branch (CardCollection.tsx L50). Page imports `BuildingsIcon, PlusIcon` from `@phosphor-icons/react`. ✔
>
> **Mock status = real (correct):** `TenantsPage.tsx` uses `useAdminApi()` → `makeAdminApi(client)` (real HTTP client). It does NOT import `mockBilling.ts`. Only `RouteGroupsPage.tsx` and `OfficialPricesPage.tsx` consume the mock (per mockBilling.ts header: billing/routing backend is design-only, so those sibling pages mock). Tenants is a genuinely-live page.
>
> **Minor refinements:**
>
> - The `field` chip uses `r.isolation_mode` (snake_case) from `TenantView`; default isolation in the create form is `'field'`. Consistent with backend.
> - Spec says PATCH "only isolation_mode is mutable" — confirmed by `updateTenantSchema`/`updateTenant` summary.

## 11. Accounts (Credits/Ledger) — `/console/accounts`

**Audience:** Operator / Admin (user with role === 'admin') · **Data status:** `partial-mock` · **Verify severity:** `minor`

**Backend endpoints**

| Method | Path                        | Purpose                                                                                                                                          |
| ------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST` | `/admin/accounts`           | Create a billing account for a tenant with optional opening credits (HUMAN credits). Wired now via api.createAccount.                            |
| `POST` | `/admin/accounts/:id/topup` | Top up an account by N HUMAN credits; returns { account_id, balance } (balance = µcredit string). Wired now via api.topup.                       |
| `GET`  | `/admin/tenants`            | Populate the tenant picker in the create-account modal (TenantSelect → api.listTenants, qk.tenants()).                                           |
| `GET`  | `/admin/accounts/:id`       | NOT wired yet. SHOULD be added (api has no getAccount) to re-fetch an account by id so the page can resolve a balance without first creating it. |
| `GET`  | `/admin/ledger`             | NOT wired in UI. Available in admin.ts as listLedger (keyset). SHOULD power the transaction-ledger table promised by the page notes.             |
| `GET`  | `/admin/payments`           | NOT wired in UI. Available in admin.ts as listPayments (keyset). SHOULD power a payment-intents panel.                                           |
| `POST` | `/admin/redemption-codes`   | NOT wired in UI. api.generateCodes exists. SHOULD power a redemption-code generator the page notes reference.                                    |

**Cached entities:** qk.tenants() → TenantView[] @ STALE_REFERENCE (60s) — already cached via TenantSelect (read-only catalog for the picker); SHOULD cache qk.ledger(tenantId) → Page<LedgerView> @ STALE_VOLATILE (10s) via useKeyset; invalidate after topup; SHOULD cache qk.payments(tenantId) → Page<PaymentIntentView> @ STALE_VOLATILE (10s) via useKeyset; DO NOT cache the one-shot { account_id, balance } topup response or AccountView from create — these are held in local component state (account), not in TanStack; DO NOT cache plaintext redemption codes if generator is added (secret-returning POST, shown once)

**Components:** `Modal`, `Button`, `NumberField`, `TenantSelect`, `Money`, `useSetConsoleAction`, `PlusIcon`, `toast`, `mutationError`, `DataTable (recommended, not present)`, `StatusBadge (recommended)`, `TenantSelect as TopBar filter via useSetConsoleFilters (recommended)`, `useKeyset (recommended for ledger/payments)`

## Accounts (Credits / Ledger) — `/console/accounts`

Primary file: `/Users/alienworm/actionow-web/apps/web/src/features/console/AccountsPage.tsx` (116 lines, single component `AccountsPage`). Route wired at `/Users/alienworm/actionow-web/apps/web/src/routes.tsx:57` (`<Route path="accounts" element={<AccountsPage />} />`, inside the `role="admin"`-gated `/console` subtree).

---

### 1. PURPOSE & AUDIENCE

- **Who:** Operator / Admin only — audience (a). The page lives under the frontend `/console/*` subtree which is gated by `ProtectedRoute role="admin"` (a logged-in non-admin is bounced to `/app`, an unauthenticated visitor to `/login`).
- **Backend guard:** every call hits `/admin/*` → `AdminGuard` + `@Roles('admin')`, admin JWT bearer (`ADMIN_JWT_SECRET`).
- **Why:** operator-side credit administration — create a tenant billing account with an opening balance, and top up an existing account. The page notes promise more (ledger, redemption-codes, payments) but the current implementation only covers create + topup.
- **Naming caveat:** frontend `/console/accounts` is the _operator_ console; it is unrelated to the backend `/console/*` tenant-self-service API.

### 2. CONTENT / INFORMATION ARCHITECTURE

**NOW (what ships):** The page is intentionally minimal. There is no list and no on-mount fetch. State is entirely local (`account: AccountView | null`, plus modal open flags and credit inputs).

- **Balance hero card** (`.glass`, `--r-md`, `padding var(--s-5)`, flex space-between): only renders when local `account` is non-null (i.e. immediately after a create, or after a topup updates it). Left column = uppercase nano label `accounts.cols.balance` ("Balance"), the balance in `--fs-xl`/700 via `<Money micro={account.credit_balance} />`, and the account id in `--fs-caption`/`--faint`. Right = a ghost `Button` "Top up" (`accounts.topup.action`) opening the topup modal.
- **Empty state** (`.panel`, centered, `--muted`, `--fs-sm`): shown whenever `account` is null (the default on every page load) — text `accounts.empty` = "Create an account to start, or top up an existing one." Because nothing is ever fetched on mount, **this empty state is what the operator sees on every fresh visit**, even for tenants that already have accounts.
- **TopBar action slot** (`useSetConsoleAction`): a ghost `Button` with `PlusIcon` → "New account" (`accounts.new`) opens the create modal.
- **Create modal** (`Modal`, title `accounts.new`): `TenantSelect` (label `accounts.form.tenant`, placeholder "—") + `NumberField` (label `accounts.form.credits` = "Opening credits", `min={0}`). Footer = cta `Button` "Create" (`accounts.submit`) with `loading={create.isPending}`. On success: stores returned `AccountView` into local `account`, toasts `accounts.created`, closes, resets credits to 0.
- **Topup modal** (`Modal`, title `accounts.topup.title`): single `NumberField` (`accounts.topup.credits` = "Credits to add", `min={0}`). Footer = cta `Button` "Top up" (`accounts.topup.submit`). On success: patches local `account.credit_balance` with the returned `balance` (µcredit string), toasts `accounts.topup.done`.

**Loading/error states:** No skeleton/loading UI on the page itself (no list query). Mutation pending → only the modal footer button shows its spinner. Errors are surfaced exclusively through `mutationError(t)` → localized toast (`errors.<code>` / `errors.network`); there is no inline error region.

**SHOULD contain (per page notes "admin/accounts(+topup), admin/ledger, admin/redemption-codes, admin/payments; Credit balances, top-ups, transaction ledger"):**

1. **Account lookup / resolution** — a `TenantSelect` in the TopBar filter slot (`useSetConsoleFilters`) that, on selection, fetches the tenant's account so the balance card renders without first creating an account. This requires a new `getAccount(id)` (or a list) method — see Gaps.
2. **Transaction ledger table** — a `DataTable<LedgerView>` (columns: `created_at`, `type`, `credits_delta` via `Money`, `balance_after` via `Money`, `resource_id`, `job_id`), keyset-paginated via `useKeyset` over `qk.ledger(tenantId)`.
3. **Payments panel** — `DataTable<PaymentIntentView>` (provider, purpose, `amount_minor`+currency, `credit_amount`, `status` via `StatusBadge`, `created_at`) over `qk.payments(tenantId)`.
4. **Redemption-code generator** — a modal calling `api.generateCodes` (count, creditsPerCode, expiresAt) with a one-time reveal panel (codes shown once, never cached).
5. **Held credits** — display `account.credit_held` (the i18n key `accounts.cols.held` = "Held" already exists but is unused) alongside balance.

### 3. BACKEND ENDPOINTS

Wired now (all through `useAdminApi()` → `makeAdminApi` in `/Users/alienworm/actionow-web/apps/web/src/lib/api/admin.ts`):

- `POST /admin/accounts` — body `CreateAccountBody { tenantId: string; credits?: number }` (HUMAN opening credits, omitted when `credits <= 0`). Returns `201 AccountView { id, tenant_id, credit_balance (µcredit str), credit_held (µcredit str), created_at }`. `@Idempotent` server-side, but the page does **not** pass an idempotency key (`createAccount` has no key param in admin.ts).
- `POST /admin/accounts/:id/topup` — body `TopupBody { credits: number }` (HUMAN credits). Returns `200 { account_id, balance }` (`balance` = µcredit string). `@Idempotent` server-side; no key passed.
- `GET /admin/tenants` — via `TenantSelect`/`api.listTenants` (`getPage → rows`) to fill the create-modal picker.

Available in admin.ts but NOT consumed by this page (recommended additions): `GET /admin/ledger` (`listLedger`, keyset → `Page<LedgerView>`), `GET /admin/payments` (`listPayments`, keyset → `Page<PaymentIntentView>`), `POST /admin/redemption-codes` (`generateCodes`).

Missing from admin.ts entirely: `GET /admin/accounts/:id` (the inventory documents this endpoint, but there is no `getAccount` method — so the page literally cannot read an existing account's balance; it can only show one it just created/topped-up).

### 4. DATA & CACHING

- **No page-level query.** The `account` is held in React `useState`, not TanStack Query — so it is intentionally NOT cached and resets on navigation/reload. Both mutations are `useMutation` with no `queryClient.invalidateQueries` (there are no relevant cached lists to invalidate here yet).
- **Only cached entity today:** `qk.tenants()` → `TenantView[]` at `STALE_REFERENCE` (60s), owned by `TenantSelect` — correct tier for slow-changing catalog data.
- **Optimistic update:** the topup success handler optimistically merges the new balance into local state (`setAccount(a => ({...a, credit_balance: r.balance}))`) rather than refetching — fine given there's no cached account entity.
- **SHOULD add** (when ledger/payments land): `qk.ledger(tenantId)` and `qk.payments(tenantId)` via `useKeyset`, both at `STALE_VOLATILE` (10s) since they are operational/live data; invalidate `qk.ledger(tenantId)` in the topup `onSuccess` (a topup writes a ledger row). Money fields stay decimal strings end-to-end (never `Number()`).
- **NEVER cache:** the one-shot `{account_id, balance}` topup payload, the create `AccountView` (local state by design), and any future redemption-code plaintext (secret-returning, shown once).

### 5. COMPONENTS & COMPOSITION

Current composition is **two modals over a single hero/empty card** — no master/detail, no table.

- `Modal` (not `Drawer`) for both create and topup — appropriate since each form has ≤2 fields. Footer cta `Button` carries `loading`.
- Form fields: `TenantSelect` (which internally renders `SelectField`/`Select` over `qk.tenants()`) + `NumberField` (clamps empty/invalid → 0, never NaN). No `FormField`-level validation beyond `min={0}`.
- `Money` renders the µcredit string via `lib/money.ts → formatCredits` (BigInt math, `.tabular`, locale-grouped, 2-frac truncation) — no float.
- `Button` ghost variant for both the TopBar action and the in-card "Top up" trigger; `PlusIcon` (Phosphor) in the action.
- `toast` for success, `mutationError(t)` for errors.
- **Recommended additions:** `DataTable<LedgerView>` and `DataTable<PaymentIntentView>` (desktop table / mobile stacked cards, keyset "load more"), `StatusBadge` for payment status, a `TenantSelect` published via `useSetConsoleFilters` for account resolution, and `useKeyset` for pagination.

### 6. LAYOUT & TYPOGRAPHY

- Root is a single flex column (`gap var(--s-3)`); no in-page tabs, no SubNav leaf beyond the `accounts` nav item (billing/tenants group `tenants` per `nav-config.ts`).
- Console chrome supplies the title/subtitle (`nav.accounts` = "Accounts", `subtitles.accounts` = "Account balance & top-up") and the refresh button; the page only publishes its action slot.
- Heading hierarchy is shallow: hero card balance is `--fs-xl`/700; the balance label is `--fs-nano` uppercase `--muted`; account id `--fs-caption` `--faint`. Density is very low (one card + two modals).
- **Responsive:** nothing page-specific — it inherits the `ConsoleLayout` `useMediaQuery(BP.md)` split (Rail+SubNav+TopBar on desktop, BottomTabs on mobile). The single card reflows trivially. When tables are added they get the `DataTable` desktop-table / mobile-stacked-card behavior for free.

### 7. MOCK-vs-REAL & GAPS

- **Real, not mock.** Both wired calls (`createAccount`, `topup`) hit the live `/admin/*` backend via `client.ts`; `TenantSelect` hits real `/admin/tenants`. This page does **not** touch `mockBilling.ts`. `mockStatus = partial-mock` reflects that the _implemented_ surface is real, but the page is a **partial skeleton** that omits the ledger/payments/redemption features its own notes promise — those backends exist and are real, just unconsumed here.
- **Gap 1 (highest priority): no way to view an existing account.** There is no on-mount fetch and no `getAccount` method in admin.ts, so the balance card only appears for an account just created or topped-up in the current session; every fresh visit shows the empty state. Fix: add `getAccount(id)` → `GET /admin/accounts/:id` and a tenant→account resolution flow (e.g. TopBar `TenantSelect` filter). Note the inventory says there is no list-accounts endpoint, so resolution likely needs the tenant's account id surfaced elsewhere or a new lookup.
- **Gap 2: ledger is absent from the UI.** `api.listLedger` (`GET /admin/ledger`, keyset `LedgerView`) and `qk.ledger(tenantId)` both exist but no component renders them. The page's "transaction ledger" promise is unmet. Add a `DataTable<LedgerView>` + `useKeyset`.
- **Gap 3: payments absent.** `api.listPayments` (`GET /admin/payments`) and `qk.payments(tenantId)` exist, unused. Add a payments panel.
- **Gap 4: redemption codes absent.** `api.generateCodes` (`POST /admin/redemption-codes`) exists; no generator UI here (the notes list `admin/redemption-codes`).
- **Gap 5: held credits unused.** `accounts.cols.held` i18n key and `credit_held` field exist but aren't displayed.
- **Minor:** mutations don't send an `Idempotency-Key` even though both POSTs are `@Idempotent` server-side; `createApiKey`-style retries are unprotected. Low risk for create/topup but worth adding for safe retries.
- **Prioritized recommendation order:** (1) account resolution + `getAccount` so the page is usable for existing accounts; (2) ledger table (the headline feature); (3) payments panel; (4) redemption-code generator; (5) display held credits; (6) idempotency keys on the two POSTs.

> **🔎 Verification notes:** ## Verdict: mockStatus is WRONG — should be `real`, not `partial-mock`
>
> `AccountsPage.tsx` imports **zero** mock modules (`grep -c mock` = 0). It uses `useAdminApi()` → `makeAdminApi(client)` from `/Users/alienworm/actionow-web/apps/web/src/lib/api/admin.ts`, which hits real HTTP endpoints (`client.post('/admin/accounts')`, `client.post('/admin/accounts/${id}/topup')`). `mockBilling.ts` exists but only powers the **official-prices / route-groups** console pages (its own header comment says so) — it has no account/ledger/topup exports and is never imported by AccountsPage. The "partial-mock" label is inaccurate; the wired path is fully real. (One could argue "partial" loosely because the page only wires 2 of the page's promised features and leaves ledger/payments/redemption unbuilt — but that is _unbuilt UI_, not _mock data_. Nothing on this page reads mock data.)
>
> ## Endpoints — all 7 REAL (zero phantoms)
>
> Confirmed in `/Users/alienworm/actionow-core/apps/api/src`:
>
> - `POST /admin/accounts` — `admin.controller.ts:443` `@Post('accounts')` under `@Controller('admin')`. Real, wired via `api.createAccount`.
> - `POST /admin/accounts/:id/topup` — `admin.controller.ts:453` `@Post('accounts/:id/topup')`. Returns `{ account_id, balance }` (balance = µcredit string). Spec's return shape is **exactly correct**.
> - `GET /admin/tenants` — `admin.controller.ts:416`. Real, wired via `api.listTenants`.
> - `GET /admin/accounts/:id` — `admin.controller.ts:465` `@Get('accounts/:id')` → `getAccount`. **Spec correctly says it's NOT wired in the client**: confirmed `admin.ts` has no `getAccount` method. Spec's recommendation to add it is valid and the backend already supports it.
> - `GET /admin/ledger` — `admin.controller.ts:910`. Available as `listLedger` (keyset) in `admin.ts:131`, not consumed by the page. Correct.
> - `GET /admin/payments` — lives in a separate controller: `admin-payments.controller.ts` `@Controller('admin/payments')` + `@Get()` (resolves to `/admin/payments`). Available as `listPayments` in `admin.ts:134`, not consumed by the page. Correct.
> - `POST /admin/redemption-codes` — `admin.controller.ts:923`. `api.generateCodes` exists (`admin.ts:123`), returns `{ codes, credit_amount }`, not consumed by the page. Correct.
>
> ## Field-name accuracy
>
> - Spec topup return `{ account_id, balance }` matches backend exactly (`admin.controller.ts:461-462`).
> - Page binds balance to **`credit_balance`** on `AccountView` (`types.ts:10`), and on topup success spreads `{ ...a, credit_balance: r.balance }`. The spec's "balance = µcredit string" is right, but note the _view field_ is `credit_balance`, not `balance` — only the topup _response_ uses `balance`.
>
> ## Components — all present (zero phantoms)
>
> All "wired now" components resolve to real files: `Modal`, `Button`, `NumberField`, `toast` (ui/), `TenantSelect`, `Money` (data/), `useSetConsoleAction` (console/ConsoleChrome.tsx:25), `mutationError` (lib/api/), `PlusIcon` (@phosphor-icons/react). The "(recommended, not present)" tags are honest: `DataTable` and `StatusBadge` DO exist as files (`data/DataTable.tsx`, `data/StatusBadge.tsx`) — so "not present on this page" is the right reading, they're just not used by AccountsPage. `useSetConsoleFilters` exists (ConsoleChrome.tsx:41) and `useKeyset` exists (`lib/query.ts:16`) — both valid recommendations.
>
> ## Refinements
>
> - Correct `mockStatus` to `real` (or at minimum note no mock data is consumed).
> - Backend explicitly documents NO PATCH/DELETE for accounts (balance is ledger-owned) — worth noting the page can never directly edit balance, only topup.

## 12. API Keys (Admin) — `/console/api-keys`

**Audience:** Operator / Admin (role === 'admin') · **Data status:** `partial-mock` · **Verify severity:** `minor`

**Backend endpoints**

| Method   | Path                        | Purpose                                                                                                                                                    |
| -------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `GET`    | `/admin/api-keys?tenantId=` | List API keys for the selected tenant (required tenantId query). Returns PageEnvelope<ApiKeyView>; unwrapped to rows via getPage. WIRED.                   |
| `POST`   | `/admin/api-keys`           | Mint a new key for the selected tenant. Body {tenantId, resourceAllowlist?, rateLimit?}. Returns {id, plaintext} ONCE; NOT idempotent. WIRED.              |
| `PATCH`  | `/admin/api-keys/:id/group` | Bind/unbind a key to a route group. Body {routeGroupId: uuid                                                                                               | null}. Returns {id, route_group_id}. EXISTS IN BACKEND, NOT WIRED in this page. |
| `DELETE` | `/admin/api-keys/:id`       | Revoke (soft-delete) a key; 204; key rejected 401 after. EXISTS IN BACKEND, NOT WIRED in this page.                                                        |
| `GET`    | `/admin/route-groups`       | List route groups to populate the group-bind picker (id + name). Needed once group-bind is wired; currently route groups are mock-only on /console/groups. |
| `GET`    | `/admin/tenants`            | Populate the TopBar TenantSelect filter (via TenantSelect → qk.tenants()). WIRED.                                                                          |

**Cached entities:** qk.apiKeys(tenantId) = ['admin','api-keys',tenantId] — list of ApiKeyView; default 15s staleTime; keepPreviousData; enabled only when tenantId!=''; qk.tenants() = ['admin','tenants'] — TenantSelect options; STALE_REFERENCE (60s); DO NOT CACHE: ApiKeyCreatedView.plaintext — held only in local useState, never written to the query cache; surfaced once then dropped; Recommended additions when group-bind ships: qk.routeGroups() for the picker (no qk entry exists today — route groups are mockBilling-only)

**Components:** `CardCollection`, `EntityCard`, `StatusBadge`, `TenantSelect`, `CopyField`, `Modal`, `Button`, `TextField`, `NumberField`, `useSetConsoleAction`, `useSetConsoleFilters`, `KeyIcon`, `PlusIcon`

## 1. PURPOSE & AUDIENCE

**Operator/admin-only** key administration surface at frontend route `/console/api-keys`. Gated by `ProtectedRoute role="admin"` (a logged-in non-admin is bounced to `/app`; unauthenticated → `/login`). Client-side gating is advisory; the real boundary is the backend `AdminGuard + @Roles('admin')` on every `/admin/*` endpoint (admin JWT bearer signed with `ADMIN_JWT_SECRET`).

This is the **operator-managed** key surface: the operator mints keys **for any tenant** (tenant chosen in the TopBar filter, sent in the body). It is the ONLY api-key UI that ships. The parallel **tenant self-service** surface (`/console/api-keys` _backend_ API behind `ConsoleGuard`: `POST/GET/rotate/DELETE`, scoped to the caller's own tenant) has **no frontend at all** — `/app` is a placeholder. Contrast: the tenant surface can rotate keys and returns `200 {id, status:'disabled'}` on delete, but cannot bind route groups; only this admin surface has the group-bind endpoint.

Primary file: `/Users/alienworm/actionow-web/apps/web/src/features/console/ApiKeysPage.tsx`.

## 2. CONTENT / INFORMATION ARCHITECTURE

### What exists NOW

The page is a **tenant-filtered card grid** with a mint flow. No master/detail, no per-row actions.

- **TopBar filter slot** (`useSetConsoleFilters`): a 200px-wide `TenantSelect` (bare Select variant). Selection is persisted to the URL `?tenant=` via `useUrlState('tenant')`. Until a tenant is picked, the list query is disabled.
- **TopBar action slot** (`useSetConsoleAction`): ghost `Button` "Mint key" (`apiKeys.new`) with `PlusIcon`, opens the create Modal.
- **Body**: `CardCollection` (default grid, `repeat(auto-fill, minmax(280px,1fr))`) of `EntityCard`s. Per card:
  - `icon={KeyIcon}` leading glyph
  - `title` = `<code>` of the key **id** (NOT the secret — lists never include plaintext/hashes)
  - `badge` = `StatusBadge` with `statusTone(r.status)` (`active`→ok green, `disabled`→fail red) and label `t('status.'+status, status)`
  - `chips` = `${rate_limit}/min` (only if non-null) followed by each `resource_allowlist` entry
  - `meta` = single "Created" cell, `new Date(created_at).toLocaleDateString()`
- **Empty state**: when no tenant selected OR zero keys → centered muted text `apiKeys.empty` ("Pick a tenant to view keys"). Note the same string covers both "no tenant" and "tenant has no keys" — see Gaps.
- **Loading state**: `RoseLoader` (size 64) inside CardCollection, gated to `tenantId !== '' && isLoading`.
- **Error state**: NONE rendered in the body — list `useQuery` has no error UI; only the create mutation surfaces errors via `mutationError(t)` toast.
- **Create Modal** (`apiKeys.new`): `TextField` allowlist (comma-separated free text, split/trim/filter on submit) + `NumberField` rate limit (`min={1}`, default 0; only sent when `>0`). Footer CTA "Mint" with `loading`. **No tenant field inside the modal** — it reuses the TopBar-selected `tenantId`.
- **Reveal Modal** (`apiKeys.reveal.title`): opens when `plaintext !== null`. Shows a `--run`-colored one-time warning (`apiKeys.reveal.warn`) and a `CopyField` with the plaintext. Footer "Done" clears `plaintext`. This is the only place the secret is ever shown; it lives in local `useState`, never the cache.

### What it SHOULD contain (gaps vs backend)

- **Route-group column/chip + bind action** — `ApiKeyView` from the backend carries `route_group_id: string|null`, and `PATCH /admin/api-keys/:id/group` exists. The card should show the bound group (resolve `route_group_id` → group name via `GET /admin/route-groups`) and offer a bind/unbind action (Select of groups + "default" = null). This is the page's headline missing feature and the explicit tie-in to the Route Groups page (`/console/groups`).
- **Revoke action** — `DELETE /admin/api-keys/:id` (204, key→401) exists but is unwired. Each card needs a `RowAction`/`Button` (danger) gated behind `ConfirmDialog`.
- **routeGroupId on create** — `POST /admin/api-keys` accepts `routeGroupId?`, but the frontend `CreateApiKeyBody` omits it; add a group `SelectField` to the create Modal.
- **Status filter / empty-state disambiguation**, and ideally surfacing `rate_limit` and `resource_allowlist` as proper fields rather than only chips.

## 3. BACKEND ENDPOINTS

**Reads**

- `GET /admin/api-keys?tenantId=<uuid>` → `PageEnvelope<ApiKeyView>` (unwrapped to `rows`). `ApiKeyView` (admin) = `{ id, tenant_id, resource_allowlist: string[], rate_limit: number|null, status, route_group_id: string|null, created_at }`. **WIRED** (`api.listApiKeys` → `client.getPage`). Note the frontend `ApiKeyView` type currently **omits `route_group_id`** — drift to fix.
- `GET /admin/tenants` → tenant options for the filter (via `TenantSelect`). **WIRED.**

**Writes**

- `POST /admin/api-keys` body `{ tenantId, resourceAllowlist?: string[], rateLimit?: int>0 }` → `201 { id, plaintext }`. Plaintext returned **once**; endpoint is **NOT idempotent** (no `Idempotency-Key`). **WIRED** (`api.createApiKey`).
- `PATCH /admin/api-keys/:id/group` body `{ routeGroupId: uuid|null }` → `{ id, route_group_id }`. uuid binds; `null` unbinds → `default` group. **NOT WIRED.**
- `DELETE /admin/api-keys/:id` → `204` (revoke/soft-delete; key then 401). **NOT WIRED.**
- `GET /admin/route-groups` → `PageEnvelope<RouteGroupView>` (`{id, name, group_ratio_bps, status, description, ...}`) to resolve/pick groups. Needed for the bind UI. **NOT WIRED** (route groups are mock-only today on `/console/groups`).

## 4. DATA & CACHING

- **List query**: `useQuery({ queryKey: qk.apiKeys(tenantId), queryFn: () => api.listApiKeys(tenantId), enabled: tenantId !== '', placeholderData: keepPreviousData })`. `qk.apiKeys(tenantId)` = `['admin','api-keys',tenantId]`. Uses the **global default 15s staleTime** (operational data; no explicit override). `keepPreviousData` keeps the prior tenant's cards visible while switching tenants (smooth). This is **live-usage tier**, not static-catalog — keys mutate (mint/revoke/rebind).
- **Tenants query** (inside `TenantSelect`): `qk.tenants()` at `STALE_REFERENCE` (60s) — reference/catalog tier.
- **Invalidation on mint**: `create.onSuccess` awaits `qc.invalidateQueries({ queryKey: qk.apiKeys(tenantId) })`, then closes the form, resets `allowlist`/`rateLimit`, and stashes `r.plaintext` in local state. No optimistic update (correct — the server assigns `id`/`status`).
- **MUST NOT be cached**: `ApiKeyCreatedView.plaintext`. It is held only in component `useState` and shown once via the reveal Modal; it is never written to TanStack cache and the list never re-fetches it. Good handling.
- **Recommended for future**: revoke mutation → invalidate the same `qk.apiKeys(tenantId)`; group-bind mutation → invalidate `qk.apiKeys(tenantId)` (and optionally optimistic patch of `route_group_id`); add a `qk.routeGroups()` key (none exists today) for the picker, at `STALE_REFERENCE`.

## 5. COMPONENTS & COMPOSITION

Composition is **TopBar-slots + card grid + two Modals** (no Drawer, no DataTable, no master/detail).

- **Layout container**: `CardCollection` (grid layout) rendering `EntityCard` per row. Chosen over `DataTable` consistent with the "cards over rows" console convention.
- **Card**: `EntityCard` (`icon`, `title`, `badge`, `chips`, `meta`). Status via `StatusBadge` + `statusTone`.
- **Filter**: `TenantSelect` (bare `Select` variant) published into the TopBar via `useSetConsoleFilters`.
- **Action**: `Button variant="ghost"` published via `useSetConsoleAction`.
- **Create form**: `Modal` (centered dialog, `min(440px,92vw)`) containing `TextField` + `NumberField`, footer `Button variant="cta"` with `loading`. The create form is intentionally a lightweight `Modal`, NOT a `Drawer` (only two fields).
- **Reveal**: second `Modal` + `CopyField` (read-only `<code>` panel + copy `Button`).
- **Errors**: `mutationError(t)` toast helper (localized `errors.<code>` / `errors.network`).

**Recommended additions**: `RowAction` (revoke, danger) + `ConfirmDialog` on each card's `actions` slot; a group `SelectField`/`Select` for binding (in-card or in an edit `Drawer`); a `MockBadge` is NOT appropriate here since the list itself is real.

## 6. LAYOUT & TYPOGRAPHY

- Lives in the console shell (`ConsoleLayout`): desktop = Rail + SubNav (under the **tenants** nav group, `BuildingsIcon`) + TopBar + scrollable Outlet. The page root is `height:100%`. TopBar title = `nav.apiKeys` ("API Keys"), desktop subtitle = `subtitles.apiKeys` ("Issue and manage API keys").
- **Grid**: cards auto-fill at `minmax(280px,1fr)`, `gap: var(--s-4)`, `alignContent:start`. Cards stagger-reveal on row-set change (GSAP, reduced-motion-safe).
- **Typography**: card title is the key id rendered as `<code>` at `--fs-sm`; meta label uppercase `--fs-caption`/`--faint`; chips use `.chip`. Reveal warning at `--fs-sm` in `--run` (amber). All numerics `.tabular`.
- **Responsive**: on mobile (`< BP.md` 768px) the Rail/SubNav collapse to `BottomTabs` (API Keys is one of the 4 mobile tabs, `KeyIcon`); CardCollection grid naturally reflows to one column; the TenantSelect filter still renders in the (mobile) TopBar slot.
- **Density**: low — one card per key, single meta cell. Adding group/revoke actions and a status/group chip is the obvious density upgrade without needing a table.

## 7. MOCK-vs-REAL & GAPS

**mockStatus: partial-mock.** The list and mint flow are **REAL** (live `/admin/api-keys` via `admin.ts`/`client.ts`). The reason it is not "real" overall is that two real, available backend capabilities are **unwired**, and the feature the NOTES call out (group binding) routes through a page (`/console/groups`) whose route-group data is currently mock-only (`mockBilling.ts`).

**Concrete, prioritized recommendations:**

1. **Wire revoke** (highest value, lowest risk): add `deleteApiKey(id)` → `DELETE /admin/api-keys/:id` in `admin.ts`; add a danger `RowAction` + `ConfirmDialog` per card; invalidate `qk.apiKeys(tenantId)` on success. Endpoint already exists.
2. **Wire group binding** (the NOTES' core ask): add `bindApiKeyGroup(id, routeGroupId|null)` → `PATCH /admin/api-keys/:id/group`; surface bound group on the card and a bind/unbind `Select`. This is the concrete tie-in to the Route Groups page. Blocker: needs **real** route-group data — first switch `/console/groups` off `mockBilling.ts` onto the real `GET /admin/route-groups` (the CRUD exists per inventory §1.13), then add a `qk.routeGroups()` key and a real list method so the picker shows live groups.
3. **Fix the type drift**: extend frontend `ApiKeyView` with `route_group_id: string|null` and `CreateApiKeyBody` with `routeGroupId?: string`; thread `routeGroupId` into the create Modal so keys can be group-bound at mint time (`POST /admin/api-keys` already accepts it).
4. **UX polish**: distinguish "no tenant selected" from "tenant has no keys" (two separate empty messages); add a body-level error state for the list query; show `rate_limit`/`allowlist` as labelled meta in addition to chips.
5. **Do NOT** attempt to add rotate here — rotation is a tenant-self-service (`/console/api-keys/:id/rotate`) capability with no admin equivalent; the operator path is revoke + re-mint.

> **🔎 Verification notes:** ## Endpoints — all 6 REAL (none phantom)
>
> All paths confirmed in `apps/api/src/admin/admin.controller.ts` under `@Controller('admin')`, guarded by `@UseGuards(AdminGuard)` + `@Roles('admin')` (admin-JWT, correct audience):
>
> - `GET /admin/api-keys` (L487) — takes `tenantId` + `cursor`/`limit`, returns `PageEnvelope<ApiKeyView>`. Client unwraps via `getPage(...).rows`. WIRED. ✅
> - `POST /admin/api-keys` (L477) — `@HttpCode(201)` (spec says "Returns once", fine; note it's **201 not 200**). Body schema `createApiKeySchema` = `{tenantId (uuid, required), resourceAllowlist?, rateLimit?, routeGroupId?}`. **Spec omits `routeGroupId?` which the mint endpoint DOES accept** — a key can be bound to a group at creation time, not only via PATCH. NOT idempotent (POST not decorated `@Idempotent()`) — spec correct. WIRED. ✅
> - `PATCH /admin/api-keys/:id/group` (L498) — body `updateApiKeyGroupSchema` = `{routeGroupId: uuid|null}` (**required, nullable** — null = unbind). Returns `{id, route_group_id}`. Exists in backend. ✅
> - `DELETE /admin/api-keys/:id` (L508) — `@HttpCode(204)`, soft-delete/revoke. Exists in backend. ✅
> - `GET /admin/route-groups` (L1011) — returns `PageEnvelope<RouteGroupView>`. Exists in backend. ✅
> - `GET /admin/tenants` (L416) — feeds `TenantSelect → qk.tenants() → api.listTenants()`. WIRED. ✅
>
> ## Wiring claims are too generous (overstate frontend integration)
>
> The spec's "EXISTS IN BACKEND, NOT WIRED **in this page**" for group-bind / revoke / route-groups is misleading. These are **not wired in the frontend AT ALL** — `apps/web/src/lib/api/admin.ts` only exposes `listApiKeys` (L90) and `createApiKey` (L92) for keys. There is **no `bindApiKeyGroup`, no `revokeApiKey`/`setApiKeyGroup`, and no `listRouteGroups` client method anywhere**. So the group-bind picker and revoke action have no client plumbing, not merely no page UI. `/console/groups` (`RouteGroupsPage.tsx`) is **100% mock** (imports `listRouteGroups` etc. from `lib/api/mockBilling`, query key `['mock','route-groups']`) — spec correctly flags route groups as mock-only.
>
> ## mockStatus is WRONG → should be `live` (real), not `partial-mock`
>
> `ApiKeysPage.tsx` has **zero mock imports** — it uses `useAdminApi()` and hits real `/admin/api-keys` (list) and `/admin/api-keys` (mint). `mockBilling.ts` contains no api-key fixtures (only official-prices / route-groups / group-channels). Nothing on THIS page is mock-backed. The only "mock" association is the future group-bind picker that _would_ need `/admin/route-groups` — but that endpoint is real too; route groups are mock only on the separate `/console/groups` page. This page is fully real.
>
> ## Field-name verification (accurate)
>
> View fields used by `EntityCard` match `ApiKeyView`: `id`, `status`, `rate_limit` (nullable), `resource_allowlist` (array), `created_at` — snake_case, consistent with backend `toApiKeyView`. POST response `{id, plaintext}` matches `ApiKeyCreatedView`.
>
> ## Components — all 13 REAL
>
> All confirmed: `CardCollection`, `EntityCard`, `StatusBadge`, `TenantSelect`, `CopyField` (under `components/data/`), `Modal`, `Button`, `TextField`, `NumberField` (under `components/ui/`); `useSetConsoleAction`/`useSetConsoleFilters` (`components/console/ConsoleChrome.tsx`); `KeyIcon`/`PlusIcon` from `@phosphor-icons/react`. None phantom.
