# Actionow Admin Frontend — Design Spec

> Status: design (brainstormed 2026-06-16; revised to align with backend Phase 7–10 + add i18n). Visual direction validated interactively (Liquid Glass · 活力黄 · 明暗双主题 · 鼠标流动背景 · GSAP). Next step after approval: `writing-plans`.

## 1. Goal & Scope

Build the **admin console** for Actionow (the multi-tenant AI-gateway / metered-billing platform). The backend (`apps/api`, NestJS) already exposes a complete admin REST surface; there is **no frontend yet**. This spec covers a new SPA at `apps/admin`.

The backend is moving fast (Phase 7 OSS files ✓, Phase 8 streaming/callbacks in progress, **Phase 9 OAuth + unified `user` ✓ merged**, Phase 10 payments in progress). This spec is **aligned to that current reality** (see §3) so the MVP doesn't get rebuilt when those land.

**Phasing (decided): MVP core loop first.** Ship a usable, demoable product that exercises the full stack (auth → typed API client → table/form/dialog/toast patterns) before scaling to all modules.

- **MVP (this spec drives the first plan):** Login · Dashboard · Tenants · Accounts (+ top-up) · API Keys.
- **Later phases (designed/reserved for, not built now):** Catalog (Resources + Channels) · Pricebook · Modifiers · Jobs monitor (stream/async-callback-aware) · Ledger audit · Dify import · **Payments / 对账 (Phase 10)** · **Files (Phase 7)** · Settings (incl. OAuth identity linking).

The architecture, design system, component library, data layer, **auth layer, and i18n** below are built **once** to serve all modules; only the feature screens are phased.

## 2. Tech Stack (decided)

| Concern | Choice | Why |
|---|---|---|
| Build | **Vite + React 19 + TypeScript** (SPA) | Internal admin against a separate API; no SSR; fast dev; lives at `apps/admin`. |
| Styling | **Tailwind CSS v4** (`@tailwindcss/vite`, `@theme`) | Required by coss; tokens via `@theme`. |
| Components | **coss** (Base UI primitives) + custom Liquid Glass layer | Accessible primitives; wrapped with glass styling. |
| Animation | **GSAP** (+ `useGSAP`, Flip) | Liquid background, nav-pill morph, count-ups, sheet transitions; cleanup via `useGSAP`. |
| Data | **TanStack Query v5** | Caching, mutations, keyset pagination, invalidation. |
| Routing | **React Router v7** | Nested layout + protected routes. |
| **i18n** | **i18next + react-i18next** + `i18next-browser-languagedetector` | zh-CN \| en from day one; namespaced JSON; `Intl` for number/currency/date. |
| Data source | **Real API + seed** | `docker compose up` + `pnpm --filter @actionow/api seed`; dev proxy to `:3000`. |
| Tests | **Vitest + Testing Library**; **Playwright** smoke (later) | Component + critical-path. |

## 3. Backend Roadmap Alignment (what's live / planned, and how the MVP accommodates it)

| Phase | Backend status | Frontend implication |
|---|---|---|
| 7 — OSS files | ✓ `/v1/files/*` (api-key/tenant-scoped) | No admin endpoint → **reserve** a Files module; relevant later for Catalog `file` io_schema. Not MVP. |
| 8 — exec modes | In progress: SSE `stream` + `async-callback`, `/v1/callbacks/:provider` | `exec_mode` values now include `stream`/`async-callback` → `StatusBadge`/exec-mode display + later **Jobs monitor** must handle them. A future "试运行" console could consume SSE. Not MVP. |
| 9 — OAuth + unified identity | ✓ **merged**: `user`+`user_identity` replace `admin_user`; `POST /auth/login`, `POST /auth/register`, `GET /auth/oauth/:provider`(+`/callback`), `POST /auth/link/:provider`; roles `admin\|user`; `/admin/auth/login` kept legacy | **Auth layer targets unified `/auth/login` and gates on `role==='admin'`** (see §10). OAuth buttons reserved (callback returns `{token}`; SPA redirect handoff is a backend follow-up). Settings will host identity linking. |
| 10 — payments | In progress: `payment_intent`/`payment_event`, `/v1/payments/*`, admin **列支付/对账** | Manual `POST /admin/accounts/:id/topup` stays as the operational tool for MVP but kept **minimal** (payments will supersede it). **Reserve** a Payments/对账 module; Ledger already shows `topup`-type rows. |

**Net effect on MVP:** the only structural change vs. a naive build is the **auth layer** (unified `/auth`, role-gated, OAuth-ready) and **reserved nav slots** (Payments, Files). Everything else (Tenants/Accounts/API-Keys/Dashboard) is unaffected by 7–10.

