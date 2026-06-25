# 端用户数据平面 (End-User Data Plane) — Design Spec

> The deferred unified-tenancy piece (flagged in [[unified-tenancy-ab-design]] / [[billing-routing-governance]] as "member self-service data plane = future backend sub-project"). Closes the two readiness gaps a 4-agent deployment assessment surfaced for the "build multiple externally-operated AIGC apps on one core" vision: (A) a **tenant-admin can't manage their own app's end-users** (subjects are operator-only on `/admin`), and (B) an **end-user can't self-serve** (the `/portal` is identity-only). Both parts ship as one deliverable, phased A→B.

## What exists today (build on, don't duplicate)

- **Tenancy:** tenant → subject (end-user) → api_key + sub_account (HARD wallet). Subject schema (`packages/db/src/schema/identity.ts`), `api_key.subject_id`, `sub_account` (`packages/db/src/schema/accounts.ts`), `usage_log.subject_id`.
- **Operator (admin) subject surface — to mirror down:** `/admin/tenants/:id/users*` (subject CRUD), subject-scoped key minting, sub-wallet open/topup/transfer/balance, subject limit-plan binding, and the **subject soft-delete cascade** (sweep sub-wallet + HARD-revoke keys) — all in `apps/api/src/admin/` + `packages/db` repos ([[records-system-v1]], [[unified-tenancy-ab-design]]).
- **Auth planes:** `ConsoleGuard` (operator JWT `{sub, role}`; `tenantRole` DB-resolved; rejects member tokens) + `@TenantAdmin` guard (403 for members) from [[rbac-v1]]; **member JWT `{sub, tenant_id, typ:'subject'}`** issued by `/auth/login-member` (`registerMember`/`loginMember`, [[unified-tenancy-ab-design]] G-F). `MemberPortal` (`apps/web/src/features/app/MemberPortal.tsx`) is identity-only, awaiting this plane.
- **Governance:** `limit_plan`/`limit_rule` + `GovernanceGuard` resolves effective rules by plan id (key/tenant/subject). `SubjectDetailPanel` (`apps/web/src/features/console/SubjectDetailPanel.tsx`) is the operator subject drawer (sub-wallet + plan binding + usage bars + keys) — to mirror onto `/app`.
- Latest migration = **0049**. Contracts not in the SDK path set → web consumes via `rawClient` (audit-log / sub-wallet precedent).

## ① Architecture — three planes, server-forced scoping

| Plane                            | Guard                           | Token                      | Scope (server-forced)  | This spec        |
| -------------------------------- | ------------------------------- | -------------------------- | ---------------------- | ---------------- |
| System admin `/admin`            | `AdminGuard` (role=admin)       | admin JWT                  | all tenants            | unchanged (kept) |
| Tenant admin `/console` (`/app`) | `ConsoleGuard` + `@TenantAdmin` | operator JWT               | `req.console.tenantId` | **Part A**       |
| End-user `/portal`               | new `MemberGuard`               | member JWT `typ:'subject'` | token `subjectId`      | **Part B**       |

**Isolation invariant (load-bearing):** every query in A/B is scoped server-side to the caller's `tenantId` (A) or `subjectId` (B). An id in the request body/path is always intersected with that scope — a tenant-admin passing another tenant's `subjectId` gets 404; a member only ever reads their own token's `subjectId`. The `GovernanceGuard` rule-resolution logic is **unchanged** (still by plan id) — only _who may create/bind_ changes.

## ② Data model (migration 0050)

- `limit_plan.tenant_id` (uuid nullable, FK `tenant`). **null = platform plan** (system-admin owned); **non-null = tenant-owned**. Existing plans migrate to `null`. The plan-name unique index changes from global to **per `(tenant_id, name)`** (live rows) so tenants may reuse names.
- Everything else reused (subject, sub_account, api_key.subject_id, usage_log.subject_id, member auth, subject soft-delete cascade). **No other schema change.**

## ③ Part A — tenant-admin end-user plane (`/console`, `@TenantAdmin`)

All routes `@TenantAdmin`, scoped to `req.console.tenantId`, audited (`actor_type='member'` per the v1 taxonomy):

