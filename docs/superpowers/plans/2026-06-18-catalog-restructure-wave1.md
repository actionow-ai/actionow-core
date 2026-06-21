# Catalog Restructure + Form Selection + Billing Mock-Skeleton — Wave 1 Implementation Plan

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Checkbox steps. Worktree `/Users/alienworm/actionow-web` (branch `feat/admin-frontend`).

**Source design:** `docs/superpowers/specs/2026-06-18-catalog-page1-page2-optimization-design.md` + the backend billing spec `actionow-core/docs/superpowers/specs/2026-06-17-actionow-billing-channel-routing-design.md` (DESIGN-ONLY backend; not implemented).

**Confirmed decisions (do not re-litigate):**

- **IA = 职责分组 (by responsibility).** Nav groups: **目录(Catalog)** = `模型 | 资源` two tabs (模型 default/first; 资源 = capability hub w/ merged detail). **计费与路由(Billing & Routing)** = `分组 | 官方价格 | 调价规则`. **租户(Tenants)** = 租户/账户/API Keys (unchanged this wave).
- **Combobox** (typeable dropdown: common values + free entry) for `provider`/`model` fields.
- **Do all of Wave 1 now** (layout/IA + forms — against the real backend).
- **Billing UI = mock skeleton** for the NEW pages (官方价格表, 分组) — built with a clearly-marked mock data module, swap to real API when backend lands. **Do NOT flip live Page1/2 money to µUSD** (backend still serves µcredit; changing live display would misrepresent real data) — the µUSD re-anchor, channel cost columns, model `needs_pricing`, and api_key→group are DEFERRED to when their backend track lands. Only the two brand-new mock pages are built now.

**This wave is split into two phases.** Phase 1 (Tasks 1–8): shared components + Catalog restructure + form selection. Phase 2 (Tasks 9–12): the Billing&Routing nav group + the two mock pages. The dispatching orchestrator builds Phase 1, reviews/verifies, then Phase 2.

**Gate:** `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web lint && pnpm --filter @actionow/web build`; tests `pnpm --filter @actionow/web exec vitest run` (currently 180 passing — keep green, add new tests). Preview = `vite preview` :4173 serving `dist/` → **rebuild to see changes, no HMR**. Lowercase commits + trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Rules: no blue, Phosphor only, dark+light, button text no-wrap, i18n both locales (identical key sets), tokens only, a11y, reduced-motion.

---

# PHASE 1 — shared components + Catalog restructure + forms

## Task 1: `ComboboxField` (typeable dropdown) + test

**Files:** `src/components/ui/ComboboxField.tsx` (new) + `.test.tsx`. Read `SelectField.tsx` (for the glass dropdown + keyboard pattern + FormField composition), `TextField.tsx`, `FormField.tsx` first.

- [ ] A controlled combobox: a text input with a dropdown of `options`; the user may pick a suggestion OR type a free value (backend fields are `z.string()`). Props:

```tsx
export function ComboboxField({
  label, value, onChange, options, placeholder, hint, tooltip, required, disabled, id,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];                 // suggestions (constants or fetched)
  placeholder?: string; hint?: string; tooltip?: string;
  required?: boolean; disabled?: boolean; id?: string;
}) { ... }
```

- Behaviour: input filters `options` (case-insensitive substring) into a dropdown; ArrowUp/Down moves the highlight, Enter selects the highlight (or commits typed text), Escape closes; clicking an option commits it; typing commits free text on change. `role="combobox"` + `aria-expanded` + `aria-controls` + listbox `role="listbox"`/`option` for a11y. Reuse `FormField` wrapper (label/hint/tooltip/error). Reuse SelectField's glass/`--overlay-bg` dropdown styling + the `.select-opt` hover. No blue.
- reduced-motion respected (no animated open if the codebase animates dropdowns; match SelectField).
- [ ] Test (match `SelectField.test.tsx`/`Checkbox.test.tsx` style): renders options on focus/type; picking an option emits it; typing a non-option value emits the free text; keyboard up/down/enter selects.
- [ ] Gate green. Commit `feat(web): ComboboxField — typeable dropdown (suggestions + free entry) + test`.

## Task 2: `listSecrets` client method + `SecretSelect` component

**Files:** `src/lib/api/admin.ts`, `src/lib/api/types.ts` (verify `SecretView`), `src/lib/api/queryKeys.ts`, `src/components/data/SecretSelect.tsx` (new). Read `admin.ts`, `TenantSelect.tsx` (the pattern to mirror), `SelectField.tsx`.

