# RBAC v1 — 租户组织多席位 (system-admin / tenant-admin / tenant-member) — Design Spec

> Third sub-project of 计费与路由 (after ① 治理与额度 / ② 记录系统). Adds **tenant-org RBAC**: a tenant (= an application/space) can have multiple human operators with two seat levels — a **tenant admin** (full control of their tenant) and limited **tenant members** — under the unchanged platform **system admin**. This is the "RBAC depth" called out in the monetization strategy, and it makes the ② audit actor model express _what authority_ an actor had. Codebase impact assessed by a 21-agent analysis: **buildable as designed, additive, low-risk.**

## Roles (3)

| 角色                          | 今天                                                                    | v1                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **系统管理员** (system admin) | `user.role='admin'` (`tenant_id` null), `/console`, manages all tenants | **unchanged**                                                                                              |
| **租户管理员** (tenant admin) | `user.role='user'` + a tenant, `/app`                                   | full control of THEIR tenant; a self-registered user auto-becomes admin of the tenant registration creates |
| **租户成员** (tenant member)  | — (new)                                                                 | a limited seat inside a tenant (`/app`, read-mostly), created by a tenant admin                            |

**v1 boundary (confirmed):** one user belongs to **one** tenant; email is **globally unique** (existing `user.email` unique index); a sub-user is a normal **USER row** (`role='user'`, `tenant_role='member'`) that logs in via the existing `/auth/login` — NOT a `subject`/member-JWT (`typ:'subject'`). Multi-tenant membership is out of scope (future).

**Scope note — end-users (subjects) stay operator-managed in v1.** A tenant's _end-users_ (`subject`s, managed in F1/F2 via the **admin plane** `/admin/tenants/:id/users/*`, i.e. by the system admin in `/console`) are **not** brought to `/app` in this sub-project. A tenant-admin self-managing their own end-users from `/app` would need new console-plane subject endpoints — deferred (it pairs naturally with the future member data plane). So a "tenant admin" here means full control of the **operator-team + tenant self-service** surfaces (keys / billing / settings / members), not end-user CRUD.

## ① Data model + migration

- `user` gains `tenant_role text` (nullable). Paired CHECK: `(role='admin' AND tenant_role IS NULL) OR (role='user' AND tenant_role IN ('admin','member'))`. Index `(tenant_id, tenant_role)`.
- **Migration (additive, 3 steps, no NOT NULL):** `ADD COLUMN tenant_role` → `UPDATE user SET tenant_role='admin' WHERE role='user'` (every existing tenant user becomes a tenant admin → **zero access loss**) → `ADD CONSTRAINT` CHECK.
- Repo (`packages/db/src/repositories/auth.ts`): `UserRecord` + `USER_COLUMNS` selector + `CreateUserInput` gain `tenantRole`; `createUser` inserts it; all `find*User` select it. Add tenant-scoped `listUsersByTenant(db, tenantId, page)`, `updateUserStatus(db, tenantId, id, status)`, `updateUserTenantRole(db, tenantId, id, tenantRole)`, `createSubUser(db, {tenantId,email,passwordHash})` (wraps `createUser` with `role='user', tenant_role='member'` — NO new tenant).

## ② Enforcement (console plane)

- **`tenant_role` is resolved from the DB in `ConsoleGuard`, NOT signed into the JWT (Path A).** `ConsoleGuard` already loads the user per request (`console.guard.ts:83`), so this is one extra field, no token change, no forgery surface, no re-login on role change. `issueToken` / `AuthClaims` / OAuth signing stay `{sub, role}`.
- `ConsoleContext` gains `tenantRole: 'admin'|'member'`. `req.console` carries it.
- New **`@TenantAdmin` guard** (mirrors `AdminGuard`'s role enforcement): require `req.console.tenantRole==='admin'`, else **403** (`engineForbidden`). A system admin token is already rejected by `ConsoleGuard` (it's the operator plane), so this only ever sees tenant users.
- **Gate the administrative console writes to tenant admin:** `POST /console/api-keys` (mint), `POST /console/api-keys/:id/rotate`, `DELETE /console/api-keys/:id` (revoke), `POST /console/payments/intents` (topup), file upload (`POST /console/files/presign-upload`, `POST /console/files/:id/confirm`), and the new `/console/users` sub-user routes. (These are the _console-plane_ writes; subject/end-user CRUD lives on the **admin plane** `/admin/tenants/:id/users/*` — see scope note below — so it is not part of this gating.)
- **Member = read-only** on `/app`: `GET` usage / analytics / models / balance / files / limits / me. No keys, no topup, no uploads, no team management.
- **Exception — own-account:** a member MAY `PATCH /console/settings` to change **their own** password (self-service of own credential, not a tenant write).

## ③ Sub-user management (new console endpoints, `@TenantAdmin`)

