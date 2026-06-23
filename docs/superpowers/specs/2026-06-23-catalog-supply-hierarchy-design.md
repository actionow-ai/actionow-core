# Catalog Supply-Hierarchy (模型服务) — Design Spec

> **Status:** Approved design (brainstorming output). Next: `superpowers:writing-plans`.
> **Sub-project A of 3.** Follow-ups (separate specs): **C** = plugin code editor (CodeMirror handler editor); **B** = provider-plugin library (built-in plugins for every LLM/image/video/audio/CLI-proxy/3rd-party family). This spec is A and must produce working software on its own.

**Goal:** Re-cast the operator catalog as a 平台 → 通道 → 模型 supply hierarchy: a platform's detail shows its channels (left) and the selected channel's served models (right, as a grid with a detail popup), backed by an explicit channel↔model link that also makes routing model-aware.

**Architecture:** No entity rename — `resource` stays the DB entity and all its FKs are untouched; "平台" is a **UI label + IA re-cast** applied to `kind='model'` resources. One **additive** `channel_model` link table records which channel serves which model (seeded by 模型同步, operator-editable; models remain platform-scoped). Routing gains a **hybrid-with-fallback** filter: a model routes among its linked active channels, falling back to the platform's other active channels. `provider_plugin` keeps its name 插件 and stays the adapter a channel picks.

**Tech stack:** pnpm/turbo monorepo. `@actionow/db` (drizzle), `@actionow/contracts` (zod → openapi → `@actionow/sdk`), `@actionow/engine` (routing), NestJS API (`apps/api`), Vite/React console (`apps/web`).

---

## 1. Scope & guiding constraints

- **In scope:** model platforms — `resource.kind = 'model'`. Their detail becomes the channel/model master-detail; the standalone `定价` tab dissolves (price shown per-model + per-channel cost).
- **Out of scope / untouched:** `kind = 'workflow'` resources (Dify) keep their current tabbed detail (channels + pricebook) — the pricebook/`dify_binding` flow is unchanged. The 插件/代理/Dify/凭据 catalog pages and the 计费与路由/租户 groups are unchanged except where noted (channel editor gains a 插件 picker; that already exists via `pluginId`).
- **No `resource` → `platform` rename.** `resource.id` is a human slug used as a FK across `model`, `upstream_channel`, `pricebook`, `dify_binding`, `usage_log`, etc. Renaming is high-risk churn for zero functional gain. The wire entity stays `resource`; only i18n labels + IA change to 平台.
- **Backward compatible at runtime.** A migration backfills `channel_model` for every existing `(channel, model)` of the same platform, so day-1 routing behaviour is identical; sync/edits refine it over time.

## 2. Data model (additive — `@actionow/db`)

### 2.1 New table `channel_model` (migration `0033`)

```ts
// packages/db/src/schema/catalog.ts
export const channelModel = pgTable(
  'channel_model',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => upstreamChannel.id),
    modelId: uuid('model_id')
      .notNull()
      .references(() => model.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.modelId] }),
    index('channel_model_model_idx').on(t.modelId), // inverse lookup: a model's channels
    index('channel_model_channel_idx').on(t.channelId),
  ],
);
```

