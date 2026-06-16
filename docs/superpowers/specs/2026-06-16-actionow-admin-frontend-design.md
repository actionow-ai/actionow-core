# Actionow Admin Frontend — Design Spec

> Status: design (brainstormed 2026-06-16). Visual direction validated interactively (Liquid Glass · 活力黄 · 明暗双主题 · 鼠标流动背景 · GSAP). Next step after approval: `writing-plans`.

## 1. Goal & Scope

Build the **admin console** for Actionow (the multi-tenant AI-gateway / metered-billing platform). The backend (`apps/api`, NestJS) already exposes a complete admin REST surface; there is **no frontend yet**. This spec covers a new SPA at `apps/admin`.

**Phasing (decided): MVP core loop first.** Ship a usable, demoable product that exercises the full stack (auth → typed API client → table/form/dialog/toast patterns) before scaling to all modules.

- **MVP (this spec drives the first plan):** Login · Dashboard · Tenants · Accounts (+ top-up) · API Keys.
- **Later phases (designed for, not built now):** Catalog (Resources + Channels) · Pricebook · Modifiers · Jobs monitor · Ledger audit · Dify import · Settings.

The architecture, design system, component library, and data layer below are built **once** to serve all modules; only the feature screens are phased.

## 2. Tech Stack (decided)

| Concern     | Choice                                                     | Why                                                                                                                 |
| ----------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Build       | **Vite + React 19 + TypeScript** (SPA)                     | Internal admin against a separate API; no SSR needed; fast dev; lives in the monorepo at `apps/admin`.              |
| Styling     | **Tailwind CSS v4** (`@tailwindcss/vite`, `@theme`)        | Required by coss; tokens via `@theme`.                                                                              |
| Components  | **coss** (Base UI primitives) + custom Liquid Glass layer  | Accessible primitives (Dialog/Select/Field/Toast/Menu/Tabs/Tooltip); we wrap them with glass styling.               |
| Animation   | **GSAP** (+ `useGSAP`, Flip plugin)                        | Liquid background, nav-pill morph, count-ups, sheet transitions; framework-agnostic, cleanup via `useGSAP`/context. |
| Data        | **TanStack Query v5**                                      | Caching, mutations, keyset pagination, invalidation.                                                                |
| Routing     | **React Router v7**                                        | Nested layout routes, protected routes.                                                                             |
| Data source | **Real API + seed**                                        | `docker compose up` + `pnpm --filter @actionow/api seed`; dev proxy to `:3000`.                                     |
| Tests       | **Vitest + Testing Library**; **Playwright** smoke (later) | Component + critical-path coverage.                                                                                 |

## 3. Monorepo Placement & Backend Touch-points

New package `apps/admin` (`@actionow/admin`), added to `pnpm-workspace.yaml` and `turbo.json` pipelines (`build`/`lint`/`typecheck`/`test`). It is a **leaf app** — it must not import server packages; it talks to the API only over HTTP.

**One backend change (in scope, minimal):** add CORS to [`apps/api/src/main.ts`](apps/api/src/main.ts) — `app.enableCors({ origin: env.ADMIN_ORIGIN ?? 'http://localhost:5173', credentials: false })`, with `ADMIN_ORIGIN` added to the infra env loader + `.env.example`. The token travels in the `Authorization` header (not a cookie), so credentials stay off.

Dev wiring: Vite dev server on **5173** with a proxy `'/admin' → http://localhost:3000` and `'/v1' → :3000` (avoids CORS in dev; the `enableCors` covers non-proxied / prod). API base URL from `VITE_API_BASE_URL` (default `''` → same-origin via proxy in dev).

## 4. Design System / Tokens

Liquid Glass, dark-dominant, vibrant-yellow accent, **no blue**, **no emoji** (SVG line icons only). All tokens defined in `src/styles/theme.css` via `@theme` + `[data-theme]` overrides; **never hard-code colors/spacing in components**.

