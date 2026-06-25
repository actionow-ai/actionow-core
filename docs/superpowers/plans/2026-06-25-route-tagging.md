# 路由染色 + 标签路由 (Route Tagging) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add channel tags + an `X-Actionow-Route-Tag` canary header that hard-pins a request to channels carrying that tag (narrow-only), recording the tag on `relay_trace` + `usage_log`.

**Architecture:** The tag filter is applied at the candidate-resolution layer (`ChannelRoutingService.candidatesFor`) on top of the already-resolved candidate set — so it can only narrow, never escalate. The relay entrypoints read the header and thread `routeTag` into the run-request builder; the engine records it on the trace + usage rows.

**Tech Stack:** NestJS (apps/api), drizzle/postgres (packages/db), zod contracts (packages/contracts), Vite/React (apps/web), vitest; db/api e2e use `@testcontainers/postgresql`.

**Spec:** `docs/superpowers/specs/2026-06-25-route-tagging-design.md`. Branch: `feat/route-tagging` (spec committed there).

**Conventions (follow exactly):**

- **GIT IS GATED on the Xcode license here:** run EVERY git command prefixed with `DEVELOPER_DIR=/Library/Developer/CommandLineTools` (e.g. `DEVELOPER_DIR=/Library/Developer/CommandLineTools git commit -m "…"`). The pre-commit hook works under it. NEVER run sudo / `xcodebuild -license`.
- commitlint: lowercase imperative subject after `type(scope):`, header ≤100 chars. Commit body ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do NOT push / open PRs (phase 5 is the controller's).
- DB schema edit → `pnpm --filter @actionow/db db:generate` (drizzle-kit may prompt create-vs-rename in a non-TTY shell; if so, drive it with a tiny pty helper or re-run with input) then `pnpm --filter @actionow/db db:migrate`. Schema barrel: `packages/db/src/schema/index.ts`.
- Contracts change → `pnpm --filter @actionow/contracts build && pnpm --filter @actionow/contracts gen:openapi && pnpm --filter @actionow/sdk gen && pnpm --filter @actionow/sdk build && pnpm --filter @actionow/contracts test` and COMMIT the regenerated `openapi.json` + sdk generated files.
- GROUND TRUTH OVER PLAN: adapt to real helper/import names; note deviations. **Invariants:** the tag filter can only NARROW (never widen) the candidate set; a header-less request is byte-for-byte unchanged; `routeTag` never enters a URL or an auth decision.

---

## Phase 1 — Data + repos + contracts

### Task 1: schema — `channel.tags`, `relay_trace.route_tag`, `usage_log.route_tag`

**Files:**

- Modify: `packages/db/src/schema/catalog.ts` (`upstreamChannel`), `packages/db/src/schema/relay-trace.ts`, `packages/db/src/schema/usage.ts`
- Generate: `packages/db/drizzle/0049_*.sql` (+ meta)
- Test: `packages/db/test/schema-constraints.test.ts`

- [ ] **Step 1: Add `tags` to `upstream_channel`.** In `packages/db/src/schema/catalog.ts`, in the `upstreamChannel` columns (mirror `model.tags` at `packages/db/src/schema/model.ts:72-76`):

```ts
// Free-form operator tags for routing (染色/标签路由) + faceting. Never gate-by-default.
tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
```

(Ensure `sql` is imported from `drizzle-orm` and `text` from `drizzle-orm/pg-core` in this file — both are already used elsewhere; confirm.)

- [ ] **Step 2: Add `route_tag` to `relay_trace`.** In `packages/db/src/schema/relay-trace.ts`, after the `truncated` column:

```ts
/** The per-request route tag (染色) this call was pinned to, when set; else null. */
routeTag: text('route_tag'),
```

- [ ] **Step 3: Add `route_tag` to `usage_log`.** In `packages/db/src/schema/usage.ts`, add to the `usageLog` columns:

```ts
/** The per-request route tag (染色) the run was pinned to, when set; else null. */
routeTag: text('route_tag'),
```

- [ ] **Step 4: Generate the migration.** Run: `pnpm --filter @actionow/db db:generate`. Expected: `packages/db/drizzle/0049_*.sql` adding `upstream_channel.tags` (with default `'{}'`), `relay_trace.route_tag`, `usage_log.route_tag`. All additive — no drops, no prompts expected (pure column adds).

- [ ] **Step 5: Failing constraint test** in `packages/db/test/schema-constraints.test.ts` (a `describe('channel.tags (route tagging)')` block; reuse the file's `db` harness + an inline minimal `upstream_channel` insert, checking sibling catalog tests for required NOT NULL columns):

```ts
it('channel.tags defaults to empty array and round-trips values', async () => {
  const res = await makeResource(); // reuse the file's resource helper, or insert a minimal resource
  const [a] = await db
    .insert(schema.upstreamChannel)
    .values({ resourceId: res, providerType: 'openai' })
    .returning();
  expect(a.tags).toEqual([]);
  const [b] = await db
    .insert(schema.upstreamChannel)
    .values({ resourceId: res, providerType: 'openai', tags: ['canary', 'beta'] })
    .returning();
  expect(b.tags).toEqual(['canary', 'beta']);
});
```

- [ ] **Step 6: Run + migrate.** `pnpm --filter @actionow/db exec vitest run test/schema-constraints.test.ts` (expect FAIL: column missing) → `pnpm --filter @actionow/db db:migrate` → re-run (PASS). Then `pnpm --filter @actionow/db build`.

- [ ] **Step 7: Commit.**

```bash
DEVELOPER_DIR=/Library/Developer/CommandLineTools git add packages/db/src/schema/ packages/db/drizzle/ packages/db/test/schema-constraints.test.ts
DEVELOPER_DIR=/Library/Developer/CommandLineTools git commit -m "feat(db): channel.tags + relay_trace/usage_log.route_tag (route tagging)"
```

### Task 2: repos — select `tags` on candidate rows; accept `route_tag` on inserts; channel admin tags

**Files:**

- Modify: `packages/db/src/repositories/catalog.ts` (`UpstreamChannelRow` type + `listChannels` selection + channel create/update), `packages/db/src/repositories/route-group.ts` (`GroupChannelForResource` + `listGroupChannelsForResource` selection)
- Modify: `packages/db/src/repositories/relay-trace.ts` (`InsertRelayTraceInput` + insert), `packages/db/src/repositories/usage.ts` (usage insert input)
- Test: extend `packages/db/test/catalog.int.test.ts` (or the relevant repo test)

- [ ] **Step 1: Failing test** — a channel created with `tags: ['canary']` is returned with those tags by `listChannels` and by the group candidate query (`listGroupChannelsForResource`/`listCandidateChannelsWithFallback`). Add to the appropriate existing repo int test.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Add `tags` to `UpstreamChannelRow` + selections.** In `packages/db/src/repositories/catalog.ts`: add `readonly tags: string[]` to the `UpstreamChannelRow` type; add `tags: upstreamChannel.tags` to the channel column selection used by `listChannels` (and any other channel-row selector that feeds routing). In channel `create`/`update`, accept + persist `tags` (default `[]` on create).

- [ ] **Step 4: Add `tags` to `GroupChannelForResource` + selection.** In `packages/db/src/repositories/route-group.ts`: add `readonly tags: string[]` to `GroupChannelForResource` and `tags: upstreamChannel.tags` to the `listGroupChannelsForResource` selection (which `listCandidateChannelsWithFallback` reuses).

- [ ] **Step 5: Add `routeTag` to the trace + usage insert inputs.** In `packages/db/src/repositories/relay-trace.ts`, add `readonly routeTag?: string | null` to `InsertRelayTraceInput` and `routeTag: input.routeTag ?? null` to the insert values. In `packages/db/src/repositories/usage.ts`, add `routeTag?: string | null` to the usage-log insert input + `routeTag: input.routeTag ?? null` to the values.

- [ ] **Step 6: Run tests + build.** `pnpm --filter @actionow/db exec vitest run <the test>` (PASS); `pnpm --filter @actionow/db build`.

- [ ] **Step 7: Commit.**

```bash
DEVELOPER_DIR=/Library/Developer/CommandLineTools git add packages/db/src/repositories/
DEVELOPER_DIR=/Library/Developer/CommandLineTools git commit -m "feat(db): tags on channel candidate rows + route_tag on trace/usage inserts (route tagging)"
```

### Task 3: contracts — `ChannelView.tags`, channel create/update `tags`, trace/usage `route_tag`

**Files:**

- Modify: the catalog-views contract (`packages/contracts/src/catalog-views.ts` — `channelViewSchema`), the channel create/update request schemas, the relay-trace view, the usage-log view
- Test: the contracts test fixtures for those schemas

- [ ] **Step 1: Add fields.** `ChannelView` + `tags: z.array(z.string())`; channel create/update bodies + `tags: z.array(z.string()).optional()`; `RelayTraceView` + `route_tag: z.string().nullable()`; `UsageLogView` + `route_tag: z.string().nullable()`. Update the view fixtures in the contracts tests (`tags: []`, `route_tag: null`).

- [ ] **Step 2: Map the fields in the admin view builders.** Wherever `toChannelView` / the relay-trace view / the usage-log view are built (admin.service / the controllers), map the new columns (snake_case wire ← camel DB: `tags`, `route_tag`). Pass channel `tags` from the create/update DTO into the repo calls (Task 2).

- [ ] **Step 3: Build chain + tests.** `pnpm --filter @actionow/contracts build && pnpm --filter @actionow/contracts gen:openapi && pnpm --filter @actionow/sdk gen && pnpm --filter @actionow/sdk build && pnpm --filter @actionow/contracts test && pnpm --filter @actionow/api typecheck`.

- [ ] **Step 4: Commit.**

```bash
DEVELOPER_DIR=/Library/Developer/CommandLineTools git add packages/contracts/ packages/sdk/src/generated/openapi.ts apps/api/src/admin/ packages/db/src/repositories/
DEVELOPER_DIR=/Library/Developer/CommandLineTools git commit -m "feat(contracts): channel tags + route_tag on trace/usage views (route tagging)"
```

---

## Phase 2 — Routing filter + engine recording

### Task 4: `candidatesFor` tag intersect (narrow-only) + zero-match 400

**Files:**

- Modify: `apps/api/src/common/channel-routing.service.ts`
- Test: `apps/api/test/channel-routing.service.test.ts` (or the existing routing test; create if absent)

- [ ] **Step 1: Failing unit test** — `candidatesFor(resource, group, model, 'canary')` returns only channels whose `tags` include `'canary'`; a tag matching nothing throws an `invalid_input`-coded error; no `routeTag` returns the full set unchanged. (Use a fake/seeded db or the int harness as the routing tests do.)

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** Add `routeTag?: string` to `candidatesFor` and a `filterByTag` helper; filter the ROWS before mapping (so the narrow-only property is exact and `RunChannel` needs no `tags` field):

```ts
import { engineInvalidInput } from './errors.js'; // confirm the helper's location

// inside the class:
async candidatesFor(
  resourceId: string,
  routeGroupId: string | null | undefined,
  modelId?: string,
  routeTag?: string,
): Promise<RunChannel[]> {
  const groupId = routeGroupId ?? (await this.resolveDefaultGroupId());
  let base: RunChannel[];
  const grouped =
    groupId !== null ? await listCandidateChannelsWithFallback(this.db, resourceId, groupId) : [];
  if (grouped.length > 0) {
    const rows = filterByRouteTag(grouped, routeTag);
    base = await this.attachFaultPolicies(rows.map(toRunChannelFromGroup), rows);
  } else {
    const all = await listChannels(this.db, resourceId);
    const rows = filterByRouteTag(all, routeTag);
    base = await this.attachFaultPolicies(rows.map(toRunChannelFromChannel), rows);
  }
  return this.preferLinkedChannels(base, modelId);
}
```

```ts
// module-level helper (alongside toRunChannelFromGroup):
/**
 * 染色: when a route tag is set, keep only candidate channels carrying it. Applied
 * to the ALREADY-resolved candidate rows, so it can only NARROW (never escalate).
 * Empty after filtering → a hard 400 (no silent leak to non-tagged channels).
 */
function filterByRouteTag<T extends { tags: string[] }>(rows: T[], routeTag?: string): T[] {
  const tag = routeTag?.trim();
  if (tag === undefined || tag === '') return rows;
  const matched = rows.filter((r) => r.tags.includes(tag));
  if (matched.length === 0) {
    throw engineInvalidInput(`no channel matches route tag "${tag}"`);
  }
  return matched;
}
```

(`GroupChannelForResource` and `UpstreamChannelRow` now carry `tags` from Task 2, so both branches satisfy the `T extends { tags: string[] }` constraint. Note the tag miss in the grouped branch throws — it does NOT fall through to the ungrouped branch, which would widen.)

- [ ] **Step 4: Run, expect PASS**, `pnpm --filter @actionow/api typecheck`.

- [ ] **Step 5: Commit.**

```bash
DEVELOPER_DIR=/Library/Developer/CommandLineTools git add apps/api/src/common/channel-routing.service.ts apps/api/test/channel-routing.service.test.ts
DEVELOPER_DIR=/Library/Developer/CommandLineTools git commit -m "feat(api): candidatesFor route-tag intersect + zero-match 400 (route tagging)"
```

### Task 5: `RunRequest.routeTag` → record on `relay_trace` + `usage_log`

**Files:**

- Modify: `packages/engine/src/execution-service.ts` (`RunRequest`, `buildContext`/`maybeTrace`, `mirrorUsageLog`), `packages/engine/src/relay-trace.ts` (the trace context + sink row)
- Test: `packages/engine/test/*` (extend an execution-service / relay-trace test)

- [ ] **Step 1: Failing test** — a `RunRequest` with `routeTag: 'canary'` results in the relay-trace sink row carrying `routeTag: 'canary'` and `mirrorUsageLog` writing `routeTag: 'canary'` on the usage row. (Mock the trace sink + usage insert as the existing engine tests do.)

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** Add `routeTag?: string | undefined` to the `RunRequest` interface. In `buildContext` where it builds the trace context via `maybeTrace({ tenantId, jobId, channelId, providerType })`, add `routeTag: req.routeTag`. Add `routeTag?: string` to the `TracingHttpClient` context type (`relay-trace.ts`) and include it in the `insertRelayTrace` input it emits. In `mirrorUsageLog`, add `routeTag: req.routeTag` to the `insertUsageLog` input (and the failed/canceled usage-row path). (`insertRelayTrace`/`insertUsageLog` accept `routeTag` from Task 2.)

- [ ] **Step 4: Run, expect PASS**, `pnpm --filter @actionow/engine build`.

- [ ] **Step 5: Commit.**

```bash
DEVELOPER_DIR=/Library/Developer/CommandLineTools git add packages/engine/src/
DEVELOPER_DIR=/Library/Developer/CommandLineTools git commit -m "feat(engine): thread RunRequest.routeTag onto relay_trace + usage_log (route tagging)"
```

---

## Phase 3 — Header plumbing

### Task 6: parse `X-Actionow-Route-Tag` at the relay entrypoints

**Files:**

- Modify: the chat controller + `chat-relay.service.ts` (`chat`/`chatStream`/`buildChatRunRequest`), the `/v1` relay controller + its run-request builder, the media-dialect controller + builder
- Test: `apps/api/test/*.e2e.test.ts` (extend a relay e2e)

- [ ] **Step 1: Failing e2e** — model on an existing relay e2e + stub upstream: seed two channels for a resource, tag one `canary`; a request with header `X-Actionow-Route-Tag: canary` is served ONLY by the canary channel; a request with `X-Actionow-Route-Tag: nope` returns 400 `invalid_input`; the served call's `relay_trace` + `usage_log` rows carry `route_tag='canary'`.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** In each relay controller, read the header (NestJS `@Headers('x-actionow-route-tag') routeTag?: string`) and pass it into the service. Thread `routeTag` through `chat-relay.service.ts` `chat(model, ir, ctx, idem, routeTag)` / `chatStream(...)` → `buildChatRunRequest(model, ir, ctx, mode, idem, routeTag)`, which (a) passes `routeTag` to `this.channelRouting.candidatesFor(resourceId, ctx.routeGroupId, model, routeTag)` and (b) sets `routeTag` on the built `RunRequest`. Do the same in the `/v1` relay run-request builder and the media-dialect `resolveRunRequest`/builder. Trim empty → undefined so a blank header is a no-op.

- [ ] **Step 4: Run, expect PASS**, `pnpm --filter @actionow/api typecheck`.

- [ ] **Step 5: Commit.**

```bash
DEVELOPER_DIR=/Library/Developer/CommandLineTools git add apps/api/src/ apps/api/test/
DEVELOPER_DIR=/Library/Developer/CommandLineTools git commit -m "feat(api): parse X-Actionow-Route-Tag at relay entrypoints (route tagging)"
```

---

## Phase 4 — Admin / frontend

### Task 7: channel editor tags input + card chips

**Files:**

- Modify: the channel editor component (`grep -rln "ChannelEditor\|channel" apps/web/src/features/console | head` — likely `ChannelEditor.tsx` under the model-access feature) + the channel card; the web channel api types/helpers (re-export `tags`)
- Test: a web component test for the editor

- [ ] **Step 1:** Add a multi-tag chips input to the channel editor, mirroring the **model tags** editor (find it: `grep -rln "tags" apps/web/src/features/console | head` → the model editor's tags field/component — reuse that component). Wire `tags` into the channel create/update payload (the contract types from Task 3 carry it). Show tag chips on the channel card. **Step 2:** i18n (zh-CN + en) for the tags label/placeholder. **Step 3:** `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web test`. **Step 4:** Commit `feat(web): channel tags editor + card chips (route tagging)`.

### Task 8: `RelayTracesPage` route_tag column + filter

**Files:**

- Modify: `apps/web/src/features/console/RelayTracesPage.tsx` + its api helper/types
- Test: extend the RelayTraces test if present

- [ ] **Step 1:** Add a `route_tag` column to the relay-traces DataTable (render the tag as a chip, `—` when null) and a filter input (text) that passes `route_tag` to the list query — mirror the page's existing model/status filters. The `RelayTraceView.route_tag` field comes from Task 3. If the `/admin/relay-traces` list endpoint needs a `route_tag` query filter, add it (admin controller + repo `where` clause); if filtering client-side is the page's existing pattern, match that. **Step 2:** i18n. **Step 3:** `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web test`. **Step 4:** Commit `feat(web): relay-traces route_tag column + filter (route tagging)`.

---

## Phase 5 — Gate

### Task 9: full gate, live-verify, memory, PR

- [ ] **Step 1: Full suites.** `pnpm --filter @actionow/contracts test`, `pnpm --filter @actionow/db test`, `pnpm --filter @actionow/engine test`, `pnpm --filter @actionow/api test`, `pnpm --filter @actionow/web test` — all green. Full typecheck + lint clean.
- [ ] **Step 2: Live-verify.** Rebuild + restart the API (`HTTP_EGRESS=curl node --env-file=.env --import tsx apps/api/dist/main.js`, port 3000; apply mig 0049). Tag a channel `canary` via the admin channel update; send a relay request with `X-Actionow-Route-Tag: canary` and confirm it's served by the canary channel + a `relay_trace`/`usage_log` row carries `route_tag='canary'`; send `X-Actionow-Route-Tag: nope` → 400. Screenshot the channel tags editor + the relay-traces route_tag column.
- [ ] **Step 3:** Commit any fixes (DEVELOPER_DIR git prefix).
- [ ] **Step 4: Memory.** Add `memory/route-tagging.md` + a MEMORY.md index line; update [[billing-routing-governance]] (⑤ R shipped; S + P remain) + [[tokenhub-gap-analysis]] (流量染色/标签路由 → done).
- [ ] **Step 5: PR.** Push `feat/route-tagging` (DEVELOPER_DIR git); open PR → `main`; squash-merge (pre-authorized). Commit footer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; PR body footer `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Self-review notes (addressed)

- **Spec coverage:** ① behavior→T4 (hard-pin/narrow/zero-match) + T6 (header); ② data flow→T4-T6; ③ data model→T1-T2; ④ contracts→T3; ⑤ admin/frontend→T7-T8; ⑥ testing throughout; ⑦ phasing = the 5 phases.
- **Narrow-only invariant:** T4 filters the already-resolved rows; a grouped tag-miss throws rather than falling through to the ungrouped (widening) branch — called out explicitly in T4 Step 3.
- **No `tags` on RunChannel:** the filter runs on the row types (`GroupChannelForResource`/`UpstreamChannelRow`) which gain `tags` in Task 2, so `RunChannel` stays unchanged — consistent across T2/T4.
- **Naming:** `routeTag` (camel, code) ↔ `route_tag`/`X-Actionow-Route-Tag` (wire/header); `filterByRouteTag`; `engineInvalidInput` (400). Used consistently.
- **Header-less = unchanged:** every task guards on `routeTag` undefined/empty → no-op.