## 4. Monorepo Placement & Backend Touch-points

New package `apps/admin` (`@actionow/admin`), added to `pnpm-workspace.yaml` + `turbo.json` (`build`/`lint`/`typecheck`/`test`). **Leaf app** — must not import server packages; talks to the API only over HTTP.

**One backend change (in scope, minimal):** add CORS to [`apps/api/src/main.ts`](apps/api/src/main.ts) — `app.enableCors({ origin: env.ADMIN_ORIGIN ?? 'http://localhost:5173' })`, `ADMIN_ORIGIN` added to the infra env loader + `.env.example`. Token is sent in the `Authorization` header (not a cookie). **Note:** OAuth uses HttpOnly cookies on `/auth/oauth/*` — only relevant if/when the SPA wires the OAuth redirect (then CORS needs `credentials: true` + an allowlisted origin); MVP email/password login needs no cookies.

Dev wiring: Vite dev server on **5173**, proxy `'/admin'`,`'/auth'`,`'/v1'` → `http://localhost:3000` (no CORS in dev). API base from `VITE_API_BASE_URL` (default `''` → same-origin via proxy).

## 5. Design System / Tokens

Liquid Glass, dark-dominant, vibrant-yellow accent, **no blue**, **no emoji** (SVG line icons only). All tokens in `src/styles/theme.css` via `@theme` + `[data-theme]`; **never hard-code colors/spacing in components**.

**Accent:** `--accent:#FFD60A`; accent-strong gradient `#FFD60A→#FF9F0A` (active rail icon/emphasis); CTA = solid `--accent` + near-black ink `#1C1500`.

**Themes** (`data-theme` on `<html>`, persisted to `localStorage`, default dark, honor `prefers-color-scheme` first load):

| Token | Dark | Light |
|---|---|---|
| `--bg` | `#0d0c0a` | `#f1eee4` |
| `--text`/`--muted`/`--faint` | `#f2efe6`/`#9a9384`/`#8f897a` | `#272219`/`#7a7263`/`#9b927f` |
| `--glass-bg` | `rgba(255,255,255,.06)` | `rgba(255,255,255,.55)` |
| `--glass-bd` | `rgba(255,255,255,.12)` | `rgba(0,0,0,.05)` |
| `--glass-hl` | `rgba(255,255,255,.22)` | `rgba(255,255,255,.65)` |
| `--glass-shadow` | `0 1px 1px rgba(0,0,0,.25),0 12px 28px rgba(0,0,0,.4)` | `0 1px 2px rgba(60,45,5,.05),0 10px 24px rgba(120,90,20,.1)` |
| `--panel-bg` | `rgba(18,16,12,.82)` | `rgba(255,255,255,.66)` |
| blobs `--b1/2/3`,`--spot` | warm amber/gold/orange | softer warm |

**Spacing:** 8px grid (`--s-1..--s-8` = 4/8/12/16/20/24/32); gutter 16, module gap 12, card pad 16. **Radii:** `--r-sm:11 --r-md:14 --r-lg:18 --r-pill:20`. **Type:** system UI; bold, slightly tight headings; `tabular-nums` for money/metrics. **Status:** succeeded=green, running=amber, queued=orange, failed=red, canceled=neutral (no blue).

## 6. Liquid Glass Implementation Strategy

Apple's rule — **glass = functional layer above content; content stays primary.** Tiered (SVG refraction is Chromium-only, GPU-costly 1–3/viewport):

1. **Chrome = glass.** `.glass` utility: `var(--glass-bg)` + `backdrop-filter:blur(22px) saturate(170%)` + `1px var(--glass-bd)` + `inset 0 1px 0 var(--glass-hl)` + `var(--glass-shadow)`. → rail, sub-nav, top bar, stat cards, buttons, dialogs/sheets, dropdowns, toasts, login card.
2. **Content = legible.** Tables/forms on `--panel-bg` (near-opaque, light `blur(10px)`), tabular numerals, high-contrast badges. **Never** heavy glass behind dense data.
3. **Hero refraction (1–2 spots max):** login card + active nav pill may use an SVG filter (`feTurbulence`+`feDisplacementMap`+`feSpecularLighting`) via `filter:url(#lg-refract)`, gated by `@supports (backdrop-filter:url(#x))` with a static-glass fallback (Safari/Firefox). Defined once in a hidden `<svg>` (`glass-filters.tsx`).
4. **Ambient background (`AppBackground`):** 3 warm blurred radial blobs + cursor-tracking spotlight (the layer the mouse interacts with).

## 7. GSAP Animation Spec

`useGSAP` (scoped, auto-cleanup). **Autonomous** motion gated by `prefers-reduced-motion`; **pointer-driven** parallax stays on. Transforms/opacity only.