**Accent:** `--accent: #FFD60A` (vibrant yellow); accent-strong gradient `#FFD60A → #FF9F0A` for the active rail icon and emphasis; CTA = solid `--accent` with near-black ink `#1C1500`.

**Themes (`data-theme` on `<html>`, persisted to `localStorage`, default dark, honor `prefers-color-scheme` on first load):**

| Token                              | Dark                                                    | Light                                                         |
| ---------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| `--bg`                             | `#0d0c0a`                                               | `#f1eee4`                                                     |
| `--text` / `--muted` / `--faint`   | `#f2efe6` / `#9a9384` / `#8f897a`                       | `#272219` / `#7a7263` / `#9b927f`                             |
| `--glass-bg`                       | `rgba(255,255,255,.06)`                                 | `rgba(255,255,255,.55)`                                       |
| `--glass-bd`                       | `rgba(255,255,255,.12)`                                 | `rgba(0,0,0,.05)`                                             |
| `--glass-hl` (inset top sheen)     | `rgba(255,255,255,.22)`                                 | `rgba(255,255,255,.65)`                                       |
| `--glass-shadow`                   | `0 1px 1px rgba(0,0,0,.25), 0 12px 28px rgba(0,0,0,.4)` | `0 1px 2px rgba(60,45,5,.05), 0 10px 24px rgba(120,90,20,.1)` |
| `--panel-bg` (content surfaces)    | `rgba(18,16,12,.82)`                                    | `rgba(255,255,255,.66)`                                       |
| ambient blobs `--b1/2/3`, `--spot` | warm amber/gold/orange                                  | softer warm                                                   |

**Spacing:** 8px grid — `--s-1:4 --s-2:8 --s-3:12 --s-4:16 --s-5:20 --s-6:24 --s-8:32`. App gutter 16, module gap 12, card padding 16. **Radii:** `--r-sm:11 --r-md:14 --r-lg:18 --r-pill:20`. **Type:** system UI stack; bold, slightly tight headings (Apple "bold left-aligned"); `font-variant-numeric: tabular-nums` for all money/metrics.

**Semantic status:** succeeded=green, running=amber, queued=orange, failed=red, canceled=neutral (no blue anywhere).

## 5. Liquid Glass Implementation Strategy

Faithful to Apple's rule — **glass is a functional layer above content; content stays primary.** Tiered for performance & legibility (research: SVG-in-`backdrop-filter` refraction is Chromium-only and GPU-costly at 1–3/viewport).

1. **Chrome = glass.** `.glass` utility: `var(--glass-bg)` + `backdrop-filter: blur(22px) saturate(170%)` + `1px var(--glass-bd)` + `inset 0 1px 0 var(--glass-hl)` + `var(--glass-shadow)`. Applies to: nav rail, sub-nav, top bar, stat cards, buttons, dialogs/sheets, dropdowns, toasts, the login card.
2. **Content = legible.** Tables/forms sit on `--panel-bg` (near-opaque, light `blur(10px)`), tabular numerals, high-contrast badges. **Never** heavy glass behind dense data.
3. **Hero refraction (1–2 spots max):** login card + active nav pill may use an SVG filter (`feTurbulence`+`feDisplacementMap`+`feSpecularLighting`) referenced via `filter: url(#lg-refract)`, gated by `@supports (backdrop-filter: url(#x))` with a static-glass fallback for Safari/Firefox. Defined once in a hidden `<svg>` (`glass-filters.tsx`).
4. **Ambient background (`AppBackground`):** 3 blurred warm radial blobs behind the chrome (glass needs something to refract) + a cursor-tracking spotlight. This is the layer the mouse interacts with.

## 6. GSAP Animation Spec

Use `useGSAP` (scoped context, auto-cleanup). All **autonomous** motion gated by `prefers-reduced-motion`; **pointer-driven** parallax stays on (user-initiated). Prefer transforms/opacity only (perf).

