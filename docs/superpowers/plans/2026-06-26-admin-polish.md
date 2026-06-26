# 前端打磨 (Admin Polish) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add true bulk admin endpoints (batch enable/disable/delete, partial-success) to replace the web's N-parallel-single-calls workaround, and audit/version badges on entity rows ("last changed {when} by {who}" + a deep-link to the entity's audit trail).

**Architecture:** Per-entity `POST /admin/<entity>/bulk {ids, action}` → `{succeeded, failed}` via a `bulkApply` service helper, one `audit_log` row per affected entity. A batch `POST /admin/audit-log/latest {target_type, ids}` (DISTINCT-ON latest per target) feeds an `<AuditBadge>` + `useLatestAudit` hook on the entity list pages.

**Tech Stack:** NestJS (apps/api), drizzle/postgres (packages/db), zod contracts (packages/contracts), Vite/React (apps/web), vitest; api e2e use `@testcontainers/postgresql`. **No migration** (badges read the existing `audit_log`).

**Spec:** `docs/superpowers/specs/2026-06-26-admin-polish-design.md`. Branch: `feat/admin-polish` (spec committed; rebased on main).

**Conventions (follow exactly):**

- **GIT IS GATED on the Xcode license:** prefix EVERY git command with `DEVELOPER_DIR=/Library/Developer/CommandLineTools`. The pre-commit hook works under it. NEVER run sudo / `xcodebuild -license`.
- commitlint: lowercase imperative subject, header ≤100 chars; commit body ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do NOT push / open PRs (phase 5 is the controller's).
- Contracts change → `pnpm --filter @actionow/contracts build && gen:openapi && pnpm --filter @actionow/sdk gen && build && pnpm --filter @actionow/contracts test`, COMMIT regenerated files.
- Admin routes not in the SDK path set → web consumes via `rawClient` (`apps/web/src/lib/api/admin.ts`).
- i18n: new user-facing strings in BOTH `apps/web/src/i18n/locales/zh-CN` and `/en`.
- GROUND TRUTH OVER PLAN: mirror the named precedents; adapt to real names; note deviations. **Partial-success invariant:** a bulk op never aborts the whole batch on one bad id — it collects `{succeeded, failed:[{id,error}]}`.

---

## Phase 1 — bulk backend

### Task 1: bulk endpoints (`models`/`channels`/`oauth-sessions`) + contracts

**Files:**

- Modify: `packages/contracts/src/admin-requests.ts` (or the admin contracts module) + a views module; `apps/api/src/admin/admin.controller.ts`, `admin.service.ts`
- Test: `apps/api/test/admin-bulk.e2e.test.ts`

- [ ] **Step 1: Contracts.** Add `bulkActionRequestSchema = z.object({ ids: z.array(z.string()).min(1), action: z.enum([...]) })` — one per entity (model action `enable|disable|delete`; channel `enable|disable|delete`; oauth-session `revoke`) OR a shared `{ids, action}` with the controller validating the action set per route. Add `bulkResultViewSchema = z.object({ succeeded: z.array(z.string()), failed: z.array(z.object({ id: z.string(), error: z.string() })) })`. Export + run the contracts/SDK regen chain + commit-with-the-task.

- [ ] **Step 2: Failing e2e** (`apps/api/test/admin-bulk.e2e.test.ts`, testcontainer + admin JWT): `POST /admin/models/bulk { ids:[m1, m2, 'nope'], action:'disable' }` → 200 `{ succeeded:[m1,m2], failed:[{id:'nope', error:...}] }`; m1+m2 are now `disabled`; an `audit_log` row exists per disabled model (`action='model.disable'`). Similar smoke for `/admin/channels/bulk` (by channel id) + `/admin/oauth-sessions/bulk` (action `revoke`).

- [ ] **Step 3: Run, expect FAIL.**

- [ ] **Step 4: Implement `bulkApply` + the 3 endpoints.** In `admin.service.ts`:

```ts
export interface BulkResult {
  succeeded: string[];
  failed: { id: string; error: string }[];
}

/** Apply a per-id mutation across ids, collecting partial success. perId throws → that id lands in `failed`. */
async function bulkApply(ids: string[], perId: (id: string) => Promise<void>): Promise<BulkResult> {
  const succeeded: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const id of ids) {
    try {
      await perId(id);
      succeeded.push(id);
    } catch (e) {
      failed.push({ id, error: e instanceof Error ? e.message : 'failed' });
    }
  }
  return { succeeded, failed };
}
```

Service methods (reuse the existing single-row repo ops): `bulkModels(action, names)` → per name `updateModelStatus`/`softDeleteModel`; `bulkChannels(action, ids)` → per id channel status/soft-delete; `bulkRevokeOAuthSessions(ids)` → per id `revokeOAuthSession`. Each `perId` does the single-row op AND emits an `audit_log` row (`appendAuditLog`/`AuditService`, `action='model.disable'` etc., best-effort) so each entity's badge reflects the bulk change.

Controller routes (each admin-guarded, `@Audit` NOT needed since the service emits per-entity rows — or use the interceptor with a meta of the ids; prefer per-entity emission):

```ts
@Post('models/bulk')
@HttpCode(200)
async bulkModels(@Body(new ZodBody(bulkModelActionSchema)) dto): Promise<BulkResultView> {
  return this.admin.bulkModels(dto.action, dto.ids);
}
// + POST channels/bulk, POST oauth-sessions/bulk
```

- [ ] **Step 5: Run e2e, expect PASS**, `pnpm --filter @actionow/api typecheck`.

- [ ] **Step 6: Commit.**

```bash
DEVELOPER_DIR=/Library/Developer/CommandLineTools git add packages/contracts/ packages/sdk/src/generated/openapi.ts apps/api/src/admin/ apps/api/test/admin-bulk.e2e.test.ts
DEVELOPER_DIR=/Library/Developer/CommandLineTools git commit -m "feat(api): bulk models/channels/oauth-sessions endpoints (admin polish)"
```

---

## Phase 2 — bulk web

### Task 2: rewire the 3 pages' bulk actions to one call

**Files:** `apps/web/src/features/console/ModelsSection.tsx`, `OAuthSessionsPage.tsx`, `ResourceDetailPane.tsx` (channels bulk); `apps/web/src/lib/api/admin.ts` (bulk helpers); i18n

- [ ] **Step 1: admin api helpers** — `bulkModels(action, ids)` → `rawClient.post('/admin/models/bulk', {ids, action})`, `bulkChannels(...)`, `bulkRevokeOAuthSessions(ids)`, each returning `BulkResultView`.
- [ ] **Step 2: ModelsSection** — replace `Promise.allSettled(sel.map(updateModel))` with one `api.bulkModels(action, sel.map(m=>m.name))`; toast `t('admin.bulk.result', {ok: r.succeeded.length, failed: r.failed.length})`; invalidate the models query; clear selection. Same for OAuthSessionsPage (revoke) + ResourceDetailPane (channels enable/disable/delete).
- [ ] **Step 3: i18n** (`admin.bulk.*` result string) zh-CN + en.
- [ ] **Step 4:** `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web test`. **Step 5: Commit** `feat(web): bulk actions via single endpoint + result toast (admin polish)`.

---

## Phase 3 — latest-audit backend

### Task 3: `latestAuditByTarget` repo + `POST /admin/audit-log/latest`

**Files:** `packages/db/src/repositories/audit.ts`; `apps/api/src/admin/admin.controller.ts` + `admin.service.ts`; `packages/contracts/src/` (latest-audit request + view); Test: `packages/db/test/audit.int.test.ts` + an admin e2e

- [ ] **Step 1: Failing repo test** — seed 3 audit rows for the same `(target_type='channel', target_id=X)` at increasing times + 1 for Y; `latestAuditByTarget(db, 'channel', [X, Y, Z])` returns the NEWEST row per target for X and Y, omits Z (no rows). Deterministic tiebreak.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement repo:**

```ts
export interface LatestAuditRow {
  targetId: string;
  actorType: string;
  actorId: string | null;
  action: string;
  createdAt: Date;
}

/** The newest audit_log row per target id (for the given target_type). Ids with no rows are absent. */
export async function latestAuditByTarget(
  db: DbOrTx,
  targetType: string,
  ids: string[],
): Promise<LatestAuditRow[]> {
  if (ids.length === 0) return [];
  return db.execute(sql`
    SELECT DISTINCT ON (target_id) target_id AS "targetId", actor_type AS "actorType",
           actor_id AS "actorId", action, created_at AS "createdAt"
    FROM audit_log WHERE target_type = ${targetType} AND target_id = ANY(${ids})
    ORDER BY target_id, created_at DESC
  `) as unknown as Promise<LatestAuditRow[]>;
}
```

(Adapt to the repo's drizzle query style — if it prefers the query builder, use `selectDistinctOn`; confirm the row-shape cast matches sibling repos.)

- [ ] **Step 4: Contracts + endpoint.** `latestAuditRequestSchema = { target_type: z.string(), ids: z.array(z.string()) }`; `latestAuditViewSchema` = a record/array of `{ target_id, actor_type, actor_id, action, created_at }`. Controller: `POST /admin/audit-log/latest` (admin-guarded) → `this.admin.latestAudit(dto.target_type, dto.ids)` mapped to the view. Regen SDK.

- [ ] **Step 5: Run tests, expect PASS**, typecheck. **Step 6: Commit** `feat(api): latest-audit-by-target batch endpoint (admin polish)`.

---

## Phase 4 — audit badges web

### Task 4: `<AuditBadge>` + `useLatestAudit` + wire into 5 tables

**Files:** Create `apps/web/src/components/data/AuditBadge.tsx` + `apps/web/src/lib/api/useLatestAudit.ts`; `apps/web/src/lib/api/admin.ts` (latestAudit helper) + queryKeys; modify the 5 list pages (channels, models, fault-policies, limit-plans, route-groups); i18n; Test: `AuditBadge.test.tsx`

- [ ] **Step 1: admin helper + hook** — `admin.latestAudit(targetType, ids)` (rawClient POST); `useLatestAudit(targetType, ids)` = a `useQuery` keyed on `(targetType, sorted ids)` that batches one fetch per list render and returns a `Map<id, LatestAuditView>`.
- [ ] **Step 2: Failing component test** (`AuditBadge.test.tsx`) — renders "{relativeTime} · {actor}" from a row; clicking navigates to `/console/audit-log` with the `target_type`+`target_id` filter; renders nothing when no row.
- [ ] **Step 3: Implement `<AuditBadge>`** — props `{ entry?: LatestAuditView; targetType: string; targetId: string }`; renders a small Pill `t('audit.badge', {time, actor})` (relative time via the existing date util) linking to `/console/audit-log?target_type=…&target_id=…` (match how `AuditLogPage` reads its filters — pass via query params or its filter state). No badge when `entry` is undefined.
- [ ] **Step 4: Wire into the 5 tables** — channels (ResourceDetailPane / ChannelCard), models (ModelsSection/ModelsCatalog), FaultPoliciesPage, LimitPlansPage, RouteGroupsPage: call `useLatestAudit('<target_type>', rows.map(id))` once, render `<AuditBadge entry={map.get(id)} .../>` in a column/cell. Each uses the right `target_type` (`channel`/`model`/`fault_policy`/`limit_plan`/`route_group`).
- [ ] **Step 5: i18n** (`audit.badge`) zh-CN + en.
- [ ] **Step 6:** `pnpm --filter @actionow/web typecheck && pnpm --filter @actionow/web test`. **Step 7: Commit** `feat(web): audit/version badges on entity rows (admin polish)`.

---

## Phase 5 — Gate

### Task 5: full gate, live-verify, memory, PR

- [ ] **Step 1: Full suites** (run testcontainer suites separately to dodge the parallel-load flake): `pnpm --filter @actionow/contracts test`, `pnpm --filter @actionow/db test`, `pnpm --filter @actionow/api exec vitest run`, `pnpm --filter @actionow/web test` — all green; typecheck + lint clean.
- [ ] **Step 2: Live-verify** (rebuild + restart API): admin logs in; `POST /admin/models/bulk {ids:[real, real, bogus], action:'disable'}` → `{succeeded:[2], failed:[bogus]}` + the two models show `disabled` + `audit_log` has 2 `model.disable` rows; `POST /admin/audit-log/latest {target_type:'model', ids:[...]}` returns the latest rows; screenshot a list page showing audit badges.
- [ ] **Step 3:** Commit fixes (DEVELOPER_DIR git).
- [ ] **Step 4: Memory.** Add `memory/admin-polish.md` + index line; update [[billing-routing-governance]] (⑤-P shipped; only ⑤-S streaming-fallback remains in ⑤).
- [ ] **Step 5: PR.** Push `feat/admin-polish` (DEVELOPER_DIR git); open PR → `main`; squash-merge (pre-authorized). Footers: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` (commit) + `🤖 Generated with [Claude Code](https://claude.com/claude-code)` (PR body).

---

## Self-review notes (addressed)

- **Spec coverage:** §① bulk → T1 (endpoints + partial-success + per-entity audit) + T2 (web); §② badges → T3 (latest-audit) + T4 (component + 5 tables); §③ testing throughout; §④ phasing = these 5 phases. No migration (matches spec).
- **Partial-success invariant** stated in the header + enforced in T1 `bulkApply` (per-id try/catch → `{succeeded, failed}`).
- **Per-entity audit emission** (T1) is what makes the T4 badges reflect bulk changes — called out in both tasks.
- **Naming:** `bulkApply`/`BulkResult(View)`, `latestAuditByTarget`/`LatestAuditView`, `<AuditBadge>`/`useLatestAudit` — consistent across tasks.
- **Reuse:** mirrors existing single-row repo ops, `DataTable` `bulkActions`, `AuditLogPage` filters, `rawClient` precedent.
