# Actionow Web — Frontend Development Plan

> Backend merged to `main` + deployed (track-4/5 economics + auth hardening live). TDD-first, gate-green per PR. Grounded against the live tree. Generated 2026-06-18.

> Companion: [frontend-roadmap.md](./frontend-roadmap.md) · [frontend-impact-backend-hardening] (impact assessment) · [component-audit.md](./component-audit.md).

---

# Frontend Development Plan — `apps/web` (Backend live on `main`, deployed)

**Audience:** the engineer starting the `apps/web` console work now.
**Status check (verified against the live tree):** `client.ts` has **no `put`**; `TextField` has **no `minLength`/`maxLength`**; `RankingBar`, `consoleApi.ts`, and `AuthPage.test.tsx` **do not exist yet**; `mockBilling.ts` still backs **both** `RouteGroupsPage` and `OfficialPricesPage`; `money.ts` exports `formatCredits` but **not** `compareMicroDesc`/`formatCreditsSigned`; `qk` already has `resources/channels/apiKeys/models/model/modelGrants/analyticsUsage` but **not** `routeGroups`/`routeGroupChannels`/`officialPrices`. Everything below is grounded in that reality.

---

## 1. SHARED INFRA FIRST — thin prep PR (`PR-0`)

Do this **once, first**, as a single small PR. It is pure plumbing (no page behavior change), so it unblocks every Sprint-1 ticket and keeps the de-mock PRs focused. Each item ships with its own failing test.

### 1a. `lib/api/client.ts` — add `put`

- Add `put<T>(path, body?)` mirroring `patch` but `method: 'PUT'`, **no Idempotency-Key option** (the PUT verb is the idempotency).
- **First failing test** (`client.test.ts`): `client.put('/x', {a:1})` sends `method: 'PUT'`, JSON body, `content-type: application/json`, and **no** `Idempotency-Key` header.
- _Why first:_ `admin.addGroupChannel` won't compile without it.

### 1b. `lib/api/queryKeys.ts` — consolidate the new keys (add **once**, no duplication)

- `routeGroups: () => ['admin','route-groups'] as const`
- `routeGroupChannels: (id: string) => ['admin','route-groups', id, 'channels'] as const`
- `officialPrices: (params?: Record<string,unknown>) => ['admin','official-prices', params] as const`
- Reuse existing `resources()`, `channels(resourceId)`, `apiKeys(tenantId)`, `analyticsUsage(params)`.
- **Test** (`queryKeys.test.ts`): exact-shape assertions for the three new keys.
- _Note:_ the **API-Keys** ticket also wants `qk.routeGroups`; it lands here so API-Keys consumes it, never re-adds it.

### 1c. `lib/api/types.ts` — add all new wire types in one diff

Consolidated so the de-mock PRs only _import_, never define:

- **Route Groups:** `RouteGroupView` (`group_ratio_bps: number` — int bps, **not** µ-money; `status: string`; `description: string|null`; `created_at/updated_at`), `RouteGroupChannelView`, `CreateRouteGroupBody`, `UpdateRouteGroupBody` (`description: string|null` clears), `AddGroupChannelBody`.
- **Official Prices:** `OfficialPriceView` (µUSD **decimal strings** `input_price_per_1m`/`output_price_per_1m`; nullable `display_name`/`cached_input_price_per_1m`/`source_url`/`effective_at`/`notes`/`updated_by`; `effective_at` is **full ISO**), `CreateOfficialPriceBody` (camelCase **human USD/1M**, `inputUsdPer1m`/`outputUsdPer1m` required `>0`), `UpdateOfficialPriceBody` (no `provider`/`modelSlug`; nullable-clearable fields).
- **API Keys:** `ApiKeyView` gains `route_group_id: string|null`; `CreateApiKeyBody` gains `routeGroupId?: string`; new `UpdateApiKeyGroupBody { routeGroupId: string|null }` (required, nullable).
- **Catalog economics:** `ChannelView` gains `input_cost_per_1m: string|null` + `output_cost_per_1m: string|null`; `CreateChannelBody` gains `inputCostUsdPer1m?: number` + `outputCostUsdPer1m?: number`; `UpdateChannelBody` gains `inputCostUsdPer1m?: number|null` + `outputCostUsdPer1m?: number|null`.
- **Ranking:** `UsageRollupView` gains `provider_cost: string` + `margin: string` (µUSD sums; `margin` can be negative).
- **Do NOT** delete the mock `RouteGroup`/`RouteGroupChannel`/`OfficialModelPrice` types yet — they die inside the de-mock tickets once the pages stop importing them.

### 1d. `lib/money.ts` — money helpers the ranking board needs

- `compareMicroDesc(a, b): number` — `BigInt(a)` vs `BigInt(b)`, returns `-1/0/1` for **descending** sort.
- `formatCreditsSigned(micro, locale?, maxFrac?)` — always prefix `+` for positive, keep `-` for negative, `0` unsigned; reuse `formatCredits` internals, **never** `Number()` on money.
- **First failing test** (`money.test.ts`): `['1000000','3000000','2000000'].sort(compareMicroDesc) === ['3000000','2000000','1000000']`; a pair `> Number.MAX_SAFE_INTEGER` still orders correctly; `formatCreditsSigned('2500000')==='+2.5'`, `'-2500000'→'-2.5'`, `'0'→'0'`.

### 1e. `components/console/RankingBar.tsx` — the one tiny primitive this batch funds

- New **presentational** component (NOT the chart primitive). Props `rows: UsageRollupView[]`, `topN = 5`, `showMargin = true`. Sorts a copy desc by `cost` via `compareMicroDesc`, slices `topN`, computes max-cost as `BigInt` for the CSS width %, renders one labeled horizontal bar per model (`<Money micro={cost}/>`), optional signed-margin cell via `formatCreditsSigned` with `--ok`/`--fail` tone. **The only place `Number()` is allowed is the CSS percentage**, after BigInt math, guarded against divide-by-zero.
- **First failing test** (`RankingBar.test.tsx`): 6 unsorted rows + `topN=3` → exactly 3 bars, highest-cost bucket first in DOM order.

### 1f. `components/ui/TextField.tsx` — additive `minLength?`/`maxLength?` (funded here, used by AuthPage)

- Thread two **named** props to the underlying `<input>` (no `{...rest}` spread — the field-contract forbids it).
- **First failing test** (`TextField` test): `<TextField type="password" minLength={8} maxLength={256}/>` → input `toHaveAttribute('minLength','8')` / `maxLength '256'`.

> **Explicitly deferred to later sprints (do NOT build in PR-0):** the full **chart primitive** (analytics page, Sprint 2), the **trace-viewer primitive** (relay-traces, Sprint 2), and **`lib/api/consoleApi.ts`** (tenant `/app` screens, Sprint 2). PR-0 only ships the data layer + `RankingBar` + the two `TextField` props.

**PR-0 acceptance:** `client.put` exists + tested; the three `qk.*` added + tested; all new types compile; `compareMicroDesc`/`formatCreditsSigned` + tests green; `RankingBar` renders + sorts; `TextField` forwards length props. `typecheck + lint + test + build` all green. No page imports change in this PR.

---

## 2. SPRINT 1 — UNBLOCKED NOW (backend live on `main`)

### Recommended order & parallelism

```
PR-0 (shared infra) ───────────────────────────► merge first, everyone rebases on it
       │
       ├── LANE A (de-mock pair, sequential within lane):
       │     S1-RouteGroups  ──►  S1-OfficialPrices   (both edit types.ts/mockBilling; serialize to avoid churn)
       │
       ├── LANE B (independent, parallel with A):
       │     S1-AuthAdapt     (only touches AuthPage + TextField + i18n)
       │     S1-CatalogEcon   (ChannelEditor/ResourceDetailPane/ModelsPage)
       │     S1-RankingBoard  (DashboardPage + RankingBar already in PR-0)
       │
       └── S1-ApiKeys  ──► depends on S1-RouteGroups' listRouteGroups + qk.routeGroups
             (the *revoke* half + type additions can start immediately;
              the *bind picker* half waits on RouteGroups landing)
```

- **Start day 1 in parallel:** RouteGroups (Lane A head), AuthAdapt, CatalogEcon, RankingBoard.
- **OfficialPrices** starts as soon as RouteGroups merges (shared `mockBilling.ts`/`types.ts` edits — serialize to avoid conflicts).
- **ApiKeys** revoke + types can land anytime; its group picker is gated on RouteGroups' `listRouteGroups`.

---

### S1-RouteGroups — De-mock Route Groups (P0 #1) · effort **M**

- **Goal:** swap `RouteGroupsPage.tsx` off `mockBilling` onto live `/admin/route-groups` (CRUD + idempotent PUT membership upsert + real channel roster); remove the `<MockBadge/>` from this page only.
- **Key files:** `lib/api/admin.ts` (+8 methods), `RouteGroupsPage.tsx` (rewrite to `useAdminApi`+`qk.*`), `i18n` (`groups.tip.ratioLive`). (`client.put`/types/`qk` already in PR-0.)
- **Endpoints:** `GET/POST/GET:id/PATCH:id/DELETE:id /admin/route-groups`; `GET/PUT/DELETE /admin/route-groups/:id/channels[/:channelId]`; roster from `GET /admin/resources` + `GET /admin/resources/:id/channels`.
- **First failing test** (`admin.test.ts`): `addGroupChannel(id,chId,{priority,weight})` issues **`PUT`** `/admin/route-groups/:id/channels/:channelId` with body `{priority,weight}` and **no Idempotency-Key** (regression guard).
- **Acceptance:** no `mockBilling` import in the page; create carries Idempotency-Key, PATCH/PUT/DELETE do not; the single PUT upsert replaces the mock add+update split; PUT defaults `priority=0,weight=1` (not 100/100); channel-count column derives from the **cached `qk.routeGroupChannels(id)`** length (per-row `useQuery`, not a sync `countGroupChannels`); `group_ratio_bps` read/written as int bps (`10000=×1.00`, never the µ-money path); ratio tooltip notes it drives real customer pricing; tsc+lint+tests clean.
- **Depends on:** PR-0.

### S1-OfficialPrices — De-mock Official Prices (P0 #2) · effort **M**

- **Goal:** wire `OfficialPricesPage.tsx` to `/admin/official-prices` — **write** human USD/1M (camelCase), **read** µUSD decimal strings (snake_case), consume the cursor envelope, drop the page's client-side µUSD math + `<MockBadge/>`.
- **Key files:** `admin.ts` (+5 methods), `OfficialPricesPage.tsx`, `mockBilling.ts` (delete **only** the official-price exports — keep route-group exports), `admin.test.ts`.
- **Endpoints:** `GET/POST/GET:id/PATCH:id/DELETE:id /admin/official-prices`.
- **First failing test** (`admin.test.ts`): `createOfficialPrice` POSTs to `/admin/official-prices` with an Idempotency-Key and a **camelCase USD** body (`inputUsdPer1m` present) — proving **no client-side µUSD pre-multiplication**.
- **Acceptance:** table renders `$X.XX/1M` via `Number(s)/1e6` on the **string** field (display only, never the write path); create blocks `≤0` for input/output (`.positive()`); `effectiveAt` sent as full ISO (`yyyy-mm-dd`→`T00:00:00Z`); PATCH never sends `provider`/`modelSlug` and uses `null` to clear nullable fields; `qk.officialPrices()` invalidated on mutate; RouteGroupsPage still compiles.
- **Depends on:** PR-0; merge **after** S1-RouteGroups (shared `mockBilling.ts`/`types.ts`).