| #   | Motion                                                                         | Technique                                                                  | Reduced-motion        |
| --- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | --------------------- |
| 1   | Ambient blobs follow cursor (liquid parallax, 3 depths + reverse for parallax) | `gsap.quickTo(blob,'x/y')`, listener on `document`, offset from stage rect | keep (pointer-driven) |
| 2   | Cursor spotlight glow                                                          | `gsap.quickTo(spot,'x/y')`, fade opacity on enter/leave                    | keep                  |
| 3   | Idle blob breathing/drift                                                      | `gsap.to(...,{yoyo,repeat:-1,ease:'sine.inOut'})` on inner element         | disable (static)      |
| 4   | Active nav pill morphs between items                                           | GSAP **Flip** (or `offsetTop/offsetHeight` tween)                          | instant snap          |
| 5   | Stat number count-up on mount                                                  | `gsap.to({v:0}→target, onUpdate)`                                          | set final value       |
| 6   | Dialog/sheet "materialize"                                                     | scale `.98→1` + opacity + blur-in                                          | opacity only          |
| 7   | Table rows stagger-in / toast slide                                            | `gsap.from(rows,{stagger})`                                                | none/opacity          |

`src/lib/motion/`: `gsap.ts` (register Flip once), `useReducedMotion.ts`. **Important lesson baked in:** the mouse listener attaches to `document` (not a glass-covered element), and pointer parallax must **not** be gated behind reduced-motion.

## 7. Component Inventory

**coss-based UI wrappers** (`components/ui/`, glass-styled): `Button`, `Dialog`, `Field`/`Input`/`Label`, `Select`, `Toast`/`Toaster`, `Menu` (admin dropdown), `Tooltip`, `Tabs`, `Switch`. Install patterns via the coss skill + coss-particles at implementation time.

**Custom Liquid Glass + layout (`components/glass/`, `components/layout/`):**

- `GlassPanel`, `GlassButton`, `StatCard` (with count-up), `AppBackground` (blobs + spotlight + parallax), `glass-filters` (SVG defs).
- `AppShell` (icon rail + sub-nav + top bar + `<Outlet/>`), `NavRail`, `SubNav` (Flip pill), `TopBar` (title + search + CTA slot + admin menu), `ThemeToggle`.

**Data (`components/data/`):** `DataTable` (column defs, loading skeleton, empty/error states), `StatusBadge`, `KeysetPagination` (cursor next/prev), `CopyField` (one-time secret reveal + copy), `Money` (µcredit→display), `RelativeTime`.

**Feedback:** `EmptyState`, `ErrorState`, `Skeleton`, `ConfirmDialog`.

## 8. App Shell & Navigation

Shell **B** (validated): thin **icon rail** (top-level groups) → **sub-nav** (pages in the group) → **content**. Route map (MVP routes built; rest reserved):

```
/login                         (public)
/                → redirect /dashboard
/dashboard       Dashboard
/tenants         Tenants list + create
/tenants/:id     Tenant detail (accounts, keys)        [later]
/accounts        Accounts list + create + top-up
/api-keys        API keys list + mint
/catalog · /pricing · /modifiers · /jobs · /ledger · /dify · /settings   [later]
```

Rail groups: **运营** (Dashboard, Tenants) · **计费** (Accounts, Ledger, Pricing, Modifiers) · **目录** (Catalog, Dify) · **监控** (Jobs) · **设置**.

## 9. Data Layer

**Typed client (`lib/api/`):** hand-written thin client mirroring the controller's snake_case JSON views (`types.ts`), since the surface is ~19 endpoints (codegen from `/docs` `openapi.json` is a noted future option). `client.ts` = `fetch` wrapper: injects base URL + `Authorization: Bearer`, parses the unified error envelope (shape per [`common/unified-error.filter.ts`](apps/api/src/common/unified-error.filter.ts) — confirm in plan), throws a typed `ApiError { code, message, retryAfterMs? }`. On `401` → clear token, redirect `/login`.

