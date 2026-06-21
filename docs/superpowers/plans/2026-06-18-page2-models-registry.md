# Page 2 — Models Registry (relay models + tenant grants + token pricing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Checkbox (`- [ ]`) steps. All work in worktree `/Users/alienworm/actionow-web` (branch `feat/admin-frontend`).

**Goal:** Build the operator **Models Registry** page against the real `/admin/models*` API. A full-width, feature-rich `DataTable` of relay models (provider icon, name, modality, capability chips, input/output token prices, visibility, status), with a create/edit **Drawer**, a grant-management **Drawer**, per-row delete (ConfirmDialog), and bulk enable/disable. **No raw JSON anywhere** — capabilities is a toggle group, prices are integer fields with a clear µcredit/credit hint. Also fill the data-layer gaps (update/delete/grants list/revoke methods + types + enums + query keys + idempotency).

**Architecture:** Table-centric page. Overlays (create/edit, grants) are driven by URL state (`useUrlState('edit')` / `useUrlState('grants')` holding the model `name`) so they are deep-linkable and refresh-safe. Parent owns nothing editable beyond the URL keys; each Drawer owns its own form state seeded from the fetched model. Data via `qk` + `mutationError`; lists via the `getPage` envelope adapter. New reusable `CapabilitiesField` (controlled `Record<string,boolean>`, preserves unknown keys).

**Tech Stack:** React 19, TS strict, TanStack Query v5, react-i18next, Phosphor (`*Icon`), vitest.

Working dir `/Users/alienworm/actionow-web`. Gate: `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web lint && pnpm --filter @actionow/web build`; tests `pnpm --filter @actionow/web exec vitest run`. **The preview is `vite preview` on :4173 serving `dist/` — a rebuild is required for changes to show; do NOT rely on HMR.** Lowercase commits, co-author trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Rules: **no blue**, no emoji (Phosphor only), dark+light themes, button text no-wrap, i18n zh-CN + en both, design tokens (no hard-coded colors), a11y (roles/labels/keyboard), reduced-motion respected.

---

## Backend contract (current `main`, source of truth — do NOT change the backend)

Backend `/Users/alienworm/actionow-core`. All routes require admin JWT. All lists return `PageEnvelope<T> = {data,next_cursor,has_more}` (`?cursor&limit`, default 50, max 200).

- `GET /admin/models` → `PageEnvelope<ModelView>` (newest-first, excludes soft-deleted).
- `POST /admin/models` → `ModelView` (201). `@Idempotent()`. Body `CreateModelDto`:
  - `name: string` (required), `resourceId: string` (required, FK to an existing resource), `display?: string`, `modality?: string` (db default `'chat'`), `capabilities?: Record<string,boolean>`, `visibility?: 'public'|'tenant'` (default `'public'`), `inputPrice?: int≥0` (µcredit-per-INPUT-token, default 0), `outputPrice?: int≥0` (µcredit-per-OUTPUT-token, default 0), `status?: 'active'|'disabled'` (default `'active'`).
- `GET /admin/models/:name` → `ModelView` (404 if unknown/soft-deleted).
- `PATCH /admin/models/:name` → `ModelView` (200/404). `@Idempotent()`. Body `UpdateModelDto` (all optional; omitted = unchanged):
  - `display?: string|null` (null clears), `capabilities?: Record<string,boolean>`, `inputPrice?: int≥0`, `outputPrice?: int≥0`, `visibility?: 'public'|'tenant'`, `status?: 'active'|'disabled'`.
  - **NOT updatable: `name`, `resourceId`, `modality`** (immutable post-create).
- `DELETE /admin/models/:name` → 204/404 (soft-delete; frees the name for re-create).
- `POST /admin/models/:name/grants` → `{ ok: true }` (201/404). `@Idempotent()`. Body `{ tenantId: string }` (uuid). Idempotent on `(model,tenant)` (dup = no-op).
- `GET /admin/models/:name/grants` → `PageEnvelope<ModelGrantView>` (404 if model unknown).
- `DELETE /admin/models/:name/grants/:tenantId` → 204/404 (hard-delete; idempotent in effect).

