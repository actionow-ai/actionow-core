# Actionow Phase 5 — Auth, Rate-Limit, Admin API, Seed Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. `- [ ]` steps. TDD.

**Goal:** Replace the Phase-3 stub auth with real **API-key auth** (hash lookup, `resource_allowlist`, per-key rate-limit), add **two-level Redis rate limiting**, **admin auth (RBAC) + admin CRUD** over the catalog/pricing/tenants/keys + a **dify-import** endpoint, **OpenAPI** docs, wire **modifier scope filtering**, and a **seed script** + **acceptance e2e** proving the §12 criteria. This makes the scaffold real: seed → `POST /v1/run` with an API key works end-to-end.

**Architecture:** All in `apps/api` (NestJS) over the existing packages. Auth = NestJS guards (`ApiKeyGuard` for `/v1/*`, `AdminGuard`/JWT for `/admin/*`). Rate-limit = a Redis token-bucket guard. Admin endpoints are thin REST over `@actionow/db` repos + `@actionow/engine` (`DifyRegistrationService`). Seed = a script using the db repos.

**Tech Stack:** NestJS 11, `@nestjs/jwt`, `@nestjs/swagger`, `argon2` (admin password) / `node:crypto` sha256 (API-key hash), ioredis (rate-limit), Vitest + Testcontainers + supertest.

**Source spec:** §4.6 (note: OpenAI-compat endpoint is OUT of this phase unless trivial), §4.7 (errors), §8 (multi-tenant/auth/account), §9.2 (modifier scope), §12 (acceptance), §14 待定 (defaults).

---

## Conventions

- Repo root, branch `feat/phase-5-api-admin`. TDD; commit per task (lowercase conventional subject). Don't push.
- Strict ESLint. apps may import any package. New deps go in `apps/api`. Secrets/keys never logged.
- Reuse `@actionow/db` repos; add only the small ones named below. Reuse the Phase-3 `UnifiedErrorFilter`.

---

## Task 1: API-key model + `ApiKeyGuard` (replace stub auth)

**Files:** `packages/db/src/repositories/auth.ts` (api_key + admin_user reads/writes); `apps/api/src/auth/` (`api-key.guard.ts`, `api-key.service.ts`, update `auth.service.ts`); tests.

- db `auth.ts`: `createApiKey(db, {tenantId, resourceAllowlist?, rateLimit?}) → { id, plaintext }` — generate `ak_<base64url(32 bytes)>`, store `hash = sha256(plaintext)` (hex), return plaintext ONCE. `findApiKeyByHash(db, hash)` → `{id, tenantId, resourceAllowlist, rateLimit, status}` or undefined. `createAdminUser(db, {email, passwordHash, role})`, `findAdminByEmail`.
- `ApiKeyGuard` (NestJS): read `Authorization: Bearer ak_...` (or `x-api-key`), `sha256` it, `findApiKeyByHash`; reject `unauthorized` if missing/disabled. Attach `{tenantId, apiKeyId, resourceAllowlist, rateLimit}` to the request. On `/v1/run/:resourceId`, if `resourceAllowlist` is non-empty and the resource isn't in it → `unauthorized`/`resource_not_found`. Resolve the account via `getAccountByTenant`. **Remove the `x-tenant-id` stub path** (or keep only behind `NODE_ENV!==production` for tests, clearly marked).

- [ ] **Step 1: Failing tests** — unit: key generation + sha256 round-trip; guard rejects missing/bad key (401 `unauthorized` envelope), accepts a valid key and sets tenant context; allowlist blocks a non-listed resource. (NestJS guard test with a fake request + injected fake repo.)
- [ ] **Step 2–4:** Implement; green. Wire `ApiKeyGuard` onto the `/v1` controllers (RunController, JobsController) via `@UseGuards`.
- [ ] **Step 5:** Commit `feat(api): api-key auth guard with hash lookup + resource allowlist`.

---

## Task 2: Two-level Redis rate limiting

**Files:** `packages/infra/src/rate-limit.ts` (token-bucket on ioredis); `apps/api/src/auth/rate-limit.guard.ts`; tests.

