# 前端打磨 (Admin Polish) — 批量端点 + 审计/版本徽标 — Design Spec

> Second piece (**P**) of ⑤ 路由深度+前端打磨, the last sub-project of 计费与路由 (after R 路由染色 shipped). Two independent operator-UX polish items: (1) **true bulk admin endpoints** (batch enable/disable/delete) to replace the web's current N-parallel-single-calls workaround; (2) **audit/version badges** on entity rows surfacing "last changed {when} by {who}" + a deep-link to the entity's audit trail. After this, ⑤ is closed except **S streaming 模型降级**.
>
> No migration — both parts are additive endpoints + web; badges read the existing `audit_log` ([[records-system-v1]]).

## What exists today (build on, don't duplicate)

- **Bulk UI, single-call backend:** `DataTable` (`apps/web/src/components/data/DataTable.tsx`) already supports multi-row selection (`selectable`) + a `bulkActions(selected, clear)` slot. `ModelsSection` (`apps/web/src/features/console/ModelsSection.tsx`) does bulk enable/disable via `Promise.allSettled(sel.map((m) => api.updateModel(...)))` — N parallel single calls, no bulk endpoint. `OAuthSessionsPage` + `ResourceDetailPane` (channels) similarly. Admin API has only single-row routes (e.g. `PATCH /admin/models/:name`, `PATCH /admin/resources/:id/channels/:channelId`).
- **Audit log, siloed:** `audit_log` (append-only; columns incl. `actor_type`, `actor_id`, `action`, `target_type`, `target_id`, `created_at`, `meta`) is surfaced only in `AuditLogPage` (`apps/web/src/features/console/AuditLogPage.tsx`) with filters (tenant/actor/action/target/time). Entities have `created_at`/`updated_at` but **no `updated_by`**. The `@Audit` decorator + `AuditService` emit one row per mutating admin request.
- **Conventions:** admin CRUD = controller route → `admin.service` → repo; web consumes via `rawClient` (`apps/web/src/lib/api/admin.ts`); `@Audit(action, target)` on mutations; contracts in `packages/contracts`.

## ① Part 1 — bulk admin endpoints

- **Shape (per entity):** `POST /admin/<entity>/bulk` with body `{ ids: string[], action }` → `{ succeeded: string[], failed: { id: string; error: string }[] }` (**partial success** — one bad id never blocks the rest; mirrors today's `Promise.allSettled` UX but as one request + unified audit).
- **Entities / actions (the three with multi-select UI):**
  - **models** — `enable | disable | delete`, ids = model **names** (the admin identifier, `PATCH /admin/models/:name`).
  - **channels** — `enable | disable | delete`, ids = channel **ids** (flat `/admin/channels/bulk`; channel ids are global even though the single-row route is nested under a resource).
  - **oauth-sessions** — `revoke`, ids = session ids.
- **Implementation:** an `admin.service` `bulkApply` helper. Status actions (enable/disable) → `UPDATE … SET status=… WHERE <idcol> = ANY(ids) RETURNING <idcol>`; `succeeded` = returned ids, `failed` = the rest tagged `"not found"`. Delete actions → per-id soft-delete, collecting `{succeeded, failed}`. **One `audit_log` row per affected entity** (action `model.disable` / `channel.delete` / `oauth_session.revoke`, matching the single-row audit actions), emitted via `AuditService` best-effort — so each entity's badge (Part 2) reflects the bulk change.
- **Contracts:** a shared `bulkActionRequestSchema` (`{ ids: string[], action: enum }` per entity) + `bulkResultViewSchema` (`{ succeeded, failed }`). SDK regen.
- **Web:** change the three pages' `bulkActions` from N parallel calls to one `api.bulk<Entity>(ids, action)` call; toast the result (`"N 成功, M 失败"`), invalidate the list query, clear selection. The `failed[]` errors surface in the toast/detail.

## ② Part 2 — audit/version badges

- **Batch endpoint:** `POST /admin/audit-log/latest` body `{ target_type: string, ids: string[] }` → `{ [id]: { actor_type, actor_id, action, created_at } }` (the latest `audit_log` row per target). Repo: `SELECT DISTINCT ON (target_id) target_id, actor_type, actor_id, action, created_at FROM audit_log WHERE target_type = $1 AND target_id = ANY($2) ORDER BY target_id, created_at DESC`. Returns only ids that have audit rows (others render no badge).
- **Web:** a `<AuditBadge>` component + `useLatestAudit(targetType, ids)` hook (one batched fetch per list render, keyed on the visible ids). The badge renders `"{relativeTime} · {actor}"` (e.g. `5分钟前 · operator`); clicking navigates to `/console/audit-log` pre-filtered by `target_type` + `target_id` (the audit page already has those filters — pass them via query params / its existing filter state). No badge when the entity has no audit row.
- **Contracts:** `latestAuditRequestSchema` + `latestAuditViewSchema` (a map keyed by id). SDK regen.
- **Landing tables (shared component → adding more pages later is trivial):** channels, models, fault-policies, limit-plans, route-groups. Each maps its rows to the right `target_type` (`channel`/`model`/`fault_policy`/`limit_plan`/`route_group`) for the batch fetch + badge.

## ③ Testing

- **bulk:** `admin.service` unit — partial success/failure report (a mix of valid + non-existent ids → correct `{succeeded, failed}`); one `audit_log` row per affected entity. e2e — one `POST /admin/models/bulk {ids:[valid, valid, bogus], action:'disable'}` → the two valid disabled + in `succeeded`, the bogus in `failed`; an audit row per disabled model.
- **latest-audit:** repo/e2e — `DISTINCT ON` returns the newest row per target; ids with no audit are absent. Order-by tiebreak deterministic.
- **web:** `AuditBadge`/`useLatestAudit` component test (renders actor + relative time; click → navigates with the right filter); a bulk-action page test (one call, toast reflects `failed`).
- **contracts:** fixtures for `bulkResultView`, `latestAuditView`.
- **regression:** existing admin/console/web suites green (additive; single-row routes unchanged).

## ④ Phasing (one branch `feat/admin-polish`, phased commits → one PR → squash-merge)

1. **bulk backend:** `bulkApply` + `POST /admin/{models,channels,oauth-sessions}/bulk` + per-entity audit emission; contracts (`bulkActionRequest`/`bulkResultView`) + SDK regen; service/e2e tests.
2. **bulk web:** rewire the three pages' `bulkActions` to one call + result toast + invalidation.
3. **latest-audit backend:** repo `latestAuditByTarget` + `POST /admin/audit-log/latest` + contracts + SDK regen; tests.
4. **audit badges web:** `<AuditBadge>` + `useLatestAudit` hook + wire into the 5 tables + deep-link + i18n.
5. **gate:** full typecheck/lint/tests; live-verify; memory; PR.

## Out of scope (future)

`updated_by` denormalization on entities (audit_log stays the source of truth); a generic cross-entity bulk framework (per-entity endpoints only); bulk ops / badges on entities beyond the listed set (the shared pieces make adding more trivial); transactional all-or-nothing bulk (v1 is partial-success); ⑤'s **S** streaming 模型降级.