**`ModelView` JSON shape (exact):**

```ts
{
  id: string;
  name: string;
  display: string | null;
  modality: string; // 'chat' default
  capabilities: Record<string, boolean>; // common keys: tools, vision, audio, json, stream
  visibility: string; // 'public' | 'tenant'
  resource_id: string; // FK to resource.id
  input_price: string; // BIGINT µcredit-per-token serialized as DECIMAL STRING e.g. "30"
  output_price: string; // same
  status: string; // 'active' | 'disabled'
  created_at: string; // ISO-8601 (no updated_at)
}
```

**`ModelGrantView` JSON shape (exact):** `{ id: string; model_id: string; tenant_id: string; created_at: string }`.

**Money units (CRITICAL, surface in UI):** prices are **µcredits per token**, returned as **decimal strings**, sent as **integers**. `1 credit = 1,000,000 µcredits`. Convenient identity: a price of `N` µcredits/token equals exactly **`N` credits per 1,000,000 tokens** — use this for the human hint. Parse `input_price`/`output_price` strings with `Number(...)` for the form's NumberField; send integers back.

---

## Frontend current state (what exists — reuse, don't duplicate)

- `src/lib/api/admin.ts`: `listModels` (uses `getPage().rows`), `createModel(body)` (**no idempotency**), `grantModel(name,{tenantId})` (**no idempotency**). Missing: `getModel`, `updateModel`, `deleteModel`, `listModelGrants`, `revokeModelGrant`.
- `src/lib/api/types.ts`: `ModelView` ✓, `CreateModelBody` ✓, `Modality` ✓. Missing: `UpdateModelBody`, `ModelGrantView`.
- `src/lib/api/enums.ts`: `MODALITIES`, `toOptions(opts,t)`, `EnumOption<V>={value,labelKey}`. Missing: visibility/status/capability sets.
- `src/lib/api/queryKeys.ts`: `qk.models()` ✓. Missing: `qk.modelGrants(name)`.
- `src/routes.tsx`: console children under `<Route path="/console" element={<ConsoleLayout/>}>` (resources, resources/:id, modifiers, dify, tenants, accounts, api-keys). No models route.
- `src/components/console/chrome/nav-config.ts`: `NAV` groups; **add models to the `catalog` group** after resources. Consider whether to add a MOBILE_TAB (optional; keep MOBILE_TABS unchanged unless trivial).
- Toolkit (reuse, do NOT rebuild): `DataTable` (props: columns, rows, rowKey, empty, loading, fill, onRowClick, selectedKey, pageSize, searchable, filterKeys, rowActions, actionsWidth, selectable, bulkActions, columnToggle), `EntityCard`/`CardCollection`, `Drawer({open,title,onClose,children,footer?,width?})`, `Modal`, `ConfirmDialog`, `RowAction({icon,label,onClick,loading?,danger?,disabled?})`, `Toggle({checked,onChange,label?,disabled?})`, `SelectField`, `NumberField`, `TextField`, `FormField`, `Tooltip({text,children?})`, `TenantSelect({label?,value,onChange,placeholder?,tooltip?})`, `StatusBadge({tone,label})`+`statusTone(s)`, `ProviderIcon({provider,size?,tile?,showLabel?})`, `mutationError(t)`, `useUrlState(key,fallback?)`, `STALE_REFERENCE`/`STALE_VOLATILE`, `useKeyset`, `useSetConsoleAction` (top-bar action slot — see ResourcesPage). i18n at `src/i18n/locales/{en,zh-CN}/console.json`.

Read `src/features/console/ResourcesPage.tsx`, `src/features/console/ResourceDetailPane.tsx`, `src/features/console/ChannelEditor.tsx` (Drawer + inline mutation + `mutationError` pattern), and `src/features/console/TenantsPage.tsx` for the established page conventions (top-bar action via `useSetConsoleAction`, `qk` + `useQuery`, toasts, i18n keys layout) before writing code. Match them.

