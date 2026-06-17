# Actionow Backend Hardening Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the gaps the backend audit found — uniform pagination on every list endpoint, full CRUD (incl. credential revocation), and unified table-design standards (FK indexes, `updated_at`, soft-delete, status CHECK constraints) — plus the new `GET /admin/relay-traces` read endpoint.

**Architecture:** Four sequenced tracks. Track A (schema standards) is foundational and lands ONE additive migration `0015`; Tracks B–D are mostly code on top. Each track is its own branch off `main`, gated + merged before the next. Authz is already clean (audit) — do not change the guard model.

**Tech stack:** pnpm monorepo, NestJS 11 (ESM/NodeNext), Drizzle + drizzle-kit, vitest + Testcontainers, zod, strict ESLint. Money = bigint µcredits.

---

## Locked conventions (apply everywhere)

### Pagination (BREAKING for existing list consumers — incl. the admin frontend)

- **Query params:** `limit` (int, clamp 1..200, default 50), `cursor` (opaque, base64 of `"<created_at_iso>|<id>"`).
- **Response envelope (uniform):** `{ "data": T[], "next_cursor": string | null, "has_more": boolean }`.
- **Repo keyset:** `ORDER BY created_at DESC, id DESC`; cursor filters `(created_at, id) < (cursorCreatedAt, cursorId)`; fetch `limit + 1` rows → `has_more` = got an extra; `next_cursor` from the last returned row (null when `!has_more`).
- **Shared helpers:** `apps/api/src/common/pagination.ts` (`parsePageQuery(q)`, `encodeCursor(row)`, `decodeCursor(s)`, `toPage(rows, limit)`); a db-side keyset helper in `packages/db/src/repositories/pagination.ts`.
- **Migrate existing cursor endpoints** (`/admin/jobs`, `/admin/ledger`, `/v1/jobs`, `/admin/usage`, `/admin/payments`, `/console/usage`) to the `data`/`next_cursor`/`has_more` envelope (drop bespoke `jobs`/`transactions`/`logs`/`intents` keys).
- **EXEMPT:** `GET /v1/models` keeps the OpenAI `{ object:'list', data:[…] }` shape (spec-mandated, visibility-filtered, small) — no cursor.

### Table-design standard (one additive migration `0015`)

- **PK:** uuid `defaultRandom()`. **Exception (documented, KEEP):** `resource.id`, `gift_code.code`, `redemption_code.code` stay `text` (human-readable slugs / immutable tokens).
- **Timestamps:** every table has `created_at` (tz) `defaultNow()`. Every MUTABLE table has `updated_at` (tz) `defaultNow()`; immutable tables carry a `// immutable: no updated_at` comment.
- **Soft-delete:** add `deleted_at` (tz, null) to operator/customer-facing tables: `tenant, account, api_key, resource, model, upstream_channel, secret_ref, oauth_session, pricebook_entry, modifier, dify_binding, redemption_code`. List repos filter `deleted_at IS NULL`; DELETE endpoints set `deleted_at = now()`. Ephemeral/audit tables stay hard/no-delete: `job, ledger_txn, usage_log, relay_trace, webhook_outbox, idempotency_key, payment_event, channel_health, resource_version, secret_material, user_identity`.
- **FK indexes:** every FK column gets an index (`<table>_<col>_idx`); tenant-leading composite where it's a common filter.
- **status CHECK constraints:** add a `CHECK (status IN (...))` per status column (documented allowed values). Keep `text` (not pg enum) for evolvability.
- **timestamps with timezone**, **snake_case**, **money bigint µcredits** — already uniform; keep.

### CRUD standard

- Every admin entity: Create / List (paginated) / Get-by-id / Update (PATCH) / Delete (soft where the table has `deleted_at`, hard otherwise).
- Credentials (`api_key`, `oauth_session`, `secret_ref`) get a DELETE = revoke (soft-delete; resolver/guards must treat soft-deleted as absent).
- `Idempotency-Key` header on admin mutating POSTs → dedupe via the existing `idempotency_key` table.
- 404 via `engineNotFound` on every `:id` route; never return secrets.

---

## Track A — Schema standards (migration 0015) — FOUNDATION

**Files:** `packages/db/src/schema/*.ts`, generated `0015_*.sql`, touched repos, schema int tests.