**Money:** all balances/costs arrive as **decimal µcredit strings**. `lib/money.ts` parses safely (BigInt) and formats `µ → credits` (÷1_000_000) for display; inputs (top-up, opening credits) are **human credits** sent as numbers (backend converts). Never use `Number` on raw µcredit strings for math.

**Pagination:** `lib/query.ts` `useKeyset(endpoint, params)` — cursor = last row `created_at` ISO; `limit` default 50 (max 200); consumes `next_cursor`.

**Query keys** per resource; mutations invalidate lists (e.g. create tenant → invalidate `['tenants']`).

## 10. Auth Flow

`POST /admin/auth/login {email,password} → { token }` (JWT, role `admin`, ~12h TTL). `lib/auth/store.ts` stores the token (`localStorage`, in-memory mirror) + decodes role/exp for display. `ProtectedRoute` guards the shell; missing/expired token → `/login`. No refresh endpoint yet → on 401 re-login (noted limitation).

## 11. MVP Screens

- **Login** — centered glass card (hero refraction candidate) over ambient background; email + password (coss `Field`); error toast on 401; submit → store token → `/dashboard`.
- **Dashboard** — 4 `StatCard`s (tenants, active API keys, today's jobs, today's spend) with count-up; "Recent jobs" `DataTable`. _(Note: there is no single stats endpoint; dashboard aggregates from existing list endpoints — tenants count, etc. Heavy aggregates that need new endpoints are deferred/stubbed and called out in the plan.)_
- **Tenants** — `DataTable` (name, isolation_mode, created_at); "新建租户" → `Dialog` (name + isolationMode `Select`: field/schema/db). Create → invalidate list + toast.
- **Accounts** — list per tenant (balance via `Money`, held, created_at); create account (tenant `Select` + opening credits); row action **Top up** → `Dialog` (credits) → optimistic balance refresh.
- **API Keys** — list per tenant (id, allowlist, rate_limit, status, created_at); **Mint key** → `Dialog` (tenant, resource allowlist, rate limit) → result shows **plaintext once** in a `CopyField` with a clear "won't be shown again" warning.

## 12. Accessibility

- coss/Base UI primitives provide focus management, ARIA, keyboard for dialogs/menus/selects.
- **Reduce transparency / increase contrast:** a "降低透明度" toggle (and honor `prefers-reduced-transparency`/`prefers-contrast`) swaps glass tokens for near-opaque surfaces — Apple's required accessibility path.
- All text on glass meets **WCAG AA**; status badges carry text, not color alone.
- Full keyboard nav; visible focus rings; `prefers-reduced-motion` respected (§6).

## 13. Testing & Verification Gate

- Component tests (Vitest + Testing Library) for `DataTable`, `Money`, `KeysetPagination`, the API client error mapping, and each MVP screen's happy path with a mocked client.
- `pnpm --filter @actionow/admin typecheck && lint && build && test` green; wired into turbo so root `pnpm build/lint/test` include admin.
- Manual/Playwright smoke against seeded API: login → create tenant → create account → top up → mint key (later automated).

## 14. Out of Scope (now)

Catalog/Pricebook/Modifiers/Jobs/Ledger/Dify/Settings screens; OpenAPI codegen; token refresh; i18n framework (copy is zh-CN inline for now); file-storage admin views (no admin endpoint yet).

## 15. Assumptions & Open Items (resolve early in the plan)

1. Exact **error-envelope shape** — read `common/unified-error.filter.ts`.
2. **Dashboard aggregates** — which numbers come from existing lists vs. need a new `/admin/stats` endpoint (prefer client-side aggregation for MVP; flag if a count needs server support).
3. **CORS env name** `ADMIN_ORIGIN` — confirm infra `loadEnv` extension.
4. coss exact install/import (skill at implementation).
5. zh-CN as the only locale for MVP.