- [ ] **admin.ts**: add `listSecrets: async () => (await client.getPage<SecretView>('/admin/secrets')).rows`. (Backend hardening added `GET /admin/secrets` returning the envelope; `SecretView = {id, provider, created_at}` — confirm in types.ts; it has NO plaintext/label per the resync notes.)
- [ ] **queryKeys.ts**: add `secrets: () => ['admin', 'secrets'] as const`.
- [ ] **SecretSelect.tsx**: a `SelectField` over `listSecrets()` (`qk.secrets()`, `STALE_REFERENCE`); option label = `s.id` (+ provider/created_at muted if shown); value = `s.id`. Props `{ label?, value, onChange, tooltip?, hint?, placeholder? }`. Mirror `TenantSelect`. This is the "pick an existing credential" control.
- [ ] Gate green. Commit `feat(web): listSecrets + SecretSelect (pick existing credential)`.

## Task 3: ConsoleLayout — third column fills the container (no outer padding)

**Files:** `src/components/console/ConsoleLayout.tsx`. Read it.

- [ ] Remove the content-area's `padding: var(--s-3)` (the inner scroll `<div>` at ~line 52) so the routed view fills edge-to-edge: change to `padding: 0` (keep `paddingBottom: 76` on mobile for the bottom tab bar — i.e. mobile keeps bottom space, desktop 0). The outer shell `padding: var(--s-4)` + column `gap` stay.
- [ ] Because pages now own their own edge spacing, ensure the per-page scroll containers provide the shadow/selection-ring breathing room internally (Task 5/6 handle the pages). Verify nothing else relied on that 12px (search usages).
- [ ] Gate green. Commit `fix(web): console content area fills container (drop outer padding)`.

## Task 4: ResourceDetailPane — merge 概览/通道/定价 tabs into ONE scrolling pane

**Files:** `src/features/console/ResourceDetailPane.tsx`. Read it (it currently uses `Tabs` + `useUrlState('tab')`).

- [ ] Remove the `Tabs` and the `tab` url-state. Render a single vertical scrolling pane with three stacked **sections**, each with a section heading:
  1. **概览 (overview)** — the existing overview panel (ProviderIcon + id + meta + status SelectField).
  2. **通道 (channels)** — a section heading + the "添加通道" button + the channels `DataTable` (keep all existing behaviour: rowActions edit/disable/sync/delete, bulkActions, `actionsWidth`, the ChannelEditor/ConfirmDialog).
  3. **定价 (pricing)** — section heading + "添加定价" + the pricebook `DataTable` + PricingModal.
- [ ] Section heading style: a small uppercase/`--muted` label or a `--fs-lg` weight heading consistent with the app; separate sections with spacing (`var(--s-5)`). Keep the ChannelEditor / PricingModal / ConfirmDialog mounts.
- [ ] Add i18n `resources.sections.{overview,channels,pricing}` (both locales) for the headings; remove now-unused `resources.tabs.*`/`detail.tabsLabel` only if nothing else uses them (grep first).
- [ ] Gate green. Commit `feat(web): merge resource detail into a single sectioned pane (no tabs)`.

## Task 5: `CatalogPage` — 模型 | 资源 two-tab page (single route + ?tab)

**Files:** `src/features/console/CatalogPage.tsx` (new), `src/routes.tsx`, `src/features/console/ResourcesPage.tsx` + `ModelsPage.tsx` (light refactor so they work as tab bodies). Read `ResourcesPage.tsx`, `ModelsPage.tsx`, `Tabs.tsx`, `routes.tsx`, `useUrlState.ts`.

- [ ] **CatalogPage**: top-level `Tabs` (or `SegmentedControl`, whichever is the page-level pattern) with `模型 | 资源`, driven by `useUrlState('tab', 'models')` (模型 = default/first tab, the 对外 product surface). Render the active tab's body: `ModelsPage` or `ResourcesPage`. Each body keeps using `useSetConsoleAction` for its own top-bar button (新建模型 / 新建资源) — only the mounted body sets it, so the action follows the tab automatically. Keep the bodies' own url-state (`edit`/`grants` for models, `id` for resource selection) working alongside `tab`.
- [ ] **Resource selection URL**: resources currently use `/console/resources/:id`. Migrate selection to `?tab=resources&id=<id>` (read via `useUrlState('id')` instead of the route param) so it lives under the single catalog route. Update ResourcesPage to read `id` from url-state; update the card `onClick` to `setId(r.id)` (url-state) instead of `navigate('/console/resources/:id')`.
- [ ] **routes.tsx**: add `<Route path="catalog" element={<CatalogPage />} />`. Replace the old `resources` / `resources/:id` / `models` routes with redirects to `/console/catalog?tab=resources` / `?tab=models` (use `<Navigate>` or small redirect elements that preserve params where feasible). Keep `/console/dashboard` etc. unchanged.
- [ ] Gate green. Commit `feat(web): unified catalog page — 模型 | 资源 tabs (single route)`.

