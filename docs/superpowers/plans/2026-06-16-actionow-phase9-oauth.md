# Actionow Phase 9 — OAuth + 统一身份 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. `- [ ]` steps. TDD.

**Goal:** Replace the flat `admin_user` table with a unified `user` + `user_identity` model (admin + regular users, one auth logic), add local registration, and Google/GitHub OAuth (auxiliary login + account linking) via `arctic`, issuing the existing `@nestjs/jwt`.

**Architecture (research-grounded, verified 2026-06):** `user(email, email_verified, password_hash NULLABLE, role, status, tenant_id?)` + `user_identity(user_id, provider, provider_user_id, unique(provider, provider_user_id))` — **keyed on `(provider, sub)`, never email**. `arctic` (Google OIDC+PKCE, GitHub OAuth2+state) wired into plain Nest controllers. Existing `admin_user` rows migrate into `user` (role=admin); the admin guard/endpoints repoint to `user.role`. Register-then-link; **verified-email-only auto-linking**; account-takeover defense.

**Source:** capabilities-expansion spec §Phase 9 + the Phase-9 research brief.

**Existing to repoint:** `packages/db/src/schema/identity.ts` (adminUser), `packages/db/src/repositories/auth.ts` (createAdminUser/findAdminByEmail), `apps/api/src/admin/auth/{admin-auth.service,admin.guard}.ts`, `apps/api/src/seed/seed.ts`.

---

## Conventions

- Repo root, branch `feat/phase-9-oauth`. TDD; commit per task (lowercase conventional subject). Don't push.
- Strict ESLint, no `any`. Passwords use existing `hashPassword`/`verifyPassword` (scrypt) in `@actionow/infra`. JWT via existing `@nestjs/jwt`. No secret/token logging.
- Reuse the existing `createTenant`/`createAccount` repos so registration provisions a tenant+account.

---

## Task 1: `user` + `user_identity` schema + migration + repos

**Files:** `packages/db/src/schema/identity.ts` (replace `adminUser` with `user`; add `userIdentity`), migration; `packages/db/src/repositories/auth.ts` (rework); barrel; integration test.

- `user(id uuid pk, email text not null unique, email_verified boolean default false, password_hash text NULLABLE, role text default 'user', status text default 'active', tenant_id uuid? fk, created_at)` — store email lowercased (normalize in the repo).
- `user_identity(id uuid pk, user_id uuid fk on delete cascade, provider text, provider_user_id text, created_at, unique(provider, provider_user_id), index(user_id))`.
- **Migration**: generate drizzle migration creating `user` + `user_identity`. Because Phase-5 `admin_user` has live seed/test rows, the migration must also **copy `admin_user` → `user`** (`INSERT INTO "user"(id,email,email_verified,password_hash,role,status,created_at) SELECT id,email,true,password_hash,role,status,created_at FROM admin_user`) and then `DROP TABLE admin_user`. Put the data-copy in the generated SQL (edit the migration file to add the `INSERT ... SELECT` + `DROP` after the `CREATE TABLE`s). (Drizzle-kit won't auto-write data migrations — add them by hand and verify with a test that an existing admin_user-shaped row survives.)
- Repos (`auth.ts`): `createUser({email,passwordHash?,role,status?,emailVerified?,tenantId?}) → User`; `findUserByEmail(email)`; `findUserById(id)`; `findUserByIdentity(provider, providerUserId) → User | undefined` (join user_identity); `createUserIdentity({userId,provider,providerUserId})`; `linkIdentityTx` helper (create user + identity in one tx). Keep `createApiKey`/`findApiKeyByHash` unchanged. Remove `createAdminUser`/`findAdminByEmail` (or alias `createAdminUser`→`createUser({role:'admin'})` for the seed; prefer renaming the seed call).

- [ ] **Step 1: integration test** (Testcontainers): migrate (incl. the data-copy) → assert `user`+`user_identity` exist and `admin_user` is gone; `createUser` + `findUserByEmail` (case-insensitive); `findUserByIdentity` join; unique(provider,provider_user_id) rejects a dup. **Step 2–4:** implement schema+migration(+data copy)+repos; green. **Step 5:** Commit `feat(db): unified user + user_identity model (migrate admin_user)`.

---

## Task 2: Unified auth service (register + login) + repoint admin

**Files:** `apps/api/src/auth/` (new: `auth.controller.ts` `POST /auth/register` + `POST /auth/login`, `auth.service.ts`); rework `apps/api/src/admin/auth/{admin-auth.service.ts,admin.guard.ts}` to use `user`; update `apps/api/src/seed/seed.ts`; tests.

- `AuthService`:
  - `register({email,password}) → {token}`: reject if `findUserByEmail` exists; `createUser({email, passwordHash: hashPassword(password), role:'user', emailVerified:false})`; **provision a tenant+account** for the user (`createTenant` + `createAccount`, set `user.tenant_id`); sign JWT `{sub:user.id, role}`.
  - `login({email,password}) → {token}`: `findUserByEmail`; `verifyPassword`; uniform `unauthorized` on any failure (no enumeration); sign JWT.
  - `issueToken(user)` shared with OAuth (Task 3).
- **Repoint admin auth**: `admin-auth.service.ts` `login` now uses `findUserByEmail` + role check (admins are `user.role==='admin'`); keep `POST /admin/auth/login` working (or delegate to `AuthService.login`). `admin.guard.ts` / the `@Roles('admin')` check reads the JWT `role` (already does) — confirm it still gates admin endpoints. The JWT payload stays `{sub, role}`.
- **Seed**: replace `createAdminUser(...)` with `createUser({email:'admin@actionow.local', passwordHash:..., role:'admin', emailVerified:true})`.

- [ ] **Step 1: e2e** (Testcontainers pg): `register` → 200 + token + a tenant+account provisioned + user.role='user'; duplicate email → 409/`invalid_input`; `login` correct→token / wrong→401; **migrated admin still logs in** via `/admin/auth/login` and the JWT gates `GET /admin/tenants` (200 for admin, 401/403 for a regular user token). **Step 2–4:** implement; green. **Step 5:** Commit `feat(api): unified register/login + admin repoint to user model`.

---

## Task 3: Google/GitHub OAuth via arctic (+ account linking)

**Files:** `apps/api/src/auth/oauth.controller.ts` + `oauth.service.ts`; env additions; tests. Add dep `arctic`.

- Env (`packages/infra/src/config.ts`, all optional so app boots without them): `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`, `OAUTH_REDIRECT_BASE` (e.g. `http://localhost:3000`). If a provider's creds are unset → its routes return `invalid_input`/501 with a clear message (don't crash).
- `OauthService` (using `arctic`):
  - `start(provider)`: `generateState()` (+ `generateCodeVerifier()` for Google PKCE); build the authorization URL (Google scopes `openid profile email`; GitHub `read:user user:email`); return `{url, state, codeVerifier?}`.
  - `callback(provider, code, codeVerifier?)`: `validateAuthorizationCode` → get profile: Google `decodeIdToken(tokens.idToken())` → `{sub, email, email_verified, name}`; GitHub fetch `https://api.github.com/user` (id=sub) + `https://api.github.com/user/emails` (pick `primary && verified`). Then **find-or-create**: `findUserByIdentity(provider, sub)` hit → return that user; miss → if a verified provider-email matches an existing **verified** `user.email` → auto-link (add identity); else **lightweight register** (createUser password_hash NULL, email_verified=provider flag, role 'user', provision tenant+account) + identity, one tx. Return the user → `issueToken`.
  - `link(provider, code, codeVerifier?, currentUserId)`: authenticated linking — add a `user_identity` to the current user; reject if that `(provider,sub)` already links another user; for an unverified-password current account, require the caller to be the authenticated session (they are) — fine.
