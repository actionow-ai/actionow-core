# Re-sync: Pagination Envelope + Page 1 (backend hardening refactor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / executing-plans. Checkbox (`- [ ]`) steps.

**Goal:** Re-sync the frontend data layer to the refactored backend (every list now returns a `PageEnvelope`, full CRUD + real channel DELETE + sync-models + idempotency-key) and fix/enhance the just-built Resources page. Unbreak first; add only the new capabilities Page 1 uses now.

**Architecture:** A single `getPage<T>` adapter in `client.ts` converts the backend envelope `{data,next_cursor,has_more}` → the existing `Page<T> {rows,nextCursor}`; plain catalog list methods return `rows` (arrays) so existing pages keep working unchanged; the bespoke `listJobs/listLedger/listUsage/listPayments` unwraps (which read now-removed keys) switch to `getPage`. Add `Idempotency-Key` header support. Page 1 gains real channel delete (via a new `ConfirmDialog`), sync-models, and resource status edit.

**Tech Stack:** React 19, TS strict, TanStack Query v5, react-i18next, Phosphor, vitest.

Backend (current `main`, source of truth): `/Users/alienworm/actionow-core`. Envelope: `apps/api/src/common/pagination.ts` → `PageEnvelope<T> = { data: T[]; next_cursor: string | null; has_more: boolean }`, query `?cursor&limit` (default 50, max 200). Idempotency: header `Idempotency-Key` (optional; honored on non-secret admin POSTs). New routes: `DELETE /admin/resources/:id/channels/:channelId`, `POST /admin/resources/:id/channels/:channelId/sync-models` (`{defaultInputPrice?,defaultOutputPrice?}` → `{resource_id,created[],updated[],total}`), `PATCH /admin/resources/:id` (`{status?:'active'|'disabled'}`). **No `*View` field changed** (migration-0015 columns aren't projected) — do NOT touch existing view types.

Working dir `/Users/alienworm/actionow-web`. Gate: `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web lint && pnpm --filter @actionow/web build`; tests `pnpm --filter @actionow/web exec vitest run`. Lowercase commits. Rules: no blue, no emoji (Phosphor), dark+light, tokens, i18n both locales, a11y.

---

## File Structure

- `src/lib/api/client.ts` (modify) — `PageEnvelope<T>` type, `getPage<T>` adapter, per-request headers (Idempotency-Key).
- `src/lib/api/admin.ts` (modify) — repoint all list methods; add `deleteChannel`/`syncChannelModels`/`updateResource`; thread `idempotencyKey?` on Page-1 create POSTs.
- `src/lib/api/types.ts` (modify) — add `UpdateResourceBody`, `SyncChannelModelsBody`, `SyncChannelModelsResult`.
- `src/components/ui/ConfirmDialog.tsx` (new) + test — destructive-action confirm (Modal-based).
- `src/features/console/ResourceDetailPane.tsx` (modify) — channel delete (ConfirmDialog) + sync-models action; resource status edit in Overview.
- i18n `console.json` both locales — `common.{delete,confirm,cancel}`, `confirm.*`, `channels.actions.{delete,syncModels}`, `channels.synced`, `resources.actions.setStatus`.

---

## Task 1: `client.ts` — envelope adapter + idempotency header

**Files:** `src/lib/api/client.ts`. Read it first (note the existing `request`/`get`/`post`/`patch`/`delete`/`getWithHeaders` + how it builds query/headers + `Page` import from `./types`).

- [ ] **Step 1: Add the `PageEnvelope` type + `getPage` adapter.** After the existing client methods, add to the returned object:

```ts
// at top-level of the module:
export interface PageEnvelope<T> {
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
}
```

```ts
// inside createClient's returned object (Page imported from './types'):
getPage: async <T>(path: string, query?: Record<string, string | number | undefined>): Promise<import('./types').Page<T>> => {
  const env = await request<PageEnvelope<T>>(path, { query });
  return { rows: env.data, nextCursor: env.next_cursor };
},
```

(Match the existing `request` signature for how `query` is passed — reuse the same query-serialization the current `get` uses.)

- [ ] **Step 2: Per-request headers for POST (Idempotency-Key).** Extend the internal request options with an optional `headers?: Record<string,string>` merged after the default content-type/auth, and widen `post` to accept an options arg:

```ts
post: <T>(path: string, body?: unknown, opts?: { idempotencyKey?: string }): Promise<T> =>
  request<T>(path, { method: 'POST', body, headers: opts?.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : undefined }),
```

Keep `get`/`patch`/`delete` unchanged. Ensure existing `post` call sites (no opts) still compile.

- [ ] **Step 3: Verify** typecheck + existing `client.test.ts` green (extend it: `getPage` unwraps `{data,next_cursor}`→`{rows,nextCursor}`; `post` with `idempotencyKey` sends the `Idempotency-Key` header). Run `vitest run src/lib/api/client.test.ts`.
- [ ] **Step 4: Commit** `feat(web): client getPage envelope adapter + idempotency-key header`.

## Task 2: `admin.ts` — repoint lists + new Page-1 methods

**Files:** `src/lib/api/admin.ts`. Read it first.

- [ ] **Step 1: Repoint plain catalog lists to return arrays via `getPage().rows`** (keeps existing call sites working — they expect `View[]`):
  - `listTenants: async () => (await client.getPage<TenantView>('/admin/tenants')).rows`
  - `listResources: async () => (await client.getPage<ResourceView>('/admin/resources')).rows`
  - `listChannels: async (resourceId) => (await client.getPage<ChannelView>(\`/admin/resources/${resourceId}/channels\`)).rows`
  - `listPricebook: async (resourceId) => (await client.getPage<PricebookView>('/admin/pricebook', { resourceId })).rows`
  - `listModifiers: async () => (await client.getPage<ModifierView>('/admin/modifiers')).rows`
  - `listModels: async () => (await client.getPage<ModelView>('/admin/models')).rows`
  - `listApiKeys: async (tenantId) => (await client.getPage<ApiKeyView>('/admin/api-keys', { tenantId })).rows`
- [ ] **Step 2: Fix the keyset lists** (`listJobs`, `listLedger`) — drop the `r.jobs`/`r.transactions` unwraps; return `client.getPage<JobView>('/admin/jobs', { tenantId, cursor, limit })` and `client.getPage<LedgerView>('/admin/ledger', { tenantId, cursor, limit })` (both already typed `Promise<Page<T>>` — `getPage` returns exactly that). Fix `listUsage`/`listPayments` similarly: `listUsage: (p) => client.getPage<UsageLogView>('/admin/usage', p)`, `listPayments: (tenantId, limit?) => client.getPage<PaymentIntentView>('/admin/payments', { tenantId, limit })` (return `Page<T>` now; no consumer yet, so the signature change is safe — update their declared return types).
- [ ] **Step 3: Leave `analyticsUsage` unchanged** (`GET /admin/analytics/usage` still returns a bare `UsageRollupView[]`).
- [ ] **Step 4: Add the new Page-1 methods:**
  - `deleteChannel: (resourceId, channelId) => client.delete<void>(\`/admin/resources/${resourceId}/channels/${channelId}\`)`
  - `syncChannelModels: (resourceId, channelId, body: SyncChannelModelsBody) => client.post<SyncChannelModelsResult>(\`/admin/resources/${resourceId}/channels/${channelId}/sync-models\`, body)`
  - `updateResource: (id, body: UpdateResourceBody) => client.patch<ResourceView>(\`/admin/resources/${id}\`, body)`
- [ ] **Step 5: Thread idempotency on Page-1 create POSTs** — add an optional `idempotencyKey?: string` 2nd/3rd arg to `createResource`, `createChannel`, `createPricebook` and pass `{ idempotencyKey }` to `client.post`. (Call sites generate `crypto.randomUUID()`.)
- [ ] **Step 6: Verify** typecheck (existing `admin.test.ts` may need return-type tweaks if it asserts list shapes — fix to expect arrays/`Page`). Gate green. Commit `feat(web): admin client re-synced to pagination envelope + channel delete/sync + resource patch`.

## Task 3: `types.ts` — new bodies

**Files:** `src/lib/api/types.ts`.

- [ ] Add:

```ts
export interface UpdateResourceBody {
  status?: 'active' | 'disabled';
}
export interface SyncChannelModelsBody {
  defaultInputPrice?: number;
  defaultOutputPrice?: number;
}
export interface SyncChannelModelsResult {
  resource_id: string;
  created: string[];
  updated: string[];
  total: number;
}
```

- [ ] Verify typecheck. Commit `feat(web): types for resource patch + channel sync-models` (or fold into Task 2's commit).

## Task 4: `ConfirmDialog` component

**Files:** `src/components/ui/ConfirmDialog.tsx` (new) + `ConfirmDialog.test.tsx`. Built on `Modal`.

- [ ] **Test** `ConfirmDialog.test.tsx` (RTL): renders title + message + confirm/cancel buttons; clicking confirm calls `onConfirm`, cancel calls `onClose`; `danger` styles the confirm button.
- [ ] **Implement**: `ConfirmDialog({ open, title, message, confirmLabel?, cancelLabel?, danger?, loading?, onConfirm, onClose })` → a `Modal` with the message body + footer `[Cancel(ghost), Confirm(cta or danger, loading)]`. Reuse `Button`'s `danger` variant (added in L2) + `loading`. Tokens, no blue.
- [ ] Verify green. Commit `feat(web): confirmdialog for destructive actions`.

## Task 5: Page 1 — channel delete + sync-models + resource status edit

**Files:** `src/features/console/ResourceDetailPane.tsx`. Read it first (lists already get arrays from Task 2 → no `.data`/`.rows` change needed; confirm `channels.data ?? []`/`pricebook.data ?? []` still work — they do, the methods return arrays).

- [ ] **Channel delete**: add a "delete" `rowAction` (Phosphor `TrashIcon`, ghost danger) that opens a `ConfirmDialog`; on confirm → `deleteChannel(id, channel.id)` mutation → invalidate `qk.channels(id)` + `mutationError(t)` + success toast. Hold `const [delTarget, setDelTarget] = useState<ChannelView | undefined>()`; render one `ConfirmDialog` driven by it.
- [ ] **Sync-models**: add a `rowAction` "sync models" (Phosphor `ArrowsClockwiseIcon`) → `syncChannelModels(id, channel.id, {})` mutation → on success toast `t('channels.synced', { total })` and invalidate `qk.models()` (new models may be created). (No body fields needed for the minimal case.)
- [ ] **Resource status edit** (Overview tab): add a small control — a `SelectField` (or two buttons) for status `active`/`disabled` → `updateResource(id, { status })` mutation → invalidate `qk.resources()` + toast. Use `toOptions(CHANNEL_STATUSES, t)` (same active/disabled set) or a dedicated enum.
- [ ] **Idempotency** on the create mutations (ResourceDetailPane addChannel/addPrice, ResourcesPage createResource): pass `crypto.randomUUID()` as the idempotency key (generate once per mutation instance, e.g. `const idem = useState(() => crypto.randomUUID())[0]` reset per open — or generate inside mutationFn).
- [ ] **Verify** gate green. Commit `feat(web): resource detail — channel delete/sync-models + resource status edit`.

## Task 6: i18n

**Files:** `console.json` both locales.

- [ ] Add (synced): `common.{delete,confirm,cancel}`, `confirm.{deleteChannelTitle,deleteChannelMsg}`, `channels.actions.{delete,syncModels}`, `channels.synced` (`{{total}}`), `resources.actions.setStatus`. Verify gate + `vitest run` green. Commit `feat(web): i18n for channel delete/sync + resource status`.

---

## Final verification (controller, against the real API on :4173, backend current)

- [ ] Full gate + `vitest run` green.
- [ ] **Lists load again** (the unbreak): Resources list, channels, pricebook, Tenants, API Keys, Modifiers all render real rows (envelope unwrapped). Dashboard recent-jobs loads (`Page` via getPage).
- [ ] **Channel delete**: a channel row's delete → ConfirmDialog → removes it from the list.
- [ ] **Sync-models**: action runs, toasts the created/updated total.
- [ ] **Resource status**: toggling active/disabled persists (reload reflects it).
- [ ] Create flows still work (idempotency header sent; retry doesn't duplicate). No blue/emoji; dark+light.

## Self-review notes

- Unbreak = `getPage` + repointed lists; existing pages need NO list-read changes because catalog methods still return arrays (`.rows`). Keyset methods (`listJobs`/`listLedger`/`listUsage`/`listPayments`) fixed to read `data` not the removed `jobs`/`transactions`/`logs`/`intents`.
- No `*View`/enum/forms-toolkit changes (migration 0015 columns not projected; contracts unchanged).
- New CRUD limited to Page-1 needs (delete channel, sync-models, resource status). Other entities' CRUD (tenants/accounts/models/secrets/grants/traces/oauth) deferred to their pages.
- `ConfirmDialog` (previously deferred) is built here because real channel DELETE now exists and is destructive.