## Task 6: nav-config — Catalog entry + new 计费与路由 group (move 调价规则)

**Files:** `src/components/console/nav-config.ts` (NOTE: real path is `src/components/console/nav-config.ts`, no `chrome/` segment). Read it.

- [ ] **catalog group**: replace the `资源`/`模型` items with a single `{ to: '/console/catalog', labelKey: 'catalog' }` (the page's own tabs switch 模型/资源). Remove `modifiers` from catalog (it moves to billing). Keep `dify` in catalog (or move per design — keep in catalog for now).
- [ ] **New `billing` group** (key `'billing'`, an apt Phosphor icon e.g. `ReceiptIcon`/`CoinsIcon`): items `{ to:'/console/groups', labelKey:'groups' }`, `{ to:'/console/official-prices', labelKey:'officialPrices' }`, `{ to:'/console/modifiers', labelKey:'modifiers' }`. (NOTE the existing `billing` group key currently holds `accounts` — rename the existing accounts group to `'tenants'`/`'finance'` as appropriate, OR add accounts into the Tenants group. Resolve the key collision: the design puts 账户 under 租户. Move `accounts` into the `ops`/tenants grouping and free `billing` for the new group, OR name the new group `'routing'`. Pick a clean, non-colliding set and update `groupForPath`/`activeItem`/`MOBILE_TABS` accordingly.)
- [ ] Update `MOBILE_TABS` if it referenced `/console/resources` or `/console/models` → point to `/console/catalog`.
- [ ] i18n `nav.{catalog,groups,officialPrices}` (+ keep `nav.modifiers`) both locales; and the group labels if the chrome renders group names.
- [ ] Gate green. Commit `feat(web): nav — catalog entry + billing & routing group`.

## Task 7: Apply Combobox + SecretSelect to the channel/resource forms

**Files:** `src/features/console/ChannelEditor.tsx`, `src/features/console/ResourcesPage.tsx`. Read both.

- [ ] **ChannelEditor**:
  - `providerType`: `TextField` → `ComboboxField` with `options={[...COMMON_PROVIDERS]}` (keep the edit-mode read-only behaviour: on edit, provider stays disabled/omitted from the update body — preserve current logic). tooltip unchanged.
  - `model`: `TextField` → `ComboboxField`. Options = the resource's already-known model names: `useQuery(qk.models(), api.listModels, {staleTime:STALE_REFERENCE})` filtered to `m.resource_id === resourceId`, mapped to `m.name` (allow free entry too). hint stays.
  - `credentialRef`: replace the bare `TextField` + inline-create with a `SecretSelect` (pick existing) PLUS the existing "新建凭证" inline flow (keep `createSecret` → on success set credentialRef to the new id AND it should appear in the SecretSelect after invalidating `qk.secrets()`). Layout: SecretSelect + a small "新建" button that opens the existing credential mini-form.
- [ ] **ResourcesPage create modal**: `provider` `TextField` → `ComboboxField` with `COMMON_PROVIDERS`. Keep the `hint`.
- [ ] i18n: any new labels (e.g. `credentials.pickExisting`, `credentials.orCreate`) both locales.
- [ ] Gate green. Commit `feat(web): combobox for provider/model + pick-existing credential in channel editor`.

## Task 8: Phase-1 verification

- [ ] Full gate + `vitest run` green (report counts). Rebuild `dist/`.
- [ ] Confirm (the orchestrator will pixel-verify): catalog page renders with 模型|资源 tabs, action button switches per tab; resource selection works via `?id`; merged detail pane shows overview+channels+pricing sections; third column fills container (no dead padding gap, shadows not clipped); provider/model comboboxes work; credential pick-existing + create works; nav shows 目录 + 计费与路由; old routes redirect; dark+light; no console errors.

---

# PHASE 2 — Billing & Routing mock-skeleton pages

> Mock-only: NO real backend. Build a clearly-marked mock data module so swapping to real APIs later is a one-file change. Add a visible "演示数据 (mock)" badge on these pages so mock is never mistaken for live data. Units shown in **USD** (µUSD/1M → `$X/1M tokens`), per the billing spec, since these are brand-new and not tied to live µcredit data.

## Task 9: Mock data + types module

**Files:** `src/lib/api/mockBilling.ts` (new), `src/lib/api/types.ts` (add the new view types).

- [ ] Types (frontend, matching the billing spec shapes): `OfficialModelPrice {id, provider, model_slug, display_name, input_price_per_1m, output_price_per_1m, cached_input_price_per_1m?, source_url?, effective_at?, notes?, updated_by?, created_at}`; `RouteGroup {id, name, group_ratio_bps, status, description?, created_at}`; `RouteGroupChannel {group_id, channel_id, priority, weight}`. Mark with a comment that these mirror the (unbuilt) backend spec.
- [ ] `mockBilling.ts`: in-memory mock arrays + async functions returning them (simulate the client shape): `listOfficialPrices()`, `createOfficialPrice()`, `updateOfficialPrice()`, `deleteOfficialPrice()`, `listRouteGroups()`, `createRouteGroup()`, ..., `listGroupChannels(groupId)`, `addGroupChannel()`, `removeGroupChannel()`. Keep an obvious `// MOCK — replace with real /admin/... when backend track N lands` header. Mutations mutate the in-memory arrays (so the UI is interactive in the demo).
- [ ] Gate green. Commit `feat(web): mock billing data module (official prices + route groups) — pre-backend skeleton`.

## Task 10: `OfficialPricesPage` (mock)

**Files:** `src/features/console/OfficialPricesPage.tsx` (new), route + nav already slotted (Task 6). Read `ModelsPage.tsx` as the template.

- [ ] A `DataTable` (searchable, sortable, pageSize) over `listOfficialPrices()`: columns provider (ProviderIcon + name), model_slug, display_name, 输入价 `$X/1M`, 输出价 `$X/1M`, effective_at, source (link). rowActions edit/delete (ConfirmDialog). Top action "新建官方价".
- [ ] Create/edit Drawer: `provider` = **ComboboxField** (COMMON_PROVIDERS); `model_slug`/`display_name`/`source_url`/`notes` = TextField; `input_price_per_1m`/`output_price_per_1m`/`cached` = NumberField shown as **$ /1M** (store µUSD/1M integer, show `= $X.XX/1M` hint); `effective_at` = a date input (native `type="date"` via TextField or a small date field). All via the mock mutations.
- [ ] Visible "演示数据" badge near the title.
- [ ] i18n both locales (`officialPrices.*`). Gate green. Commit `feat(web): official model price table (mock skeleton)`.

## Task 11: `RouteGroupsPage` (mock) + channel membership

**Files:** `src/features/console/RouteGroupsPage.tsx` (new). Read `ResourceDetailPane.tsx` (master-detail or table+drawer pattern) + `ModelsPage.tsx`.

- [ ] A `DataTable` over `listRouteGroups()`: columns name, **倍率** (group_ratio_bps → show as `×1.50` and/or `+50%`), status (StatusBadge), description, (channel count). rowActions: edit, 管理渠道, delete. Top action "新建分组".
- [ ] Create/edit Drawer: `name` TextField; **group_ratio** input — a NumberField labelled as a multiplier or percent with a clear hint (e.g. enter `150` % or `1.5×`; store as bps integer `15000`); show the computed bps + the resulting "×N.NN". `status` SelectField; `description` TextField.
- [ ] **管理渠道 Drawer** (membership): list this group's channels (`listGroupChannels(groupId)` joined to channel names — use a mock channel list or the real `listChannels` per resource if convenient; mock is fine), each with **priority** + **weight** NumberFields (priority high = tried first, with a hint) + remove. An "add channel" picker (SelectField/Combobox of channel ids). All via mock mutations.
- [ ] Visible "演示数据" badge. i18n both locales (`groups.*`). Gate green. Commit `feat(web): route groups + channel membership (mock skeleton)`.

## Task 12: Phase-2 verification

- [ ] Full gate + tests green (counts). Rebuild `dist/`.
- [ ] Confirm: 计费与路由 group shows 分组/官方价格/调价规则; official prices page renders mock rows + create/edit/delete work in-session; route groups page + ratio input + channel membership priority/weight work; "演示数据" badges visible; provider combobox in the price form; dark+light; no console errors.

---

## Notes / out of scope this wave

- **Deferred to backend tracks** (NOT this wave): µUSD re-anchor of LIVE Page1/2 money; model `needs_pricing` on the live registry; `upstream_channel` cost columns on the live channel editor; `api_key.route_group_id` on the (future) API Keys page; sync auto-pricing. These touch live data/endpoints that don't exist yet — adding them now would misrepresent real µcredit data.
- Keep the mock pages' data layer isolated in `mockBilling.ts` so the future swap to `/admin/official-prices` + `/admin/groups` is a single-file change.
- Everything tokenized, no blue, Phosphor, both themes, both locales, a11y, reduced-motion.