- **Subjects:** `GET/POST /console/subjects`, `GET/PATCH/DELETE /console/subjects/:id`. Create = externalId or email (+ displayName); PATCH = status / displayName / limitPlanId; DELETE = the existing soft-delete cascade. Reuse the admin subject repos, scoped to the tenant.
- **Subject-scoped keys:** extend `POST /console/api-keys` to accept an optional `subjectId` (validated to belong to the caller's tenant); `GET /console/api-keys` gains a subject filter/column.
- **Sub-wallet (per subject):** `GET /console/subjects/:id/sub-account` + `POST .../open|topup|transfer`. `topup` = internal allocation from the tenant pool to the subject's HARD wallet (not a payment). Reuse the admin sub-wallet repos.
- **Tenant limit plans:** `GET/POST/PATCH/DELETE /console/limit-plans` — forced `tenant_id = caller's tenant` (list/get/update/delete reject other tenants' and platform plans). Bind: `POST /console/subjects/:id/limit-plan { planId | null }` (planId must be a plan of the caller's tenant).

**Web (`/app`):** a 端用户 (Subjects) page (DataTable + create + a detail drawer mirroring `SubjectDetailPanel`: sub-wallet, plan binding, usage bars, scoped keys); a 额度套餐 page (tenant-scoped, mirroring `LimitPlansPage`); a subject selector on the AppKeys mint form; tenant-admin-only nav items; i18n (zh-CN + en).

## ④ Part B — end-user self-service plane (`/member`, `MemberGuard`, read-only)

- **`MemberGuard`:** verifies the member JWT (`typ:'subject'`), resolves `req.member = { subjectId, tenantId }` (checks subject is active). Mirrors `ConsoleGuard` but accepts ONLY member tokens; an operator/admin token is rejected (and a member token stays rejected on `/console`).
- **Endpoints (read-only, locked to the token's `subjectId`):**
  - `GET /member/me` — identity + status.
  - `GET /member/usage` — own `usage_log` (keyset).
  - `GET /member/balance` — own `sub_account` balance/held (or a shared-pool indicator when no hard wallet).
  - `GET /member/api-keys` — own keys (masked; never plaintext).
  - `GET /member/limits` — own effective limit plan + usage-vs-cap (reuse the limit-status computation).
- **Web (`/portal`):** replace the `MemberPortal` placeholder with real read-only views (usage / balance / keys / limits), via a member-token `rawClient`. Members authenticate through the existing `/member/login`; Model-B externalId subjects (no login) remain app-fronted (no `/member/*` for them).

## ⑤ Contracts

`limitPlanView` + `tenant_id`; reuse `subjectView`; new member view schemas (`memberUsageView`, `memberBalanceView`, `memberKeyView`, `memberLimitsView`). `/console` + `/member` routes are not in the SDK path set → web consumes via `rawClient`. Any zod-schema additions run the contracts→SDK regen chain.

## ⑥ Testing

- **Part A:** tenant-admin CRUDs own subject; **a cross-tenant `subjectId` → 404** (isolation); mints a subject-scoped key; sub-wallet topup moves credit pool→subject; tenant limit-plan CRUD + bind; a **member token → 403** on these writes (`@TenantAdmin`); **binding another tenant's plan is rejected** (tenant-scoped).
- **Part B:** a member JWT → `/member/{usage,balance,api-keys,limits}` returns ONLY that subject's data; a member cannot read another subject's data; an **operator token is rejected on `/member/*`** and a **member token stays rejected on `/console/*`**.
- **Web:** 端用户 page + portal component tests; contracts fixtures (`limitPlanView.tenant_id`, member views).
- **Regression:** existing `/admin` subject surface + console + governance suites stay green (additive; `/admin` unchanged; plan resolution unchanged).

## ⑦ Phasing (one branch `feat/end-user-data-plane`, phased commits → one PR → squash-merge)

1. **Data + repos + contracts:** `limit_plan.tenant_id` (mig 0050) + per-`(tenant_id,name)` unique; tenant-scoped plan repo (list/create/update/delete by tenant); `limitPlanView.tenant_id` + member view contracts + regen. No behavior change.
2. **Part A backend:** `/console` subjects CRUD + sub-wallet + tenant limit-plans + bindings + subject-scoped key minting, all `@TenantAdmin` + tenant-scoped + audited; e2e (incl. cross-tenant 404 + member 403).
3. **Part A web:** `/app` 端用户 page + detail drawer + 额度套餐 page + key subject selector + nav + i18n.
4. **Part B backend:** `MemberGuard` + `/member/*` read endpoints (subject-scoped); e2e (own-data-only + cross-plane token rejection).
5. **Part B web:** `/portal` self-service views + i18n.
6. **Gate:** full typecheck/lint/tests; live-verify; memory; PR squash-merge.

## Out of scope (future)

Member write actions (self mint/rotate keys, self-topup — v1 is read-only); `/member/*` for Model-B externalId subjects (app-fronted); member-initiated subject self-registration into an app (tenant-admin/admin provisions); tenant-admin reaching across tenants; payment to a subject's wallet from the member side; subscription/recurring billing (separate sub-project).
