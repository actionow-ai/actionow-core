# Actionow Console Build-out — Design Spec (F0 + F1)

**Date:** 2026-06-16
**Surface:** `apps/web` (Vite + React 19 + TS + Tailwind v4, Liquid-Glass design system, GSAP, i18n zh/en)
**Branch:** `feat/admin-frontend`
**Status:** Approved design — input to `writing-plans`.

## Goal

Make the two backend-ready surfaces real in the frontend:

- **F0 — Operator console** (`/console`, admin JWT → `/admin/*`): full catalog + observability so an operator can stand up sellable models and watch the platform.
- **F1 — Tenant self-service console** (`/app`, user JWT → `/console/*`): the customer back-office that fulfills the landing promise ("把你的客户变成租户"): keys, usage, models, self top-up.

One spec, **sliced implementation**: shared foundation first, then the two surfaces. The implementation plan (writing-plans) phases the slices.

## Locked decisions (from brainstorming)

1. **One combined console spec**, implemented in slices (shared foundation → operator → tenant).
2. **Full operator catalog** this round: resources + upstream channels + pricebook + modifiers + Dify import + jobs + ledger + payments list. (Track C's model-registry / redemption-codes / global-stats are **NOT** shipped on the backend → out of scope, F3.)
3. **Tenant top-up = real intent flow**: `POST /console/payments/intents` → render `redirect_url`/`qr` → poll/refresh balance. Actual settlement is the backend webhook's job; sandbox/stub providers still exercise the full UI flow.

## Architecture (approach A)

Layered API clients + a shared console kit + two app shells.

- **API clients** (`lib/api/`): keep the existing fetch wrapper ([client.ts](apps/web/src/lib/api/client.ts)) and `admin` client; add a **`console` client** for `/console/*` (user JWT, tenant-scoped by the backend `ConsoleGuard`). No `v1` client this round (playground is F2). Errors flow through the existing `ApiError` (envelope §4.7) → `errors.*` i18n.
- **Query layer:** TanStack Query v5; stable query-key conventions per surface (`['admin', ...]`, `['console', ...]`); a **keyset pagination hook** for cursor endpoints (`next_cursor`).
- **Shared console kit** (`components/data/` + `components/ui/`): extend [DataTable](apps/web/src/components/data/DataTable.tsx) (already uses RoseLoader for loading) with status badges + a keyset pager; add `FormDrawer` (create/edit panels), `MoneyCell` (`formatCredits` from [money.ts](apps/web/src/lib/money.ts)), `StatusToggle` (soft enable/disable), `EmptyState`, `SectionHeader`, `CopyableSecret` (one-time API-key plaintext reveal — `apiKeys.reveal` i18n already exists).
- **Shells:** operator reuses [ConsoleLayout](apps/web/src/components/console/ConsoleLayout.tsx) (extend [nav-config](apps/web/src/components/console/nav-config.tsx) with a "目录/Catalog" group); tenant `/app` gets a **new, lighter shell** — desktop left sidebar + topbar (balance, lang, theme, logout, 返回官网), mobile bottom tab bar — replacing the [UserHome](apps/web/src/features/app/UserHome.tsx) placeholder.
- **Role routing** (already in [ProtectedRoute](apps/web/src/lib/auth/ProtectedRoute.tsx)): admin → `/console`, user → `/app`.

Money is bigint µcredits serialized as decimal strings → parse to `bigint`, render via `formatCredits`. No floats.

## F0 — Operator console (`/console`, `/admin/*`)

Nav groups (Rail): **运营** · **目录** · **租户** · **支付**.

| Screen          | Route                    | API                                       | Notes                                                                                                                |
| --------------- | ------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Dashboard       | `/console/dashboard`     | existing                                  | keep; link out to jobs/ledger                                                                                        |
| Jobs            | `/console/jobs`          | `GET /admin/jobs?tenantId&cursor&limit`   | keyset pager, filter by tenant; row → Job detail                                                                     |
| Job detail      | `/console/jobs/:id`      | from list row                             | status / exec_mode / cost; **output preview** incl. R2 media (image/video/audio)                                     |
| Ledger          | `/console/ledger`        | `GET /admin/ledger?tenantId&cursor&limit` | keyset pager; type, credits_delta, balance_after                                                                     |
| Resources       | `/console/resources`     | `GET/POST /admin/resources`               | list + create (id, kind, modality, providerType, execModes, ioSchema, version)                                       |
| Resource detail | `/console/resources/:id` | resource + channels + pricebook           | sections below                                                                                                       |
| — Channels      | within resource detail   | `POST /admin/resources/:id/channels`      | **fields incl. real-providers**: providerType, credentialRef, **endpoint, model, proxy_ref, config**, weight, status |
| — Pricebook     | within resource detail   | `GET/POST /admin/pricebook?resourceId`    | method/timing/spec/markup/active                                                                                     |
| Modifiers       | `/console/modifiers`     | `GET/POST /admin/modifiers`               | scope (global/tenant/resource/capability), whenExpr, op, value, priority, active                                     |
| Dify import     | `/console/dify`          | `POST /admin/dify/import`                 | yaml + endpoint + pricingModel → registers a resource; show compat_report                                            |
| Tenants         | `/console/tenants`       | existing                                  | keep                                                                                                                 |
| Accounts        | `/console/accounts`      | existing                                  | keep                                                                                                                 |
| API Keys        | `/console/api-keys`      | existing                                  | keep                                                                                                                 |
| Payments        | `/console/payments`      | `GET /admin/payments?tenantId`            | per-tenant intent list (provider/purpose/amount/status)                                                              |

Backend has **no DELETE** — lifecycle is create + soft-disable via `status`; UI uses `StatusToggle`, never a delete button.

## F1 — Tenant console (`/app`, `/console/*`)

New shell; nav: **概览 · API Keys · 用量 · 模型 · 充值**.

| Screen   | Route         | API                                                                   | Notes                                                                                                                                                               |
| -------- | ------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview | `/app`        | `GET /console/usage`                                                  | credit balance / held + usage summary, quick links. **Balance = latest ledger `balance_after`** (0 if no ledger rows); no dedicated console balance endpoint exists |
| API Keys | `/app/keys`   | `GET/POST /console/api-keys`, `POST .../:id/rotate`, `DELETE .../:id` | create / rotate / disable; **one-time plaintext** via `CopyableSecret`                                                                                              |
| Usage    | `/app/usage`  | `GET /console/usage?cursor&limit`                                     | own jobs + ledger, keyset                                                                                                                                           |
| Models   | `/app/models` | `GET /console/models`                                                 | visible models (name/display/modality/capabilities/visibility); may be sparse until Track C lands                                                                   |
| Top-up   | `/app/topup`  | `POST /console/payments/intents`                                      | pick provider + amount → `redirect_url`/`qr` → poll balance refresh                                                                                                 |

## Cross-cutting

- **i18n:** extend the `console` namespace (zh + en) with all new screen strings; keep parity.
- **Errors:** `ApiError.code` → `errors.*` toast; network → `errors.network`.
- **Loading:** `RoseLoader` / `LoadingScreen` everywhere; honor `prefers-reduced-motion`.
- **Responsive:** operator Rail→mobile bottom tabs (existing pattern); tenant shell desktop sidebar→mobile bottom tabs. Buttons never wrap; icon-only on mobile overflow. No blue, no emoji.
- **Auth:** admin → operator; user → tenant. Register provisions user+tenant (existing).

## Testing & verification

- `pnpm --filter @actionow/web typecheck && lint && build` green per slice.
- Verify against the **real API on :3000**: seed admin (`admin@actionow.local`) for operator; register a fresh user for the tenant console; exercise create-key / rotate / usage / top-up-intent end-to-end in the browser preview (drive frames manually when the preview tab is backgrounded).
- Confirm keyset pagination, one-time secret reveal, money formatting, and role routing.

## Out of scope (later phases)

- **F2:** multimodal playground over `/v1/run` (+ Track A chat-completions endpoints when merged); `/v1/files` upload UI.
- **F3:** Track C model registry / redemption codes / global usage stats UI; pricing refinement.
- **F4:** real payment-provider settlement UX (webhook is backend); OAuth login buttons (enable `config.oauthEnabled`); billing history/receipts.
- Refining the placeholder media pricing rates.

## Decisions deferred to writing-plans

- Exact slice ordering (foundation → operator catalog → operator observability → tenant shell → tenant screens) and which slices ship as independent commits.
- JSON-shaped inputs (`ioSchema` / channel `config` / pricebook `spec`): use a **validated JSON textarea** now (guided field-builders are a later refinement).
