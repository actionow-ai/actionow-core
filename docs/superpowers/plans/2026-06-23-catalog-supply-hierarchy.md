# Catalog Supply-Hierarchy (模型服务) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-cast the operator catalog as 平台 → 通道 → 模型: each channel owns an explicit list of the models it serves (a `channel_model` link), the platform detail shows channel cards (left) + the selected channel's model grid (right) + a model-detail popup, and routing prefers a model's linked channels with fallback to the platform's others.

**Architecture:** Additive only. `resource` stays the DB entity (no rename); 平台 is a UI label on `kind='model'` resources. A `channel_model` join table (membership, seeded by 模型同步, backfilled at migration) records channel↔model. `ChannelRoutingService.candidatesFor` gains an optional `modelId` and **demotes non-linked channels to a lower priority tier**, so the engine's existing priority-tiered failover yields "prefer linked, fall back to platform" for free. Spec: `docs/superpowers/specs/2026-06-23-catalog-supply-hierarchy-design.md`.

**Tech Stack:** drizzle (`@actionow/db`), zod→openapi→`@actionow/sdk` (`@actionow/contracts`), `@actionow/engine` routing, NestJS (`apps/api`), Vite/React (`apps/web`). Tests: vitest. Migrations: `pnpm --filter @actionow/db db:generate` then `db:migrate`.

**Conventions to follow (read before starting):**

- Repo fns live in `packages/db/src/repositories/*.ts` and are re-exported from `index.ts`.
- Contract views in `packages/contracts/src/catalog-views.ts`; backend `toView` mappers `.parse()` against them; FE imports inferred TYPES only.
- After ANY contract change: `pnpm --filter @actionow/contracts build && pnpm --filter @actionow/contracts gen:openapi && pnpm --filter @actionow/sdk gen && pnpm --filter @actionow/sdk build`.
- Web column/table conventions: see the round-4 `Column` API (`numeric`/`noClip`/`grow`/`toolbarActions`) in `apps/web/src/components/data/DataTable.tsx`.

---

## Phase 1 — Schema, migration, backfill, repositories

### Task 1.1: `channel_model` table

**Files:**

- Modify: `packages/db/src/schema/catalog.ts` (add table after `channelHealth`)
- Modify: `packages/db/src/schema/index.ts` (export if it re-exports per-table; verify)

- [ ] **Step 1: Add the table**

In `packages/db/src/schema/catalog.ts`, add `primaryKey` to the `drizzle-orm/pg-core` import, then append:

```ts
/**
 * Channel↔model membership (catalog supply-hierarchy): which `upstream_channel`
 * serves which `model`. Seeded by `syncChannelModels`, operator-editable; models
 * stay platform-scoped (`model.resource_id`). Presence = "this channel can serve
 * this model"; routing prefers a model's linked channels (see ChannelRoutingService).
 */
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
    index('channel_model_model_idx').on(t.modelId),
    index('channel_model_channel_idx').on(t.channelId),
  ],
);
```

Note: `model` is in `packages/db/src/schema/model.ts` which already imports `resource` from `catalog.ts`. Importing `model` INTO `catalog.ts` would create a cycle. Avoid it: define `channelModel` in `packages/db/src/schema/model.ts` instead (it already imports nothing from catalog except via `resource`; it CAN import `upstreamChannel` from catalog). Put the table in `model.ts`, importing `upstreamChannel` from `./catalog.js`. Add `primaryKey`, `index` to model.ts's pg-core import.

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @actionow/db db:generate`
Expected: a new `packages/db/migrations/0033_*.sql` creating `channel_model` with the PK + 2 indexes.

- [ ] **Step 3: Append the backfill to the generated SQL**

Open the new `0033_*.sql` and append (so existing channel/model pairs are linked → routing unchanged at cutover):

```sql
--> statement-breakpoint
INSERT INTO "channel_model" ("channel_id", "model_id")
SELECT c."id", m."id"
FROM "upstream_channel" c
JOIN "model" m ON m."resource_id" = c."resource_id"
WHERE c."deleted_at" IS NULL AND m."deleted_at" IS NULL
ON CONFLICT DO NOTHING;
```

- [ ] **Step 4: Apply + verify**

Run: `pnpm --filter @actionow/db db:migrate`
Then verify: `psql "$DATABASE_URL" -c "select count(*) from channel_model;"`
Expected: a non-zero count equal to Σ(channels × models) per resource for seeded data.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/model.ts packages/db/migrations/
git commit -m "feat(db): channel_model link table + backfill"
```