---

## File Structure

- `src/lib/api/types.ts` (modify) — add `UpdateModelBody`, `ModelGrantView`.
- `src/lib/api/admin.ts` (modify) — add `getModel`, `updateModel`, `deleteModel`, `listModelGrants`, `revokeModelGrant`; thread `idempotencyKey?` on `createModel` + `grantModel` + `updateModel`.
- `src/lib/api/enums.ts` (modify) — add `VISIBILITIES`, `MODEL_STATUSES`, `CAPABILITIES`.
- `src/lib/api/queryKeys.ts` (modify) — add `modelGrants(name)`.
- `src/components/data/CapabilitiesField.tsx` (new) + test — controlled capability toggle group.
- `src/features/console/ModelsPage.tsx` (new) — the registry table page.
- `src/features/console/ModelEditor.tsx` (new) — create/edit Drawer.
- `src/features/console/ModelGrantsDrawer.tsx` (new) — grant management Drawer.
- `src/routes.tsx` (modify) — add `<Route path="models" element={<ModelsPage/>} />`.
- `src/components/console/chrome/nav-config.ts` (modify) — add `{ to: '/console/models', labelKey: 'models' }` to the `catalog` group.
- i18n `src/i18n/locales/{en,zh-CN}/console.json` (modify) — `models.*`, `enums.visibility.*`, `enums.capability.*`, plus any new `status.*` / `nav.*` keys used. **Both locales, parallel keys.**

---

## Task 1: Data layer — types, client methods, enums, query keys

**Files:** `types.ts`, `admin.ts`, `enums.ts`, `queryKeys.ts`. Read each first.

- [ ] **types.ts** — add:

```ts
export interface UpdateModelBody {
  display?: string | null;
  capabilities?: Record<string, boolean>;
  /** µcredit-per-INPUT-token (integer). */
  inputPrice?: number;
  /** µcredit-per-OUTPUT-token (integer). */
  outputPrice?: number;
  visibility?: 'public' | 'tenant';
  status?: 'active' | 'disabled';
}

export interface ModelGrantView {
  id: string;
  model_id: string;
  tenant_id: string;
  created_at: string;
}
```

- [ ] **admin.ts** — thread idempotency on the existing model POSTs and add the missing methods. Match the existing `createResource`/`deleteChannel`/`syncChannelModels` patterns (look at how `idempotencyKey` is passed to `client.post(path, body, { idempotencyKey })` and how `client.patch`/`client.delete`/`getPage` are used). Result:

```ts
listModels: async () => (await client.getPage<ModelView>('/admin/models')).rows,
createModel: (body: CreateModelBody, idempotencyKey?: string) =>
  client.post<ModelView>('/admin/models', body, { idempotencyKey }),
getModel: (name: string) => client.get<ModelView>(`/admin/models/${name}`),
updateModel: (name: string, body: UpdateModelBody, idempotencyKey?: string) =>
  client.patch<ModelView>(`/admin/models/${name}`, body),   // PATCH: no idempotency arg on client.patch — see note
deleteModel: (name: string) => client.delete<void>(`/admin/models/${name}`),
grantModel: (name: string, body: { tenantId: string }, idempotencyKey?: string) =>
  client.post<{ ok: true }>(`/admin/models/${name}/grants`, body, { idempotencyKey }),
listModelGrants: async (name: string) =>
  (await client.getPage<ModelGrantView>(`/admin/models/${name}/grants`)).rows,
revokeModelGrant: (name: string, tenantId: string) =>
  client.delete<void>(`/admin/models/${name}/grants/${tenantId}`),
```