| # | Motion | Technique | Reduced-motion |
|---|---|---|---|
| 1 | Blobs follow cursor (3 depths + reverse) | `gsap.quickTo`, listener on **`document`**, offset from stage rect | keep |
| 2 | Cursor spotlight | `gsap.quickTo` + opacity fade | keep |
| 3 | Idle blob breathing | `gsap.to(...,{yoyo,repeat:-1,'sine.inOut'})` | disable |
| 4 | Active nav pill morph | GSAP **Flip** (or `offsetTop/offsetHeight` tween) | snap |
| 5 | Stat count-up | `gsap.to({v:0}→target,onUpdate)` | final value |
| 6 | Dialog/sheet materialize | scale `.98→1`+opacity+blur-in | opacity only |
| 7 | Row stagger / toast slide | `gsap.from(rows,{stagger})` | none |

`src/lib/motion/`: `gsap.ts` (register Flip), `useReducedMotion.ts`. **Lessons baked in:** mouse listener on `document` (not a glass-covered element); pointer parallax **not** gated by reduced-motion.

## 8. Component Inventory

**coss-based UI (`components/ui/`, glass-styled):** `Button`, `Dialog`, `Field`/`Input`/`Label`, `Select`, `Toast`/`Toaster`, `Menu`, `Tooltip`, `Tabs`, `Switch` (patterns via coss + coss-particles at implementation).

**Custom glass + layout:** `GlassPanel`, `GlassButton`, `StatCard` (count-up), `AppBackground`, `glass-filters`; `AppShell` (icon rail + sub-nav + top bar + `<Outlet/>`), `NavRail`, `SubNav` (Flip pill), `TopBar` (title + search + CTA slot + admin menu + **lang switch**), `ThemeToggle`.

**Data:** `DataTable` (column defs, skeleton, empty/error), `StatusBadge` (incl. stream/async-callback/exec-mode values), `KeysetPagination`, `CopyField` (one-time secret reveal), `Money` (µcredit→display), `RelativeTime`. **Feedback:** `EmptyState`, `ErrorState`, `Skeleton`, `ConfirmDialog`.

## 9. App Shell & Navigation

Shell **B** (validated): icon rail (top-level groups) → sub-nav (pages) → content. Routes (MVP built; rest reserved):

```
/login                         (public)
/  → /dashboard
/dashboard                     Dashboard
/tenants                       Tenants
/accounts                      Accounts (+ top-up)
/api-keys                      API keys
/catalog · /pricing · /modifiers · /jobs · /ledger · /payments · /dify · /files · /settings   [later]
```

Rail groups: **运营**(Dashboard, Tenants) · **计费**(Accounts, Ledger, **Payments/对账**, Pricing, Modifiers) · **目录**(Catalog, Dify, Files) · **监控**(Jobs) · **设置**(incl. OAuth identity).

## 10. Auth Layer (Phase-9-ready)

Backend (Phase 9, merged): unified `user` with `role` (`admin`/`user`); `POST /auth/login {email,password} → {token}` (JWT `{sub,role}`); OAuth `GET /auth/oauth/:provider`(+`/callback` returns `{token}`); `/admin/auth/login` legacy.

Frontend:
- `lib/auth/` with a small **auth client** pointed at a configurable `AUTH_BASE` (default `/auth`) so the path is one constant, not scattered. MVP calls `POST {AUTH_BASE}/login`.
- **Gate on role:** after login, decode the JWT; require `role === 'admin'` (else show "需要管理员权限"). This is what makes a *unified* user model serve an *admin* console.
- Token in `localStorage` (+ in-memory mirror); `ProtectedRoute` guards the shell; `401`/expired → clear + `/login`. No refresh endpoint → re-login (noted limitation).
- **OAuth reserved:** Login page renders disabled-but-present "用 Google / GitHub 登录" buttons behind a `VITE_OAUTH_ENABLED` flag (default off) → `GET /auth/oauth/:provider`. Enabled once the backend wires the callback→SPA redirect handoff. **No public register** in the admin console (admins are provisioned).

## 11. Data Layer

**Typed client (`lib/api/`):** hand-written, mirrors the controller's snake_case JSON views (`types.ts`); ~19 endpoints (OpenAPI codegen from `/docs` is a future option). `client.ts` = `fetch` wrapper: base URL + `Authorization: Bearer`, parses the unified error envelope (shape per [`common/unified-error.filter.ts`](apps/api/src/common/unified-error.filter.ts) — confirm in plan) → typed `ApiError { code, message, retryAfterMs? }`; `401` → clear token → `/login`.