- `POST /console/users` — create a sub-user: admin supplies `email` + initial `password`; creates a USER (`role='user'`, `tenant_role='member'`, same `tenant_id`); returns `{id, email}` (never logs the password).
- `GET /console/users` — list the tenant's users (id, email, status, tenant_role, created_at), keyset. **Admin-only** in v1.
- `PATCH /console/users/:id` — admin updates a sub-user's `status` (active/disabled) and/or `tenant_role` (promote/demote member↔admin). Tenant-scoped (the target must belong to the caller's tenant).
- `DELETE /console/users/:id` — disable the sub-user (`status='disabled'`; soft). A disabled user fails `ConsoleGuard`'s active check.
- **Forgotten password (v1):** admin re-sets via `PATCH` (a new password) — no email/invite infra yet.
- Self-register (`local-auth.service.ts register`) + OAuth self-register set the created user's `tenant_role='admin'`.

## ④ Audit integration

- Capture the actor's tenant role: the `AuditInterceptor` reads `req.console.tenantRole` and records it in `meta.actor_tenant_role`. **Keep `actor_type` = `operator|member|system` and its CHECK unchanged for v1** (a tenant operator is still `actor_type='member'`); a cleaner `actor_type` taxonomy (platform-admin / tenant-admin / tenant-member / end-user) is **deferred to audit v2** to avoid churning the ② CHECK + tests. So "who / with what tenant authority / changed what" is captured via `meta`.

## ⑤ Contracts

- `consoleMeViewSchema` (`packages/contracts/src/console-views.ts`) gains `tenant_role: z.string().nullable()`; `toMeView` maps `u.tenantRole`. New `consoleUserViewSchema` (id, email, status, tenant_role, created_at) + create/update request bodies. `gen:openapi` → SDK regen. (Sub-user endpoints not in the SDK path set → web consumes via `rawClient`, matching the limit-plan/audit precedent.)

## ⑥ Frontend (`/app`)

- The web learns the tenant role from **`/console/me`** (`tenant_role`), NOT the JWT (the web's synthetic `member` role is for subjects/`typ:'subject'` — keep them distinct; document both meanings).
- New **成员管理 (Members)** page (tenant-admin only) in the `/app` nav: list sub-users, create (email + initial password, one-time shown), promote/demote, disable.
- Role-gate the existing `/app` writes for members: `AppKeys` (mint/rotate/revoke), `AppBilling` (topup), `AppMedia` (upload), `AppSettings` (password change stays — own-account) — hide/disable the admin-only actions for `tenant_role='member'`, show read-only. A "current role" chip in the `/app` top bar; the 成员管理 nav item shows for admins only.
- Member login is the existing `/login` → `/app` (homePath for `role='user'` unchanged); the `/app` surfaces self-gate by `tenant_role`.

## ⑦ Testing

- **Repo/migration:** `tenant_role` backfill → all existing tenant users `admin` (regression: zero access loss); CHECK rejects bad combos; `createSubUser` lands in the caller's tenant + creates NO new tenant; `listUsersByTenant` scoping.
- **Guard:** `@TenantAdmin` allows admin, **403s** a member on each gated write; a system-admin token still rejected by `ConsoleGuard`; a member CAN change own password; a member is read-only.
- **Sub-user create:** member created via `/console/users` is a USER row on `/auth/login` (not a subject) — covered.
- **Audit:** a tenant-admin vs member mutation records the right `meta.actor_tenant_role`; `actor_type` CHECK untouched.
- **Contracts:** `consoleMeView` + sub-user view fixtures.
- **Regression:** existing console/admin/provision e2e green (additive; existing users = tenant admins).

## ⑧ Phasing (one branch `feat/rbac`, phased commits → one PR → squash-merge)

1. **Data + repos:** `tenant_role` migration (additive + backfill) + CHECK + index; repo `UserRecord`/`USER_COLUMNS`/`createUser`/`createSubUser`/`listUsersByTenant`/`update*`; `consoleMeView.tenant_role`; SDK regen. No behavior change.
2. **Self-register:** local + OAuth self-register set `tenant_role='admin'`.
3. **Guard + audit:** DB-resolved `tenantRole` in `ConsoleContext`; `@TenantAdmin` guard (403); `meta.actor_tenant_role` in the interceptor; tests.
4. **Gate + sub-user CRUD:** gate the 7 writes; add `/console/users` CRUD (admin-only) + service/repo; full guard test matrix; members become read-only.
5. **Frontend:** `/console/me` tenant_role gating; 成员管理 page + nav; role chip; member read-only on AppKeys/Billing/Settings/subjects.
6. **Gate:** full typecheck/lint/tests; live-verify; memory; PR.

## Out of scope (future)

Multi-tenant membership (a user in several tenants); **console-plane end-user (subject) management from `/app`** (tenant-admin self-managing their own end-users — pairs with the future member data plane; subjects stay operator-managed via `/console`); email/invite-link onboarding + member-initiated password reset; a fine permission matrix beyond admin/member (the earlier domain×rw operator split is dropped); platform-operator sub-roles (billing/support/auditor); the `actor_type` taxonomy rename (audit v2); a member self-service data plane beyond `/app` read views.