- **Membership only.** Presence = "this channel serves this model." No per-link `enabled` (YAGNI — disable at channel or model level). Name remapping keeps using the existing `upstream_channel.model_map` (our model name → upstream id).
- Hard-delete a link on unbind (it's pure join data); models/channels are unaffected.

### 2.2 Migration + backfill (`0033`)

1. `CREATE TABLE channel_model …` (+ indexes, PK).
2. Backfill — one row per existing `(channel, model)` sharing a platform:
   ```sql
   INSERT INTO channel_model (channel_id, model_id)
   SELECT c.id, m.id
   FROM upstream_channel c JOIN model m ON m.resource_id = c.resource_id
   WHERE c.deleted_at IS NULL AND m.deleted_at IS NULL
   ON CONFLICT DO NOTHING;
   ```
   This preserves today's "any channel of a platform serves any of its models" so routing is unchanged at cutover.

### 2.3 Repository functions (`packages/db/src/repositories/`)

- `model.ts`: `listChannelModels(db, channelId)` → models linked to a channel (the right-panel grid); `listModelChannels(db, modelId)` → the inverse (popup "服务通道" + routing); `linkChannelModel(db, channelId, modelId)`; `unlinkChannelModel(db, channelId, modelId)`.
- `model.ts`: extend the model row reads used by views to optionally include served-channel ids (or expose via the dedicated `listModelChannels`).

## 3. Routing — hybrid with fallback (`@actionow/engine` + channel loading)

Today the candidate-channel set for a request is **all active channels of the model's resource** (`upstream_channel where resource_id = … and status='active'`), fed to `routeBlocking`/`routeWithFailover` (`packages/engine/src/channel-routing.ts`). Change the **candidate query** (in the API/engine boundary that loads channels for a model — the chat/media relay services), not the router algorithm:

1. Resolve the request model → `model` row → `resource_id`.
2. Candidates = active channels of that resource **that are linked to this model** via `channel_model`.
3. **Fallback:** if that set is empty (model has no links yet) **or** every linked candidate is cooling down (`channel_health.cooldown_until > now`), fall back to **all** active channels of the resource (today's behaviour).
4. The router (weighted tier + cooldown + `isFailoverRetryable`) is unchanged; it just receives a (possibly) filtered candidate list.

This keeps a channel that genuinely doesn't serve a model out of rotation, while never hard-failing a model that has no links or whose links are all unhealthy. Add a debug log when the fallback path fires.

## 4. Sync — `syncChannelModels` also writes links

`syncChannelModels` (admin service) currently upserts `model` rows under the resource from a channel's discovered upstream models. Add: for each discovered model, **upsert a `channel_model` link** for `(thisChannel, thatModel)`. Result: a freshly-synced channel auto-populates its served-model grid; models remain platform-scoped (resource-owned).

## 5. API · contracts · SDK

### 5.1 Endpoints (`apps/api`)

- `GET /admin/channels/:channelId/models` → the channel's linked models (right-panel grid).
- `POST /admin/channels/:channelId/models` → `{ modelId }` link existing, or `{ create: ModelCreateInput }` create-and-link. Idempotency-Key honored.
- `DELETE /admin/channels/:channelId/models/:modelId` → unlink (does not delete the model).
- Reuse existing model CRUD (`/admin/models`) for editing a model from the popup.

### 5.2 Contract views (`@actionow/contracts`)

- `modelViewSchema` (catalog-views): add `served_channel_ids: z.array(z.string())` (the inverse, for the popup "服务通道" + the FE to know link membership). Backend `toView` mapper joins `channel_model`.
- `channelViewSchema`: add `model_count: z.number()` (shown on the channel card).
- New `channelModelLinkInputSchema` for the POST body.
- Regenerate: `pnpm --filter @actionow/contracts build && gen:openapi && pnpm --filter @actionow/sdk gen && build`. FE imports the inferred TYPES only.

## 6. Operator UI (`apps/web`)

### 6.1 Navigation & naming

- Relabel the catalog nav item: i18n `nav.resources` / `subtitles.resources` → **模型服务** wording (route `/console/catalog` unchanged). `provider_plugin` page keeps **插件**.
- All resource-facing labels for `kind='model'` read **平台** (i18n only).

### 6.2 Platform list (entry) — `ResourcesPage`

Unchanged master list of platform cards (today's resource cards). On a platform card click, drill into the platform detail.

### 6.3 Platform detail — `ResourceDetailPane` (rewritten for `kind='model'`)

- **Header** (already merged in round-3): platform identity + meta + status `SelectField` + a **breadcrumb** (模型服务 / `<platform>`).
- **Body = two-pane master-detail:**
  - **Left ⅓ — channel cards** (`ChannelCard`): provider icon, channel name, endpoint host, the 插件/adapter it uses, weight, `model_count`, health/status dot. A selected card highlights. `+ 通道` opens `ChannelEditor` (existing; it already has the 插件 picker + proxy picker). Per-card actions: edit / enable-disable / 模型同步 / delete.
  - **Right ⅔ — model grid** (`ModelGrid`) for the selected channel: a responsive card grid (`repeat(auto-fill, minmax(~150px,1fr))`). Each `ModelCard`: name, modality chip, price (in/out), status dot. Toolbar: `模型同步` (sync this channel) + `+ 模型` (link existing platform model OR create+link). Click a card → **model detail popup** (`Drawer`/`Modal`): modality, capabilities, price in/out, **服务通道** (the inverse links), rate limit, fallback chain, visibility — with 编辑 (→ `ModelEditor`) and 从通道解绑 (unlink) actions.
- **`kind='workflow'` fallback:** render the existing tabbed detail (通道 + 定价) unchanged. Branch on `resource.kind`.
- **`定价` dissolves for model platforms:** per-model price lives on the model card + popup; per-channel cost stays on the channel (editor + card). No standalone pricebook tab for `kind='model'`.
- Narrow viewport: drill (platform → channels → models) with the breadcrumb/back, reusing the round-3 `ConsoleBack` pattern.

### 6.4 New/changed components

- `ChannelCard`, `ModelGrid`, `ModelCard`, `ModelDetailDrawer` (new, under `features/console/`).
- `ModelsSection` (today's per-resource model table) → repurposed into the per-channel `ModelGrid` (or replaced).
- `queryKeys.ts`: `channelModels(channelId)`, `modelChannels(modelId)`.
- `useAdminApi`: `listChannelModels`, `linkChannelModel`, `unlinkChannelModel`.

## 7. Tenant-facing 模型列表 (对外显示)

`/app/models` (`AppModels.tsx`) already lists usable models (public + granted). Minimal change: confirm it reflects the catalog; optionally reuse a read-only model-detail popup for parity. No tenant-side data-model change. (Tenant routing already resolves model → resource → channels; the new link filter applies transparently.)

## 8. Error handling & edge cases

- Unbinding the **last** channel from a model → the model has zero links → routing fallback keeps it servable via all platform channels; surface a subtle "无专属通道，回退到平台通道" hint on the model card.
- Linking a model already linked → `ON CONFLICT DO NOTHING` (idempotent).
- Deleting a channel → cascade-remove its `channel_model` rows (FK/manual in the delete repo fn).
- A model whose `resource_id` ≠ the channel's resource cannot be linked (validate in the POST handler).

## 9. Testing

- **db (int):** `channel_model` link/unlink/list (both directions); `syncChannelModels` writes links; backfill query produces the expected pairs; channel delete removes links.
- **engine/relay:** model routes among linked channels; fallback fires when no links / all cooling; unchanged when backfilled.
- **contracts:** `modelViewSchema` (+`served_channel_ids`) and `channelViewSchema` (+`model_count`) fixtures parse; mapper round-trips.
- **web:** platform detail renders channel cards + model grid; selecting a channel swaps the grid; model popup opens with 服务通道; link/unlink mutates + invalidates; `kind='workflow'` still shows the tabbed detail.

## 10. Phasing (for writing-plans)

1. **Schema + migration + backfill + repos** (`channel_model`, link fns, sync writes links).
2. **Routing** hybrid-fallback in the candidate query + engine tests.
3. **Contracts/SDK** (`served_channel_ids`, `model_count`, link endpoints) + API handlers.
4. **Operator UI** (platform detail two-pane, ChannelCard/ModelGrid/ModelCard/ModelDetailDrawer, nav relabel, 定价 dissolve, workflow fallback).
5. **Tenant 模型列表** parity pass + cleanup.

## 11. Open questions (none blocking)

- Exact `模型服务` vs `平台` nav wording — decided 模型服务 for the nav group; platform for the node. Adjustable in i18n.
- Whether a per-link `enabled` toggle is wanted later (deferred, YAGNI).