- **Check the real `client.patch` signature first.** If `client.patch` does NOT accept an idempotency option (the resync added idempotency to `post` only), then `updateModel` should NOT take/expect to send an idempotency key via patch — keep `updateModel(name, body)` with no key and DROP the idempotencyKey param. Do whatever compiles and matches `client.ts`. PATCH is naturally idempotent anyway. Only `createModel`/`grantModel` (POSTs) must thread the key.
- Encode `name`/`tenantId` path segments safely if the existing methods do (match existing style; model names can contain `/` e.g. `anthropic/claude` — prefer `encodeURIComponent(name)` for the `:name` segment; verify the rest of admin.ts's convention and stay consistent).
- [ ] **enums.ts** — add (using the existing `EnumOption<V>` shape `{value,labelKey}`):

```ts
export const VISIBILITIES: EnumOption<'public' | 'tenant'>[] = [
  { value: 'public', labelKey: 'enums.visibility.public' },
  { value: 'tenant', labelKey: 'enums.visibility.tenant' },
];
export const MODEL_STATUSES: EnumOption<'active' | 'disabled'>[] = [
  { value: 'active', labelKey: 'enums.modelStatus.active' },
  { value: 'disabled', labelKey: 'enums.modelStatus.disabled' },
];
// Known capability flags shown as toggles / chips. icon for table chips.
export interface CapabilityDef {
  key: string;
  labelKey: string;
}
export const CAPABILITIES: CapabilityDef[] = [
  { key: 'tools', labelKey: 'enums.capability.tools' },
  { key: 'vision', labelKey: 'enums.capability.vision' },
  { key: 'audio', labelKey: 'enums.capability.audio' },
  { key: 'json', labelKey: 'enums.capability.json' },
  { key: 'stream', labelKey: 'enums.capability.stream' },
];
```

- [ ] **queryKeys.ts** — add `modelGrants: (name: string) => ['admin', 'models', name, 'grants'] as const,` (match the existing `qk` style).
- [ ] **Gate** (typecheck + lint) green. Commit `feat(web): model registry data layer — update/delete/grants methods, types, enums, keys`.

## Task 2: `CapabilitiesField` (new reusable component) + test

**Files:** `src/components/data/CapabilitiesField.tsx` (new), `.test.tsx`. Read `Toggle.tsx`, `FormField.tsx`, `enums.ts`, and an existing field with a `tooltip`/`hint` (e.g. `ChipsField.tsx`) first.

- [ ] **Implement.** A controlled toggle group over `Record<string,boolean>`. Renders one `Toggle` per `CAPABILITIES` entry (label from i18n). Also surface any **extra keys present in `value` but not in `CAPABILITIES`** as additional toggles (so editing a synced model that has unknown flags doesn't silently drop them). `onChange` returns the full updated record. Use `FormField` (with `label`/`tooltip`/`hint`) as the wrapper for a consistent labeled field. No raw JSON.

```tsx
export function CapabilitiesField({
  value,
  onChange,
  label,
  tooltip,
  hint,
}: {
  value: Record<string, boolean>;
  onChange: (next: Record<string, boolean>) => void;
  label?: string;
  tooltip?: string;
  hint?: string;
}) {
  /* known CAPABILITIES toggles + any extra keys in value; toggling sets value[key]=bool */
}
```

- Toggling a known cap that's absent from `value` sets it to the new boolean. Keep keys that are `false` in the record OR omit them — either is fine for the backend; pick one and be consistent (recommend: keep explicit `true`/`false` for known caps, preserve extras as-is). The model create/edit caller will pass the record straight through.
- i18n: labels via `t(def.labelKey)`; extra keys show the raw key as label.
- a11y: each Toggle already exposes its label; the group sits in a `FormField`.
- [ ] **Test** (`@testing-library/react` + `user-event`, match `Toggle.test.tsx`/`Checkbox.test.tsx` style): renders a toggle per known capability; toggling emits the updated record with the flipped key; an extra key in `value` renders as an extra toggle and is preserved on change.
- [ ] **Gate** green. Commit `feat(web): CapabilitiesField toggle group (no raw json) + test`.

## Task 3: `ModelEditor` Drawer (create + edit)

**Files:** `src/features/console/ModelEditor.tsx` (new). Read `ChannelEditor.tsx` (the Drawer + mutation + inline-secret pattern) and `ResourcesPage.tsx` (idempotency UUID per open) first.

- [ ] **Implement.** A `Drawer` for creating or editing a model. Props:

```tsx
export function ModelEditor({
  name,            // undefined = create; string = edit (fetch via getModel)
  open,
  onClose,
}: { name?: string; open: boolean; onClose: () => void }) { ... }
```

- **Create mode** (`name === undefined`): empty form. Fields:
  - `name` — `TextField` (required), tooltip "the unique model id callers request".
  - `resourceId` — `SelectField` populated from `useQuery(qk.resources(), api.listResources, {staleTime: STALE_REFERENCE})`; options = each resource `{value: r.id, label: r.id}` (optionally prefix with provider). tooltip "which resource/upstream this model routes to". Required.
  - `display` — `TextField` (optional), hint "human-readable label".
  - `modality` — `SelectField` from `toOptions(MODALITIES, t)` (default `'text'`). tooltip.
  - `capabilities` — `CapabilitiesField`. tooltip "features this model supports".
  - `visibility` — `SelectField` from `toOptions(VISIBILITIES, t)` (default `public`). hint: tenant ⇒ requires a grant.
  - `inputPrice` / `outputPrice` — `NumberField` (min 0, step 1, integer). **hint MUST state units**: `t('models.tip.price')` → e.g. "µcredits / token · 1 credit = 1,000,000 µ · ≈ {{n}} credits / 1M tokens" with `{n}` = the current value (compute inline). tooltip explaining µcredits.
  - `status` — `SelectField` from `toOptions(MODEL_STATUSES, t)` (default active) OR a `Toggle` "active". Pick `SelectField` for consistency.
  - Submit → `api.createModel({ name, resourceId, display||undefined, modality, capabilities, visibility, inputPrice, outputPrice, status }, idemKey)` where `idemKey` is a fresh `crypto.randomUUID()` generated per drawer-open (mirror ResourcesPage). On success: `invalidateQueries(qk.models())`, toast `models.created`, `onClose()`.
- **Edit mode** (`name` set): `useQuery({ queryKey: ['admin','models',name], queryFn: () => api.getModel(name), enabled: open })`. Seed form from the fetched model: parse `Number(input_price)`/`Number(output_price)`. Render **name / resourceId / modality as READ-ONLY** (display the values, disabled fields or plain text) — they are immutable. Editable: `display`, `capabilities`, `visibility`, `inputPrice`, `outputPrice`, `status`. Submit → `api.updateModel(name, { display: display.trim()===''? null : display.trim(), capabilities, visibility, inputPrice, outputPrice, status })`. On success: invalidate `qk.models()` AND the detail key, toast `models.updated`, `onClose()`.
- Use `mutationError(t)` on both mutations; `Button variant="cta" loading`. Drawer `footer` = submit button. Reset/seed correctly when `open`/`name` changes (mirror how ChannelEditor keys/initializes; the parent will pass a React `key` to force remount per target — see Task 5).
- [ ] **Gate** green. Commit `feat(web): model create/edit drawer (structured fields, µcredit price hint)`.

## Task 4: `ModelGrantsDrawer` (manage tenant grants)

**Files:** `src/features/console/ModelGrantsDrawer.tsx` (new). Read `TenantSelect.tsx`, `RowAction.tsx`, `ConfirmDialog.tsx` first.

- [ ] **Implement.** A `Drawer` to manage a model's tenant grants. Props `{ name: string; open: boolean; onClose: () => void }`.
  - Header note (muted text): explain that `public` models are open to all tenants and grants only gate `tenant`-visibility models. (Optionally fetch the model to show its current visibility; or just show the static note — keep simple, static note is fine.)
  - **Add grant:** `TenantSelect` (value = a local `tenantId` state) + a `Button` "grant" → `api.grantModel(name, { tenantId }, crypto.randomUUID())`. On success: `invalidateQueries(qk.modelGrants(name))`, toast `models.grant.granted`, clear the select.
  - **Granted list:** `useQuery({ queryKey: qk.modelGrants(name), queryFn: () => api.listModelGrants(name), enabled: open })`. Resolve tenant names: `useQuery(qk.tenants(), api.listTenants, {staleTime: STALE_REFERENCE})` → map `tenant_id` → tenant name (fallback to the id). Render as a small `DataTable` (or a simple list) with columns: tenant (name + id muted), granted_at; `rowActions` = a single `RowAction` (TrashIcon, danger) → opens a `ConfirmDialog` → `api.revokeModelGrant(name, tenant_id)`; on success invalidate `qk.modelGrants(name)`, toast `models.grant.revoked`.
  - Empty state: "no grants yet". Loading state handled by DataTable `loading`.
  - `mutationError(t)` everywhere.
- [ ] **Gate** green. Commit `feat(web): model grants drawer — grant/revoke tenant access`.

## Task 5: `ModelsPage` (registry table) + route + nav + i18n

**Files:** `src/features/console/ModelsPage.tsx` (new), `src/routes.tsx`, `nav-config.ts`, i18n. Read `ResourcesPage.tsx` + `ResourceDetailPane.tsx` (DataTable usage, `useSetConsoleAction`, rowActions/bulk) first.

- [ ] **ModelsPage.** Full-width page (NOT master-detail). Structure:
  - `useQuery({ queryKey: qk.models(), queryFn: api.listModels, staleTime: STALE_REFERENCE })`.
  - Top-bar action via `useSetConsoleAction` → "New model" `Button` that opens the create drawer (set `edit` url-state to a sentinel like `'__new__'`, or use a separate boolean; recommended: a `useUrlState('edit')` where `''`=closed, `'__new__'`=create, otherwise the model name to edit).
  - URL state: `const [edit, setEdit] = useUrlState('edit')` and `const [grants, setGrants] = useUrlState('grants')`. Optional filters: `const [vis, setVis] = useUrlState('visibility')`, `const [st, setSt] = useUrlState('status')`.
  - **DataTable** of models, `rowKey={(m)=>m.name}`, `searchable`, `selectable`, `pageSize={20}`, `actionsWidth="132px"`. Columns:
    1. provider/name — `cell` = `<span flex><ProviderIcon provider={m.resource_id /* or m.name */} size={18}/> <strong>{m.name}</strong> {m.display && <muted>{m.display}</muted>}</span>`. (ProviderIcon resolves any string; pass the most provider-ish value available — try `m.resource_id`. If that reads poorly, pass `m.name`.) `width` ~ flexible; sortable by name.
    2. modality — `m.modality`. `width:'96px'`.
    3. capabilities — small inline chips: for each `CAPABILITIES` def where `m.capabilities[def.key]` is true, render a tiny icon-chip (Phosphor icon + tooltip via `title`). Keep compact; if none, `—`.
    4. input price — formatted: show the integer + a muted "/tok"; e.g. `{Number(m.input_price)}`. `width:'110px'`, right-aligned, `tabular`. sortable by `Number(m.input_price)` via `sortValue`.
    5. output price — same. `width:'110px'`.
    6. visibility — `StatusBadge` (tone: public→'ok'? choose a sensible tone; visibility isn't a status — use a neutral chip or `StatusBadge` with `statusTone` won't map 'public'. Prefer a plain small chip/`StatusBadge tone='idle'|'run'` mapped manually, or just text). Keep on-palette, no blue. `width:'110px'`.
    7. status — `StatusBadge tone={statusTone(m.status)} label={t('status.'+m.status, m.status)}`. `width:'100px'`.
  - `rowActions={(m)=>(<><RowAction icon={PencilSimpleIcon} label={t('common.edit')} onClick={()=>setEdit(m.name)}/><RowAction icon={UsersIcon} label={t('models.actions.grants')} onClick={()=>setGrants(m.name)}/><RowAction icon={TrashIcon} label={t('common.delete')} danger onClick={()=>setDelTarget(m)}/></>)}`.
  - `bulkActions={(sel,clear)=>(<>enable / disable buttons → Promise.all(sel.map(m=>api.updateModel(m.name,{status})))→ invalidate qk.models()→ clear()</>)}` (mirror ResourceDetailPane's `bulkSetStatus`).
  - Delete: `const [delTarget,setDelTarget]=useState<ModelView|undefined>()` + `ConfirmDialog` (danger) → `api.deleteModel(delTarget.name)` → invalidate `qk.models()` → toast `models.deleted` → clear target.
  - Optional filters (if included): a small `SelectField`/segmented filter for visibility + status placed in the toolbar area above the table, applied client-side to `rows` before passing to DataTable (URL-stated). Keep simple; search + sortable columns are the baseline. **If filters add risk, ship search+sort only and note it.**
  - Render `<ModelEditor key={edit||'new'} name={edit && edit!=='__new__' ? edit : undefined} open={edit!==''} onClose={()=>setEdit('')} />` and `<ModelGrantsDrawer key={grants} name={grants} open={grants!==''} onClose={()=>setGrants('')} />` and the ConfirmDialog. (Guard ModelGrantsDrawer rendering on `grants!==''` so `name` is always a real model name when open.)
- [ ] **routes.tsx** — add `<Route path="models" element={<ModelsPage />} />` next to `resources`. Import `ModelsPage`.
- [ ] **nav-config.ts** — add `{ to: '/console/models', labelKey: 'models' }` to the `catalog` group's `items` (after resources). (Leave MOBILE_TABS unless trivial to add.)
- [ ] **i18n** both `en` and `zh-CN` `console.json` — add a `models.*` block (title, new, empty, created, updated, deleted, `cols.*`, `form.*`, `tip.*` incl. the price-unit hint with an `{{n}}` interpolation, `actions.{grants,...}`, `grant.{title,note,tenant,submit,granted,revoked,empty,colTenant,colGranted}`, `confirm.{deleteTitle,deleteMsg,revokeTitle,revokeMsg}`), plus `enums.visibility.{public,tenant}`, `enums.modelStatus.{active,disabled}`, `enums.capability.{tools,vision,audio,json,stream}`, and a `nav.models` label (match how other nav labels are keyed — check how `labelKey: 'resources'` resolves in SubNav/Rail; add the parallel `models` key wherever `resources` lives). Reuse existing `common.{edit,delete,cancel,confirm}` and `status.*`. **Keep zh-CN and en key sets identical.** Chinese copy should match the design summary's terminology (模型 / 授权 / 输入价 / 输出价 / 可见性 / 能力 / µcredits).
- [ ] **Gate** green (typecheck + lint + build). Commit `feat(web): models registry page + route + nav + i18n`.

## Task 6: Verify (build + tests + live)

- [ ] Full gate: `pnpm --filter @actionow/web typecheck && lint && build` and `vitest run` — all green. Report counts.
- [ ] **Rebuild `dist/`** (the preview serves it). Confirm the page renders the real `GET /admin/models` data (the backend is running on the codex sidecar; resources/models exist). If the backend has no models yet, the empty state must render cleanly; you can also trigger a `sync-models` from a resource channel (Page 1) to populate, but do NOT depend on it — empty state is acceptable for verification.
- [ ] Sanity-check (describe what you verified, do not skip): models list renders; create drawer opens with structured fields + price hint shows the credits/1M-tokens equivalent; edit drawer prefills and shows name/resource/modality read-only; grants drawer lists/grants/revokes; delete confirm works; bulk enable/disable; dark+light; no console errors. (The dispatching orchestrator will do the final pixel verification; you must at least confirm the build is served and the route loads without runtime errors.)

---

## Out of scope / notes

- No tenant self-service or Playground (later interfaces).
- Model `name`/`resourceId`/`modality` are immutable post-create (backend) — enforce read-only in edit.
- `capabilities` is free-form `Record<string,boolean>`; the toggle group covers known flags and preserves unknown ones.
- Grants are hard-deleted; revoke uses a ConfirmDialog. Public models ignore grants (note it in the UI).
- Keep everything token-driven, no blue, Phosphor icons only, both themes, both locales, a11y, reduced-motion.