### Task 1.2: Link repository functions

**Files:**

- Modify: `packages/db/src/repositories/model.ts`
- Modify: `packages/db/src/repositories/index.ts` (re-export the new fns)
- Test: `packages/db/test/channel-model.int.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/channel-model.int.test.ts` mirroring an existing int test's harness (copy the testcontainer/db setup from `packages/db/test/redemption-service.int.test.ts` header). Body:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
// ...reuse the int-test db bootstrap (migrated test DB) as `db`, plus seed helpers
import {
  linkChannelModel,
  unlinkChannelModel,
  listChannelModels,
  listModelChannels,
} from '../src/repositories/model.js';

describe('channel_model links', () => {
  it('links, lists both directions, and unlinks', async () => {
    const { channelId, modelId } = await seedChannelAndModel(db); // helper: one resource, one channel, one model
    await linkChannelModel(db, channelId, modelId);
    expect((await listChannelModels(db, channelId)).map((m) => m.id)).toContain(modelId);
    expect(await listModelChannels(db, modelId)).toContain(channelId);
    await unlinkChannelModel(db, channelId, modelId);
    expect(await listChannelModels(db, channelId)).toHaveLength(0);
    expect(await listModelChannels(db, modelId)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @actionow/db test channel-model`
Expected: FAIL — `linkChannelModel is not a function` (not yet exported).

- [ ] **Step 3: Implement the repo fns**

In `packages/db/src/repositories/model.ts`, import `channelModel` from `../schema/model.js` (same file) and add (after the existing model fns):

```ts
/** Link a channel to a model (idempotent). */
export async function linkChannelModel(
  db: DbOrTx,
  channelId: string,
  modelId: string,
): Promise<void> {
  await db.insert(channelModel).values({ channelId, modelId }).onConflictDoNothing();
}

/** Remove a channel↔model link (idempotent). */
export async function unlinkChannelModel(
  db: DbOrTx,
  channelId: string,
  modelId: string,
): Promise<void> {
  await db
    .delete(channelModel)
    .where(and(eq(channelModel.channelId, channelId), eq(channelModel.modelId, modelId)));
}

/** Remove ALL links for a channel (called when a channel is deleted). */
export async function unlinkAllForChannel(db: DbOrTx, channelId: string): Promise<void> {
  await db.delete(channelModel).where(eq(channelModel.channelId, channelId));
}

/** The active models a channel serves (right-panel grid), newest link first. */
export async function listChannelModels(db: DbOrTx, channelId: string): Promise<ModelRow[]> {
  return db
    .select(MODEL_COLUMNS) // reuse the existing column projection used by listModels; if none, inline model.* fields
    .from(model)
    .innerJoin(channelModel, eq(channelModel.modelId, model.id))
    .where(and(eq(channelModel.channelId, channelId), isNull(model.deletedAt)))
    .orderBy(desc(channelModel.createdAt));
}

/** The channel ids that serve a model (inverse — routing + popup 服务通道). */
export async function listModelChannels(db: DbOrTx, modelId: string): Promise<string[]> {
  const rows = await db
    .select({ channelId: channelModel.channelId })
    .from(channelModel)
    .where(eq(channelModel.modelId, modelId));
  return rows.map((r) => r.channelId);
}
```

If `MODEL_COLUMNS`/`ModelRow` don't already exist in `model.ts`, use the same select shape `listModels` uses and its row type. Ensure `and, eq, isNull, desc` are imported from `drizzle-orm`.

- [ ] **Step 4: Re-export**

In `packages/db/src/repositories/index.ts`, add `linkChannelModel, unlinkChannelModel, unlinkAllForChannel, listChannelModels, listModelChannels` to the model repo export block.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @actionow/db test channel-model`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repositories/ packages/db/test/channel-model.int.test.ts
git commit -m "feat(db): channel_model link repository fns"
```

### Task 1.3: Sync writes links + channel-delete cascades

**Files:**

- Modify: `apps/api/src/admin/admin.service.ts` (`syncChannelModels` ~line 998, `deleteChannel` ~line near 954)
- Test: extend `apps/api/test/admin-models.e2e.*` or the admin service int test that covers sync.

- [ ] **Step 1: Write the failing test**

In the existing admin sync test (find via `grep -rn "syncChannelModels" apps/api/test`), after a sync, assert the synced models are linked to the channel:

```ts
const linked = await listModelChannels(db, syncedModelId);
expect(linked).toContain(channelId);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @actionow/api test admin-models`
Expected: FAIL — link not written by sync yet.

- [ ] **Step 3: Implement**

In `admin.service.ts` `syncChannelModels`, for each upserted model row, call `await linkChannelModel(this.db, channelId, modelRow.id);` (import it). In `deleteChannel`, before/after the soft-delete call `await unlinkAllForChannel(this.db, channelId);`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @actionow/api test admin-models`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/admin/admin.service.ts apps/api/test/
git commit -m "feat(api): sync seeds channel_model links; channel delete unlinks"
```

---

## Phase 2 — Hybrid routing (prefer linked, fall back to platform)

### Task 2.1: Demote non-linked channels in `candidatesFor`

**Files:**

- Modify: `apps/api/src/common/channel-routing.service.ts`
- Modify callers: `apps/api/src/chat/chat-relay.service.ts:197`, `apps/api/src/execution/run.service.ts:146`
- Test: `apps/api/test/channel-routing.service.*` (create or extend)

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/channel-routing.hybrid.int.test.ts`. Seed a resource with 2 channels (A, B) + 1 model linked to A only. Assert:

```ts
const cands = await routing.candidatesFor(resourceId, null, modelId);
const a = cands.find((c) => c.id === channelA)!;
const b = cands.find((c) => c.id === channelB)!;
expect(b.priority).toBeGreaterThan(a.priority); // linked A preferred; unlinked B demoted to a lower tier
// no links at all → all equal (fallback)
const noLink = await routing.candidatesFor(resourceId, null, modelWithNoLinks);
expect(new Set(noLink.map((c) => c.priority)).size).toBe(1);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @actionow/api test channel-routing.hybrid`
Expected: FAIL — `candidatesFor` ignores the 3rd arg today.

- [ ] **Step 3: Implement**

In `channel-routing.service.ts`: add `import { listModelChannels } from '@actionow/db';`, a module const, and the `modelId` param + demotion:

```ts
/** Non-linked channels are pushed to this far-lower priority tier so the engine's
 *  priority-tiered failover tries a model's LINKED channels first and only falls
 *  back to the platform's other channels when the linked ones are exhausted/cooling. */
const UNLINKED_PRIORITY_OFFSET = 1_000_000;
```

```ts
  async candidatesFor(
    resourceId: string,
    routeGroupId: string | null | undefined,
    modelId?: string,
  ): Promise<RunChannel[]> {
    const groupId = routeGroupId ?? (await this.resolveDefaultGroupId());
    let base: RunChannel[];
    if (groupId !== null) {
      const grouped = await listGroupChannelsForResource(this.db, resourceId, groupId);
      if (grouped.length > 0) {
        base = await this.attachFaultPolicies(grouped.map(toRunChannelFromGroup), grouped);
      } else {
        const all = await listChannels(this.db, resourceId);
        base = await this.attachFaultPolicies(all.map(toRunChannelFromChannel), all);
      }
    } else {
      const all = await listChannels(this.db, resourceId);
      base = await this.attachFaultPolicies(all.map(toRunChannelFromChannel), all);
    }
    return this.preferLinked(base, modelId);
  }

  /** Demote channels NOT linked to `modelId` to a lower tier (hybrid fallback).
   *  No-op when modelId is absent, the model has no links, or NONE of the current
   *  candidates is linked (then every candidate stays — full platform fallback). */
  private async preferLinked(channels: RunChannel[], modelId?: string): Promise<RunChannel[]> {
    if (modelId === undefined || channels.length === 0) return channels;
    const linked = new Set(await listModelChannels(this.db, modelId));
    if (linked.size === 0 || !channels.some((c) => linked.has(c.id))) return channels;
    for (const c of channels) if (!linked.has(c.id)) c.priority += UNLINKED_PRIORITY_OFFSET;
    return channels;
  }
```

Refactor the duplicated `listChannels` branch into the inline form above (DRY-acceptable; keeps the grouped/ungrouped logic intact). Keep `attachFaultPolicies`, the toRunChannel mappers, and `groupRatioBpsFor` unchanged.

- [ ] **Step 4: Thread `modelId` from callers**

`chat-relay.service.ts:197`:

```ts
const channels = await this.routing.candidatesFor(resourceId, ctx.routeGroupId, resolved.modelId);
```

`run.service.ts:146`: same — pass the resolved model id available there (find the resolved model in that scope; if `run.service` resolves via `resolveModelForTenant`, use `resolved.modelId`; if it routes a workflow resource with no model, pass `undefined` — the param is optional, behaviour unchanged).

- [ ] **Step 5: Run the test + the existing routing/relay tests**

Run: `pnpm --filter @actionow/api test channel-routing && pnpm --filter @actionow/api test chat-relay`
Expected: PASS (backfilled/all-linked → single tier → unchanged; the new test's partial-link case demotes B).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/common/channel-routing.service.ts apps/api/src/chat/chat-relay.service.ts apps/api/src/execution/run.service.ts apps/api/test/channel-routing.hybrid.int.test.ts
git commit -m "feat(api): model-aware routing — prefer a model's linked channels, fall back to platform"
```

---

## Phase 3 — Contracts, SDK, API endpoints

### Task 3.1: Extend contract views

**Files:**

- Modify: `packages/contracts/src/catalog-views.ts`
- Test: `packages/contracts/test/catalog-views.test.ts`

- [ ] **Step 1: Add fields + the link-input schema**

In `catalog-views.ts`, add to `channelViewSchema` (after `fault_policy_id`):

```ts
  /** Count of models this channel serves (channel_model links). */
  model_count: z.number(),
```

Add to `modelViewSchema` (after `fallback_models`):

```ts
  /** Channel ids that serve this model (inverse channel_model links; popup 服务通道). */
  served_channel_ids: z.array(z.string()),
```

Add a new export:

```ts
/** `POST /admin/resources/:id/channels/:channelId/models` body: link existing or create+link. */
export const channelModelLinkInputSchema = z.object({
  model_id: z.string().optional(),
});
export type ChannelModelLinkInput = z.infer<typeof channelModelLinkInputSchema>;
```

- [ ] **Step 2: Update the test fixtures**

In `packages/contracts/test/catalog-views.test.ts`, add `model_count: 2` to the `channelViewSchema` fixture and `served_channel_ids: []` to the `modelViewSchema` fixture (these are required — a missing field fails `.parse`, the same trap fixed in PR #16/#17).

- [ ] **Step 3: Run the contracts test**

Run: `pnpm --filter @actionow/contracts test`
Expected: PASS.

- [ ] **Step 4: Regenerate SDK**

Run:

```bash
pnpm --filter @actionow/contracts build && pnpm --filter @actionow/contracts gen:openapi && pnpm --filter @actionow/sdk gen && pnpm --filter @actionow/sdk build
```

Expected: clean build; `packages/sdk` reflects the new fields.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/ packages/sdk/
git commit -m "feat(contracts): channel.model_count + model.served_channel_ids + link input; regen sdk"
```

### Task 3.2: `toView` mappers populate the new fields

**Files:**

- Modify: `apps/api/src/admin/admin.controller.ts` (`toChannelView` ~line 1380, `toModelView`)
- Modify: `apps/api/src/admin/admin.service.ts` (give the channel/model list reads the counts/ids)

- [ ] **Step 1: Plumb `model_count` into channel views**

The channel list service (`listChannels`/`getChannel` path used by `toChannelView`) must supply a count. Add a repo fn `countChannelModels(db, channelId)` OR batch in the list: in `admin.service.listChannels`, after loading channels, `const counts = await modelCountsByChannel(db, channelIds)` (a `select channel_id, count(*) … group by channel_id` repo fn) and attach. `toChannelView(row)` reads `row.modelCount ?? 0` → `model_count`.

- [ ] **Step 2: Plumb `served_channel_ids` into model views**

In the model read path feeding `toModelView`, attach `served_channel_ids` via `listModelChannels(db, model.id)` (batch for lists: a `select model_id, channel_id … where model_id in (...)` repo fn `channelIdsByModel(db, modelIds)` → Map). `toModelView` reads `row.servedChannelIds ?? []`.

- [ ] **Step 3: Run the admin view tests**

Run: `pnpm --filter @actionow/api test admin`
Expected: PASS (views now parse against the extended schemas).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/admin/ packages/db/src/repositories/
git commit -m "feat(api): channel model_count + model served_channel_ids in views"
```

### Task 3.3: Link endpoints

**Files:**

- Modify: `apps/api/src/admin/admin.controller.ts` (add 3 routes near the existing `resources/:id/channels/:channelId/sync-models` ~line 663)
- Modify: `apps/api/src/admin/admin.service.ts` (link/unlink/list wrappers)
- Test: `apps/api/test/admin-channel-models.e2e.*` (create)

- [ ] **Step 1: Write the failing e2e test**

Mirror an existing admin e2e (e.g. the channels e2e). Steps: create resource + channel + model; `POST /admin/resources/:id/channels/:cid/models {model_id}` → 201; `GET …/models` → contains the model; `DELETE …/models/:modelId` → 204; `GET` → empty.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @actionow/api test admin-channel-models`
Expected: FAIL — routes 404.

- [ ] **Step 3: Implement controller routes**

In `admin.controller.ts`, add (import `channelModelLinkInputSchema`, `toModelView`, the service fns):

```ts
@Get('resources/:id/channels/:channelId/models')
async listChannelModels(
  @Param('id') id: string,
  @Param('channelId') channelId: string,
) {
  const rows = await this.admin.listChannelModels(id, channelId);
  return rows.map(toModelView);
}

@Post('resources/:id/channels/:channelId/models')
@HttpCode(201)
async linkChannelModel(
  @Param('id') id: string,
  @Param('channelId') channelId: string,
  @Body(new ZodBody(channelModelLinkInputSchema)) dto: ChannelModelLinkInput,
) {
  await this.admin.linkChannelModel(id, channelId, dto);
  return { ok: true };
}

@Delete('resources/:id/channels/:channelId/models/:modelId')
@HttpCode(204)
async unlinkChannelModel(
  @Param('id') id: string,
  @Param('channelId') channelId: string,
  @Param('modelId') modelId: string,
) {
  await this.admin.unlinkChannelModel(id, channelId, modelId);
}
```

- [ ] **Step 4: Implement service methods**

In `admin.service.ts`:

```ts
async listChannelModels(resourceId: string, channelId: string): Promise<ModelRow[]> {
  await this.getChannel(resourceId, channelId); // 404s if channel not in resource
  return listChannelModels(this.db, channelId);
}
async linkChannelModel(resourceId: string, channelId: string, dto: ChannelModelLinkInput): Promise<void> {
  await this.getChannel(resourceId, channelId);
  if (dto.model_id === undefined) throw new BadRequestException('model_id required');
  const m = await getModelById(this.db, dto.model_id); // add this repo fn if missing
  if (m === undefined || m.resourceId !== resourceId) {
    throw new BadRequestException('model must belong to the same platform');
  }
  await linkChannelModel(this.db, channelId, dto.model_id);
}
async unlinkChannelModel(resourceId: string, channelId: string, modelId: string): Promise<void> {
  await this.getChannel(resourceId, channelId);
  await unlinkChannelModel(this.db, channelId, modelId);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @actionow/api test admin-channel-models`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/admin/ packages/db/src/repositories/ apps/api/test/admin-channel-models.e2e.ts
git commit -m "feat(api): channel↔model link endpoints"
```

---

## Phase 4 — Operator UI (platform detail two-pane + model popup)

### Task 4.1: SDK client + query keys

**Files:**

- Modify: `apps/web/src/lib/api/queryKeys.ts`
- Modify: `apps/web/src/lib/api/useAdminApi.ts`

- [ ] **Step 1: Add query keys**

In `queryKeys.ts` (after `channels`):

```ts
  channelModels: (channelId: string) => ['admin', 'channels', channelId, 'models'] as const,
```

- [ ] **Step 2: Add API methods**

In `useAdminApi.ts`, add (mirroring existing channel methods, using the resource+channel nested path):

```ts
listChannelModels: (resourceId: string, channelId: string) =>
  GET(`/admin/resources/${resourceId}/channels/${channelId}/models`),
linkChannelModel: (resourceId: string, channelId: string, modelId: string) =>
  POST(`/admin/resources/${resourceId}/channels/${channelId}/models`, { model_id: modelId }),
unlinkChannelModel: (resourceId: string, channelId: string, modelId: string) =>
  DELETE(`/admin/resources/${resourceId}/channels/${channelId}/models/${modelId}`),
```

Match the exact GET/POST/DELETE helper signatures already used in the file.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @actionow/web typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/api/
git commit -m "feat(web): channel-models api client + query keys"
```

### Task 4.2: `ModelDetailDrawer` component

**Files:**

- Create: `apps/web/src/features/console/ModelDetailDrawer.tsx`

- [ ] **Step 1: Build the drawer**

A read-first detail `Drawer` (reuse `components/ui/Drawer.tsx`) showing a `ModelView`: modality, capability chips, input/output price, `served_channel_ids` (resolve names from the channel list passed in), `rate_limit`, `fallback_models`, `visibility`, `status`. Footer buttons: 编辑 (calls an `onEdit` prop → opens `ModelEditor`) and 从通道解绑 (calls `onUnlink(modelId)`). Props: `{ model: ModelView; channelName?: string; onEdit: () => void; onUnlink: () => void; onClose: () => void }`. Use the existing `Pill`/`StatusBadge`/`.chip` primitives; no new tokens.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @actionow/web typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/features/console/ModelDetailDrawer.tsx
git commit -m "feat(web): ModelDetailDrawer"
```

### Task 4.3: Platform detail two-pane (channel cards │ model grid)

**Files:**

- Modify: `apps/web/src/features/console/ResourceDetailPane.tsx`
- Create: `apps/web/src/features/console/ChannelCard.tsx`, `apps/web/src/features/console/ModelGrid.tsx`
- Modify: `apps/web/src/i18n/locales/{zh-CN,en}/console.json`

- [ ] **Step 1: ChannelCard**

`ChannelCard` props `{ channel: ChannelView; selected: boolean; onSelect: () => void; onEdit/onToggle/onSync/onDelete }`. Card shows: `ProviderIcon`, provider/name, endpoint host (muted), `model_count` chip, weight chip, a health/status dot (`StatusBadge`/`Pill`). Selected → `border: 2px solid var(--border? use --accent)` ring (match `.entity-card.is-selected`). Reuse `.entity-card` class.

- [ ] **Step 2: ModelGrid**

`ModelGrid` props `{ resourceId; channel: ChannelView; }`. Query `qk.channelModels(channel.id)` → `api.listChannelModels`. Render a CSS grid `gridTemplateColumns: repeat(auto-fill, minmax(150px, 1fr))` of model cards (name, modality chip, price, status dot). Toolbar above: `模型同步` (calls existing `syncChannelModels` mutation) + `+ 模型` (opens a small picker: link an existing platform model or open `ModelEditor` to create). Card click → open `ModelDetailDrawer`. Unlink → `api.unlinkChannelModel` then invalidate `qk.channelModels(channel.id)` + `qk.models()`.

- [ ] **Step 3: Wire into ResourceDetailPane (model platforms only)**

Replace the `通道/模型/定价` sub-tabs for `resource.kind === 'model'` with: keep the merged header (round-3) + a breadcrumb, then a two-column layout `gridTemplateColumns: minmax(240px, 0.4fr) minmax(0, 1fr)` — left `<ChannelList>` of `ChannelCard`s (selection in url-state `?cid=`), right `<ModelGrid channel={selectedChannel} />` (empty-state prompt when no channel selected). Keep `ChannelEditor` (it already has the 插件 + proxy pickers) for add/edit. For `resource.kind !== 'model'`, render the EXISTING tabbed detail unchanged (channels + pricing) — branch at the top of the render.

- [ ] **Step 4: i18n**

Add keys: `resources.detail.servedModels`, `resources.detail.pickChannel`, `models.link`, `models.unlink`, `models.servedChannels`, breadcrumb labels — in both `zh-CN` and `en` console.json. (zh first; mirror to en.)

- [ ] **Step 5: Typecheck + lint + verify in preview**

Run: `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web lint`
Then preview: start `web-dev`, open `/console/catalog?id=<model-platform>`, confirm channel cards left, model grid right on channel select, model popup opens, link/unlink works, and a `kind=workflow` resource still shows the old tabs. Check console for errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/console/ apps/web/src/i18n/
git commit -m "feat(web): platform detail — channel cards │ model grid │ model popup"
```

### Task 4.4: Nav relabel + 定价 dissolve

**Files:**

- Modify: `apps/web/src/i18n/locales/{zh-CN,en}/console.json` (`nav.resources`, `subtitles.resources` → 模型服务 wording)
- Modify: `apps/web/src/features/console/ResourceDetailPane.tsx` (ensure no standalone 定价 tab for `kind='model'`; price shown on model card/popup + channel cost in ChannelEditor)

- [ ] **Step 1: Relabel nav**

Update `nav.resources` to 模型服务 (and `subtitles.resources`). Leave the route + `labelKey` as `resources` (only the translated string changes), so `nav-config.ts` is untouched.

- [ ] **Step 2: Confirm 定价 dissolved**

For `kind='model'`, the detail has NO 定价 tab (Task 4.3 already omits it). Verify the per-model price renders on the model card + popup and per-channel cost remains in `ChannelEditor`. (Pricebook remains only for `kind='workflow'`.)

- [ ] **Step 3: Verify + commit**

Preview check, then:

```bash
git add apps/web/src/i18n/ apps/web/src/features/console/ResourceDetailPane.tsx
git commit -m "feat(web): nav 模型服务 + dissolve standalone 定价 tab for model platforms"
```

---

## Phase 5 — Tenant 模型列表 parity + final verification

### Task 5.1: Tenant model list parity

**Files:**

- Modify: `apps/web/src/features/app/AppModels.tsx` (optional read-only detail popup for parity)

- [ ] **Step 1: Confirm coverage**

`/app/models` already lists usable models (public + granted). Verify it reflects the catalog post-change (no data-model change tenant-side; routing link filter is transparent). Optionally add a read-only model-detail popup mirroring `ModelDetailDrawer` (no channel internals exposed to tenants — show modality/capabilities/price only).

- [ ] **Step 2: Verify in preview + commit**

Preview `/app/models`. Then:

```bash
git add apps/web/src/features/app/AppModels.tsx
git commit -m "feat(web): tenant model list parity"
```

### Task 5.2: Full regression gate

- [ ] **Step 1: Run everything**

```bash
pnpm --filter @actionow/db test && pnpm --filter @actionow/contracts test && pnpm --filter @actionow/api test && pnpm --filter @actionow/web test && pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web lint
```

Expected: all green (testcontainer flakes under parallel Docker load — re-run the failing suite in isolation to confirm).

- [ ] **Step 2: Live smoke (Bash-context api + curl)**

Start api + worker, create a 2-channel platform, link a model to one channel, send a chat for that model, confirm it routes to the linked channel (relay-trace), disable that channel, confirm fallback to the other. Clean up test artifacts after.

- [ ] **Step 3: Final commit / open PR** (when the user authorizes the PR)

```bash
git commit -m "feat(catalog): supply-hierarchy 模型服务 (channel↔model + hybrid routing + platform detail)"
```

---

## Notes for the executor

- This plan is Spec A only. Spec C (CodeMirror plugin editor) and Spec B (provider-plugin library) are separate plans.
- The round-3 + round-4 UI polish is a separate, already-finished deliverable on `main` (uncommitted) — coordinate the PR boundary with the user.
- If `getModelById` / `MODEL_COLUMNS` / batch count helpers don't exist, add them following the nearest existing repo fn; don't invent new patterns.