- `oauth.controller.ts`:
  - `GET /auth/oauth/:provider` → `start` → set `state` (+`codeVerifier`) in **short-lived HttpOnly, Secure(in prod), SameSite=Lax cookies** → 302 redirect to the provider URL.
  - `GET /auth/oauth/:provider/callback?code&state` → read+clear the cookies, **verify `state` matches** (else 400) → `callback(...)` → issue JWT (return JSON `{token}` or set a cookie + redirect to a configured frontend — for the scaffold return `{token}`).
  - `POST /auth/link/:provider` (AdminGuard/JWT-auth) → linking start/callback (or a single call accepting `{code}` for tests).
- **Security:** state/codeVerifier single-use + cleared on callback; redirect_uri exact (registered per provider); **never auto-link on unverified email**; uniform errors.

- [ ] **Step 1: tests** — unit: `start` builds correct authorize URLs (scopes/params) for Google (PKCE) + GitHub (state). Integration (Testcontainers pg, **arctic's network mocked** via `vi.stubGlobal('fetch', …)` returning canned token + profile/emails responses, OR by injecting a fake profile resolver): callback for a NEW `(provider,sub)` → creates user+identity (+tenant/account), returns token; callback for an EXISTING identity → logs in the same user (no dup); a verified provider email matching a verified existing user → auto-links; an **unverified** provider email does NOT auto-link (separate user); `POST /auth/link` adds an identity to the current user; linking a `(provider,sub)` already owned by another user → rejected. **Step 2–4:** implement; green. **Step 5:** Commit `feat(api): google/github oauth via arctic with account linking`.

---

## Task 4: Verification gate

- [ ] `pnpm typecheck && pnpm lint && pnpm build && pnpm test` green (Docker up). Boundaries intact. No token/secret/password logging. The migrated admin path + all existing admin/auth tests still pass. Commit any fixups `chore: phase-9 oauth verification gate green`.

---

## Phase 9 Definition of Done

- `admin_user` migrated to a unified `user` + `user_identity` model; existing admin login + admin endpoints still work (role on `user`).
- Local `POST /auth/register` (provisions tenant+account) + `POST /auth/login`; uniform unauthorized.
- Google (OIDC+PKCE) + GitHub (OAuth2+state) login via `arctic`: new-user lightweight register, existing-identity login, **verified-email-only** auto-link, authenticated `POST /auth/link/:provider`; keyed on `(provider, sub)`; state/PKCE single-use cookies.
- `pnpm typecheck/lint/build/test` green; boundaries enforced; no secret leakage.

> **Next:** Phase 10 — payments (Stripe reference + Alipay/WeChat/crypto stubs).