**Money:** balances/costs arrive as **decimal µcredit strings**. `lib/money.ts` parses via BigInt and formats µ→credits (÷1e6); inputs (top-up, opening credits) are **human credits** sent as numbers. Never `Number()` a raw µcredit string for math. Display via `Intl.NumberFormat` (locale-aware).

**Pagination:** `lib/query.ts` `useKeyset(endpoint, params)` — cursor = last row `created_at` ISO; `limit` default 50 (max 200); consumes `next_cursor`. Query keys per resource; mutations invalidate lists.

## 12. i18n (zh-CN | en from day one)

- **Stack:** `i18next` + `react-i18next` + `i18next-browser-languagedetector`. Init in `src/i18n/index.ts`; `<Suspense>`-safe.
- **Resources:** `src/i18n/locales/{zh-CN,en}/{common,auth,tenants,accounts,apiKeys,dashboard,errors}.json` (namespaced per feature). **All user-facing copy goes through `t()` from the start** — no hard-coded strings in components (same discipline as design tokens).
- **Language:** default detected from `navigator.language` (fallback `zh-CN`), persisted to `localStorage`; **language switcher** in the top bar / admin menu (中文 / English). `<html lang>` updated on change.
- **Formatting:** numbers/credits/currency/dates via `Intl.*` keyed to the active locale (not hard-coded `¥` or `,`).
- **Errors:** backend `ApiError.code` (e.g. `insufficient_credits`, `unauthorized`) maps to localized messages in the `errors` namespace; fall back to the backend `message` only when no key exists. Keeps error UX translatable.
- **Scope note:** copy is authored in both locales as screens are built; zh-CN is the source of truth, en kept in parity. RTL is out of scope.

## 13. MVP Screens

- **Login** — centered glass card (hero-refraction candidate) over `AppBackground`; email + password (coss `Field`); submit → `POST /auth/login` → require `role==='admin'` → store token → `/dashboard`; error toast on 401/non-admin. Reserved OAuth buttons (flag-gated). Lang + theme switch present.
- **Dashboard** — 4 `StatCard`s (tenants, active API keys, today's jobs, today's spend) with count-up; "Recent jobs" `DataTable`. *No single stats endpoint exists → aggregate client-side from list endpoints; any count needing server support is flagged in the plan, not invented.*
- **Tenants** — `DataTable` (name, isolation_mode, created_at); "新建租户" `Dialog` (name + isolationMode `Select`). Create → invalidate + toast.
- **Accounts** — list per tenant (`Money` balance, held, created_at); create (tenant `Select` + opening credits); row **Top up** `Dialog` (credits) → refresh. (Kept minimal — Phase 10 payments will extend this.)
- **API Keys** — list per tenant; **Mint key** `Dialog` (tenant, resource allowlist, rate limit) → result shows **plaintext once** in `CopyField` with a clear "不会再次显示" warning.

## 14. Accessibility

- coss/Base UI primitives → focus management, ARIA, keyboard for dialogs/menus/selects.
- **Reduce transparency / increase contrast** toggle (+ honor `prefers-reduced-transparency`/`prefers-contrast`) swaps glass tokens for near-opaque surfaces (Apple's required path).
- Text on glass meets **WCAG AA**; badges carry text not color alone; full keyboard nav; visible focus; `prefers-reduced-motion` respected (§7).

## 15. Testing & Verification Gate

- Vitest + Testing Library for `DataTable`, `Money`, `KeysetPagination`, API-client error mapping, **auth role-gating**, **i18n key coverage (no missing keys; zh/en parity)**, and each MVP screen's happy path with a mocked client.
- `pnpm --filter @actionow/admin typecheck && lint && build && test` green; wired into turbo.
- Playwright smoke against seeded API (later): login → create tenant → create account → top up → mint key.

## 16. Out of Scope (now)

Catalog/Pricebook/Modifiers/Jobs/Ledger/**Payments**/Dify/Files/Settings screens; OAuth SPA redirect login (until backend wires the handoff); OpenAPI codegen; token refresh; RTL locales.

## 17. Assumptions & Open Items (resolve early in the plan)

1. **Error-envelope shape** — read `common/unified-error.filter.ts`.
2. **Dashboard aggregates** — client-side from existing lists for MVP; flag any count needing a new endpoint (don't invent `/admin/stats`).
3. **Auth target** — admin SPA uses unified `POST /auth/login` + `role==='admin'` gate; `/admin/auth/login` legacy not used. Confirm the JWT role claim name.
4. **CORS env** `ADMIN_ORIGIN` — confirm infra `loadEnv` extension.
5. **Branch base** — `feat/admin-frontend` is currently off the Phase-8 base; **rebase onto the latest backend (with `/auth` + CORS hook) before implementation**.
6. coss exact install/import (skill at implementation).
7. en copy authored in parity with zh-CN as screens land.
