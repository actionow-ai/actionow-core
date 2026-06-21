# M2M Admin Service Tokens — Design

**Date:** 2026-06-20
**Status:** Approved (implementing)
**Branch:** `feat/fe-be-converge` (worktree `actionow-converge`)

## Problem

The admin control plane (`/admin/*`) authenticates only with a 12-hour human-login
JWT (`AdminGuard` → `verifyAsync` against `ADMIN_JWT_SECRET`). For the
embed-as-backend product scenario (①), an external developer's backend must call
`/admin/*` to provision customers (tenants/accounts/api-keys) at signup. Today that
forces stuffing an admin's email+password or hand-rotating short-lived JWTs — there
is no long-lived, revocable, per-integration machine credential.

## Goal

Add a **service token** (M2M credential) the `AdminGuard` accepts as a Bearer token,
mintable/listable/revocable by an authenticated admin, mirroring the proven
data-plane api-key pattern. Also register the OpenAPI `bearerAuth` security scheme
(the contract currently declares no auth at all).

## Decisions

- **Privilege model: full admin.** A service token carries `role: 'admin'` and reuses
  the existing `@Roles` RBAC. Scoped/least-privilege tokens are explicitly out of scope
  (YAGNI). Implication: a service token can mint further tokens — accepted.
- **Dedicated `admin_token` table** (not a reuse of `api_key`, not a static env token).
  Keeps control-plane creds off the data-plane hot path; revocable + auditable.
- **Endpoint base:** `/admin/tokens`.
- **Expiry:** optional `expires_at` (nullable = never).
- **No `last_used_at` in v1** (avoids a DB write on every admin request).

## Data model — migration `0024`, table `admin_token`

| Column       | Type                               | Notes                                  |
| ------------ | ---------------------------------- | -------------------------------------- |
| `id`         | uuid PK `gen_random_uuid()`        |                                        |
| `name`       | text NOT NULL                      | human label (which integration)        |
| `hash`       | text NOT NULL, UNIQUE index        | SHA256 hex of plaintext (`hashApiKey`) |
| `created_by` | uuid NOT NULL → `user(id)`         | minting admin (audit attribution)      |
| `expires_at` | timestamptz NULL                   | optional; NULL = never                 |
| `status`     | text NOT NULL DEFAULT `'active'`   | CHECK in (`active`,`disabled`)         |
| `created_at` | timestamptz NOT NULL DEFAULT now() |                                        |
| `updated_at` | timestamptz NOT NULL DEFAULT now() |                                        |
| `deleted_at` | timestamptz NULL                   | soft-delete (revoke)                   |

Indexes: unique on `hash`, index on `created_by`.

Plaintext format: `at_<base64url(32 random bytes)>` (distinct `at_` prefix from the
data-plane `ak_`). Only the SHA256 hex is stored; plaintext is returned once.

## Components

### `packages/db` — repo functions (mirror `api_key` repo)

- `createAdminToken(db, { name, createdBy, expiresAt? }) → { id, plaintext }`
- `findAdminTokenByHash(db, hash) → AdminTokenRecord | undefined` — filters
  `deleted_at IS NULL` only (mirrors `findApiKeyByHash`); the returned record carries
  `status` and `expires_at` so the **guard** decides active/expired. Revoked
  (soft-deleted) tokens read as absent.
- `listAdminTokens(db, page) → KeysetResult<AdminTokenView>` (no hash)
- `softDeleteAdminToken(db, id) → string | undefined`
- Schema in `packages/db/src/schema/identity.ts`; drizzle migration `0024`.

### `apps/api` — service + controller

- `AdminTokenService`: `mint(name, createdBy, expiresAt?)`, `list(page)`, `revoke(id)`.
- Routes on the admin controller (or a small `admin-tokens.controller.ts`), under
  `AdminGuard` (any authenticated admin):
  - `POST /admin/tokens` `{ name, expiresAt? }` → `{ id, plaintext }` (201)
  - `GET /admin/tokens` → keyset page of `AdminTokenView`
  - `DELETE /admin/tokens/:id` → 204

### `apps/api` — `AdminGuard` change (the security-critical bit)

After extracting the Bearer token, branch by prefix:

- starts with `at_` → `hashApiKey(token)` → `findAdminTokenByHash`; reject if missing,
  `status!=='active'`, soft-deleted, or `expires_at` in the past; on success attach
  `{ adminId: created_by, role: 'admin' }`.
- otherwise → existing `jwt.verifyAsync` path (human sessions unchanged).
  Both paths then run `enforceRoles`. All failures → uniform `unauthorized`.
  Guard gains a DB dependency (inject `DB`); keep the JWT path's behavior identical.

### `packages/contracts` — contract + SDK

- New zod: `adminTokenViewSchema`, `createAdminTokenSchema` (`{ name, expiresAt? }`),
  reuse `apiKeyCreatedSchema` shape (`{ id, plaintext }`) for the mint response.
- Register `bearerAuth` HTTP-bearer security scheme; attach `security` to `/admin/*`
  (and `/console/*`) paths.
- Regenerate `openapi.json` + `@actionow/sdk` (reproducibility CI guards it).

## Error handling

All auth failures return the existing `unauthorized` engine error (no enumeration
difference between unknown / expired / revoked / wrong-secret). Mint/list/revoke
validation errors flow through the existing `ZodBody` + error pipeline.

## Testing

- **Unit** (`admin.guard` spec): JWT still passes; valid `at_` token passes; expired,
  revoked (soft-deleted), disabled, and unknown `at_` tokens → 401; `@Roles` still
  enforced for both credential types; a non-`at_` non-JWT → 401.
- **e2e** (`admin-token.e2e.test.ts`, testcontainers): mint → call a protected
  `/admin/*` route with the token → succeeds; list shows it (no hash); revoke → token
  now 401; expired token → 401; a non-admin (user) JWT cannot mint.
- Re-run the existing `admin-relay-ops` / admin-crud e2e to prove the JWT path didn't
  regress.

## Out of scope (future)

Scoped/least-privilege roles; `last_used_at` audit; token-level audit attribution
(beyond `created_by`); a frontend management page (separate FE backlog item).

## Verification gates

contracts test/typecheck/lint · apps/api tsc+lint+e2e (new + regression) · sdk
typecheck+gen reproducible · apps/web typecheck/build (SDK shape unchanged for it) ·
contract CI green. Then commit on `feat/fe-be-converge`, re-sync delivery branch, push PR #2.