- [ ] A1. Add `created_at` where missing: `oauth_session, gift_code, dify_binding, channel_health` (tz, defaultNow). Add `updated_at` to mutable tables missing it: `tenant, api_key, user, resource, upstream_channel, pricebook_entry, modifier, secret_ref, file_object`. Comment immutable tables.
- [ ] A2. Add `deleted_at` (tz, null) to the soft-delete table set (above).
- [ ] A3. Add FK indexes on every un-indexed FK column (per audit: `api_key.tenant_id, user.tenant_id, user_identity.user_id, account.tenant_id, idempotency_key.tenant_id, file_object.tenant_id, resource_version.resource_id, upstream_channel.resource_id, pricebook_entry.resource_id, dify_binding.resource_id, secret_material.secret_ref_id, webhook_outbox.job_id`, etc.).
- [ ] A4. Add `CHECK (status IN (...))` constraints for each status column (oauth_session, payment_intent, job, redemption_code, gift_code, resource, upstream_channel, model, file_object, usage_log). Document allowed values.
- [ ] A5. `pnpm --filter @actionow/db db:generate` → ONE `0015_*.sql`. Update list repos to filter `deleted_at IS NULL`. Add `.$type<T>()` to untyped jsonb (`execution.ts` inputs/output/error, catalog config, pricing spec) — type-only, no migration.
- [ ] A6. db int tests: migration-presence (0015 cols/indexes/checks exist); a soft-deleted row is excluded from its list repo. Full `@actionow/db` suite + typecheck + lint green. Commit.
- [ ] A7. Combined schema review (focus: additive-only/no data loss, CHECK values match current data, soft-delete filter applied consistently). Gate + merge.

## Track B — Uniform pagination

**Files:** `apps/api/src/common/pagination.ts` (new), `packages/db/src/repositories/pagination.ts` (new), all list repos + admin/console/v1 controllers + their e2e tests.

- [ ] B1. Shared api helper + db keyset helper (see conventions). Unit tests for cursor encode/decode + clamp + keyset SQL.
- [ ] B2. Convert every list repo to `(filter, { cursor, limit }) → { rows, hasMore, nextCursor }` keyset. (tenants, api_keys, resources, channels, pricebook, modifiers, models, oauth_sessions, secrets, redemption_codes, dify, relay_trace, + standardize jobs/ledger/usage/payments.)
- [ ] B3. Wrap every list controller in the `{ data, next_cursor, has_more }` envelope; accept `limit`/`cursor`. Keep `/v1/models` OpenAI-exempt.
- [ ] B4. Update all affected e2e tests to the new envelope; add a pagination e2e (2 pages via cursor, has_more flips). Gate + merge.

## Track C — relay-traces read endpoint

**Files:** `packages/db/src/repositories/relay-trace.ts` (+`listRelayTraces`), admin dto/service/controller, e2e.

- [ ] C1. `listRelayTraces(db, { jobId?, tenantId?, providerType?, channelId?, from?, to? }, page)` — keyset paginated.
- [ ] C2. `GET /admin/relay-traces` (admin-guarded) with those filters + pagination; defense-in-depth: re-run header redaction on read (never surface a token even if a legacy row had one). e2e: filter by job_id + paginate; assert redaction.
- [ ] C3. Gate + merge.

## Track D — CRUD completeness + idempotency

**Files:** admin dto/service/controller, repos (add update/delete/get-by-id), `apps/api/src/common/idempotency.ts`, e2e.

- [ ] D1. Credential revoke (soft-delete): `DELETE /admin/api-keys/:id`, `DELETE /admin/oauth-sessions/:id`, `DELETE /admin/secrets/:id` + `GET /admin/secrets` (metadata, no plaintext) + `GET /admin/secrets/:id`. Resolver + ApiKeyGuard treat soft-deleted as absent (test: a revoked key → 401; a revoked oauth session → channel resolve returns undefined).
- [ ] D2. `model`: `GET /admin/models/:name`, `PATCH /admin/models/:name`, `DELETE` (soft). `model_grant`: `GET /admin/models/:name/grants`, `DELETE /admin/models/:name/grants/:tenantId`.
- [ ] D3. `upstream_channel`: `DELETE /admin/resources/:id/channels/:channelId` (soft) + `GET …/:channelId`. `pricebook`: PATCH + DELETE. `modifier`: PATCH + DELETE. `resource`/`tenant`/`account`: `GET /:id` + `PATCH /:id`.
- [ ] D4. `redemption_code`: `GET /admin/redemption-codes?resourceId&status` (paginated). `dify`: `GET /admin/dify`, `PATCH`, `DELETE`.
- [ ] D5. `Idempotency-Key` header support on admin POSTs via `idempotency_key` table (store key+endpoint → cached response; replay returns it). e2e: double-POST with same key → one entity.
- [ ] D6. Per-sub-track e2e + a combined CRUD review (no secret leakage, soft-delete semantics, 404 consistency). Gate + merge.

---

## Notes

- **Breaking change:** the pagination-envelope unification changes admin/console/v1 list response shapes — the admin frontend (`/Users/alienworm/actionow-web`) consuming these must update. Acceptable pre-1.0; flag to operator.
- **Migration discipline:** only Track A generates a migration (`0015`); other tracks are code-only (reuse `idempotency_key`). Never hand-number; `db:generate`.
- **No authz changes** — the guard model is correct per audit.