### S1-AuthAdapt — Password-policy + login-throttle adapts · effort **S**

- **Goal:** enforce/hint the 8–256 register-password policy, surface the backend `400 invalid_input` message (stop swallowing it), and on login `429` read `ApiError.retryAfterMs` to show a live "try again in Ns" cooldown that disables submit.
- **Key files:** `TextField.tsx` (length props from PR-0), `AuthPage.tsx`, `i18n` (`auth.passwordPolicy`, `auth.retryInSeconds`, `errors.tooManyAttemptsRetry`), **new** `AuthPage.test.tsx`. **No client/`errors.ts` change** — `retryAfterMs`/`message` already parsed.
- **Endpoints:** `POST /auth/register` (400 `invalid_input`), `POST /auth/login` (429 `rate_limited` + `retry_after_ms`).
- **First failing test** (`AuthPage.test.tsx`, RED 5): fake timers; mock `login()` to reject `new ApiError('rate_limited','...',429,true,3000)` → toast contains `3`, submit button disabled, label shows `t('auth.retryInSeconds',{seconds:3})`.
- **Acceptance:** register field has `minLength=8`/`maxLength=256` + visible hint; **login field has neither** (server doesn't length-check login); `invalid_input` surfaces `err.message` not the generic string; cooldown ticks down each second and re-enables on elapse with the interval cleared on unmount (no `act()` leak); both `en` + `zh-CN` keys present.
- **Depends on:** **NONE** — start day 1 (only the additive `TextField` props from PR-0).

### S1-CatalogEcon — Models price/IO + Channel cost/margin · effort **M**

- **Goal:** make catalog economics visible/editable — render model resale prices via `Money` (BigInt-safe sort) with modality, and wire the live Track-5 channel **operator-cost** fields (µUSD/1M) into `ChannelView` display + `ChannelEditor` create/update.
- **Key files:** `ChannelEditor.tsx` (two USD/1M `NumberField`s, tri-state PATCH: omit=unchanged / `null`=clear / number=set), `ResourceDetailPane.tsx` (two read-only cost cols, `÷1e6` `usdLabel`, `—` on null), `ModelsPage.tsx` (price cols → `Money`/`formatCredits`, BigInt-safe `sortValue`), `i18n`. (Type additions in PR-0; `createChannel`/`updateChannel` pass bodies through unchanged — no new admin methods.)
- **Endpoints:** existing `GET/POST/PATCH /admin/resources/:id/channels`, `GET /admin/models`.
- **First failing test** (`ChannelEditor.test`): channel with `input_cost_per_1m='500000'` seeds the input field as `0.5` (`÷1e6`); `null`→empty.
- **Acceptance:** model price cols never use naive `Number()` and sort BigInt-safe; channel costs round-trip (edit→reopen persists, clear→reopen shows unset); **channel cost ≠ customer price** — label "operator cost"; `Money` used for models (credits) but a `usdLabel` formatter for channels (USD) — the central unit hazard.
- **Depends on:** PR-0 (one-edit-win, independent of Lane A).

### S1-RankingBoard — Dashboard analytics ranking board · effort **M**

- **Goal:** add a "Top models by cost" board to `DashboardPage` fed by `GET /admin/analytics/usage?groupBy=model`, surfacing live Track-5 `provider_cost`/`margin`.
- **Key files:** `DashboardPage.tsx` (`useQuery` `analyticsUsage({groupBy:'model'})`, `STALE_VOLATILE`, render `<RankingBar/>` + section header + loading/empty), `i18n` (`dashboard.ranking.*`). (`RankingBar`, `UsageRollupView` fields, `compareMicroDesc`/`formatCreditsSigned` all in PR-0.)
- **Endpoint:** `GET /admin/analytics/usage?groupBy=model` — **raw array**, no envelope; read `usage.data ?? []`, never `.rows`.
- **First failing test** (`DashboardPage.test.tsx`): mock `analyticsUsage` → 3-row array incl. a negative margin; assert section header renders, top model first, signed negative margin shown.
- **Acceptance:** rows sorted desc by `cost` via BigInt (test with value `> MAX_SAFE_INTEGER`); only top-N render; margin signed with fail-tone for negatives; divide-by-zero guarded; raw-array (no envelope) consumed.
- **Depends on:** PR-0 (independent one-edit-win).

### S1-ApiKeys — Group-bind + revoke (P0 #3) · effort **M**

- **Goal:** bind/rebind an API key to a route group (a pricing decision via the group ratio) and revoke a key, wiring `PATCH /admin/api-keys/:id/group`, `DELETE /admin/api-keys/:id`, and bind-on-create `routeGroupId`.
- **Key files:** `admin.ts` (`bindApiKeyGroup`, `revokeApiKey`), `ApiKeysPage.tsx` (create-modal group `SelectField`, per-card group chip, Bind dialog + Revoke `ConfirmDialog`, `useQuery(qk.routeGroups, listRouteGroups)`), `i18n`. (Types in PR-0; **consume** RouteGroups' `listRouteGroups`/`qk.routeGroups` — do not re-add.)
- **Endpoints:** `PATCH /admin/api-keys/:id/group` (body `{routeGroupId: uuid|null}`, explicit `null` unbinds), `DELETE /admin/api-keys/:id` (204), `POST /admin/api-keys` (optional `routeGroupId`, **not** `@Idempotent`), `GET /admin/route-groups`.
- **First failing test** (`admin.test.ts`): `bindApiKeyGroup('k1',{routeGroupId:null})` PATCHes `/admin/api-keys/k1/group` with explicit `null` in the JSON body (not omitted); `revokeApiKey('k1')` DELETEs and resolves void on 204.
- **Acceptance:** create picker labels each group `name ×N.NN`; card shows bound group or `default ×1.00` on null; bind dialog shows the **pricing-impact hint** (the bound ratio is the customer price); `— default —` sends explicit `null`; revoke confirms → DELETE → list refreshes; `routeGroupId` **omitted** (not null) on create when none chosen; `group_ratio_bps` via `bps/10000`, never money path.
- **Depends on:** **S1-RouteGroups** for the bind picker (`listRouteGroups`, `RouteGroupView`, `qk.routeGroups`). The **revoke** action + type additions can ship independently before RouteGroups lands.

---

## 3. SPRINT 2 — bigger Phase-1 items (each funds a new primitive/infra)

| Ticket                                  | One-line goal                                                                                                         | New primitive / infra it funds                                                            | Dependency                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Nav parameterization**                | Generalize `nav-config.ts`/`ConsoleChrome` so routes carry params (`:tenantId`, etc.) instead of the fixed admin set. | The parameterized nav contract that **unblocks the tenant shell** for the `/app` screens. | Sprint-1 console stable on real data.                                       |
| **Relay-traces page**                   | New admin page listing relay traces (read endpoint live per backend-hardening migrations 0015-0018).                  | **Trace-viewer primitive** (expand/inspect a single relay trace).                         | Backend relay-traces read endpoint (live); shared `qk`/`admin` conventions. |
| **Admin analytics page**                | Full analytics surface beyond the dashboard board (time-series + group-by switching).                                 | **Chart primitive** (the real one `RankingBar` deliberately is _not_).                    | `analyticsUsage` (live); the chart primitive is built here.                 |
| **Tenant `/app` backend-ready screens** | First tenant-facing screens against already-shipped tenant endpoints.                                                 | **`lib/api/consoleApi.ts`** (the tenant-plane client, sibling to admin `admin.ts`).       | Nav parameterization (tenant shell) + the tenant endpoints.                 |

---

## 4. SPRINT 3+ — Phase 2 console + Phase-3 backend-blocked watchlist

### Phase 2 (Sprint 3) — polished tenant console

- Build the **5 thin `/console` endpoints** into a polished tenant console (self-serve usage/keys/billing views) on top of `consoleApi.ts` from Sprint 2. Unblocked once those endpoints ship; track their merge.

### Phase 3 — backend-BLOCKED backlog (watchlist, do NOT start)

| Backlog item        | Exact backend dependency it waits on                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **channel-health**  | **BLOCKED** — `usage_log` has latency/status **null** (no per-channel health signal exists to render).             |
| **credit-buckets**  | **BLOCKED** — the ledger has **no `source`/`bucket`** column to attribute or segment credits by.                   |
| **multi-dim price** | **BLOCKED** — pricing is single-dimension server-side; needs a multi-dimensional price model in the backend first. |

> **Two still-true caveats (restated):**
>
> 1. **usage_log latency/status are null → channel-health is blocked** until the backend populates them.
> 2. **the ledger has no source/bucket → credit-buckets is blocked** until that schema lands.

---

## 5. WORKING AGREEMENT

1. **TDD-first, always.** Write the failing test, watch it fail (RED), then implement (GREEN), then refactor. Every ticket above names its **first failing test** — start there.
2. **The gate is non-negotiable.** Every PR keeps **typecheck + lint + test + build** green before merge. No exceptions, no "fix in a follow-up".
3. **Small, focused PRs — one ticket per PR.** PR-0 is the only shared-infra PR; after that each Sprint-1 ticket is its own PR. Lane A (RouteGroups→OfficialPrices) serializes because they share `mockBilling.ts`/`types.ts`.
4. **Money is decimal-µ strings.** Use `BigInt` / `formatCredits` (`÷1e6` semantics) and the new `compareMicroDesc`/`formatCreditsSigned`. **Never `Number()` on money** — the single permitted exception is a CSS bar-width percentage, computed _after_ BigInt math, for presentation only. **Exceptions that are NOT money:** `group_ratio_bps` is an int (`bps/10000`); official-price/channel-cost _display_ `Number(s)/1e6` is allowed because those magnitudes are tiny — but the **write path is always human numbers passed straight through**, never client-multiplied.
5. **Idempotency-Key only on `@Idempotent` admin POSTs.** Send it on `createRouteGroup` and `createOfficialPrice` (fresh `crypto.randomUUID()` per create). **Do NOT** send it on: PATCH/DELETE, the membership **PUT** (verb-idempotent), or `POST /admin/api-keys` (secret-returning, not `@Idempotent`).
6. **De-mock surgically.** Remove `mockBilling`/`MockBadge` imports from a page without deleting the shared files until _every_ consumer is migrated. `mockBilling.ts` and `MockBadge.tsx` survive Sprint 1 (OfficialPrices ships last in Lane A).

---

## 6. START HERE

**First ticket: `PR-0` (Shared Infra), and within it the very first commit is `client.put`.**

**First failing test to write — in `apps/web/src/lib/api/client.test.ts`:**

> Assert that calling `client.put('/x', { a: 1 })` issues an HTTP request with `method: 'PUT'`, a JSON-serialized body, `content-type: application/json`, and **no `Idempotency-Key` header**.

It fails today because `ApiClient` has no `put` method (verified — `client.ts` exposes only `get/getPage/post/patch/delete`). Make it pass by adding `put<T>(path, body?) => request<T>(path, { method: 'PUT', body })`, then proceed through the rest of PR-0 (queryKeys → types → money helpers → `RankingBar` → `TextField` props), each with its own RED test, before opening any Sprint-1 ticket.

---

# Appendix — Execution-ready ticket specs (Sprint 1)

## FE-CONSOLE-ROUTEGROUPS-REAL — Wire RouteGroupsPage to the live /admin/route-groups backend · effort M

**Goal:** Replace the in-memory mockBilling backing of features/console/RouteGroupsPage.tsx with the real, now-deployed /admin/route-groups admin API (groups CRUD + idempotent PUT membership upsert + real channel roster), removing the mock import and MockBadge.

**Files to touch:**

- `lib/api/client.ts` — Add a put<T>(path, body?) method (the membership upsert is PUT and the client has no put today; mirror patch but method:'PUT', no Idempotency-Key).
- `lib/api/types.ts` — Add real view + body types: RouteGroupView (id,name,group_ratio_bps:number,status,description:string|null,created_at,updated_at), RouteGroupChannelView (group_id,channel_id,priority,weight,created_at), CreateRouteGroupBody (name; groupRatioBps?; description?; status?), UpdateRouteGroupBody (name?; groupRatioBps?; status?; description?:string|null), AddGroupChannelBody (priority?; weight?). Keep/RouteGroup mock types only if mockBilling still needs them for the sibling OfficialPrices page; do NOT reuse the old camel-less mock RouteGroup for the wire types.
- `lib/api/admin.ts` — Add 8 methods to makeAdminApi: listRouteGroups (getPage→.rows), createRouteGroup(body,idempotencyKey), getRouteGroup(id), updateRouteGroup(id,body), deleteRouteGroup(id):void, listGroupChannels(id) (getPage→.rows), addGroupChannel(id,channelId,body) via client.put (NO idempotency key), removeGroupChannel(id,channelId):void. Import the new types.
- `lib/api/queryKeys.ts` — Add qk.routeGroups() => ['admin','route-groups'] and qk.routeGroupChannels(id) => ['admin','route-groups',id,'channels'].
- `features/console/RouteGroupsPage.tsx` — Swap all mockBilling imports + QK_GROUPS/qkGroupChannels for useAdminApi + qk.\*; drive table from listRouteGroups; channel-count column reads the cached membership PageEnvelope (see gotchas); editor uses createRouteGroup(idemKey)/updateRouteGroup with camelCase groupRatioBps; GroupChannelsDrawer uses addGroupChannel PUT (single upsert replaces mock add+update), removeGroupChannel; channel picker fed by real roster; remove MockBadge import+render; add group_ratio tooltip note that it drives real customer pricing.
- `i18n/locales/en/console.json` — Reuse existing groups.\* keys; add groups.tip.ratioLive (e.g. 'This ratio now multiplies real customer billing.') appended in the ratio tooltip; add groups.channels.cols.channel already present; no key removals.
- `i18n/locales/zh-CN/console.json` — Mirror the new groups.tip.ratioLive key in zh-CN.

**Endpoints:**

- `GET /admin/route-groups` — List groups. PageEnvelope {data,next_cursor,has_more}; getPage unwraps to {rows,nextCursor}. Use .rows (small set, no keyset UI needed — render all).
- `POST /admin/route-groups` — Create. 201. @Idempotent — send Idempotency-Key. Body camelCase: name, groupRatioBps? (default 10000), description?, status?. Response snake_case RouteGroupView.
- `GET /admin/route-groups/:id` — Get one or 404. Not strictly needed (list already has all fields) — optional client method; page edits from the cached list row.
- `PATCH /admin/route-groups/:id` — Update. Body camelCase, all optional. description:null clears it. groupRatioBps stays int bps. No idempotency key (patch has none).
- `DELETE /admin/route-groups/:id` — Soft-delete. 204 → client.delete returns undefined. Frees the name.
- `GET /admin/route-groups/:id/channels` — List memberships. PageEnvelope of RouteGroupChannelView (group_id,channel_id,priority,weight,created_at). getPage→.rows.
- `PUT /admin/route-groups/:id/channels/:channelId` — Idempotent UPSERT of membership. Body {priority?,weight?} (defaults priority=0, weight=1). One call covers BOTH the mock add AND the mock update. NO Idempotency-Key header (PUT is verb-idempotent). Returns RouteGroupChannelView.
- `DELETE /admin/route-groups/:id/channels/:channelId` — Hard-delete membership. 204.
- `GET /admin/resources` — Channel-roster source #1: list resources (getPage→.rows ResourceView).
- `GET /admin/resources/:id/channels` — Channel-roster source #2: per-resource channels (getPage→.rows ChannelView{id,provider_type,model,status}). Fan-out across resources to build the global add-channel roster; derive label as `${provider_type} · ${model ?? id}`.

**Client methods:**

- listRouteGroups: async () => (await client.getPage<RouteGroupView>('/admin/route-groups')).rows
- createRouteGroup: (body: CreateRouteGroupBody, idempotencyKey?: string) => client.post<RouteGroupView>('/admin/route-groups', body, { idempotencyKey })
- getRouteGroup: (id: string) => client.get<RouteGroupView>(`/admin/route-groups/${id}`) // optional
- updateRouteGroup: (id: string, body: UpdateRouteGroupBody) => client.patch<RouteGroupView>(`/admin/route-groups/${id}`, body)
- deleteRouteGroup: (id: string): Promise<void> => client.delete<undefined>(`/admin/route-groups/${id}`)
- listGroupChannels: async (id: string) => (await client.getPage<RouteGroupChannelView>(`/admin/route-groups/${id}/channels`)).rows
- addGroupChannel: (id: string, channelId: string, body: AddGroupChannelBody) => client.put<RouteGroupChannelView>(`/admin/route-groups/${id}/channels/${channelId}`, body) // PUT, NO idempotencyKey
- removeGroupChannel: (id: string, channelId: string): Promise<void> => client.delete<undefined>(`/admin/route-groups/${id}/channels/${channelId}`)
- client.put<T>(path, body?) => request<T>(path, { method: 'PUT', body }) // NEW on ApiClient in client.ts

**Query keys:**

- qk.routeGroups() => ['admin','route-groups']
- qk.routeGroupChannels(id: string) => ['admin','route-groups', id, 'channels']
- (reuse existing) qk.resources() and qk.channels(resourceId) for the roster fan-out

**Type changes:**

- NEW RouteGroupView { id: string; name: string; group_ratio_bps: number; status: string; description: string | null; created_at: string; updated_at: string } — note string status (backend returns plain string), and group_ratio_bps is a NUMBER (int32 bps, NOT a µ-string).
- NEW RouteGroupChannelView { group_id: string; channel_id: string; priority: number; weight: number; created_at: string }
- NEW CreateRouteGroupBody { name: string; groupRatioBps?: number; description?: string; status?: 'active'|'disabled' } (camelCase)
- NEW UpdateRouteGroupBody { name?: string; groupRatioBps?: number; status?: 'active'|'disabled'; description?: string | null } (description:null clears)
- NEW AddGroupChannelBody { priority?: number; weight?: number } (defaults priority=0, weight=1)
- Backend-delta vs the OLD mock RouteGroup/RouteGroupChannel: response gains updated_at on the group and created_at on the membership; status is a bare string not the 'active'|'disabled' union; the mock's flat group_ratio_bps stays a number but is now LIVE customer pricing.
- Leave the mock RouteGroup/RouteGroupChannel types in types.ts ONLY if OfficialPricesPage/mockBilling still imports them; otherwise the page should import the new wire types. RouteGroupsPage must stop importing the mock RouteGroup.

**Components:**

- Reuse: DataTable, Column, StatusBadge+statusTone, Drawer, ConfirmDialog, NumberField, SelectField, TextField, RowAction, Button, toast — all already hardened/committed; no new primitives.
- Reuse useSetConsoleAction for the 'New group' header action.
- Reuse useAdminApi() + qk.\* + mutationError(t) data-layer convention (no built-in invalidation in admin.ts; page invalidates in onSuccess).
- Reuse crypto.randomUUID() inline for the POST Idempotency-Key (same pattern as ResourcesPage/ChannelEditor — useState(() => crypto.randomUUID()) in the editor, regenerated per create).
- NO new component needed. DELETE the <MockBadge/> usage (do not delete the MockBadge component file — OfficialPricesPage still uses it).

**TDD plan (failing tests first):**

- admin.test.ts: assert createRouteGroup posts to '/admin/route-groups' with the Idempotency-Key header and camelCase body {name,groupRatioBps,...}; assert listRouteGroups GETs and unwraps env.data → rows.
- admin.test.ts: assert addGroupChannel issues PUT '/admin/route-groups/:id/channels/:channelId' with body {priority,weight} and NO Idempotency-Key header (regression guard against accidental idempotency on the non-idempotent-key PUT).
- admin.test.ts: assert removeGroupChannel + deleteRouteGroup issue DELETE and resolve void on 204.
- client.test.ts: assert new client.put sends method PUT, JSON body, content-type, and no Idempotency-Key.
- RouteGroupsPage component test: renders groups from a mocked listRouteGroups; assert the ratio cell shows ×N.NN and signed delta% from group_ratio_bps; assert the channels column reflects the cached membership length (mock qk.routeGroupChannels(id) → N rows → shows N).
- RouteGroupsPage component test: editor create path sends groupRatioBps = round(percent\*100) and invalidates qk.routeGroups(); edit path sends PATCH; ratio tooltip contains the 'drives real customer pricing' copy.
- GroupChannelsDrawer test: changing priority/weight on an existing member calls addGroupChannel (PUT upsert), not a separate update method; adding a new channel from the roster also calls addGroupChannel with defaults; both invalidate qk.routeGroupChannels(id) AND qk.routeGroups() so the count column refreshes.
- GroupChannelsDrawer test: roster is built from listResources + per-resource listChannels and excludes channels already in the membership (by channel_id).

**Acceptance criteria:**

- RouteGroupsPage no longer imports mockBilling; the <MockBadge/> is gone from the page; mockBilling.ts is untouched (still backs OfficialPricesPage).
- Group list, create, edit, delete all hit /admin/route-groups via useAdminApi and reflect after invalidating qk.routeGroups().
- POST create carries an Idempotency-Key; PATCH/PUT/DELETE do not.
- Manage-channels drawer: add, priority/weight edit, and remove all work through PUT (upsert) + DELETE; the single PUT upsert replaces the former mock add+update split.
- PUT body defaults are priority=0, weight=1 (NOT the mock 100/100); adding a fresh channel with no edits sends those defaults (or omits them and lets the backend default).
- The add-channel picker lists the real channel roster (resources→channels fan-out), excludes already-member channel_ids, and shows a derived human label; membership rows resolve channel_id → that label.
- Channel-count column derives from the cached qk.routeGroupChannels(group.id) PageEnvelope length (per-row useQuery or prefetched cache read), NOT a synchronous countGroupChannels call.
- group_ratio_bps is read/written as an integer bps number (10000 = ×1.00); the ratio tooltip notes it now drives real customer pricing.
- ratioPct↔bps remap unchanged: bps = round(percent\*100), displayed as ×(bps/10000) and signed delta% vs 10000.
- name-collision (duplicate group name) and validation errors surface via mutationError(t) (ApiError 400).
- tsc + lint clean; new admin.ts/client.ts tests pass; component tests pass.

**Gotchas:**

- BODY is camelCase, RESPONSE is snake_case: send {groupRatioBps}, read {group_ratio_bps}. Don't send group_ratio_bps in the body — the zod schema only accepts groupRatioBps.
- group_ratio_bps is an INTEGER basis-points number, NOT money — 10000 = ×1.00. Do NOT run it through the µ-string/BigInt money helpers. It is the one numeric field here that is a plain Number.
- createRouteGroupSchema default groupRatioBps = 10000; you can omit it on create and the backend defaults. The editor seeds ratioPct from (group_ratio_bps ?? 10000)/100.
- PUT membership is an idempotent UPSERT: it REPLACES both the mock addGroupChannel and updateGroupChannel. There is no separate PATCH membership endpoint — both 'add' and 'edit priority/weight' are the same PUT call.
- PUT membership defaults are priority=0, weight=1 (backend) — the mock used 100/100. Update the NumberField seed defaults for new members to 0/1, not 100/100, to match what actually persists.
- Idempotency-Key goes on POST create ONLY (controller has @Idempotent on createRouteGroup). The PUT membership is NOT given an Idempotency-Key (the PUT verb provides idempotency; addGroupChannelSchema has no idempotency field).
- Channel count must come from the membership query (a PageEnvelope, .rows.length), not a sync read. Either run a small per-row useQuery(qk.routeGroupChannels(id)) for the count column, or prefetch memberships; the old synchronous countGroupChannels() pattern is gone. Invalidate qk.routeGroups() AND qk.routeGroupChannels(id) after add/remove so the count refreshes.
- Channel roster is two-hop: listResources() then listChannels(resourceId) per resource, then flatten. ChannelView has no human name — derive a label like `${provider_type} · ${model ?? id}`. The membership row's channel_id is the channel UUID; map it back to the flattened roster to render a label (fallback to channel_id).
- response status is a bare string (RouteGroupView.status: string), so StatusBadge/statusTone and the status SelectField should still constrain to 'active'|'disabled' on write but tolerate any string on read.
- DELETE returns 204 → client.delete resolves undefined; don't read a body. Soft-delete frees the name for reuse.
- client.put does not exist yet — add it to client.ts/ApiClient first or admin.addGroupChannel won't compile.
- Do NOT delete MockBadge.tsx or mockBilling.ts — OfficialPricesPage is still mock; only remove the imports/usages from RouteGroupsPage.
- List endpoints are paginated (has_more/next_cursor) but groups and per-group memberships are expected small; current mock UI renders all rows with client-side search/sort. Use getPage().rows and render all (no keyset UI) unless the roadmap says otherwise — flag if a tenant could exceed the default page limit.

**Depends on:**

- Backend /admin/route-groups (Track 3) merged to main + deployed (confirmed in admin.controller.ts ~lines 1007-1082 and admin.dto.ts ~lines 477-520).
- Hardened component library + qk/admin/client data-layer conventions (already committed).

## CONSOLE-OfficialPrices-Live: Wire OfficialPricesPage to the live /admin/official-prices backend (drop mock + client-side µUSD math) · effort M

**Goal:** Replace the in-memory mockBilling-backed OfficialPricesPage with the real /admin/official-prices admin API: send HUMAN USD-per-1M on write, parse µUSD-string fields on read, consume the cursor envelope, and remove the MockBadge.

**Files to touch:**

- `lib/api/types.ts` — Add real OfficialPriceView (snake_case, µUSD STRINGS, matching backend: input_price_per_1m/output_price_per_1m string; display_name/cached_input_price_per_1m/source_url/effective_at/notes/updated_by nullable; created_at/updated_at). Add CreateOfficialPriceBody (camelCase HUMAN USD/1M: provider, modelSlug, displayName?, inputUsdPer1m, outputUsdPer1m, cachedInputUsdPer1m?, sourceUrl?, effectiveAt?, notes?) and UpdateOfficialPriceBody (no provider/modelSlug; displayName/cachedInputUsdPer1m/sourceUrl/effectiveAt/notes are `T | null` clearable; inputUsdPer1m/outputUsdPer1m optional non-null). Delete the old OfficialModelPrice mock interface ONLY after RouteGroupsPage no longer imports it (it doesn't — RouteGroup/RouteGroupChannel stay).
- `lib/api/admin.ts` — Add 5 methods: listOfficialPrices (getPage with {provider?,cursor?,limit?} → Page<OfficialPriceView>), createOfficialPrice(body, idempotencyKey?) (POST @Idempotent), getOfficialPrice(id) (optional), updateOfficialPrice(id, body) (PATCH, no idempotency key), deleteOfficialPrice(id) (DELETE → void). Import the new types.
- `lib/api/queryKeys.ts` — Add qk.officialPrices(params?: Record<string,unknown>) => ['admin','official-prices', params] (params for the optional provider filter; keep a stable shape consistent with qk.usage/analyticsUsage).
- `features/console/OfficialPricesPage.tsx` — Swap mockBilling imports → useAdminApi + qk; remove MockBadge import/usage and the local QK const and the local usdLabel/µUSD helpers. Table cells parse µUSD strings (Number(r.input_price_per_1m)/1e6) for display + sortValue. Editor sends HUMAN USD numbers; map effectiveAt yyyy-mm-dd → full ISO (append 'T00:00:00Z'); show effective_at as a date (slice/format the ISO datetime). Use STALE_REFERENCE on the query. createOfficialPrice passes a fresh idempotencyKey (crypto.randomUUID()).
- `lib/api/mockBilling.ts` — Remove the official-price seed array + listOfficialPrices/createOfficialPrice/updateOfficialPrice/deleteOfficialPrice exports (now dead). KEEP all route-group/membership exports — RouteGroupsPage still imports them.
- `i18n/locales/en/console.json` — Add any new keys the rewrite needs: officialPrices.cols.cachedInput? (optional new col), and an error/empty string only if introduced. Existing officialPrices.\* block already covers title/new/editTitle/save/empty/created/updated/deleted/source/cols/form/tip/priceEquiv/confirm — reuse them.
- `i18n/locales/zh-CN/console.json` — Mirror any new keys added to en/console.json.
- `lib/api/admin.test.ts` — Add cases for the 5 official-price methods (path/method/idempotency/USD-not-µUSD body assertions) — see tddPlan.

**Endpoints:**

- `GET /admin/official-prices` — Query ?provider=&limit=&cursor=. Returns PageEnvelope {data, next_cursor, has_more}; client getPage unwraps to {rows, nextCursor}. Rows are OfficialPriceView with µUSD STRING prices.
- `POST /admin/official-prices` — @Idempotent (send Idempotency-Key). 201. Body camelCase HUMAN USD/1M: inputUsdPer1m & outputUsdPer1m REQUIRED and z.number().positive() (so 0 is rejected); provider/modelSlug required; effectiveAt is z.string().datetime() (FULL ISO). Service does BigInt(round(usd\*1e6)). (provider,modelSlug) unique → 400 on collision.
- `GET /admin/official-prices/:id` — Get one or 404. Optional for the page; add the client method for completeness/parity with other entities.
- `PATCH /admin/official-prices/:id` — No idempotency key. provider/modelSlug NOT patchable. displayName/cachedInputUsdPer1m/sourceUrl/effectiveAt/notes are nullable→clear with null; inputUsdPer1m/outputUsdPer1m optional non-null .positive(). Same USD→µUSD remap.
- `DELETE /admin/official-prices/:id` — 204 (soft-delete; frees the (provider,slug) pair). client.delete returns void. 404 when absent.

**Client methods:**

- listOfficialPrices: (params?: { provider?: string; cursor?: string; limit?: number }) => Promise<Page<OfficialPriceView>> // client.getPage('/admin/official-prices', params)
- createOfficialPrice: (body: CreateOfficialPriceBody, idempotencyKey?: string) => Promise<OfficialPriceView> // client.post('/admin/official-prices', body, { idempotencyKey })
- getOfficialPrice: (id: string) => Promise<OfficialPriceView> // client.get(`/admin/official-prices/${id}`)
- updateOfficialPrice: (id: string, body: UpdateOfficialPriceBody) => Promise<OfficialPriceView> // client.patch(`/admin/official-prices/${id}`, body) — NO idempotency key (mirrors updateModel)
- deleteOfficialPrice: (id: string): Promise<void> => client.delete<undefined>(`/admin/official-prices/${id}`)

**Query keys:**

- qk.officialPrices: (params?: Record<string, unknown>) => ['admin', 'official-prices', params] as const // page invalidates qk.officialPrices() in create/update/delete onSuccess

**Type changes:**

- OfficialPriceView { id: string; provider: string; model_slug: string; display_name: string | null; input_price_per_1m: string; output_price_per_1m: string; cached_input_price_per_1m: string | null; source_url: string | null; effective_at: string | null; notes: string | null; updated_by: string | null; created_at: string; updated_at: string } // µUSD prices are DECIMAL STRINGS (BigInt-safe); effective_at is a full ISO datetime string, NOT yyyy-mm-dd
- CreateOfficialPriceBody { provider: string; modelSlug: string; displayName?: string; inputUsdPer1m: number; outputUsdPer1m: number; cachedInputUsdPer1m?: number; sourceUrl?: string; effectiveAt?: string; notes?: string } // HUMAN USD per 1M (e.g. 2.5), camelCase; input/output REQUIRED & > 0
- UpdateOfficialPriceBody { displayName?: string | null; inputUsdPer1m?: number; outputUsdPer1m?: number; cachedInputUsdPer1m?: number | null; sourceUrl?: string | null; effectiveAt?: string | null; notes?: string | null } // NO provider/modelSlug; null clears nullable fields; input/output optional non-null > 0
- Remove (or stop exporting) the old OfficialModelPrice mock interface in types.ts once the page + mockBilling no longer reference it. Keep RouteGroup/RouteGroupChannel.

**Components:**

- DataTable (reuse) — columns now read µUSD strings: cell `${(Number(r.input_price_per_1m)/1e6).toLocaleString(...)}`, sortValue `Number(r.input_price_per_1m)`; rowKey={(r)=>r.id}; searchable, pageSize 20
- Drawer + ComboboxField (provider, COMMON_PROVIDERS) + TextField (modelSlug, displayName, sourceUrl url, notes) + NumberField (input/output/cached, in DOLLARS now with step e.g. 0.01, min 0) — reuse hardened versions; the in-file DateField stays (TextField has no date type)
- ConfirmDialog, RowAction, Button, toast, ProviderIcon, useSetConsoleAction — reuse
- MockBadge — REMOVE its import + the `<MockBadge/>` in the header row
- No genuinely-new primitive required

**TDD plan (failing tests first):**

- admin.test.ts: 'listOfficialPrices paginates /admin/official-prices' — getPage to '/admin/official-prices' with arg { provider, cursor, limit } (provider passthrough).
- admin.test.ts: 'createOfficialPrice posts to /admin/official-prices with idempotency key' — method post, path correct, and arg is the camelCase USD body (inputUsdPer1m present) — proving NO µUSD pre-multiplication on the client.
- admin.test.ts: 'updateOfficialPrice patches /admin/official-prices/:id WITHOUT provider/modelSlug' — method patch, path `/admin/official-prices/op1`, body omits provider/modelSlug; asserts a null value is preserved (clearable field).
- admin.test.ts: 'deleteOfficialPrice deletes /admin/official-prices/:id' — method delete, path, arg undefined.
- (unit) effectiveAt remap helper test: yyyy-mm-dd '2024-08-06' → '2024-08-06T00:00:00Z'; empty string → omit field (undefined); already-ISO passes through. Extract the helper so it is unit-testable.
- (unit) µUSD-string → display test: '2500000' → '2.50' (per-1M dollar label), and Number()-based sortValue ordering — guards against naive Number() on a huge string / float drift.
- (component, optional but recommended — mirrors PricebookSpecForm.test.tsx) OfficialPricesPage editor submit builds a body with HUMAN USD numbers and an ISO effectiveAt, and the table renders a µUSD string as a $X.XX/1M label.

**Acceptance criteria:**

- Page lists live rows from GET /admin/official-prices (no mock import); MockBadge is gone from the header.
- Table shows input/output prices as $X.XX/1M derived from the µUSD STRING fields via Number(s)/1e6 (never the raw string, never the old client-side µUSD integers); sorting on price works.
- Create sends camelCase HUMAN USD (inputUsdPer1m/outputUsdPer1m/cachedInputUsdPer1m) with an Idempotency-Key header; 0 is not submittable for input/output (>0 required) and the form prevents/handles it.
- effectiveAt entered via the date picker is sent as a FULL ISO datetime (yyyy-mm-ddT00:00:00Z); the table renders effective_at (an ISO datetime) back as a date.
- Edit drawer does NOT send provider/modelSlug; clearing cached price / sourceUrl / effectiveAt / notes / displayName sends null (field cleared on the server); leaving a field unchanged omits it.
- Delete calls DELETE /:id, expects 204, toasts, and the list invalidates (qk.officialPrices()).
- List/create/update/delete invalidate qk.officialPrices() in onSuccess; query uses STALE_REFERENCE.
- RouteGroupsPage still compiles and runs (route-group mock exports untouched); `pnpm test` + typecheck/lint pass.

**Gotchas:**

- UNIT REMAP (the hard part): WRITE = camelCase HUMAN USD/1M numbers (service multiplies ×1e6, rounds). READ = snake_case µUSD DECIMAL STRINGS. So drop ALL client-side µUSD math in the page (the old usd()/usdLabel µUSD integers and the step:1000 NumberFields). On read: Number(r.input_price_per_1m)/1e6 for the $ label; on write: pass the dollar value straight through. NumberFields now hold dollars (step ~0.01, min 0).
- effectiveAt SCHEMA BUG: backend is z.string().datetime() (full ISO 8601) but the DateField emits yyyy-mm-dd → MUST append 'T00:00:00Z' before sending, else 400. Read-side effective_at comes back as a full ISO datetime string → slice to the date for the table/date input.
- input/output REQUIRED + .positive() on create: NumberField emits 0 for empty/NaN — 0 fails .positive() → guard before submit (disable Save or show field error when input/output ≤ 0).
- PATCH non-patchable fields: never include provider/modelSlug in UpdateOfficialPriceBody (backend schema has no such keys; leave provider/modelSlug read-only/disabled in the edit drawer).
- Nullable-clearable on PATCH: send `null` (not undefined, not '') to clear cachedInputUsdPer1m/displayName/sourceUrl/effectiveAt/notes; send `undefined`/omit to leave unchanged. The current mock body uses `undefined` for empty — that must become `null` for the clear semantics on edit (on CREATE, omit instead — create has no nullable, omitting = absent).
- Envelope: GET returns {data, next_cursor, has_more}; client.getPage already unwraps to {rows, nextCursor}. The page currently consumes a flat array from the mock — switch to reading .rows (or keep the full-list pattern via listOfficialPrices().then(p=>p.rows), mirroring admin.ts listModels()). Page size is small so a single page is fine for v1; cursor pagination can be deferred.
- Money parsing: prices are decimal µ-strings — use Number(s)/1e6 only for DISPLAY of these small reference prices; do not naively Number() huge ledger-style strings elsewhere. (BigInt not needed for per-1M display magnitudes, but never multiply on the client for the write path.)
- display_name / cached / source_url / effective_at / notes / updated_by come back as `null` (not undefined) — render '—' on null and seed the editor from `?? ''`.
- mockBilling.ts is SHARED with RouteGroupsPage — only remove the official-price exports; deleting route-group exports breaks that page.
- sourceUrl is z.string().url() on the backend — empty string must be omitted (create) / sent as null (clear on edit), never '' (would 400).
- POST is 201, DELETE is 204 (client returns undefined) — fine with existing client; PATCH carries no idempotency key (client.patch has no such option, mirrors updateModel).

**Depends on:**

- Backend /admin/official-prices CRUD (merged to main + deployed — verified in admin.controller.ts ~958-1005, admin.dto.ts ~432-475, admin.service.ts ~1258-1344)
- Hardened component library (Drawer/ComboboxField/NumberField/DateField field-contract, STALE_REFERENCE, mutationError) — already committed

## CONSOLE-APIKEYS-GROUP-REVOKE: Group-binding + revoke on the admin API Keys page · effort M

**Goal:** Let admins bind/rebind an API key to a route group (a pricing decision via the group's ratio) and revoke a key, wiring ApiKeysPage to the now-LIVE PATCH /admin/api-keys/:id/group, DELETE /admin/api-keys/:id, and POST routeGroupId (bind-on-create).

**Files to touch:**

- `lib/api/types.ts` — Add route_group_id: string|null to ApiKeyView (line ~14-21). Add routeGroupId?: string to CreateApiKeyBody (line ~62-66). Add UpdateApiKeyGroupBody { routeGroupId: string | null } (REQUIRED key, nullable — null unbinds → default group).
- `lib/api/admin.ts` — Add bindApiKeyGroup(id, body: UpdateApiKeyGroupBody) -> client.patch<{id:string; route_group_id:string|null}>(`/admin/api-keys/${id}/group`, body); add revokeApiKey(id): Promise<void> -> client.delete<undefined>(`/admin/api-keys/${id}`). createApiKey already exists — body now carries optional routeGroupId, no method change. listRouteGroups is provided by the dependsOn Route Groups ticket (real GET /admin/route-groups, returns RouteGroupView rows).
- `lib/api/queryKeys.ts` — Add routeGroups: () => ['admin','route-groups'] as const (only if the dependsOn ticket hasn't already added it — coordinate, do not duplicate).
- `features/console/ApiKeysPage.tsx` — (1) Add a group <SelectField> to the create Modal (options = '— default —' + each RouteGroup as `name ×N.NN`); pass body.routeGroupId when non-empty. (2) On each EntityCard, show the bound group as a chip (resolve route_group_id -> group name+ratio; null -> 'default ×1.00'). (3) Add per-card actions: a 'Bind group' control (RowAction/Button opening a small bind Modal with the group SelectField + pricing hint) and a danger 'Revoke' RowAction opening ConfirmDialog. (4) Add bind + revoke useMutation, invalidate qk.apiKeys(tenantId) onSuccess, mutationError(t) onError, toast on success. (5) useQuery(qk.routeGroups(), api.listRouteGroups) to feed both pickers; gate behind same admin plane.
- `i18n/locales/en/console.json` — Under apiKeys._: add form.group, form.groupDefault, bind.title, bind.hint (pricing-impact warning: binding sets the customer price ratio), bind.submit, group.default ('default'), revoke.title, revoke.msg, actions.bind, actions.revoke, revoked, bound, cols.group, ratio.equiv ('×{{mult}}'). Mirror in zh-CN/console.json (groups._ there already models the ratio copy — reuse phrasing).

**Endpoints:**

- `PATCH /admin/api-keys/:id/group` — LIVE. Body {routeGroupId: uuid|null}; null -> key falls back to 'default' group at routing time. Returns {id, route_group_id}. routeGroupId is REQUIRED on the body but nullable (send explicit null to unbind). Non-null uuid is validated to exist server-side (404/400 if not).
- `DELETE /admin/api-keys/:id` — LIVE. 204 No Content; soft-delete (revoke). The key is rejected with 401 on subsequent auth. client.delete<undefined> returns no body.
- `POST /admin/api-keys` — LIVE. Already accepts optional routeGroupId (uuid) for bind-on-create; omitted -> null. 201, returns {id, plaintext} (ApiKeyCreatedView — does NOT echo route_group_id). NOT @Idempotent (secret-returning POST) — do not pass an idempotency key.
- `GET /admin/route-groups` — LIVE (provided by dependsOn ticket's listRouteGroups). PageEnvelope<RouteGroupView>; each row has id, name, group_ratio_bps (int basis points, 10000=×1.00), status, description|null. Used to populate both pickers and the pricing hint.
- `GET /admin/api-keys` — LIVE. Already wired (api.listApiKeys -> .rows). ApiKeyView now includes route_group_id server-side; frontend type just needs the field added.

**Client methods:**

- bindApiKeyGroup(id: string, body: UpdateApiKeyGroupBody): Promise<{ id: string; route_group_id: string | null }> // client.patch(`/admin/api-keys/${id}/group`, body)
- revokeApiKey(id: string): Promise<void> // client.delete<undefined>(`/admin/api-keys/${id}`)
- listRouteGroups(): Promise<RouteGroupView[]> // OWNED BY dependsOn ticket; consume it here, do not re-add. If it lands as Page<RouteGroupView>, take .rows.

**Query keys:**

- qk.routeGroups: () => ['admin','route-groups'] as const // add only if dependsOn ticket hasn't; reuse, do not duplicate

**Type changes:**

- ApiKeyView: + route_group_id: string | null (backend already returns it; toApiKeyView maps row.routeGroupId)
- CreateApiKeyBody: + routeGroupId?: string (uuid; omitted -> null at create)
- UpdateApiKeyGroupBody (new): { routeGroupId: string | null } // REQUIRED but nullable — mirrors updateApiKeyGroupSchema. null = unbind -> default group
- RouteGroupView (frontend): ensure a real type exists with { id; name; group_ratio_bps: number; status; description: string|null; created_at; updated_at } — the dependsOn ticket should add it; the current types.ts has a MOCK `RouteGroup` (no updated_at) used by mockBilling. Reuse the real one, do not bind to the mock shape.

**Components:**

- Reuse Modal (create form + bind dialog) — already hardened (focus trap, Esc, inert).
- Reuse ConfirmDialog for revoke (danger + loading) — same pattern as RouteGroupsPage/ModelsPage.
- Reuse SelectField for the group picker (create + bind) — option label '{name} ×{N.NN}', plus a '— default —' option mapping to null/undefined.
- Reuse EntityCard/CardCollection (page already uses these, NOT DataTable) + StatusBadge + the existing chips array for the bound-group chip.
- Reuse RowAction for per-card Bind/Revoke icon buttons (TrashIcon danger for revoke, e.g. LinkIcon/StackIcon for bind) — honors --min-touch/.hit-slop.
- Reuse mutationError(t) onError + toast(...) onSuccess.
- No genuinely-new primitive required. A small ratioMultiplier(bps)=(bps/10000).toFixed(2) helper (copy from RouteGroupsPage lines 45-52) for the ×N.NN label — consider lifting to a shared util to avoid a third copy.

**TDD plan (failing tests first):**

- admin.test: bindApiKeyGroup('k1',{routeGroupId:'g1'}) issues PATCH /admin/api-keys/k1/group with body {routeGroupId:'g1'} and returns {id,route_group_id}; with {routeGroupId:null} sends explicit null (assert null is in the JSON body, not omitted).
- admin.test: revokeApiKey('k1') issues DELETE /admin/api-keys/k1 and resolves void on 204 (no JSON parse).
- admin.test: createApiKey({tenantId,routeGroupId:'g1'}) POSTs body including routeGroupId; createApiKey({tenantId}) omits routeGroupId (no null sent).
- ApiKeysPage.test: card renders the bound-group chip — route_group_id='g1' shows the group name + ×N.NN; route_group_id=null shows 'default ×1.00'.
- ApiKeysPage.test: create Modal group SelectField defaults to '— default —' (no routeGroupId sent); selecting a group sends body.routeGroupId.
- ApiKeysPage.test: bind dialog renders the pricing hint, submitting calls bindApiKeyGroup with the chosen id (and null when '— default —' chosen), then invalidates qk.apiKeys(tenantId).
- ApiKeysPage.test: Revoke RowAction opens ConfirmDialog; confirming calls revokeApiKey(id), shows loading, invalidates on success, toasts.
- ApiKeysPage.test: route-groups query failing/empty still renders cards and lets revoke proceed; group picker shows only '— default —' (degrade gracefully, no crash).

**Acceptance criteria:**

- Create Modal has a group picker (default + each route group labeled with its ×N.NN ratio); creating with a group sends routeGroupId, without sends none.
- Each API-key card shows its bound group (name + ratio) or 'default ×1.00' when route_group_id is null.
- A per-card Bind action opens a dialog with the group picker and a hint stating the bound group sets the customer price ratio; submitting calls PATCH .../group and the chip updates after invalidation.
- Choosing '— default —' in the bind dialog sends routeGroupId: null (explicit) and unbinds to the default group.
- A per-card Revoke action opens ConfirmDialog (danger); confirming DELETEs the key (204), the list refreshes and the key disappears; a toast confirms.
- All mutations route errors through mutationError(t) and show loading state; success toasts use the new i18n keys (en + zh-CN).
- route_group_id and routeGroupId types are added; tsc + the new tests pass; no use of mockBilling in ApiKeysPage.

**Gotchas:**

- PRICING IMPACT (the headline of this ticket): the bound group's group_ratio_bps IS the customer price ratio. Binding/unbinding a key changes what the tenant is charged. The bind dialog MUST show this as a hint, not a silent dropdown. Label each option with its ×N.NN so the operator sees the price effect before confirming.
- group_ratio_bps is basis points, integer, NOT money/µ-strings — 10000 = ×1.00, 15000 = ×1.50. Use bps/10000, never the 1e6/BigInt money path. It's a plain int32.
- PATCH body routeGroupId is REQUIRED-but-nullable: to unbind you must send explicit null in the JSON, not undefined/omit. The create body routeGroupId is OPTIONAL — omit it (don't send null) when none chosen.
- POST /admin/api-keys returns ApiKeyCreatedView {id, plaintext} ONLY — it does NOT echo route_group_id, so don't read it back from the create response; rely on list invalidation to surface the binding.
- POST /admin/api-keys is NOT @Idempotent (secret-returning) — do not pass an idempotencyKey to createApiKey.
- DELETE returns 204 with no body — type as Promise<void> / client.delete<undefined> (matches deleteChannel/revokeSecret pattern); don't try to parse JSON.
- listRouteGroups currently lives in mockBilling.ts and returns a raw RouteGroup[] (mock shape, no updated_at). This ticket must consume the REAL admin.ts listRouteGroups from the dependsOn ticket; do NOT import from mockBilling. If the dependsOn ticket isn't merged, this is blocked for the picker (revoke can ship independently).
- ApiKeysPage uses EntityCard/CardCollection and listApiKeys returns .rows (a plain array, NOT a keyset Page) — keep that shape; don't refactor to DataTable/useKeyset.
- After revoke the soft-deleted key is 401 on auth but may still appear if backend list includes revoked rows — verify list filters them; if not, the card may show status changing rather than vanishing. Confirm against the live list response.
- Resolve route_group_id -> name client-side via the route-groups query; handle the race where a key references a group not in the (possibly stale/empty) list — fall back to showing the raw id rather than crashing.

**Depends on:**

- Route Groups ticket — provides the REAL admin.ts listRouteGroups (GET /admin/route-groups -> RouteGroupView), the real RouteGroupView type, and qk.routeGroups. Required for both group pickers and the ×N.NN pricing hint. (Revoke + the type additions can land without it; the bind picker cannot.)

## FE-AUTH-HARDENING-01 · effort S

**Goal:** Adapt the shipped AuthPage to the now-LIVE auth hardening: enforce + hint the 8–256 char register-password policy and surface the backend 400 invalid_input body, and on a login 429 read ApiError.retryAfterMs to show a live "try again in Ns" cooldown that disables submit until it elapses.

**Files to touch:**

- `components/ui/TextField.tsx` — Add optional minLength?: number and maxLength?: number props and forward them to the underlying <input> (native constraint attrs). TextField currently exposes NO length props — this is the blocking gap for A1. Keep the existing field-contract surface (no arbitrary spread); just thread two named props through to <input minLength={minLength} maxLength={maxLength}>.
- `features/auth/AuthPage.tsx` — (A1) On the register password TextField only (mode==='register'), pass minLength={8} maxLength={256} and a hint={t('auth.passwordPolicy')} ("8–256 characters"). Leave the login password field unconstrained (backend does not enforce length on login). (A2) Add cooldown state: const [cooldownUntil,setCooldownUntil]=useState(0) plus a 1s tick (setInterval cleared on unmount) so remaining seconds re-render; derive cooldownLeftSec=Math.max(0,Math.ceil((cooldownUntil-now)/1000)). In submit()'s catch, branch on err instanceof ApiError: when err.code==='rate_limited' && err.retryAfterMs, set cooldownUntil=Date.now()+err.retryAfterMs and toast t('errors.tooManyAttemptsRetry',{seconds: Math.ceil(err.retryAfterMs/1000)}); for other ApiError codes keep toast(t(`errors.${err.code}`, t('auth.failed'))) BUT prefer err.message when code==='invalid_input' so the backend 'password must be 8-256 characters' string is surfaced (don't swallow) — i.e. toast(err.code==='invalid_input' ? (err.message || t('errors.invalid_input')) : t(`errors.${err.code}`, t('auth.failed')), 'error'). Disable the submit Button while cooldownLeftSec>0 (disabled={busy || cooldownLeftSec>0}) and when active swap its label to t('auth.retryInSeconds',{seconds: cooldownLeftSec}); busy already drives loading.
- `i18n/locales/en/console.json` — Add auth.passwordPolicy ('8–256 characters'), auth.retryInSeconds ('Try again in {{seconds}}s'), errors.tooManyAttemptsRetry ('Too many attempts, try again in {{seconds}}s'). (Reuse existing errors.rate_limited as the generic fallback.)
- `i18n/locales/zh-CN/console.json` — Add the same three keys with zh-CN copy (e.g. auth.passwordPolicy '8–256 个字符', auth.retryInSeconds '{{seconds}} 秒后重试', errors.tooManyAttemptsRetry '尝试过于频繁，请在 {{seconds}} 秒后重试'). fallbackLng is zh-CN so this must not be left untranslated.
- `features/auth/AuthPage.test.tsx` — NEW component test file (none exists today). Render AuthPage inside MemoryRouter + I18nextProvider + AuthProvider (or mock useAuth) with a mocked toast; cover the A1 policy hint/constraints and the A2 429 cooldown per the tddPlan.

**Endpoints:**

- `POST /auth/register` — LIVE: 400 invalid_input when password length <8 or >256 (MIN=8/MAX=256 in local-auth.controller.ts parseRegistration). Body message is the literal 'password must be 8-256 characters'. No length check on shape-only fields. No client/contract change — already callable via AuthProvider.register → client.post.
- `POST /auth/login` — LIVE: guarded by LoginThrottleGuard (per-IP, DEFAULT 10 attempts/min, override AUTH_RATE_LIMIT_PER_MIN). Over budget → 429 rate_limited with retry_after_ms in the §4.7 envelope (retryable:true). No length enforcement on login password. No contract change.

**Client methods:**

- NONE — no new admin.ts / api client methods. AuthProvider.login/register already call createClient(...).post; the HTTP client's toApiError already parses error.retry_after_ms → ApiError.retryAfterMs and error.message → ApiError.message. errors.ts already models {code,message,status,retryable,retryAfterMs}. This ticket touches only the component + TextField primitive + i18n.

**Type changes:**

- TextField props (lib component, components/ui/TextField.tsx): add minLength?: number and maxLength?: number to the prop type. No lib/api/types.ts change. No errors.ts change (ApiError.retryAfterMs + message already present). No backend-delta entity fields involved here.

**Components:**

- Reuse hardened primitives: TextField (extend with minLength/maxLength), FormField (already renders the single error-or-hint line via hint=), Button (already supports disabled + loading + aria-busy; cooldown uses disabled), SegmentedControl (login/register toggle, unchanged), toast (already supports ('msg','error')). No genuinely-new primitive — the only new surface is two pass-through props on TextField; the cooldown is local component state in AuthPage, not a new shared component.

**TDD plan (failing tests first):**

- RED 1 (TextField primitive): render <TextField type='password' minLength={8} maxLength={256} ...> and assert the rendered input has minLength=8 and maxLength=256 (getByLabelText(...).toHaveAttribute('minLength','8') / maxLength '256'). Fails today because TextField drops the props.
- RED 2 (A1 hint, register mode): render AuthPage, click the 'Register' segmented tab, assert the password policy hint t('auth.passwordPolicy') ('8–256 characters') is visible, and assert the password input now carries minLength/maxLength=8/256.
- RED 3 (A1 login mode has NO constraint): in default 'login' mode assert the password input does NOT have minLength/maxLength and the policy hint is absent (login doesn't enforce length backend-side).
- RED 4 (A1 surface 400 body, don't swallow): mock useAuth so register() rejects with new ApiError('invalid_input','password must be 8-256 characters',400). Submit the register form; assert toast was called with the backend message string 'password must be 8-256 characters' (NOT the generic t('errors.invalid_input') 'Invalid request').
- RED 5 (A2 429 cooldown + disable): use fake timers; mock useAuth so login() rejects with new ApiError('rate_limited','too many login attempts',429,true,3000). Submit login; assert (a) toast called with the rate-limited copy containing '3', (b) the submit button is now disabled and its label shows t('auth.retryInSeconds',{seconds:3}) ('Try again in 3s').
- RED 6 (A2 cooldown ticks + re-enables): advance fake timers ~1s and assert label updates to 2s, then advance past retryAfterMs and assert the submit button is re-enabled and the label returns to t('auth.registerSubmit')/'auth.loginSubmit'. Clean up the interval on unmount (assert no act() warning / timer leak).
- REFACTOR: once green, extract a tiny useCountdown(untilMs) helper inside the feature if the inline tick logic muddies AuthPage; keep it local (not a shared lib) unless a second caller appears.

**Acceptance criteria:**

- Register-mode password field renders with minLength=8 and maxLength=256 and a visible '8–256 characters' policy hint; login-mode password field has neither (login is length-unconstrained server-side).
- A register submit that the backend rejects with 400 invalid_input surfaces the backend message ('password must be 8-256 characters') in the error toast rather than the generic 'Invalid request' — the 400 body is no longer swallowed.
- A login submit that returns 429 reads ApiError.retryAfterMs, shows a 'try again in Ns' toast, disables the submit button, and the button label counts down each second.
- The submit button re-enables and its label reverts once the cooldown elapses; the 1s interval is cleared on unmount (no timer leak / act warnings).
- Both en and zh-CN console.json carry auth.passwordPolicy, auth.retryInSeconds, errors.tooManyAttemptsRetry (zh-CN is fallbackLng, must be translated).
- New AuthPage.test.tsx passes under `pnpm --filter web test` (vitest+jsdom+RTL); TextField primitive test passes; typecheck + lint clean.
- No change to lib/api/errors.ts or lib/api/client.ts (retryAfterMs/message already modeled + parsed).

**Gotchas:**

- TextField does NOT currently accept any length/constraint props — A1 is blocked until you thread minLength/maxLength through to <input>. Don't reach for an arbitrary {...rest} spread (the field-contract intentionally forbids it); add two named props.
- AuthPage's existing catch SWALLOWS the 400 detail: it does toast(t(`errors.${err.code}`, ...)), which for invalid_input renders the static 'Invalid request' and discards err.message. Must special-case invalid_input to prefer err.message.
- Envelope unit/field names: backend sends snake_case retry_after_ms; the client already remaps it to ApiError.retryAfterMs (camel). Read err.retryAfterMs in the component, not retry_after_ms. retryAfterMs is in MILLISECONDS — divide by 1000 (Math.ceil) for the seconds shown.
- Login is NOT length-constrained on the server (parseCredentials only checks non-empty). Do not add minLength/maxLength to the login password field — only register. Adding it to login would reject pre-policy legacy passwords in the browser before the request.
- The throttle guard wraps the WHOLE /auth controller, so /auth/register can also 429. The cooldown handling keys off err.code==='rate_limited', so it already covers a throttled register too — don't gate it on mode==='login'.
- 429 is per-IP and includes register; the limiter FAILS OPEN (no Redis / slow → no throttle), so 429 may not reproduce in local/dev. Tests must mock the ApiError(429,...,retryAfterMs) rather than rely on hitting the real limiter.
- Default threshold is 10 attempts/min (DEFAULT_AUTH_RATE_LIMIT_PER_MIN) unless AUTH_RATE_LIMIT_PER_MIN is set — copy/tests should not hardcode '10' in UI strings; the UI only ever shows the server-provided retry_after_ms seconds.
- Use fake timers for the cooldown tick test and clear the interval on unmount; an uncleared setInterval leaks across tests and triggers act() warnings. ApiError signature for the mocks is new ApiError(code, message, status, retryable?, retryAfterMs?).
- i18n interpolation is enabled (escapeValue:false); use {{seconds}} placeholders. fallbackLng is zh-CN, so a missing zh-CN key would render the key/English unexpectedly — add both locales.

**Depends on:**

- NONE — backend is merged to main and DEPLOYED; client error model already parses retry_after_ms/message. This is the only ticket touching a shipped, FE-called page, so it has no upstream FE-ticket dependency. (Soft note: shares the TextField primitive with other field tickets, but the minLength/maxLength addition is additive and non-breaking.)

## CAT-PRICE: Surface pricing & cost in the Catalog (Models resale price/modality + Channel cost/margin inputs) · effort M

**Goal:** Make the Catalog's economics visible and editable: render model resale prices (µcredit/token) cleanly with modality on the Models table, and wire the now-LIVE Track-5 channel cost fields (µUSD/1M) end-to-end into ChannelView display + the ChannelEditor create/update form.

**Files to touch:**

- `lib/api/types.ts` — (ii) Add `input_cost_per_1m: string | null` and `output_cost_per_1m: string | null` to `ChannelView`; add `inputCostUsdPer1m?: number` + `outputCostUsdPer1m?: number` to `CreateChannelBody`; add `inputCostUsdPer1m?: number | null` + `outputCostUsdPer1m?: number | null` to `UpdateChannelBody`. Document the unit (HUMAN USD/1M on write, µUSD/1M decimal-string on read).
- `features/console/ChannelEditor.tsx` — (ii) Add two NumberField cost inputs (input + output USD/1M). Seed from `channel?.input_cost_per_1m`/`output_cost_per_1m` via ÷1e6 (string→number, null→empty/0). On save, send HUMAN USD: include on the create body; on the PATCH body send the number when set, `null` to clear (distinguish 'unchanged' from 'clear'). Mirror the existing weight/status field placement + tooltip/hint pattern.
- `features/console/ResourceDetailPane.tsx` — (ii) Add two read-only cost columns to `chCols` (input cost / output cost) rendering µUSD/1M via a usdLabel-style ÷1e6 formatter, `—` when null. Right-align/tabular like other numeric cols.
- `features/console/ModelsPage.tsx` — (i) Replace the raw `Number(m.input_price)`/`Number(m.output_price)` + `/tok` cells in the existing inputPrice/outputPrice columns with the `Money` primitive (decimal µ-string → formatCredits, no naive Number) keeping a `/tok` (or credits/token) unit suffix; keep the modality column. Fix `sortValue: (m) => Number(m.input_price)` to a BigInt-safe comparator.
- `components/data/Money.tsx` — (i) ONLY IF a per-token suffix/variant is needed: confirm Money renders the µ-string via formatCredits; if the table needs a unit suffix, pass it from the column cell rather than forking Money. Likely no change — Money already correct.
- `i18n (console namespace)` — Add labels/tooltips/hints: channels.form.inputCost / outputCost (+ tip.\*), channels.cols.inputCost / outputCost; reuse existing models.cols.inputPrice/outputPrice (already present).

**Endpoints:**

- `GET /admin/models` — (i) Existing. ModelView already returns input_price/output_price as decimal µcredit/token strings + modality. No backend change.
- `GET /admin/resources/:id/channels` — (ii) Existing. ChannelView now ALSO returns input_cost_per_1m/output_cost_per_1m (string|null µUSD/1M) — LIVE on main. Frontend type is the only gap.
- `POST /admin/resources/:id/channels` — (ii) Existing. createChannelSchema accepts inputCostUsdPer1m/outputCostUsdPer1m (HUMAN USD/1M, nonnegative, optional). Server converts → µUSD/1M.
- `PATCH /admin/resources/:id/channels/:channelId` — (ii) Existing. updateChannelSchema accepts inputCostUsdPer1m/outputCostUsdPer1m as nonnegative-nullable-optional: omit=unchanged, null=clear, number=set (HUMAN USD/1M).

**Client methods:**

- No NEW admin.ts methods. createChannel/updateChannel already exist; they pass the body through verbatim, so they pick up inputCostUsdPer1m/outputCostUsdPer1m automatically once CreateChannelBody/UpdateChannelBody gain the fields in types.ts.
- listChannels/getPage<ChannelView> auto-carry the new read fields once ChannelView gains input_cost_per_1m/output_cost_per_1m — no signature change.

**Query keys:**

- None new. Channel writes already invalidate qk.channels(resourceId) in ResourceDetailPane; model edits already invalidate qk.models()/qk.model(name) in ModelsPage/ModelEditor.

**Type changes:**

- ChannelView: + input_cost_per_1m: string | null; + output_cost_per_1m: string | null (µUSD/1M decimal strings; null = unset).
- CreateChannelBody: + inputCostUsdPer1m?: number; + outputCostUsdPer1m?: number (HUMAN USD/1M, nonnegative; omitted → null).
- UpdateChannelBody: + inputCostUsdPer1m?: number | null; + outputCostUsdPer1m?: number | null (omit=unchanged, null=clear, number=set; HUMAN USD/1M).
- (No ModelView change — input_price/output_price already exist as decimal µ-strings; modality already present.)

**Components:**

- Money (components/data/Money.tsx) — reuse for the Models price columns (µ-string → formatCredits; never Number()).
- NumberField (components/ui/NumberField.tsx) — reuse for the two ChannelEditor USD/1M cost inputs (same as existing weight/price fields, min=0).
- DataTable Column (components/data/DataTable) — reuse to add the two read-only channel cost columns + keep the model price columns.
- usdLabel pattern from OfficialPricesPage.tsx (µUSD/1M ÷ 1_000_000 → $X.XX) — extract/duplicate a small formatter for channel cost cells (NOT Money, which is credits not USD). No genuinely-new primitive required.

**TDD plan (failing tests first):**

- (ii) types: a compile/contract test (or tsc) asserting ChannelView has input_cost_per_1m/output_cost_per_1m and Create/Update bodies have the \*UsdPer1m fields with correct nullability.
- (ii) ChannelEditor.test: seeding — given a channel with input_cost_per_1m='500000' (µUSD/1M), the input field shows 0.5 (÷1e6). null → empty/0.
- (ii) ChannelEditor.test: create — typing 0.5 / 10 sends body.inputCostUsdPer1m=0.5, outputCostUsdPer1m=10 (HUMAN USD) to createChannel.
- (ii) ChannelEditor.test: PATCH semantics — unchanged field omitted; clearing a previously-set cost sends null; setting sends the number. Assert the three branches.
- (ii) ResourceDetailPane.test: chCols render — a channel with cost shows the µUSD/1M-÷1e6 dollar label; null cost renders '—'.
- (i) ModelsPage.test: price columns render via Money/formatCredits (e.g. input_price='1500000' → grouped credits, no raw Number), modality column present; sortValue compares BigInt-safely (large µ-strings don't collide via float).

**Acceptance criteria:**

- GROUP (i) Models price/modality density: ModelsPage's input/output price columns render the decimal µcredit/token strings through the Money primitive (formatCredits, divide-by-1e6 semantics, no naive Number()), retaining a per-token unit suffix; the modality column remains visible; price sorting is BigInt-safe (no float collision on large µ-strings). No backend change; ModelView fields unchanged.
- GROUP (ii) Channel cost/margin (Track-5, LIVE): ChannelView in types.ts gains input_cost_per_1m/output_cost_per_1m (string|null); Create/Update bodies gain inputCostUsdPer1m/outputCostUsdPer1m (HUMAN USD/1M; Update nullable). ChannelEditor shows two USD/1M cost NumberFields seeded by ÷1e6 from the µUSD/1M strings (null→0/empty), writes HUMAN USD on create, and on PATCH sends number to set / null to clear / omit when unchanged. ResourceDetailPane's channel table shows two read-only cost columns (µUSD/1M ÷1e6 dollar label, '—' when null). Saving round-trips: edit a cost, reopen, value persists; clear a cost, reopen, shows unset.

**Gotchas:**

- UNIT MISMATCH is the central hazard: model prices are µCREDIT-per-TOKEN (Money/formatCredits ÷1e6 = credits); channel costs are µUSD-per-1M-TOKENS (÷1e6 = USD). Do NOT reuse Money for channel cost (it formats credits + locale-credit symbol). Use a usdLabel-style formatter for channels, Money for models. They look similar (both ÷1e6) but mean different things.
- ChannelEditor currently builds a `base` object with undefined=omit for optional fields; for the COST fields on PATCH you must additionally support null=clear — undefined ≠ null. Model the cost inputs as a tri-state (empty→clear/null on edit, value→number) and only put providerType/cost on the right branch (create vs update) like the existing providerType handling.
- Create vs Update nullability differs: CreateChannelBody cost fields are number|undefined (no null — omit → server null); UpdateChannelBody cost fields are number|null|undefined. Don't send null on create.
- Backend stores µUSD/1M as bigint → decimal string; round-trip a human 0.5 → 500000 µUSD/1M on write, and 500000 → 0.5 on read. Use ÷1_000_000 (not 1e6 float math on huge values — these are small, ≤ a few $/1M, so Number ÷ 1e6 is safe here, unlike per-token credit sums; still prefer the OfficialPricesPage usdLabel precedent).
- input_cost_per_1m/output_cost_per_1m can be null (unknown cost / subscription channels ≈ 0) — render '—' in the table and empty in the editor, never $0.00 implying a real zero unless the stored value is actually 0.
- These channel costs drive usage_log.provider_cost + margin ONLY (UsageRollupView.provider_cost/margin) — they are NOT the customer price. Label them as 'operator cost' in copy so operators don't confuse them with resale price.
- Models tab is a DataTable (ModelsPage), NOT an EntityCard — the original 'EntityCard meta/chips' framing doesn't match the live code; implement on the existing price columns. ModelEditor already edits inputPrice/outputPrice as raw µcredit integers (NumberField) — leave that as-is; this ticket is display-only for models.
- ChannelEditor's `save` currently spreads `base` into both create and update; adding null-capable cost fields means the shared `base` can carry number|null, but create must coerce null→omit. Keep the create branch clean.

**Depends on:**

- Backend Track-5 channel cost columns + ChannelView serialization + create/update DTO cost fields (MERGED to main, LIVE — confirmed in admin.controller.ts toChannelView and admin.dto.ts create/updateChannelSchema).
- Existing hardened DataTable/NumberField/Money/Drawer component library (committed).

## CONSOLE-DASH-RANK: Per-model usage/cost ranking board on DashboardPage · effort M

**Goal:** Add a "Top models by cost" horizontal ranking board to the console Dashboard, fed by GET /admin/analytics/usage?groupBy=model, with a small dedicated RankingBar component that sorts desc by cost client-side (BigInt µ-string math), shows top-N, and optionally renders a signed margin column/series — surfacing the now-LIVE Track-5 provider_cost/margin economics.

**Files to touch:**

- `lib/api/types.ts` — Extend UsageRollupView (lines 151-159): add `provider_cost: string` and `margin: string` (both µUSD decimal-string sums; margin = cost − provider_cost and CAN BE NEGATIVE → leading '-'). Update the doc comment to note these are µUSD sums, never coerced through a float.
- `components/console/RankingBar.tsx` — NEW small presentational component (NOT a chart primitive). Props: rows: UsageRollupView[]; topN?: number (default 5); showMargin?: boolean (default true). Sorts a copy of rows desc by `cost` via a BigInt comparator (compareMicroDesc), slices topN, computes the max cost as BigInt for bar width %, renders one labeled horizontal bar per model (label=bucket, value=<Money micro={cost}/>), and when showMargin renders a signed margin cell using a new signed-money formatter. Use existing tokens (--s-\*, --r-md, glass/panel, --muted, .tabular, --ok/--fail tone for +/− margin). Bar fill width = Number only for the CSS percentage (presentation), never for money.
- `lib/money.ts` — Add helpers used by RankingBar: `compareMicroDesc(a: string, b: string): number` (BigInt(a) vs BigInt(b), returns -1/0/1 for desc sort) and `formatCreditsSigned(micro, locale?, maxFrac?)` that always prefixes a sign for nonzero values ('+' for positive, existing '-' for negative; '0' unprefixed). Reuse the existing string/BigInt formatCredits internals — do not introduce Number() on money.
- `features/console/DashboardPage.tsx` — Add a useQuery for analyticsUsage({groupBy:'model'}) keyed by qk.analyticsUsage({groupBy:'model'}) with staleTime STALE_VOLATILE; render a new SectionHeader('dashboard.ranking.title') + <RankingBar rows={usage.data ?? []} /> block above (or beside) Recent jobs. Handle loading (skeleton/placeholder) and empty (dashboard.ranking.empty). Note analyticsUsage returns a RAW ARRAY (no {rows}) — read usage.data directly, default to [].
- `i18n/locales/en/console.json` — Under dashboard add `ranking`: { title: 'Top models by cost', empty: 'No model usage yet', cols: { model, cost, margin } }.
- `i18n/locales/zh-CN/console.json` — Add the matching zh-CN `dashboard.ranking` keys.
- `components/console/RankingBar.test.tsx` — NEW unit test (sort/format/render top-N/signed margin).
- `lib/money.test.ts` — NEW (or extend) unit test for compareMicroDesc + formatCreditsSigned, including a large value that overflows Number.MAX_SAFE_INTEGER and a negative margin.
- `features/console/DashboardPage.test.tsx` — NEW render test: mock useAdminApi().analyticsUsage to resolve a 3-row array, assert the ranking section renders the top model first and a signed negative margin.

**Endpoints:**

- `GET /admin/analytics/usage?groupBy=model` — ALREADY LIVE + already wired in admin.ts as analyticsUsage(). Returns RAW UsageRollupView[] ARRAY — NO pagination envelope, NO {rows}. Each row now (Track-5, merged to main) includes provider_cost:string and margin:string (µUSD decimal-string sums; margin can be negative). bucket = model name when groupBy=model. No new endpoint or client method needed — only the type changes.

**Client methods:**

- NONE — analyticsUsage(params: AnalyticsUsageQuery): Promise<UsageRollupView[]> already exists in lib/api/admin.ts (line 128-129) and already returns the raw array via client.get<UsageRollupView[]>('/admin/analytics/usage', {...params}). The new provider_cost/margin fields flow through automatically once UsageRollupView is widened in types.ts.

**Query keys:**

- NONE NEW — reuse existing qk.analyticsUsage(params) (queryKeys.ts line 15-16). Call it as qk.analyticsUsage({ groupBy: 'model' }).

**Type changes:**

- UsageRollupView (lib/api/types.ts): + provider_cost: string; + margin: string; — both µUSD decimal-string sums, margin signed/possibly-negative. This mirrors the backend interface UsageRollupView in admin.controller.ts:309-320 and toUsageRollupView mapper at :1426 (row.providerCost.toString() / row.margin.toString()).

**Components:**

- REUSE Money (components/data/Money.tsx) for the cost cell — it wraps formatCredits and already truncates on the integer string.
- REUSE SectionHeader (components/ui/SectionHeader.tsx) for the board heading.
- REUSE existing CSS tokens/classes: glass/panel, --s-_, --r-md, --fs-_, --muted, .tabular, status tones --ok/--fail for +/− margin coloring.
- NEW primitive: RankingBar (components/console/RankingBar.tsx) — a small horizontal-bar list, EXPLICITLY NOT the full chart primitive. Pure/presentational: sorts desc by cost, top-N, optional signed-margin column.

**TDD plan (failing tests first):**

- money.test.ts — compareMicroDesc: write FIRST and watch fail. ['1000000','3000000','2000000'].sort(compareMicroDesc) === ['3000000','2000000','1000000']; equal values return 0; a value > Number.MAX_SAFE_INTEGER ('90071992547409910' vs '90071992547409920') still orders correctly (proves BigInt, not Number).
- money.test.ts — formatCreditsSigned: '2500000' → '+2.5'; '-2500000' → '-2.5'; '0' → '0' (no sign); large µ-string formats without float drift.
- RankingBar.test.tsx — sort+topN: given 6 unsorted rows, with topN=3 it renders exactly 3 bars and the highest-cost model's bucket label appears first in DOM order.
- RankingBar.test.tsx — signed margin render: a row with margin '-500000' renders a '-0.5' (fail-tone) margin cell; a positive margin renders '+'. With showMargin={false} no margin cell is rendered.
- RankingBar.test.tsx — empty: rows=[] renders nothing crashy (parent shows empty state); single-row renders a full-width (100%) bar.
- DashboardPage.test.tsx — render: mock useAdminApi so analyticsUsage resolves [{bucket:'gpt-4o',cost:'9000000',provider_cost:'7000000',margin:'2000000',...},{bucket:'claude',cost:'3000000',provider_cost:'4000000',margin:'-1000000',...}, ...]; assert the ranking SectionHeader title renders, the top model ('gpt-4o') appears before the second, and the negative margin '-1' is shown. Write before wiring the query.

**Acceptance criteria:**

- Dashboard shows a 'Top models by cost' board populated from GET /admin/analytics/usage?groupBy=model.
- Rows are sorted descending by cost using BigInt/string math — NEVER Number(micro) — verified by a test with a value exceeding Number.MAX_SAFE_INTEGER.
- Only the top-N (default 5) models render as horizontal bars.
- Cost renders via the existing Money/formatCredits path; margin renders SIGNED (+/−) and negative margins are visually distinct (fail tone).
- UsageRollupView includes provider_cost + margin and the type compiles against the live raw-array response (no envelope assumed).
- analyticsUsage query uses qk.analyticsUsage({groupBy:'model'}) + STALE_VOLATILE; loading and empty states are handled.
- RankingBar is a self-contained presentational component, not a wrapper over the full chart primitive.
- pnpm --filter web test passes (RankingBar + money + DashboardPage tests green); tsc clean.

**Gotchas:**

- Money is decimal µ-strings (µUSD here). Sort/compare/sum with BigInt() on the string; the ONLY permitted Number() is computing the CSS bar-width percentage (cost/maxCost\*100) AFTER BigInt math, and only for presentation — never to derive a displayed money value.
- Response is a RAW ARRAY, not the {data,next_cursor,has_more} (or {rows,nextCursor}) envelope — use client.get (already does) and read usage.data directly with a `?? []` default. Do not call .rows on it.
- margin CAN BE NEGATIVE (margin = cost − provider_cost). formatCredits already handles a leading '-'; the new formatCreditsSigned must add a '+' for positives and leave 0 unsigned. Render the sign; do not Math.abs it away.
- Bar-width percentage: when maxCost is 0 (all-zero costs) guard against divide-by-zero → render 0%-width bars, don't NaN.
- bucket is the grouping key; for groupBy=model it is the model name string — use it as both the visible label AND the stable React key (it is unique within the rollup). No lib/rowId needed here since it's not a server entity row.
- provider_cost is present in the row but the board's primary axis is cost; provider_cost is informational — only surface it if showMargin needs a tooltip. Keep the first cut to cost + signed margin.
- Backend deltas are LIVE on main/deployed (Track-5), so no mockBilling / design-only path — wire to the real analyticsUsage method, not the mock billing types in types.ts:188+.

**Depends on:**

- Track-5 backend (UsageRollupView.provider_cost + margin) — already MERGED to main + DEPLOYED; confirmed in admin.controller.ts:309-320 and toUsageRollupView at :1426. No backend work blocks this ticket.
- Hardened component library (Money, SectionHeader, --s-_/--r-_/tone tokens) — already committed.