- infra `rate-limit.ts`: `class RedisRateLimiter { constructor(redis); async take(key, limitPerMin): Promise<{ allowed: boolean; retryAfterMs: number }> }` — fixed-window or token bucket via an atomic Redis `INCR`+`PEXPIRE` (or a small Lua script). Inject the redis client; provide an in-memory fake for tests.
- `RateLimitGuard`: after `ApiKeyGuard`, enforce TWO buckets — per `tenantId` (a configured default) and per `(tenantId, resourceId)` (the key's `rateLimit` or a default). On exceed → throw a `UnifiedError('rate_limited', retryable:true, retryAfterMs)` → filter returns 429 + `retry_after_ms`.

- [ ] **Step 1: Failing tests** — `RedisRateLimiter.take` allows up to N then blocks with `retryAfterMs>0` (use a fake redis / Testcontainers redis); guard composes tenant+resource buckets and 429s on exceed.
- [ ] **Step 2–4:** Implement; green.
- [ ] **Step 5:** Commit `feat(api): two-level redis rate limiting (tenant + resource)`.

---

## Task 3: Admin auth (JWT + RBAC)

**Files:** `apps/api/src/admin/auth/` (`admin-auth.controller.ts` `POST /admin/auth/login`, `admin-auth.service.ts`, `admin.guard.ts`); add `@nestjs/jwt`, `argon2`; tests.

- `POST /admin/auth/login {email,password}` → verify `argon2.verify(passwordHash, password)`; issue a JWT `{sub: adminId, role}` signed with `env.ADMIN_JWT_SECRET` (add to infra config; required in prod, dev default). `AdminGuard` validates the `Authorization: Bearer <jwt>`, attaches `{adminId, role}`; a `@Roles('admin')` decorator + role check.

- [ ] **Step 1: Failing tests** — login with correct/incorrect password (200 + token / 401); `AdminGuard` accepts a valid token, rejects missing/expired/garbage.
- [ ] **Step 2–4:** Implement; green.
- [ ] **Step 5:** Commit `feat(api): admin jwt auth with rbac guard`.

---

## Task 4: Admin CRUD + dify-import endpoints

**Files:** `apps/api/src/admin/` controllers+services+DTOs (zod-validated); add db write repos as needed (`createTenant`, `createAccount`, `createPricebookEntry`, `createModifier`, `createUpstreamChannel`, `updateResourceStatus`, list/get variants); tests.

Endpoints (all under `@UseGuards(AdminGuard)`):

- `POST /admin/tenants`, `GET /admin/tenants`; `POST /admin/accounts` (+ `POST /admin/accounts/:id/topup {credits}` → `topUp`); `POST /admin/api-keys` (returns plaintext once), `GET /admin/api-keys`.
- `POST/GET /admin/resources`, `POST /admin/resources/:id/channels`; `POST/GET /admin/pricebook`, `POST/GET /admin/modifiers`.
- `POST /admin/dify/import {tenantId, resourceId, yaml, endpoint, serviceKeyRef, pricingModel, allowBlockers?}` → `DifyRegistrationService.register` → returns `{resourceId, version, ioSchema, compatReport}` (maps `metered_not_allowed`/blockers to a 400/422 envelope).
- Reuse existing reads for `GET /admin/jobs`, `GET /admin/ledger` (add `listLedger(db, tenantId, cursor, limit)`).
- **Credits input**: admin topup/pricebook amounts are entered as human credits → convert via `creditsToMicro` (domain) at the boundary; store µcredits.

- [ ] **Step 1: e2e (Test + Testcontainers pg)** — as an admin (seeded), create tenant→account→topup→api-key→resource→pricebook; assert rows persisted with µcredits; `POST /admin/dify/import` registers a BYO workflow and returns io_schema; BYO+metered import → 400 `metered_not_allowed` envelope.
- [ ] **Step 2–4:** Implement; green.
- [ ] **Step 5:** Commit `feat(api): admin crud + dify import endpoints`.

---

## Task 5: Modifier scope filtering + OpenAPI

**Files:** `packages/db/src/repositories/catalog.ts` (`listActiveModifiers` → scope-aware), `apps/api/src/main.ts` (+swagger), DTO decorations.

- Modifier scope (§9.2): `listApplicableModifiers(db, {tenantId, resourceId})` returns modifiers whose `scope` is `global`, `tenant:<tenantId>`, or `capability:<resourceId>`/`resource:<resourceId>` — filtering by scope string match. RunService uses this instead of `listActiveModifiers`. (The `when_expr`/coupon evaluation stays a documented later concern; for now scope-match + `active`.)
- OpenAPI: `@nestjs/swagger` `SwaggerModule` at `/docs`; annotate the `/v1` and `/admin` controllers/DTOs enough to produce a usable spec. Emit `openapi.json`.

- [ ] **Step 1:** unit test `listApplicableModifiers` returns only global + matching tenant/resource scopes (Testcontainers). Swagger boots (`/docs` 200 in an e2e).
- [ ] **Step 2–4:** Implement; green.
- [ ] **Step 5:** Commit `feat(api): scope-aware modifiers + openapi docs`.

---

## Task 6: Seed script + acceptance e2e (the §12 capstone)

**Files:** `apps/api/src/seed/seed.ts` (runnable via `pnpm --filter @actionow/api seed`), `apps/api/test/acceptance.e2e.test.ts`.

- `seed.ts`: idempotently create — 1 tenant, 1 admin_user (`admin@actionow.local` / dev password via argon2), 1 account topped up (e.g. 100 credits), 1 api_key (print the plaintext), 1 `openai`-style resource + io_schema + active pricebook (unit/post or fixed/pre) + one upstream_channel (credential via env secret ref). Print the api key + a sample curl.
- Acceptance e2e (Testcontainers pg; a **stubbed adapter/HttpClient** injected so no network; Redis via a fake or Testcontainers): run the seed against the test db, then assert the §12 criteria:
  1. `POST /v1/run/:id` with the seeded API key (blocking) → 200 output+usage+cost; a `settle` ledger row; account debited.
  2. Insufficient balance → 402 `insufficient_credits`, no job.
  3. Same `idempotency_key` replay → same job, no double charge.
  4. Missing/invalid API key → 401 `unauthorized`.
  5. Rate-limit exceeded → 429 `rate_limited` + `retry_after_ms`.
  6. `POST /admin/dify/import` (as admin) registers a BYO workflow; `GET /v1/resources/:id` (add this if missing) shows its io_schema.

- [ ] **Step 1–4:** Write the seed + e2e; implement any missing `/v1/resources` discovery endpoint (`GET /v1/resources`, `GET /v1/resources/:id` filtered by tenant visibility + allowlist); green.
- [ ] **Step 5:** Commit `feat(api): seed script + acceptance e2e (§12 criteria)`.

---

## Task 7: Verification gate

- [ ] `pnpm typecheck && pnpm lint && pnpm build && pnpm test` green (Docker up). Boundaries intact. No secret/key logged (grep). The seed's printed key is the only plaintext-key surface (intended).
- [ ] Commit any fixups `chore: phase-5 verification gate green`.

---

## Phase 5 Definition of Done

- `/v1/*` requires a valid API key (sha256 hash lookup, `resource_allowlist` enforced); two-level Redis rate-limit returns 429 + `retry_after_ms`.
- `/admin/*` requires admin JWT (argon2 password, RBAC); admin can CRUD tenants/accounts(+topup)/api-keys/resources/channels/pricebook/modifiers and import a Dify BYO workflow; amounts entered as credits, stored as µcredits.
- Modifiers are scope-filtered (global/tenant/resource); OpenAPI served at `/docs`.
- **Seed → `POST /v1/run` with the API key works end-to-end**; the §12 acceptance e2e passes all 6 criteria.
- `pnpm typecheck/lint/build/test` all green; boundaries enforced; no secret leakage.

> This is the final phase. After merge, Phases 0–5 are complete: a runnable, tested, lint-enforced unified-AI-gateway backend scaffold.
