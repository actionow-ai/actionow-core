# Actionow Web — Unified Frontend Roadmap

> Merges three analyses into one phased, dependency-honest plan: (1) the prior per-page frontend-design analysis, (2) the ZenMux borrowable-features backend/frontend split, (3) the component-library hardening shipped this session. Re-verified against the live tree. Generated 2026-06-18.

> Companion docs: [frontend-design-analysis.md](./frontend-design-analysis.md) (per-page deep dive) · [component-audit.md](./component-audit.md) (the now-shipped hardening).

---

# Actionow Web — Unified Frontend Roadmap

> Owner: the engineer on `apps/web` (worktree `/Users/alienworm/actionow-web/apps/web`). Backend reference: `actionow-core @ feat/billing-group-routing`. Frontend: `actionow-web @ feat/admin-frontend`.
>
> **Ground-truth verified this session** (against the actual tree, not the input docs):
>
> - All `/admin/route-groups`, `/admin/official-prices`, `/admin/relay-traces`, `/admin/analytics/usage` endpoints **exist** (`apps/api/src/admin/admin.controller.ts:958-1149`).
> - The console controller has **exactly 7** routes — `POST/GET/POST(rotate)/DELETE api-keys`, `GET usage`, `GET models`, `POST payments/intents` (`apps/api/src/console/console.controller.ts:122-223`). **No** `balance`/`analytics`/`usage-log`/`payments`/`me`/`settings` route exists → Phase 2 backend work is real and required.
> - Only `RouteGroupsPage.tsx` and `OfficialPricesPage.tsx` still import `mockBilling`/`MockBadge`. Every other admin page is real-or-incomplete, not mocked.
> - `lib/api/admin.ts` has `analyticsUsage` but **no** `relayTraces`/`routeGroups`/`officialPrices` method. **No `consoleApi.ts` exists** — the tenant data layer is 100% unbuilt.
> - `features/app/UserHome.tsx` is a 48-line stub. No charting dependency is installed in `apps/web/package.json`.
> - The component-library hardening (Floating/portal tooltips, `--z-*` tokens, stable row keys, field-contract helper, touch targets, Modal close+inert) is **already done** — not re-planned here.

---

## 1. RECONCILIATION

The three inputs are largely **complementary, not contradictory** — the prior design analysis is page-by-page and frontend-deep; the ZenMux split is feature-by-feature with precise backend-readiness; the shell grounding supplies the structural facts. Where they touch the same thing they agree. The reconciliation matters mostly for (a) collapsing duplicate framings into one item, and (b) surfacing the **one thing ZenMux silently omits**.

### Overlaps (same work, different lens → merge into one item)

| Prior design analysis                                                                                                        | ZenMux split                                            | Merged item                                        | Net add from reconciliation                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1 tenant `/app` self-service home** (§3) — full screen list, `/console/*` consumption, dual-cursor usage gotcha           | **#1 Tenant `/app` console** (PARTIAL)                  | **Tenant `/app` console**                          | ZenMux pins the backend-readiness precisely: **api-keys CRUD+rotate, `GET /console/models`, `POST /console/payments/intents`, `GET /console/usage` (jobs+ledger), and auth/OAuth are backend-ready TODAY**; only the _clean_ balance card, usage-aggregation, top-up history, and profile/settings need **5 thin `/console` endpoints** (verified absent). → The tenant console **splits across Phase 1 and Phase 2**, not one monolith. |
| **NEW relay-traces page + Analytics page** (§4: `GET /admin/relay-traces`, `GET /admin/analytics/usage`, `GET /admin/usage`) | **"Admin logs page"** (BUCKET A)                        | **Admin observability (relay-traces + analytics)** | ZenMux adds the **data caveats**: `usage_log.latency_ms` is always null and `status` hardcoded `'succeeded'` (write path drops them — `engine/execution-service.ts:745`, `engine/stream.ts:430`), so **latency/error must come from relay_trace**; and `relay_trace` is gated by the **`RELAY_TRACE` env flag (defaults `'off'`)** — the page must degrade gracefully when traces are disabled.                                          |
| (implicit on Dashboard; §4 promotes Analytics)                                                                               | **#6 Ranking bar leaderboard** (READY, admin)           | **Dashboard analytics ranking board**              | UNBLOCKED NOW. `analyticsUsage()` already in `admin.ts`; lands as a `groupBy=model` top-N bar card on the operator **Dashboard** (or the new Analytics page). Zero backend, zero new client method.                                                                                                                                                                                                                                      |
| **Catalog Models tab** (real)                                                                                                | **#2 Models card price/IO density** (price part DOABLE) | **Models card density**                            | Reuse hardened `EntityCard`; surface `input_price`/`output_price` (µcredit ÷ 1e6 via `Money`) + modality in `meta`/`chips`. The price half is unblocked; the **availability-bar half is #3 (blocked)** and the **token-type split is blocked** (only 3 price dims modeled).                                                                                                                                                              |

### The KEY GAP — ZenMux omits the single highest-leverage shippable work

**ZenMux's split contains NO item for de-mocking Route Groups + Official Prices.** Yet the prior analysis's **P0** is exactly that, and I verified both pages still import `mockBilling`/`MockBadge` _despite the real CRUD already shipping on this very branch_ (`@Get/@Post/@Patch/@Delete route-groups` and `official-prices` confirmed at `admin.controller.ts:958-1074`). This is:

- **Already-shippable** (backend is real, on this branch, today),
- **Pure data-source swap** (compose existing `DataTable`/`Modal`/`Drawer` — no new design-system work),
- **Correctness-critical** (the UI currently lies: it renders `<MockBadge/>` over state that resets on reload while a real, persistent backend sits unused).

**This MUST be Phase 1, item #1.** It is the clearest "do now" in the entire roadmap and the only one ZenMux drops. (The bundled dependency — API-Keys group-bind + revoke — rides along because it needs the real `GET /admin/route-groups`.)

### The NEW item — nav architecture (ZenMux #7), not in the prior analysis

ZenMux **#7 public/console nav separation** is a frontend-architecture item the prior page-status analysis didn't raise. The shell grounding makes it actionable and ties it to the tenant-console decision:

- The audience boundary is **already enforced server-side** (`AdminGuard`/`ConsoleGuard`/`ApiKeyGuard`/public) and **structurally** at the route layer (`ProtectedRoute role="admin"` vs `ProtectedRoute`). So this is **pure presentation, unblocked now**.
- The shell grounding's load-bearing recommendation: **do NOT reuse `ConsoleLayout` as-is for the tenant `/app`** (its `NAV`/`MOBILE_TABS` groups — catalog/billing/tenants/ops — are operator-only). Instead **parameterize the nav model** (pass `nav` into `ConsoleLayout` or via `NavConfigContext`) so the hardened chrome (Rail/SubNav/TopBar/BottomTabs, animations, a11y, action/filter/back slots) is mounted twice: `<ConsoleLayout nav={OPERATOR_NAV}/>` for `/console`, `<ConsoleLayout nav={TENANT_NAV}/>` for `/app`.
- The **Rail+SubNav → single grouped sidebar collapse is OPTIONAL polish**, not a prerequisite (per the shell grounding: the current double-layer is already hardened/animated/accessible; collapsing reclaims ~24px and removes the dead single-item SubNav on `ops`). **Defer it.** The forcing function is the nav _parameterization_ (which Phase 2's tenant shell depends on), not the visual collapse.

### Conflicts — none material

The three inputs do not contradict each other on any substantive point. The only friction is **framing overlap** (the tenant console appears in all three; "logs page" vs "relay-traces + analytics" name the same endpoints), resolved by the merges above. One naming hazard to keep straight in code/docs: frontend `/console/*` **routes** = the _operator_ admin console (calls backend `/admin/*`); backend `/console/*` **API** = the _tenant_ self-service plane (ConsoleGuard). Same prefix, opposite audiences.

---

## 2. PHASED ROADMAP

Phases are ordered by **unlock cost**, not by value. Everything in Phase 1 has its backend real _today_; everything in Phase 3 names exactly what it waits on.

### PHASE 1 — UNBLOCKED NOW (zero new backend)

Everything here ships against endpoints that already exist on `feat/billing-group-routing`. No backend PR is a prerequisite for any Phase-1 item.

| #     | Item                                                        | Page(s)                                                                                         | Reuse                                                                                                                                  | Backend dependency                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Size                                     |
| ----- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **1** | **De-mock Route Groups** (P0)                               | `features/console/RouteGroupsPage.tsx`                                                          | `DataTable`, `Modal`/`Drawer`/`ConfirmDialog`, `NumberField`/`SelectField`, per-resource channel picker                                | **NONE** — `GET/POST/PATCH/DELETE /admin/route-groups`, `PUT/DELETE /admin/route-groups/:id/channels/:channelId` all live. Add `routeGroups`/`groupChannels` client methods + `qk.routeGroups()`/`qk.groupChannels(id)`. **Gotchas:** body camelCase (`groupRatioBps`, default `10000`) ↔ response snake_case (`group_ratio_bps`, **integer bps, not money**); `PUT` membership upsert replaces both mock add+update, defaults `priority=0,weight=1` (mock used 100/100); derive channel count from cached membership (the count is a `PageEnvelope`, not a sync read); `Idempotency-Key` on POST only (PUT not idempotent); remove `<MockBadge/>`.                        | **M**                                    |
| **2** | **De-mock Official Prices** (P0)                            | `features/console/OfficialPricesPage.tsx`                                                       | `DataTable` (server cursor paging), form kit, `Money`                                                                                  | **NONE** — `GET/POST/PATCH/DELETE /admin/official-prices` live. Add methods + `qk.officialPrices(params)`. **The hard unit remap:** write body is camelCase **human USD-per-1M** (`inputUsdPer1m`,`outputUsdPer1m`,`cachedInputUsdPer1m`; service does `round(usd×1e6)`); read `OfficialPriceView` is snake_case **µUSD strings** — drop the page's client-side µUSD math. **`effectiveAt` bug:** schema is `z.string().datetime()` (full ISO-8601) but `DateField` emits bare `yyyy-mm-dd` → FAILS; append `T00:00:00Z`. `input`/`output` required on create; `provider`/`modelSlug` not patchable. Consume the cursor envelope, not a flat array. Remove `<MockBadge/>`. | **M**                                    |
| **3** | **API-Keys group-bind + revoke** (P0 dependency of #1)      | `features/console/ApiKeysPage.tsx` (admin)                                                      | existing key list, `ConfirmDialog`, group picker fed by #1's `listRouteGroups`                                                         | **NONE** — `PATCH /admin/api-keys/:id/group` (body `{routeGroupId: uuid\|null}`; null→`default`), `DELETE /admin/api-keys/:id` (204, key then 401), `POST` already accepts `routeGroupId` for bind-on-create. Depends on #1 shipping real `GET /admin/route-groups`.                                                                                                                                                                                                                                                                                                                                                                                                       | **S**                                    |
| **4** | **Nav parameterization + public/console split** (ZenMux #7) | `components/console/ConsoleLayout.tsx`, `console/chrome/*`, `nav-config.ts`, `features/landing` | existing chrome (no rewrite)                                                                                                           | **NONE** (guards already enforce audiences). Pass `nav` into `ConsoleLayout` (prop or `NavConfigContext`) so chrome is audience-neutral; split marketing nav from the authed shell so they never co-render. **Unblocks Phase 2's tenant shell.** _Rail+SubNav→single-sidebar collapse = deferred optional polish._                                                                                                                                                                                                                                                                                                                                                         | **S–M**                                  |
| **5** | **Models card price/IO density** (ZenMux #2, price half)    | `features/console/CatalogPage.tsx` (Models tab/card)                                            | `EntityCard` `meta`/`chips`, `Money` (÷1e6)                                                                                            | **NONE** — `ModelView.input_price`/`output_price` already in payload. Token-type split is blocked (Phase 3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **S**                                    |
| **6** | **Admin analytics ranking board** (ZenMux #6)               | operator `DashboardPage.tsx` (or new Analytics page)                                            | `StatCard`/glass + a tiny `RankingBar` (horizontal bars; **not** the full chart primitive)                                             | **NONE** — `analyticsUsage({groupBy:'model'})` already wired in `admin.ts`. Sort desc by cost client-side, top-N. **Sums are decimal strings — no naive `Number()`.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | **S**                                    |
| **7** | **Admin relay-traces / logs page**                          | new `/console/relay-traces` (ops nav)                                                           | `DataTable` + `Drawer` + **new trace-viewer primitive** (§3)                                                                           | **NONE** for the route — `GET /admin/relay-traces` live (filter by job/tenant/provider/channel + date range). **Caveats:** gate UI on `RELAY_TRACE` flag (defaults `off`) → empty/disabled state; latency/error come from the trace, **not** `usage_log` (which has null latency + hardcoded `succeeded`). Add `relayTraces` method + `qk.relayTraces(params)`.                                                                                                                                                                                                                                                                                                            | **M–L** (carries the trace-viewer build) |
| **8** | **Admin analytics page** (per-call + rollups)               | new Analytics page (ops)                                                                        | **new chart primitive** (§3) + `DataTable` (`listUsage` exists, no page)                                                               | **NONE** — `GET /admin/analytics/usage` (raw `UsageRollupView[]` **array, not envelope**) + `GET /admin/usage` (keyset) live. Chart math on decimal-string sums must avoid `Number()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | **L** (carries the chart build)          |
| **9** | **Tenant `/app` — the backend-ready screens**               | new `/app/*` nested under the parameterized shell from #4                                       | new `consoleApi.ts` + `useConsoleApi` (mirrors `useAdminApi`); `CopyField` (one-time plaintext), `DataTable`/`CardCollection`, `Money` | **NONE for these screens** — **API keys** (`GET/POST/POST rotate/DELETE /console/api-keys`), **Models** (`GET /console/models`), **Top-up initiate** (`POST /console/payments/intents`), **Activity** (`GET /console/usage` jobs+ledger). **Sharp edges:** never send `tenantId` (from JWT); console DELETE returns **200 `{id,status:'disabled'}`** not 204; one-time plaintext never cached; `GET /console/usage` is a **dual-cursor** `{jobs, ledger}` envelope — `useKeyset` can't consume as-is. Namespace keys under `['console',...]`.                                                                                                                              | **L**                                    |

> **Phase-1 internal order:** ship **#1→#2→#3** first (the de-mock — fastest correctness win, no new primitives), then **#4** (unblocks the tenant shell), **#5/#6** (one-edit wins), then the heavier **#7/#8** (which fund the two new primitives) and **#9** (first real tenant value, no backend).

### PHASE 2 — SMALL BACKEND UNLOCK, then frontend

The tenant console's _polished_ screens need **5 thin `/console` endpoints** (verified absent today). Each is small server-side — the repo functions largely exist (`rollupUsage()` already takes a `tenantId`; `accountId` is already in `ConsoleContext`; `listUsageLogsByTenant()` exists with zero callers) — they just need a route that **locks `ctx.tenantId`**. Frontend builds the moment each lands.

| Item                            | Page(s)                                    | Reuse                                                                                                                                        | Backend dependency (the named thin endpoint)                                                                                            | Size   |
| ------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **Balance & credits header**    | `/app` overview / billing                  | **new balance/credits widget** (§3), `Money`                                                                                                 | `GET /console/balance` (or `/console/account`) — _interim:_ derive latest `balance_after` from the `GET /console/usage` ledger envelope | S (FE) |
| **Top-up history / status**     | `/app` billing                             | `DataTable`, `StatusBadge`                                                                                                                   | `GET /console/payments` + `GET /console/payments/:id`                                                                                   | S (FE) |
| **Usage aggregation (tenant)**  | `/app` usage                               | sparkline (chart primitive at small size, from §3)                                                                                           | `GET /console/analytics/usage` (tenant-locked `rollupUsage`)                                                                            | M (FE) |
| **Per-call usage log (tenant)** | `/app` usage                               | `DataTable` keyset                                                                                                                           | `GET /console/usage-log` (wire `listUsageLogsByTenant`)                                                                                 | S (FE) |
| **Profile / settings**          | `/app` settings                            | form kit                                                                                                                                     | `GET /console/me` + `PATCH /console/settings` (change password)                                                                         | S (FE) |
| **Tenant shell**                | `features/app/AppLayout` + `/app/*` routes | the parameterized `ConsoleLayout` from Phase-1 #4 + a **short `TENANT_NAV`** (overview / api-keys / usage / billing / settings — 1–2 groups) | depends on Phase-1 #4 (nav parameterization), not on backend                                                                            | M      |

> Phase 2 = "upgrade `/app` from the backend-ready stub (Phase-1 #9) to a complete console." The **tenant shell** itself has no backend dependency — it depends on Phase-1 #4; the _page contents_ depend on the 5 endpoints.

### PHASE 3 — BACKEND-BLOCKED (frontend waits; design now)

Do not start the data wiring. Lay out the components/empty states so the slot exists when the timeseries/bucket/price backend lands. Each names exactly what it waits on.

| Item                                                                          | Page(s)                                  | Reuse                             | Blocked on (the big backend)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Size                              |
| ----------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| **Channel-health tick-bar + latency/throughput charts** (ZenMux #3 — biggest) | new `ChannelHealthPage` / catalog detail | chart primitive + a new tick-bar  | **Per-call latency+status is never stored per channel** (`usage_log` drops `latencyMs`, hardcodes `status:'succeeded'`; failed relays never enter `usage_log`; `channel_health` is one overwritten cooldown row, no history). Needs: capture per-call latency+status → timeseries storage/retention → aggregate endpoints (percentiles / tokens-per-sec / availability% / bucketed history). _Interim only:_ a static up/down + last-checked card from the single cooldown row, explicitly labeled non-historical.                                | L (after backend)                 |
| **Credit-bucket ledger breakdown** (ZenMux #5)                                | `/app` billing; admin Accounts           | `DataTable`, expiry `StatusBadge` | `ledger_txn` has **no source/bucket column** (can't tell topup vs redemption-code apart); balance is a single scalar. Needs: ledger source/bucket columns (migration) + reward/compensation/referral grant endpoints + lot-based expiry + a reaper + a bucket-aggregation endpoint. _Phase-1/2 ships only:_ total-balance card + flat ledger.                                                                                                                                                                                                     | L (after backend)                 |
| **Multi-dim price matrix + token-type split** (ZenMux #2 token-half, #4)      | catalog `PriceMatrix`                    | table + `Money`                   | Only **3 of 10** price dims modeled (input/output/cached-read); other 7 (cache-write, 5min/1hr TTL, web-search, image in/out, reasoning, video) need columns + migration + settle path. `usage_log` has only input/output columns → no by-token-type breakdown without `cached_tokens`/`reasoning_tokens` columns + write-path change. No server-side matrix endpoint. _Interim:_ a 3-column (input/output/cached) read-only table built from a **client-side `models` + `official-prices` join**, with the 7 unmodeled dims shown as greyed "—". | M (3-dim now; full after backend) |

---

## 3. CROSS-CUTTING

### New design-system pieces actually needed (everything else is composition of already-hardened primitives)

Only **three** genuinely-new pieces; **no charting dependency is installed**, confirmed.

1. **Chart primitive** (bar/line/area + small sparkline cousin). Consumers: admin **Analytics** (Phase-1 #8), tenant **usage aggregation** (Phase-2), **channel-health** charts (Phase-3). House style is hand-rolled SVG + GSAP + tokens (matches `StatCard` count-up / sliding indicators), so prefer a small from-scratch SVG primitive over a heavyweight dep. Must respect the warm-amber palette ("never blue"), reduced-motion gating, light/dark tokens, `.tabular` numerics, and **consume decimal-string sums without naive `Number()`** (raw `UsageRollupView[]`, not an envelope). Highest-effort piece. The **`RankingBar`** for Phase-1 #6 is a much smaller, separate component — build it first; it is _not_ the chart primitive.
2. **Trace / request-detail viewer.** Consumer: **relay-traces** (Phase-1 #7). Compose existing `DataTable` (list) + `Drawer`; the genuinely-new part is the collapsible-headers + pretty-printed redacted **request↔response body viewer** (monospace, JSON-pretty) with latency display, stream/truncated flags, and a status pill.
3. **Balance / credits widget** for the tenant home (Phase-2). A prominent credit-balance + held-credits card (reuse `Money`/BigInt) with a self-topup CTA and a compact usage sparkline (the sparkline folds into the chart primitive at small size). `StatCard` is a starting point but the dedicated widget + CTA is new.

Everything else — Route Groups, Official Prices, Dify bindings, redemption codes, oauth-sessions, all tenant tables — is **pure composition** of the hardened `DataTable`/`EntityCard`/`CardCollection`/form-kit/`Modal`/`Drawer`/`ConfirmDialog`/`Tabs`/`Toggle`/`Money`/`StatusBadge`/`CopyField`/`Floating`. No new design-system work.

### Caching tiers for the new data (`query.ts` conventions)

Defaults: `staleTime 15s`, `retry 1`, no refetch-on-focus, `gcTime 5min`. Overrides: `STALE_REFERENCE 60s`, `STALE_VOLATILE 10s`. Mutations carry no invalidation in the client; the page invalidates the matching `qk.*` in `onSuccess`; `mutationError(t)` is the standard `onError`.

- **Reference / catalog (60s):** `routeGroups`, `groupChannels`, `officialPrices`, `models`, **`modifiers` (bump from 15s)**, `dify`, `oauthSessions`, `redemptionCodes` (list).
- **Default (15s):** `apiKeys`, `channels`, `pricebook`, `model(name)`, `modelGrants`.
- **Volatile / operational (10s):** `relayTraces`, `analyticsUsage`, `usage`, `jobs`, `ledger`, `payments`.
- **New keys to add:** `qk.routeGroups()`=`['admin','route-groups']`, `qk.groupChannels(id)`, `qk.officialPrices(params)`, `qk.relayTraces(params)`, `qk.dify()`, `qk.redemptionCodes(params)`, `qk.oauthSessions()`. **Tenant keys namespaced under `['console',...]`** to keep operator vs tenant caches disjoint.
- **Never cache (local `useState` + `CopyField`, shown once):** all one-shot plaintext — `POST /admin/api-keys`, `POST /console/api-keys` + rotate, `POST /admin/redemption-codes`, `/admin/secrets`, `/admin/oauth-sessions` + codex. These are deliberately **not** `@Idempotent` → never send `Idempotency-Key`, never replay. Also presigned URLs, dify import report, codex PKCE state, topup `{account_id, balance}` (merge to local state).
- **Two pagination exceptions** break the single-cursor pattern: `GET /admin/analytics/usage` (raw array) and `GET /console/usage` (`{jobs, ledger}` with **separate** `jobs_cursor`/`ledger_cursor`) — `useKeyset` can't consume the latter as-is. Everywhere else is keyset/cursor → "load more".
- **DELETE shape differs by plane:** admin DELETE → **204**; console DELETE → **200 `{id, status:'disabled'}`**. Handle both.

### Audience / visibility each new page targets

Four audiences on one `user` table (operator = `user` with `role==='admin'`); three backend guards (`AdminGuard+@Roles('admin')` on `/admin/*`; `ConsoleGuard` on `/console/*` API — ignores `role`, requires active+tenant_id+account; `ApiKeyGuard` on `/v1/*`).

| New page / surface                                                                                     | Audience                                             | Frontend gate                                | Backend guard                                |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| De-mocked Route Groups / Official Prices, API-Keys bind/revoke, ranking board, relay-traces, analytics | **Operator**                                         | `ProtectedRoute role="admin"` → `/console/*` | `AdminGuard + @Roles('admin')` on `/admin/*` |
| Tenant `/app/*` console (all screens)                                                                  | **Tenant user** (admins with a tenant land here too) | `ProtectedRoute` (any auth) → `/app/*`       | `ConsoleGuard` on `/console/*` API           |
| Landing / public nav                                                                                   | **Public**                                           | none                                         | none                                         |
| `/v1/*` developer plane                                                                                | **Developer integrator**                             | **no UI by design** — docs/snippets only     | `ApiKeyGuard`                                |

> Client-side role gating is **advisory** (JWT decoded, not verified) — every data path is re-guarded server-side, so route gating is cosmetic. `ConsoleGuard` ignores `role`, so an admin-with-tenant can call the tenant plane. **Do not build a `/v1` UI** — surface it as code snippets only; the sole frontend touchpoint is key minting.

---

## 4. RECOMMENDED FIRST 3 TICKETS

The three to start tomorrow — each has its backend **real today**, each is a high-value/low-risk win, each names page · endpoints · components.

### Ticket 1 — De-mock Route Groups (and bundle the channel membership swap)

- **Why:** Highest leverage in the entire roadmap. The backend shipped on _this_ branch; the UI is actively lying (renders `<MockBadge/>` over reset-on-reload state). Pure data-source swap, no new primitives — best value/effort ratio available. ZenMux omitted it entirely; the prior analysis ranked it P0.
- **Page:** `features/console/RouteGroupsPage.tsx`.
- **Endpoints:** `GET/POST/PATCH/DELETE /admin/route-groups`, `PUT/DELETE /admin/route-groups/:id/channels/:channelId`, channel roster from `GET /admin/resources` → `GET /admin/resources/:id/channels`.
- **Components:** existing `DataTable`, `Modal`/`Drawer`/`ConfirmDialog`, `NumberField`/`SelectField`, per-resource channel picker. Remove `mockBilling` import + `<MockBadge/>`.
- **Watch:** camel-write/snake-read remap; `group_ratio_bps` is **integer bps (10000 = 1.0×), not money**; `PUT` membership upsert (defaults `priority=0,weight=1`) replaces both mock add+update; derive count from cached membership; `Idempotency-Key` on POST only. **Add `routeGroups`/`groupChannels` client methods + query keys** — these don't exist in `admin.ts` yet (verified). Unblocks Ticket-equivalent API-Keys group-bind (Phase-1 #3).

### Ticket 2 — De-mock Official Prices (nail the unit remap)

- **Why:** The other half of the P0; same "backend already real" win. Slightly higher risk than Ticket 1 because of the µUSD↔USD remap and the `effectiveAt` format bug — worth doing carefully and early so the pattern is established before the tenant money screens.
- **Page:** `features/console/OfficialPricesPage.tsx`.
- **Endpoints:** `GET/POST/PATCH/DELETE /admin/official-prices` (PageEnvelope, cursor paging).
- **Components:** `DataTable` (server cursor, not the flat array), form kit, `Money`. Remove `mockBilling` import + `<MockBadge/>` + the page's client-side µUSD math.
- **Watch (load-bearing):** **write body = camelCase human USD-per-1M** (`inputUsdPer1m`/`outputUsdPer1m`/`cachedInputUsdPer1m`; service does `round(usd×1e6)`); **read = snake_case µUSD strings**. **`effectiveAt` bug:** `DateField` emits `yyyy-mm-dd` but schema is `z.string().datetime()` → append `T00:00:00Z` or it 400s. `input`/`output` required on create; `provider`/`modelSlug` not patchable. Add `officialPrices` method + `qk.officialPrices(params)`.

### Ticket 3 — Admin analytics ranking board on the operator Dashboard

- **Why:** Genuinely one page edit — `analyticsUsage()` is _already_ wired in `admin.ts` (verified), so zero new client method and zero backend. Turns the bare two-`StatCard` dashboard into something that demonstrates the analytics data is live, and validates the decimal-string-math discipline before the bigger chart primitive lands.
- **Page:** operator `DashboardPage.tsx`.
- **Endpoint:** `GET /admin/analytics/usage?groupBy=model` (raw `UsageRollupView[]` array — **no envelope**) via the existing `analyticsUsage()`.
- **Components:** existing `StatCard`/glass + a tiny new **`RankingBar`** (horizontal bars — explicitly **not** the full chart primitive; that's Phase-1 #8). Sort desc by cost client-side, slice top-10.
- **Watch:** token/cost sums are **decimal strings** — sort and render with BigInt/string math, never `Number()`.

> These three are deliberately all **zero-backend, mock-or-trivial** so they can land before any of the heavier primitive work (chart/trace viewer) or the nav parameterization. After them, the natural next step is Phase-1 #4 (nav parameterization), which unblocks the entire tenant `/app` console.

---

# Appendix A — Prior frontend-design roadmap (extract)

# FRONTEND ROADMAP EXTRACT — Actionow Web

Source docs: `/Users/alienworm/actionow-web/docs/frontend-design-analysis.md` (29-agent deep analysis, every endpoint/component grep-verified) and `/Users/alienworm/actionow-web/docs/component-audit.md`. Both generated 2026-06-18 against backend `actionow-core @ feat/billing-group-routing` and frontend `actionow-web @ feat/admin-frontend`.

**Single highest-leverage finding (verbatim intent):** _the backend has materially outrun the frontend._ Two full backend areas (route-groups, official-prices) are real but the UI still reads in-memory mocks; an entire audience (tenant self-service, the `/console/*` **API**) is fully built server-side and essentially unbuilt client-side (`/app` is a placeholder); ~a dozen admin capabilities have working endpoints with no page.

> NOTE on the component-audit: its P0/P1/P2 component-library fixes are **already implemented and committed this session** (shared `Floating` primitive + portal tooltips, `--z-*` tokens, stable row-id keys, field-contract helper, `--min-touch`/`.hit-slop`, Modal close+inert, etc.). The design system is treated as solid below; those are NOT re-listed as TODO. Only the genuinely-still-missing primitives (chart, trace viewer) carry forward.

> Naming collision to keep straight: frontend `/console/*` routes = the **operator** admin console (talks to backend `/admin/*`). Backend `/console/*` **API** = the **tenant self-service** plane (ConsoleGuard). Same prefix, opposite audiences.

---

## 1. PER-PAGE STATUS TABLE

| Route                                        | Audience                                                                          | Data status                        | What it currently does                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/` (Landing)                                | Public / prospective operators                                                    | **static**                         | Marketing page. Provider list + pricing are hardcoded; correctly static — **no public/unauthenticated data endpoint exists** (`GET /v1/models`, `GET /console/models` both require auth), so live data cannot be fetched here without a new anonymous route.                                                                             |
| `/login` (Auth)                              | Public → produces operator (`role=admin`) or tenant-user (`role=user`)            | **real**                           | `POST /auth/login`, `POST /auth/register`, `GET /auth/oauth/:provider` (gated by `VITE_OAUTH_ENABLED`). Post-auth redirect: `role==='admin' → /console/dashboard`, else `→ /app`.                                                                                                                                                        |
| `/app` (UserHome)                            | Tenant self-service end-user (`role=user`); any authed user (admins admitted too) | **static placeholder**             | 48-line file. Renders one centered glass "coming soon" card (`app.soon`/`app.hint`) + Website + Sign-out buttons. **Zero** API calls, no TanStack Query, no `qk.*`, no `mockBilling`. Only real behavior is `useAuth().logout()`. The whole tenant `/console/*` backend plane is unwired.                                                |
| `/console/dashboard`                         | Operator                                                                          | **real**                           | Two `StatCard` count tiles (`tenants.length`/`resources.length` — first keyset page only, capped at 50, not true totals) + a tenant-scoped recent-jobs `CardCollection` (≤8). Reads `GET /admin/tenants`, `GET /admin/resources`, `GET /admin/jobs?tenantId&limit=8`. No error state; "Status" meta-cell label bug (shows `created_at`). |
| `/console/catalog` (Resources + Models tabs) | Operator                                                                          | **real**                           | Full CRUD over resources/channels/models/pricebook/secrets/grants (~22 endpoints). `?tab=models\|resources`; legacy `/console/resources`, `/resources/:id`, `/models` redirect here.                                                                                                                                                     |
| `/console/modifiers`                         | Operator                                                                          | **real (incomplete)**              | List + create pricing modifiers only. Missing: edit/active-toggle (`PATCH /:id`), delete (`DELETE /:id`), detail (`GET /:id`); not sending `Idempotency-Key` on create.                                                                                                                                                                  |
| `/console/groups` (Route Groups)             | Operator                                                                          | **full-mock**                      | Billing/routing group CRUD + channel membership, but reads `mockBilling.ts` (`['mock','route-groups']`), renders `<MockBadge/>`, state resets on reload — **despite real CRUD now existing on this branch.**                                                                                                                             |
| `/console/official-prices`                   | Operator                                                                          | **full-mock**                      | Reference model-price catalog; client-side searchable flat array from `mockBilling.ts` (`['mock','official-prices']`), `<MockBadge/>` — **despite real CRUD now existing.**                                                                                                                                                              |
| `/console/dify` (Import)                     | Operator                                                                          | **partial-mock / real-incomplete** | `POST /admin/dify/import` only (real). Missing: binding list/edit/delete (`GET`/`PATCH`/`DELETE /admin/dify`), `TenantSelect`, `SecretSelect`, `serviceKeyRef`/`allowBlockers`. Import form still uses raw-uuid paste.                                                                                                                   |
| `/console/tenants`                           | Operator                                                                          | **real (incomplete)**              | List + create. Missing: tenant detail (`GET /:id`), inline `isolationMode` edit (`PATCH /:id`); no detail route/deep-links; not sending `Idempotency-Key` on create. (No tenant DELETE by design.)                                                                                                                                       |
| `/console/accounts`                          | Operator                                                                          | **partial-mock / real-incomplete** | Account create + topup only (real). Missing: ledger table, payments panel, redemption-code generator, `getAccount` re-fetch.                                                                                                                                                                                                             |
| `/console/api-keys` (Admin)                  | Operator                                                                          | **partial-mock / real-incomplete** | Operator-managed key mint + list (real; tenant chosen in TopBar filter, sent in body). Missing: group-bind picker (`PATCH /:id/group`), revoke (`DELETE /:id`), bind-on-create (`routeGroupId` in POST body).                                                                                                                            |
| `*`                                          | Public                                                                            | —                                  | Redirect to `/`.                                                                                                                                                                                                                                                                                                                         |
| (no frontend route)                          | Developer integrator                                                              | n/a — no UI by design              | `/v1/*` consumed programmatically via `ak_...` keys. Surface only as docs/code-snippets; never build an interactive `/v1` UI.                                                                                                                                                                                                            |

---

## 2. P0 — MOCK-vs-REAL (the two pages whose backend already shipped on this branch)

The per-page audits explicitly corrected `partial-mock → real` for Dify/Accounts/API-Keys; **the only pages reading mock data are Route Groups and Official Prices.**

### 2a. Route Groups (`/console/groups`) — `full-mock` → REAL available now

**Today:** imports `listRouteGroups/createRouteGroup/updateRouteGroup/deleteRouteGroup/listGroupChannels/countGroupChannels/addGroupChannel/updateGroupChannel/removeGroupChannel/MOCK_CHANNELS` from `mockBilling.ts`; keys `['mock','route-groups']` / `['mock','group-channels',id]`; `<MockBadge/>`.

**Real endpoints (exist on this branch):**

- `GET/POST /admin/route-groups`, `GET/PATCH/DELETE /admin/route-groups/:id`
- `GET /admin/route-groups/:id/channels`, **`PUT /admin/route-groups/:id/channels/:channelId`** (idempotent upsert — replaces BOTH mock `addGroupChannel` and `updateGroupChannel`), `DELETE /admin/route-groups/:id/channels/:channelId` (hard-delete membership)
- Channel roster from real `GET /admin/resources` + `GET /admin/resources/:id/channels` (replaces `MOCK_CHANNELS`)

**Field/unit gotchas:**

1. Add client methods in `admin.ts`: `listRouteGroups`, `createRouteGroup(body, idempotencyKey?)`, `getRouteGroup`, `updateRouteGroup`, `deleteRouteGroup`, `listGroupChannels(groupId)`, `upsertGroupChannel(groupId, channelId, {priority?,weight?})` (PUT), `removeGroupChannel(groupId, channelId)`.
2. Add `qk.routeGroups()` = `['admin','route-groups']` and `qk.groupChannels(id)` = `['admin','route-groups',id,'channels']` (no entries exist today).
3. **camel↔snake remap:** request body is camelCase (`groupRatioBps`, default `10000`); response is snake_case (`group_ratio_bps`). `group_ratio_bps` is an **integer in bps (10000 = 1.0×)** — a plain number, NOT a money string.
4. **Membership default drift:** PUT membership defaults `priority=0`, `weight=1`; the mock seeded `priority=100, weight=100` — adjust seed expectations.
5. **Channel COUNT column:** mock used a synchronous `countGroupChannels`; real `GET .../channels` returns a `PageEnvelope` — derive count from the cached membership query or make it lazy/unfetched (do NOT add a second sync read).
6. Replace `MOCK_CHANNELS` add-picker with a per-resource picker (`GET /admin/resources` → `GET /admin/resources/:id/channels`).
7. Send `Idempotency-Key` on `POST /admin/route-groups` (`@Idempotent`); **PUT membership is NOT idempotent.**
8. Remove `<MockBadge/>`.

### 2b. Official Prices (`/console/official-prices`) — `full-mock` → REAL available now (the tricky unit remap)

**Today:** `listOfficialPrices/createOfficialPrice/updateOfficialPrice/deleteOfficialPrice` from `mockBilling.ts`; key `['mock','official-prices']`; client-side `searchable`/`pageSize={20}` over a flat array; `<MockBadge/>`.

**Real endpoints:** `GET /admin/official-prices` (PageEnvelope, query `provider?/limit?/cursor?`), `POST` (`@Idempotent`), `PATCH /:id` (nullable-clearable; `provider`/`modelSlug` NOT patchable), `DELETE /:id` (204).

**Field/unit gotchas:**

1. Add client methods + `qk.officialPrices(params)` = `['admin','official-prices',{provider?}]`.
2. **Name + UNIT remap (the hard one):** mock/local `OfficialModelPrice` is snake_case + integer µUSD/1M (`model_slug`, `input_price_per_1m`, `cached_input_price_per_1m`, `source_url`, `effective_at`). Real **create/update body is camelCase + HUMAN USD-per-1M** (`modelSlug`, `inputUsdPer1m`, `outputUsdPer1m`, `cachedInputUsdPer1m`, `sourceUrl`, `effectiveAt`); the service does `round(usd × 1e6)`. Response `OfficialPriceView` is snake_case **µUSD strings**. → Drop the page's client-side `usdLabel` µUSD math; send human USD on write, parse µUSD strings on read.
3. **`effectiveAt` format bug to fix on wiring:** real schema is `z.string().datetime()` (full ISO-8601) but the page's `DateField` emits bare `yyyy-mm-dd`, which FAILS `.datetime()`. Emit a full timestamp (e.g. append `T00:00:00Z`).
4. Consume the `PageEnvelope` (cursor paging), not the flat array; keep refetch-on-success (no optimism needed for low-frequency catalog edits).
5. `inputUsdPer1m` / `outputUsdPer1m` are **required** on create.
6. Remove `<MockBadge/>`.

### 2c. Bundled P0 dependency

**API Keys group-bind + revoke** is sequenced as P0 #3 because it unblocks/depends on 2a: add `bindApiKeyGroup` (`PATCH /admin/api-keys/:id/group`, body `{routeGroupId: uuid|null}` — uuid binds, null unbinds → `default`), `revokeApiKey` (`DELETE /admin/api-keys/:id` → 204, key then 401), `listRouteGroups` (needs real `GET /admin/route-groups` from 2a). `POST /admin/api-keys` already accepts `routeGroupId` for bind-on-create.

---

## 3. P1 — TENANT `/app` SELF-SERVICE HOME (replace the placeholder)

The entire backend `/console/*` API is unbuilt on the client — the single biggest product gap. Build a real tenant dashboard, kept **outside** the operator `ConsoleLayout` (that shell is admin-only/`role="admin"`-gated); reuse a lightweight tenant shell (`AppBackground` + Logo + theme/lang toggles) hosting a responsive grid (StatCards row, then keys + usage two-column ≥`BP.md`/768px, models `CardCollection`). `useAuth().client` already carries the bearer JWT — no new auth plumbing needed.

**Screens it should contain:**

1. **Balance & credits header** — credit balance + held credits (render with `Money`/BigInt), primary **Top up** CTA. Needs a new balance/credits widget primitive (see §6).
2. **Top-up flow** — amount entry → `POST /console/payments/intents` → render returned `redirect_url`/`qr`. Console-side is fire-and-redirect (status polling `GET /v1/payments/intents/:id` is API-key-scoped, not console).
3. **API keys panel** — list own keys (id, status, rate_limit, resource_allowlist, created_at) with Create / Rotate / Disable row actions; one-time-plaintext `CopyField` modal on create/rotate.
4. **Usage panel** — recent jobs + ledger (cost, type, balance_after, created_at), "load more" off cursors.
5. **Available models** — read-only catalog of models visible to this tenant (so the user knows what to call).
6. **Empty / loading / error states** (no keys → "Create your first key"; `RoseLoader` via DataTable/CardCollection; toast via `mutationError`).

**The `/console/*` tenant API it should consume** (ConsoleGuard; tenant always from JWT — never send `tenantId`):

- `GET /console/api-keys?cursor&limit` → `PageEnvelope<ApiKeyView>` (console `ApiKeyView = {id, resource_allowlist, rate_limit, status, created_at}` — NO `tenant_id`/`route_group_id`)
- `POST /console/api-keys` body `{resourceAllowlist?, rateLimit?}` (NO tenantId) → `201 {id, plaintext}` (plaintext ONCE)
- `POST /console/api-keys/:id/rotate` → `201 {id, plaintext}` (old key disabled)
- `DELETE /console/api-keys/:id` → **`200 {id, status:'disabled'}`** (NOT 204 — differs from admin)
- `GET /console/usage?jobs_cursor&ledger_cursor&limit` → `{jobs: PageEnvelope<JobView>, ledger: PageEnvelope<LedgerView>}` — **two independent envelopes, two cursors** (breaks the single-`cursor` pattern; `useKeyset` can't consume it as-is)
- `GET /console/models` → `PageEnvelope<ModelListItem>` single bounded page (`next_cursor:null, has_more:false`)
- `POST /console/payments/intents` body `{provider, amount_minor:int>0, currency}` → `201 {intent_id, redirect_url?, qr?}` (purpose hardcoded `topup`)

**Build order + sharp edges:**

1. Build the data layer first — add a `makeConsoleApi(client)` bundle (parallel to `makeAdminApi`) + `qk.console*` keys namespaced under `['console', ...]` to keep operator vs tenant caches disjoint. The whole frontend data layer is admin-only today.
2. Ship API-keys self-service (highest value), then balance+top-up, then usage+models.
3. **No tenant GET-account/balance endpoint exists** in `/console/*` (account reads are admin-only `GET /admin/accounts/:id`). Either derive latest `balance_after` from the `GET /console/usage` ledger envelope short-term, or add `GET /console/account` server-side.
4. Sharp edges: dual-cursor usage envelope; console DELETE 200 not 204; one-time plaintext never cached; never send `tenantId`; all money is µcredit decimal strings → `Money`/BigInt.

### P1 — also surface fully-built backend on existing pages

- **Accounts:** wire `listLedger`/`listPayments` (keyset) + redemption-code generator (show once, never cache) + `getAccount` — `GET /admin/ledger`, `GET /admin/payments`, `POST /admin/redemption-codes`, `GET /admin/accounts/:id`.
- **Dify:** two-tab (Import | Imported bindings) — add `difyList`/`difyUpdate`/`difyDelete` + `['admin','dify']` key + `TenantSelect`/`SecretSelect`.
- **Modifiers:** edit Drawer + active Toggle + delete; send `Idempotency-Key`; bump `qk.modifiers()` to `STALE_REFERENCE`.

---

## 4. BACKEND CAPABILITIES SURFACED IN **NO** PAGE — and where each should go

| Capability / endpoint(s)                                                                                  | Client/page status                                                                                            | Surface where                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`GET /admin/relay-traces`**                                                                             | Not in `admin.ts` at all (no client method); not mocked                                                       | **NEW `/console/relay-traces` page** under **ops** nav, filterable by `jobId`/`tenantId`/`providerType`/`channelId`/`from`/`to`. Deep-link from a Dashboard job row and from a Catalog channel. Needs the **trace/timeline viewer** primitive (§6). |
| **`GET /admin/analytics/usage`** (`groupBy`; **raw `UsageRollupView[]` array, NOT an envelope**)          | No client method, no page                                                                                     | **NEW Analytics page** under **ops** (or Dashboard tab). Charts grouped by day/model/tenant/channel/api_key. Needs the **chart** primitive (§6). Token/cost sums are decimal strings — chart math must avoid naive `Number()`.                      |
| **`GET /admin/usage`** (global per-call `UsageLogView`, keyset)                                           | `listUsage` exists in `admin.ts`, no page renders it                                                          | Tab/table on the new Analytics page (per-call detail behind the rollups). `useKeyset(qk.usage(params), …)`.                                                                                                                                         |
| **`GET /admin/ledger`** (keyset)                                                                          | `listLedger` exists, no page                                                                                  | **Accounts page** — the transaction-ledger table the page already promises. `STALE_VOLATILE`.                                                                                                                                                       |
| **`GET /admin/payments`** (keyset, separate controller)                                                   | `listPayments` exists, no page                                                                                | **Accounts page** — payment-intents panel, tenant-scoped.                                                                                                                                                                                           |
| **`POST /admin/redemption-codes`** (secret-returning, NOT idempotent) + **`GET /admin/redemption-codes`** | `generateCodes` exists; list endpoint has no client method; no page                                           | **Accounts page** (or small `/console/redemption-codes`). Generator shows codes ONCE (never cache plaintext). Add `listRedemptionCodes` + list table with `status` filter.                                                                          |
| **`GET/POST/GET:id/DELETE /admin/secrets`**                                                               | `createSecret`/`listSecrets` exist; consumed only indirectly via `SecretSelect` inside Catalog                | **Standalone Secrets page** under a settings/ops/connections group, with revoke — today `DELETE /admin/secrets/:id` is unreachable from any UI. Lower priority than the billing pages.                                                              |
| **`/admin/oauth-sessions`** (+ codex `login/start`, `login/complete`)                                     | No client method, no page, not mocked                                                                         | **NEW OAuth-sessions page** (BYO subscription / codex login) under a connections/credentials group. codex `login/start` → `authorize_url` flow needs redirect + complete UI. Secret-returning POSTs → never cache.                                  |
| **`GET /admin/jobs`**                                                                                     | `listJobs` exists; consumed only as Dashboard "recent jobs" preview (`limit=8`, first page; cursor discarded) | Promote to a full **Jobs page** (or Dashboard tab) with keyset pagination + filters + a job-detail drawer that links to relay-traces.                                                                                                               |
| **`/admin/dify` (GET list), `PATCH /admin/dify/:resourceId`, `DELETE /admin/dify/:resourceId`**           | Only `difyImport` wired; list/patch/delete have no client method                                              | Extend **Dify page** to two tabs (Import \| Imported bindings): add 3 client methods, binding table, edit Drawer, delete ConfirmDialog; add `TenantSelect` + optional `serviceKeyRef`.                                                              |
| **`PATCH /admin/api-keys/:id/group`, `DELETE /admin/api-keys/:id`**                                       | No client method; not wired                                                                                   | **API Keys page** — group-bind picker (needs real `GET /admin/route-groups`) + revoke row action. (P0 #3.)                                                                                                                                          |
| **`GET /admin/tenants/:id`, `PATCH /admin/tenants/:id`**                                                  | No `getTenant`/`updateTenant`                                                                                 | **Tenants page** — detail view (read one; inline-edit `isolationMode`) deep-linking to that tenant's accounts/keys/grants. (No tenant DELETE by design.)                                                                                            |
| **`GET /admin/accounts/:id`**                                                                             | No `getAccount`                                                                                               | **Accounts page** — re-fetch a balance by id without first creating the account.                                                                                                                                                                    |
| **`/v1/*` developer plane**                                                                               | No frontend by design                                                                                         | **Do NOT build a UI.** Surface as docs/code-snippets only (base URL, `ak_...` usage, OpenAI/Anthropic/Gemini-compatible curl) on a future tenant home or docs page. Only frontend touchpoint is key minting.                                        |
| **`/console/*` tenant API**                                                                               | No frontend (placeholder `/app`)                                                                              | Build the real tenant home (§3).                                                                                                                                                                                                                    |

---

## 5. CACHING TIERS, QUERY-KEY CONVENTIONS, AUDIENCE MATRIX

### 5a. Defaults & conventions (`query.ts`)

`staleTime 15_000`, `retry 1`, `refetchOnWindowFocus false`, `gcTime` 5min. Overrides: `STALE_REFERENCE = 60_000` (catalog/config), `STALE_VOLATILE = 10_000` (operational). `useKeyset` wraps `useInfiniteQuery` for cursor lists. Mutations carry no invalidation in `admin.ts`; the consuming page invalidates the matching `qk.*` in `onSuccess`. `mutationError(t)` is the standard `onError`. Prefer **invalidate the key** over storing the mutation return value.

### 5b. Query-key namespaces (all under `['admin', ...]`)

**Existing:** `tenants`, `resources`, `resources/:id/channels`, `pricebook/:id`, `modifiers`, `secrets`, `api-keys/:tenantId`, `jobs/:tenantId`, `models`, `models/:name`, `models/:name/grants`, `usage/:params`, `analytics-usage/:params`, `ledger/:tenantId`, `payments/:tenantId`.

**Add (no entry exists today):**

- `qk.routeGroups()` = `['admin','route-groups']`
- `qk.groupChannels(id)` = `['admin','route-groups',id,'channels']`
- `qk.officialPrices(params)` = `['admin','official-prices',params]`
- `qk.dify()` = `['admin','dify']`
- `qk.relayTraces(params)` = `['admin','relay-traces',params]`
- `qk.redemptionCodes(params)` = `['admin','redemption-codes',params]`
- `qk.oauthSessions()` = `['admin','oauth-sessions']`
- When the tenant home ships, namespace under `['console', ...]` to keep operator vs tenant caches disjoint.

### 5c. staleTime tiers

| Tier                       | staleTime               | Keys                                                                                                                                                                          |
| -------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reference / catalog**    | `STALE_REFERENCE` (60s) | `tenants`, `resources`, `models`, **`modifiers` (currently default 15s — bump to 60s)**, `routeGroups`, `groupChannels`, `officialPrices`, `secrets`, `dify`, `oauthSessions` |
| **Default**                | 15s                     | `channels`, `pricebook`, `model(name)`, `modelGrants`, `apiKeys`                                                                                                              |
| **Volatile / operational** | `STALE_VOLATILE` (10s)  | `jobs`, `usage`, `analyticsUsage`, `ledger`, `payments`, `relayTraces`                                                                                                        |

Use `keepPreviousData` (already done for jobs/api-keys) on any filter-driven list.

### 5d. Invalidation rules (per mutation → invalidate)

createTenant/updateTenant → `qk.tenants()` (+detail key); createAccount/topup → account-detail key + `qk.ledger(tenantId)`; createApiKey/revokeApiKey/bindApiKeyGroup → `qk.apiKeys(tenantId)`; createResource/updateResource → `qk.resources()`; channel CRUD/syncModels → `qk.channels(resourceId)` (sync also → `qk.models()`); createPricebook → `qk.pricebook(resourceId)`; modifier CRUD → `qk.modifiers()`; model CRUD → `qk.models()` (+`qk.model(name)`); grant/revoke → `qk.modelGrants(name)`; routeGroup CRUD → `qk.routeGroups()`; upsert/removeGroupChannel → `qk.groupChannels(groupId)` (+recompute count); officialPrice CRUD → `qk.officialPrices()` (all param variants); dify CRUD → `qk.dify()`; secret create/delete → `qk.secrets()`.

### 5e. What NOT to cache

One-shot plaintext (`POST /admin/api-keys`, `POST/PATCH /console/api-keys` rotate, `POST /admin/redemption-codes`) → local `useState` + `CopyField`, shown once, never in cache; these are deliberately NOT `@Idempotent` (never send `Idempotency-Key`, never replay). Other secret-returning POSTs (`/admin/secrets`, `/admin/oauth-sessions` + codex). Presigned URLs (`POST /v1/files/presign-upload`, `GET /v1/files/:id/url`). One-shot dify import report. codex `login/start` PKCE state. Topup `{account_id, balance}` → merge into local state.

### 5f. Audience / visibility matrix

Four audiences on one unified `user` table (operator = `user` with `role==='admin'`).

| Frontend route                                                                                           | Audience                                   | Frontend gate                 | Backend guard for its data                       |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------- | ------------------------------------------------ |
| `/`                                                                                                      | (d) Public                                 | none                          | none                                             |
| `/login`                                                                                                 | (d) Public → (a)/(b)                       | none                          | local-auth / admin-auth (no guard)               |
| `/app`                                                                                                   | (b) Tenant user (+ any admin landing here) | `ProtectedRoute` (any auth)   | should be `/console/*` API → **ConsoleGuard**    |
| `/console/*` (dashboard, catalog, modifiers, groups, official-prices, dify, tenants, accounts, api-keys) | (a) Operator                               | `ProtectedRoute role="admin"` | **AdminGuard + `@Roles('admin')`** on `/admin/*` |
| `*`                                                                                                      | (d) Public                                 | redirect `/`                  | none                                             |
| (no route)                                                                                               | (c) Developer                              | —                             | `/v1/*` → **ApiKeyGuard** (`ak_...`/`x-api-key`) |

Three backend guards: **AdminGuard+@Roles('admin')** (admin JWT, `/admin/*`); **ConsoleGuard** (user JWT, requires active+tenant*id+account, ignores `role`, `/console/*` API); **ApiKeyGuard** (`ak\*...`hash,`/v1/\*`). Nav groups (`nav-config.ts`): **ops** (dashboard), **catalog** (catalog, dify), **billing** (groups, official-prices, modifiers), **tenants** (tenants, accounts, api-keys). Mobile tabs: dashboard / catalog / tenants / api-keys.

**Sharp edges:** (a) client-side role gating is advisory — JWT decoded not verified; every data path re-guarded server-side, so route gating is cosmetic. (b) ConsoleGuard ignores `role`, so an admin with a tenant can call the tenant plane. (c) `/console` prefix collision (operator frontend vs tenant backend API) must be disambiguated in docs/onboarding.

### 5g. Cross-cutting binding gotchas

- Pagination is **cursor/keyset only** (`{data, next_cursor, has_more}` — no page/total/offset) → build "load more". Two exceptions: `GET /admin/analytics/usage` (raw array) and `GET /console/usage` (`{jobs, ledger}` with separate `jobs_cursor`/`ledger_cursor`).
- All money = decimal strings (µcredits / µUSD-per-1M / amount_minor) → `Money`/BigInt, never `Number()`. `group_ratio_bps` is an integer (bps), a plain number.
- Console DELETE returns **200 `{id, status:'disabled'}`**; admin DELETE returns **204** — handle both.
- Send `Idempotency-Key` only on non-secret admin POSTs marked `@Idempotent`.
- 401 from any call → global `onUnauthorized()` (already wired in `client.ts`).

---

## 6. DESIGN-SYSTEM GAPS — still-missing vs now-covered

The doc named two genuinely-new primitives plus several "reuse existing" composites. Given this session's component-library hardening, the reusable-composite layer is solid; only two pieces remain genuinely missing.

**STILL GENUINELY MISSING (new primitives to build):**

1. **Chart component** (bar/line/area; grouped by day/model/tenant/channel/api_key) — needed by the **Analytics page** (`GET /admin/analytics/usage`) and as a smaller sparkline cousin on the **tenant home + Accounts**. None exists today. Must respect warm-amber palette ("never blue"), reduced-motion, light/dark tokens, `.tabular` numerics; consumes a raw `UsageRollupView[]` array (not an envelope) with decimal-string sums — chart math must avoid naive `Number()` on large strings. Highest-effort new primitive.
2. **Trace / request-detail viewer** (timeline or expandable request↔response pane) — needed by the **Relay-traces page/panel** (`GET /admin/relay-traces`). The genuinely-new piece is the collapsible-headers + pretty-printed **redacted request/response body viewer** (monospace, JSON-pretty), with latency display, stream/truncated flags, status pill. Can compose existing `DataTable` (list) + `Drawer` around it.
3. **Balance / credits widget** for the tenant home — a prominent credit-balance + held-credits card (reuse `Money`) with a self-topup CTA and a compact usage sparkline. `StatCard` (GSAP count-up) is a starting point but the dedicated balance widget + topup CTA is new. (The sparkline is the chart primitive at small size — folds into #1.)

**NOW COVERED — compose existing primitives, no new design-system work:**

- The two P0 billing migrations (Route Groups, Official Prices) are **pure data-source swaps** — `DataTable` (sort/search/selection/column-toggle/sticky-pins/mobile cards) + `CardCollection`/`EntityCard` + the full form kit (`Modal`/`Drawer`/`ConfirmDialog`, `TextField`/`NumberField`/`SelectField`/`ComboboxField`/`ChipsField`/`JsonField`/`KeyValueEditor`, `Toggle`/`Checkbox`, `FormField`+`useFieldId`) + domain composites (`TenantSelect`, `SecretSelect`, `CapabilitiesField`, `IoSchemaField`, `PricebookSpecForm`) all already exist.
- Dify bindings, redemption codes, oauth-sessions → compose `DataTable`/`Drawer`/`ConfirmDialog`/`Tabs`/`Toggle`/`StatusBadge` (all exist; the doc's Dify audit under-credited `Tabs`/`Toggle`).
- `Money` (BigInt µcredit, no float) for ledger/payments/balances; `StatusBadge`+`statusTone()` for ledger types/payment status/dify flags/relay-trace status; `CopyField` (one-time copy) for plaintext secrets; `RoseLoader`/`LoadingScreen`, GSAP tokens + reduced-motion gating, warm-amber tokens — all robust.
- Plus this session's hardening: portal `Floating` primitive + portal tooltips, `--z-*` token scale (Toaster now above modals), stable row-id keys (KeyValueEditor/IoSchemaField/PricebookSpecForm), field-contract helper (`width:100%` + error border), `--min-touch`/`.hit-slop`, Modal close button + background `inert`. The portal/popover pattern and reduced-motion discipline are the reference for any new chart/trace primitive.

The doc's own summary: **"The chart primitive and the trace viewer are the only two genuinely new design-system pieces; everything else is composition of existing primitives."**

---

# Appendix B — Current console shell + reuse inventory (grounding)

# Console shell, navigation & tenant home — current-state grounding

All paths below are under `/Users/alienworm/actionow-web/apps/web/src`.

---

## 1. The console shell structure today

### Composition

`components/console/ConsoleLayout.tsx` is the composition root. On every routed `/console/*` page it renders (in a single flex row, `height: 100dvh`, `gap: var(--s-3)`, `padding: var(--s-4)`):

```
[Rail 64px] [SubNav 200px] [ main: TopBar  +  scrollable <Outlet/> ]
```

- It owns three React contexts via `ConsoleChrome.tsx` — `ConsoleActionContext`, `ConsoleFiltersContext`, `ConsoleBackContext` — so a page can publish a "New …" button, filter selects, and a back target up into the `TopBar`. The publish hooks (`useSetConsoleAction`, `useSetConsoleFilters`, `useSetConsoleBack`) memoize internally to avoid the infinite-loop footgun. `DashboardPage.tsx` already uses `useSetConsoleFilters` to inject a `TenantSelect`.
- It runs a per-pathname GSAP enter tween (fade + slide-up of the routed view), reduced-motion-gated.
- `AppBackground` (glass gradient layer) sits behind everything at `z-index:0`; chrome at `z-index:1`.

### Desktop vs mobile

The split is purely `useMediaQuery(BP.md)`:

- **Desktop:** `<Rail/>` + `<SubNav/>` are rendered; `<BottomTabs/>` is not.
- **Mobile:** Rail and SubNav are dropped entirely; `<BottomTabs/>` (fixed bottom bar) is rendered, and the `main` content gets `paddingBottom: 76` to clear it. The `TopBar` itself absorbs the lang/theme/home/logout cluster on mobile (it renders them only when `!isDesktop`).

### The three chrome pieces

- **`chrome/Rail.tsx`** (64px glass column) — the **nav-group switcher**. Brand-home button at top; in the middle a vertical stack of one `IconButton` per `NAV` group (ops / catalog / billing / tenants) with a sliding active indicator (`RAIL_STEP = 52`); at bottom a lang/theme/logout cluster. Clicking a group navigates to `group.items[0].to` (the group's first leaf).
- **`chrome/SubNav.tsx`** (200px glass column) — the **in-group item list**. It computes `groupForPath(pathname)` and renders that group's `items` as `NavLink`s, with the group label as an uppercase caption header and a sliding highlight (`SUBNAV_STEP = 38`). Single-leaf groups (ops) render a one-item column.
- **`chrome/TopBar.tsx`** — page title + subtitle (from i18n `nav.*` / `subtitles.*` keyed by `activeItem(pathname)`), optional back button, the page's published `filters` + `action` slots, a refresh control (`qc.invalidateQueries`, spins while `useIsFetching`), and the mobile-only chrome cluster.
- **`chrome/BottomTabs.tsx`** — mobile only; iterates a separate **flattened** `MOBILE_TABS` list (dashboard / catalog / tenants / api-keys), not the grouped `NAV`.

### Is it genuinely a "double-layer" nav?

**Yes — on desktop it is two physically separate glass columns:** Rail (group rail, icon-only, 64px) + SubNav (in-group leaves, labelled, 200px). They are driven by the same `nav-config.ts` model: `NAV` is `NavGroup[]`, each group has an `icon` and `items: NavItem[]`. `groupForPath`/`activeItem` resolve the current group/leaf from the pathname.

The double layer earns its keep only because some groups have **multiple leaves**: `catalog` (catalog, dify), `billing` (routeGroups, official-prices, modifiers), `tenants` (tenants, accounts, api-keys). The `ops` group has a single leaf (dashboard), so for that route the 200px SubNav shows exactly one item — wasted column. So today: 4 groups, 9 leaves; the rail+subnav pattern pays off for 3 of the 4 groups.

### What it would take to collapse to a single grouped sidebar

Low effort and self-contained, because the data model already supports it:

- Replace Rail+SubNav with one `~240px` glass sidebar that maps `NAV.map(group => <header>{group.icon + label}</header> + group.items.map(NavLink))` — i.e. a grouped/sectioned list (icon + group label as a non-clickable or collapsible header, leaves indented beneath). The existing `groupForPath` / `activeItem` helpers and the sliding-highlight technique carry straight over (one indicator per visible leaf instead of two indicators in two columns).
- `ConsoleLayout` would render one child instead of two (`{isDesktop && <Sidebar/>}`); the `main`/`TopBar`/`Outlet` block is untouched; `BottomTabs` unchanged.
- The lang/theme/logout cluster currently living at the foot of the Rail moves to the foot of the unified sidebar.

**Is it warranted?** Marginally, and mostly as cleanup rather than a forcing function. Arguments for: removes the dead single-item SubNav on `ops`, reclaims ~24px of horizontal space, and a grouped sidebar is the more conventional admin pattern (easier for the new admin pages — route-groups, accounts — to slot into). Arguments against: the current Rail+SubNav is already hardened, animated, accessible, and ARIA-correct, and the icon rail reads well as an at-a-glance "where am I" affordance. **Recommendation: treat the collapse as optional polish, not a prerequisite.** The higher-value move is item 2/3 below (a tenant `/app` console), and that does not depend on collapsing the operator nav.

---

## 2. Should a tenant `/app` console reuse `ConsoleLayout`?

**Recommendation: do NOT reuse `ConsoleLayout` directly for the tenant console. Extract a shared shell, then give the tenant its own thin nav config.**

Why not reuse as-is:

- `ConsoleLayout` does not own the nav model — it delegates to `nav-config.ts`'s module-level `NAV`/`MOBILE_TABS` constants. The Rail, SubNav, and BottomTabs all import those constants directly. Those groups (`catalog` / `billing` / `tenants` / `ops`) are **operator-only** and don't map to a tenant audience at all (a tenant manages its own keys, usage, billing/credits — not the global catalog or the tenant roster).
- The Rail/SubNav/TopBar are otherwise audience-agnostic: they are pure functions of a nav model + the context slots. The chrome itself is fully reusable; only the data feeding it is operator-specific.

The clean refactor (small): the chrome components (`Rail`, `SubNav`, `TopBar`, `BottomTabs`) currently `import { NAV, groupForPath, ... } from '../nav-config'`. Parameterize that — pass the nav model in (via a prop on `ConsoleLayout` or a `NavConfigContext`), so `ConsoleLayout` becomes audience-neutral and you mount it twice:

- `/console` → `<ConsoleLayout nav={OPERATOR_NAV}/>` guarded by `role="admin"`.
- `/app` → `<ConsoleLayout nav={TENANT_NAV}/>` guarded by any authed user.

This keeps the hardened chrome (animations, a11y, the action/filter/back slots, mobile BottomTabs, focus management) and avoids forking a second shell. The tenant nav would be a short list (e.g. overview, API keys, usage, billing/credits, settings) — likely 1–2 groups, which incidentally is the case where collapsing to a single sidebar (item 1) reads best.

---

## 3. Current `UserHome` (`/app`)

**It is a pure stub — a "coming soon" placeholder, not a console.** `features/app/UserHome.tsx` renders an `AppBackground`, a `Logo` (top-left), a `LanguageSwitch` + `ThemeToggle` (top-right), and a single centered glass card containing `t('app.soon')` as a heading, `t('app.hint')` as body copy, and two buttons: "back home" (`href="/"`) and a logout CTA. There is no data, no nav, no `ConsoleLayout`, no use of the chrome contexts. Building the real tenant console means replacing this file wholesale (or wrapping it in the shared shell from item 2).

---

## 4. Routing + auth: how audiences are gated

### Route map (`routes.tsx`)

- Public, ungated: `/` (`LandingPage`), `/login` (`AuthPage`).
- `<ProtectedRoute/>` (no role) wraps `/app` → `UserHome` — **any authenticated user**.
- `<ProtectedRoute role="admin"/>` wraps `/console` → `ConsoleLayout` + all the operator leaf pages (dashboard, catalog, modifiers, groups, official-prices, dify, tenants, accounts, api-keys), plus legacy `resources`/`models` redirects into the unified catalog route.
- `*` → redirect to `/`.

### The gate (`lib/auth/ProtectedRoute.tsx`)

A 12-line guard:

- No `user` → `<Navigate to="/login" replace/>`.
- `role` given and `user.role !== role` → `<Navigate to="/app" replace/>` (a non-admin who hits `/console` is bounced to the tenant home — `/app` is the safe fallback for everyone).
- Else → `<Outlet/>`.

### Auth state (`lib/auth/AuthProvider.tsx`)

JWT in `localStorage` (`actionow.token`); `AuthUser = { id, role }` decoded from the token. `isAuthed = token !== null`. Expiry is checked on load and on window focus (`isExpired`), and the client clears the token on any 401 (`onUnauthorized`). `role` is a free-form `string` (currently `'admin'` vs everything-else).

### Login redirect by role (`features/auth/AuthPage.tsx`)

After a successful login/register: `navigate(user.role === 'admin' ? '/console/dashboard' : '/app')`. So the audience fork is already wired at exactly one decision point.

### The public-vs-authed split a nav refactor builds on

The split is clean and already three-way:

1. **Public chrome** — `LandingPage` and `AuthPage` are self-contained, each with their own `AppBackground` + top-right `LanguageSwitch`/`ThemeToggle` (no Rail/SubNav). They are NOT inside any shell.
2. **Authed-operator chrome** — `/console/*` inside `ConsoleLayout` (`role="admin"`).
3. **Authed-tenant chrome** — `/app`, currently the stub, no shell.

A "nav separation" refactor doesn't need to invent the public/authed boundary — it already exists structurally (public pages own their own minimal nav; authed pages are meant to live in a shell). The work is: (a) decide whether public pages keep their bespoke top-bar or share a `PublicNav`, and (b) give the tenant `/app` audience a real shell (item 2). The role-based redirect and `ProtectedRoute` give you the audience signal for free.

---

## 5. Reuse inventory — hardened building blocks

These are recently hardened (most timestamped 2026-06-18) and ready to assemble a tenant console and the new admin pages. Locations: `components/ui/*`, `components/data/*`, `components/console/*`.

### Layout / shell

- `console/ConsoleLayout.tsx` + `console/ConsoleChrome.tsx` (action/filter/back slot contexts) — reusable once nav model is parameterized (item 2).
- `console/chrome/{Rail,SubNav,TopBar,BottomTabs}.tsx` — reusable; coupled to `nav-config` constants today.
- `console/StatCard.tsx` — count-up animated metric tile (`{ label, value }`); used on the dashboard.
- `ui/SectionHeader.tsx` — section title row.

### Data display

- **`data/DataTable.tsx`** (29 KB, the workhorse) — typed `Column<T>` with sortable/hideable/sticky columns, client search (`searchable` + `filterKeys`), client pagination (`pageSize`), row selection, `rowActions`, `onRowClick` + `selectedKey` for master-detail, loading/empty states, `rowKey`. Backed by a tested `tableState.ts` reducer set.
- **`data/EntityCard.tsx`** — the card-as-row unit: gradient glyph/custom glyph, title, badge, chip row, definition-style `meta` grid, trailing actions, clickable/selectable with correct ARIA (won't become a button when it has interactive actions).
- **`data/CardCollection.tsx`** — responsive grid or vertical-list wrapper around cards with shared loading (`RoseLoader`) + empty states and stagger-reveal.
- **`data/Money.tsx`** — micro-credits → localized currency via `formatCredits`.
- **`data/StatusBadge.tsx`** — `statusTone(status)` maps backend enums → tone; `StatusBadge` renders a pill from a pre-resolved tone + translated label.
- **`data/CopyField.tsx`** — read-only value + guarded clipboard copy with `aria-live` (built for freshly-minted API keys → directly relevant to a tenant keys page).
- Domain-specific data widgets also present: `ProviderIcon`, `MockBadge`, `SecretSelect`, `TenantSelect`, `CapabilitiesField`, `IoSchemaField`, `PricebookSpecForm`.

### Overlays / floating

- **`ui/Floating.tsx`** — the shared portaled, anchored, flip+clamp, reposition-on-scroll primitive (the escape hatch from overflow clipping). Underpins Tooltip/Select/Combobox.
- **`ui/Modal.tsx`** — `{ open, title, onClose, children, footer }`, focus-trap, deferred-unmount exit animation, scrim + Escape/backdrop close.
- **`ui/Drawer.tsx`** — right-slide panel (`width` configurable), same lifecycle as Modal, built for long forms.
- **`ui/ConfirmDialog.tsx`**, **`ui/Tooltip.tsx`**, **`ui/Toaster.tsx`** + `toast()`.

### Inputs / form set

- `ui/Tabs.tsx` (ARIA tablist, arrow-key roving, animated underline) and `ui/SegmentedControl.tsx` (radiogroup pills, sliding indicator) — both present and tested.
- Field set: `TextField`, `NumberField`, `SelectField` (+ low-level `Select`), `ComboboxField`, `Checkbox`, `Toggle`, `ChipsField`, `KeyValueEditor`, `JsonField`, `FormField` wrapper, plus shared `fieldStyles.ts` / `kvRows.ts` helpers.
- Buttons: `Button` (cta/ghost/link/lg variants, `loading`, `href`), `IconButton` (tooltip, active/current, sizes), `RowAction`.
- `ui/RoseLoader.tsx`, `ui/LoadingScreen.tsx`.

### What's MISSING for the roadmap

- **No chart / sparkline / time-series primitive exists, and no charting dependency is installed.** `apps/web/package.json` has no recharts / visx / d3 / nivo / victory — only GSAP, Phosphor, react-query, react-router, i18next. The "chart" / "spark" filename hits are unrelated (landing-page logo/feature panels, a `spark.svg` provider logo). A tenant console (usage-over-time, credit burn-down) and a richer operator dashboard will both want a usage/spend chart, and there is no building block for it today. Options: add a small SVG line/bar primitive (consistent with the from-scratch, token-driven, GSAP-animated house style — matches how `StatCard` count-up and the sliding indicators are hand-rolled) or pull in a light dep. **This is the one clear gap to flag.**
- Minor: the dashboard today shows only two `StatCard`s (tenants, resources) + a recent-jobs card list; there is no trend/area visualization, reinforcing the chart gap.
- Minor: no generic "empty/onboarding" full-page state component beyond inline empty strings — a tenant console's first-run state may want one, but it's easily composed from existing glass + `Button`.

---

# Appendix C — ZenMux features → frontend deliverable map

# ZenMux Borrowable Features — Frontend Mapping (grounded against `apps/api/src` + `actionow-web`)

Backend cross-checks performed (cheap, as scoped):

- `GET /admin/analytics/usage` — EXISTS (`apps/api/src/admin/admin.controller.ts:1122`); schema supports `groupBy: day|model|tenant|channel|api_key` + optional `tenantId`/`from`/`to` (`admin/dto/admin.dto.ts:371`). Already wired in the FE client as `analyticsUsage()` (`actionow-web/.../lib/api/admin.ts:128`).
- `GET /admin/relay-traces` — EXISTS (`admin.controller.ts:1098`), filter by job/tenant/provider/channel + date range, paginated. NOT yet in the FE client (`admin.ts` has no `relayTraces` method). Gated by `RELAY_TRACE` env (defaults `'off'` — `packages/infra/src/config.ts:119`).
- `usage_log` write path: both callers hardcode `status: 'succeeded'` and omit `latencyMs` (`packages/engine/src/execution-service.ts:745`, `packages/engine/src/stream.ts:430`). So latency/error MUST come from relay_trace, confirming the BUCKET-A caveat and the #3 blocker.
- `/console/*` controller (`apps/api/src/console/console.controller.ts`): current routes are `POST/GET/POST(rotate)/DELETE api-keys`, `GET usage` (jobs+ledger combined envelope), `GET models`, `POST payments/intents`. The 5 proposed thin endpoints (`balance`/`analytics/usage`/`usage-log`/`payments[+:id]`/`me`+`settings`) are NOT present — confirms #1 is PARTIAL.
- `listUsageLogsByTenant` exists in db repos (`packages/db/.../usage.ts`) with ZERO production callers (only test refs) — confirms the BUCKET-B "wire the route" claim.
- Frontend reality: `/app` = `features/app/UserHome.tsx` is a literal "coming soon" glass card (no console shell). `ModelView` already carries `input_price`/`output_price`; `OfficialPriceView` carries `input_price_per_1m`/`output_price_per_1m`/`cached_input_price_per_1m` (the 3 modeled dims). `ConsoleLayout.tsx` renders a double-layer `Rail` + `SubNav`.

---

## Feature 1 — Tenant `/app` self-service console

**Frontend work.** Replace the `UserHome.tsx` placeholder with a real console shell. Build a `features/app/` tree (new): `AppLayout` (reuse/fork `ConsoleLayout` + chrome) and pages `OverviewPage`, `ApiKeysPage`, `UsagePage`, `BillingPage`, `SettingsPage`. New routes nested under `/app/*` in `routes.tsx` (currently a single `/app` leaf). New API client module `lib/api/consoleApi.ts` + `useConsoleApi` hook (parallel to `useAdminApi`) hitting `/console/*` with the user JWT.
**Blocked/unblocked.** PARTIAL. Buildable TODAY against existing `/console` routes: API Keys (full CRUD + rotate exists), Models list (`GET /console/models`), top-up initiate (`POST /console/payments/intents`), and the raw activity stream (`GET /console/usage` → jobs+ledger). BACKEND-BLOCKED sub-pages: a clean balance card, usage-aggregation charts, top-up history/status, and profile/settings — these need the 5 BUCKET-B thin endpoints (`GET /console/balance`, `GET /console/analytics/usage`, `GET /console/usage-log`, `GET /console/payments[/:id]`, `GET /console/me` + `PATCH /console/settings`). Dependency is small (repo fns already exist; just lock `ctx.tenantId` into routes).
**Smallest first slice.** Stand up `/app/api-keys` + `/app` overview inside a minimal `AppLayout`, wired entirely to the already-shipped `/console/api-keys` and `/console/usage` routes — proves the shell + user-JWT client end-to-end with zero backend.

## Feature 2 — Models card info density (price + IO)

**Frontend work.** Rework `components/data/EntityCard.tsx` consumers (or add a dedicated `ModelCard`) to surface input/output price + modality/IO in the `meta`/`chips` slots. `ModelsPage.tsx` is currently a `DataTable` (already shows `input_price`/`output_price` /tok at cols 163–187); the card variant is for the tenant `/app` models list and/or a denser catalog card view. Add a `Money`-style µcredit formatter (divide by 1e6) — the `Money.tsx` component already exists to reuse.
**Blocked/unblocked.** Price part UNBLOCKED-NOW: `ModelView.input_price`/`output_price` already in the type and payload; `OfficialPriceView` adds input/output/cached-input per-1M. The availability-bar half is feature #3 (BLOCKED). The "by token type" split (cache-write, reasoning, image, etc.) is BACKEND-BLOCKED (only 3 price dims + input/output token columns modeled — see #4).
**Smallest first slice.** Add input/output price + modality to the model card `meta` grid using existing `ModelView` fields and the µcredit divide-by-1e6 formatter — no new endpoint.

## Feature 3 — Availability tick-bar / channel health

**Frontend work.** A channel-health panel (new `features/console/ChannelHealthPage.tsx` or a card on the channel/catalog detail pane) rendering an availability tick-bar + latency-percentile and throughput (tokens/s) line charts. Needs a charting primitive the repo doesn't have yet (`components/data/` has tables/badges/cards, no timeseries chart) — so a chart component is part of this work whenever it unblocks.
**Blocked/unblocked.** BACKEND-BLOCKED (biggest). Exact dependency: per-call latency + success is never stored per channel (`usage_log` write path drops `latencyMs` and hardcodes `status:'succeeded'` at `engine/execution-service.ts:745` + `engine/stream.ts:430`; failed relays never enter `usage_log`); `channel_health` is a single overwritten cooldown row with no history. Requires: (1) capture per-call latency+status, (2) timeseries storage/retention, (3) aggregate endpoints (latency percentiles / throughput / availability% / bucketed history). All of the tick-bar + line charts wait on this.
**Smallest first slice.** None shippable as real data. Interim only: a static/placeholder health card driven by the existing single `channel_health` cooldown row (up/down + last-checked), explicitly labeled non-historical, so the layout exists when the timeseries backend lands.

## Feature 4 — Multi-dim price read-only display

**Frontend work.** A read-only price matrix (per model × dimension) — likely a new tab/section in the catalog or a `PriceMatrix` card. Short-term it's a client-side join across the dimensions already exposed: `models` (resale input/output) + `official-prices` (input/output/cached-input per-1M). Reuse `Money.tsx` + the µcredit/per-1M formatting already in `OfficialPricesPage.tsx`.
**Blocked/unblocked.** PARTIAL. UNBLOCKED-NOW for the 3 modeled dims (input / output / cached-read) via a client-side multi-call join — confirmed both `ModelView` and `OfficialPriceView` carry these fields. BACKEND-BLOCKED for the other 7 dims (cache-write, 5min/1hr TTL, web-search, image in/out, reasoning, video): they need new price columns + migration + settle-path + an aggregate price-matrix endpoint. There is no server-side price-matrix endpoint, so even the 3-dim version is a frontend join, not one call.
**Smallest first slice.** A read-only 3-column price table (input / output / cached-input per-1M) built from a `models` + `official-prices` client-side join, with the 7 unmodeled dims shown as greyed "—" placeholders.

## Feature 5 — Credit bucket ledger

**Frontend work.** Today: one total-balance card + a flat ledger list (the `/console/usage` ledger envelope already exists; render it as a `DataTable` or card list in the tenant `/app` billing page). Later: a bucketed-balance breakdown (grants / topup / referral / expiring lots) + expiry badges.
**Blocked/unblocked.** PARTIAL. UNBLOCKED-NOW: total-balance card + flat ledger from existing `/console/usage` (ledger side) — though a dedicated `GET /console/balance` (BUCKET-B) makes the balance card clean. BACKEND-BLOCKED: the bucket breakdown. Exact dependency — `ledger_txn` only writes topup/settle and has NO source/bucket column (can't distinguish topup vs redemption-code), account balance is a single scalar; needs ledger source/bucket columns (migration) + grant endpoints (reward/compensation/referral) + lot-based credit expiry + a reaper + a bucket-aggregation endpoint.
**Smallest first slice.** A single total-balance card + flat paginated ledger list on the `/app` billing page, sourced from the existing ledger envelope — no bucket semantics.

## Feature 6 — Ranking bar leaderboard (admin)

**Frontend work.** A "top models by usage" ranking-bar card on the admin `DashboardPage.tsx` (currently only has `StatCard` tiles for tenants/resources counts — no usage analytics rendered yet). Call the already-wired `api.analyticsUsage({ groupBy: 'model' })`, sort tokens/cost descending client-side, slice top-N, render horizontal bars. Reuse `StatCard`/glass styles; a tiny `RankingBar` presentational component.
**Blocked/unblocked.** UNBLOCKED-NOW (admin). Zero backend, zero new client method — `GET /admin/analytics/usage?groupBy=model` returns per-model tokens+cost and `analyticsUsage()` already exists in `lib/api/admin.ts:128`. No server-side ranking, but the data is complete for client-side sort. (Optional ranked endpoint is a nice-to-have, not a blocker.)
**Smallest first slice.** Drop a `groupBy=model` query into `DashboardPage`, sort desc by cost, render top-10 as bars — done in one page edit.

## Feature 7 — Public / console nav separation

**Frontend work.** Pure route/nav refactor in `actionow-web`. (a) Split the marketing nav (`features/landing/LandingPage.tsx`) from the authenticated "avatar → console sidebar" pattern — they should not share a nav surface. (b) Assess collapsing `ConsoleLayout.tsx`'s double-layer `Rail` + `SubNav` (both rendered on desktop at lines 48–49, driven by `nav-config.ts` groups→items) into a single grouped sidebar. The audience boundary is already enforced server-side via `ProtectedRoute role="admin"` (`routes.tsx:38`) mapping to `AdminGuard`/`ConsoleGuard`/`ApiKeyGuard`/public.
**Blocked/unblocked.** PURE FRONTEND, UNBLOCKED-NOW. No backend dependency — guard-level audience separation already exists; this is presentation only.
**Smallest first slice.** Extract a `<PublicNav>` for landing and an authed `<AppNav>`/avatar-menu, ensuring the two never co-render; defer the Rail+SubNav→single-sidebar collapse to a follow-up.

---

## Frontend-relevant items the split implies

- New `lib/api/consoleApi.ts` + `useConsoleApi` hook (user-JWT client for `/console/*`), mirroring the existing `useAdminApi` — prerequisite for the entire `/app` console (#1, #2-card, #4-tenant, #5).
- New `features/app/AppLayout` + nested `/app/*` routes in `routes.tsx` — `UserHome.tsx` is a pure placeholder today and must be replaced.
- A reusable `RankingBar` (bars) — needed by #6 now; a timeseries `Chart` primitive — needed by #3 later (neither exists in `components/data/`).
- A `relayTraces` method on `lib/api/admin.ts` (route exists, client method missing) + handling for the `RELAY_TRACE='off'` default — for the admin logs page.
- A model card price/IO upgrade to `EntityCard` consumers or a new `ModelCard`, with a µcredit/1e6 formatter (reuse `Money.tsx`) — #2 + #4.
- Decide Rail+SubNav vs single grouped sidebar in `ConsoleLayout.tsx`/`nav-config.ts` — #7.
- Recommended FE build order (matches the audit): (1) A-bucket now — #6 ranking, #7 nav, #2 price-half, admin logs page; (2) after the 5 thin `/console` endpoints land — full `/app` console (#1) + flat balance/ledger (#5) + 3-dim price table (#4); (3) gated on C-bucket backend — channel-health charts (#3), credit buckets (#5), token-type/extra price dims (#2/#4)."
