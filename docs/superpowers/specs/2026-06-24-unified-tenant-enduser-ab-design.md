# 多租户终端用户 (Unified Tenant End-User · Models A + B) — Design Spec

> **Status:** Proposed (design complete, adversarially reviewed 2026-06-24; awaiting Q&A → plan). A cross-cutting **tenancy foundation** under the 计费与路由 (billing & routing) family, built directly on top of 治理与额度 v1 (#30). Reconciled against the merged governance code at `main 12cad95`. A **completeness audit** (10-agent sweep, 2026-06-24) merged its delta below — items marked `[delta]`; headline addition: **read-path subject isolation (§4b)**. All 10 open decisions **resolved via Q&A 2026-06-24** (see §Resolved decisions); 3 deviations expand scope into a unified-person identity layer (§1.6). Status → ready for G-A planning.

**Goal:** Let one actionow-core deployment serve **many products as tenants**, and within each tenant push **wallet (credits) and api-key down to each end-user**, supporting BOTH (A) platform-owned end-user identity/login and (B) app-owned identity (actionow keyed by an `external_id`) — in **one data model**, with zero behavior change for existing tenant-level traffic.

**Architecture:** Introduce a tenant-scoped **`subject`** (the end-user) as the single new principal. Everything downstream of authentication keys off one join point — **`req.auth.subjectId` (uuid | null)**. Wallets become hierarchical (tenant `account` pool + optional per-subject `sub_account`); api-keys gain an optional `subject_id`; governance gains a `'subject'` dimension that slots into the already-polymorphic v1 machinery. A and B are two _population strategies_ for the same `subject`, not two architectures. Money stays integer µ-units; the ledger remains the source of truth.

**Tech stack:** NestJS (apps/api), Drizzle/Postgres (packages/db), Redis via `@actionow/infra`, zod contracts → openapi → `@actionow/sdk`, React/Vite console (apps/web), engine (packages/engine).

**Deployment context:** actionow-core is deployed **internally inside the company**; multiple internal AIGC products are built on top (each = a tenant), and those products are **operated externally** (serve & charge external end-users). So `tenant` = an internal product line; `subject` = that product's external end-user; the ledger does double-duty (internal cross-product cost chargeback + external per-user revenue). See memory `product-positioning`.

---

## Context — what already exists (build on, don't duplicate)

- **`tenant`** = the product/app; full `tenant_id` row-level isolation across the DB. (`packages/db/src/schema/identity.ts`)
- **`user`** = a unified _operator_ principal: platform admin (`role=admin`, `tenant_id=NULL`), tenant admin (`role=admin`, `tenant_id=X`). `user.email` is **global-unique + NOT NULL** (identity.ts:74); `user` has no `deleted_at`. Read by the RBAC guard on every console request.
- **End-user today is NOT a row**: only a loose `job.end_user` text label, or implicit via a tenant-shared api-key. `api_key` is **tenant-scoped only** (no `user_id`).
- **Wallet** = `account`, **1:1-unique on tenant** (`accounts.ts`). All hold/settle debit the tenant account. `holdCredits`/`releaseHold`/`topUp` (`repositories/account.ts`); `settleJob`/`failJob` (`repositories/settle.ts`); `ledger_txn` (`schema/execution.ts`); `<=1 settle per job` via a partial unique index on `(job_id) where type='settle'`.
- **Governance & limits v1 (#30, `main 12cad95`)** — _the ideal foundation for this work._ It is **polymorphic on `(subject_type, subject_id)` end-to-end**: `limit_usage`/`limit_alert` use text `subject_type`/`subject_id` with **no CHECK** (schema/limit.ts:99-101,131); `getUsage`/`incrUsage` take a text `UsageKey`; the guard's `enforceCounter`/`enforceConcurrency` redis keys are already `${subjectType}:${subjectId}:${ruleId}` (governance.guard.ts:127,178); `checkLimitAlert` is subject-generic. `resolveEffectiveRules(db, keyPlanId, tenantPlanId)` exists but is **called per-single-plan** (2nd arg `null`) at the guard (:203,:207) and accrual (:411), which each tag the subject themselves. Plans bind via `api_key.limit_plan_id` + `account.limit_plan_id`. **Adding `'subject'` is a third value, not a redesign.**
- **`webhook_outbox`**, **`idempotency_key`** (unique on `(tenant_id, key)`), **`relay_trace`**, **`redemption_code`**, **`payment_intent`** — all currently tenant/key-scoped.
- **Known baseline bug:** `failJob` (settle.ts:112-122) scopes the hold-release `UPDATE` to `accountId` **only**, missing the `tenantId` guard `settleJob` has (line 65). A cross-tenant hold-release race; fixed in the baseline below independent of subjects.
- **Self-serve `register`** (`local-auth.service.ts:87`) creates a **new tenant per registering user** — the opposite of "many end-users under one tenant"; retained as legacy, not used for member onboarding.

## Feasibility verdict & unifying insight

**Yes — A and B share one model.** The end-user is a **subject**: a tenant-scoped principal that optionally owns a sub-wallet and scoped keys. A vs B differ in exactly two places: (1) whether actionow stores login credentials for the subject (A yes / B no), and (2) how the subject is _resolved_ on a request (A: a subject-scoped key or member-JWT carries the id; B: a tenant-level key + an `external_id` label resolves/JIT-provisions the subject). Once `req.auth.subjectId` is populated, the data plane (wallet, governance, ledger/usage attribution, idempotency, webhooks, traces) is **model-agnostic**.

## Scope

**In:** the `subject` primitive (A+B); per-subject `sub_account` wallet (hard) + per-subject governance caps on the shared pool (soft); `api_key.subject_id`; subject context plumbed through guard → engine → settle/usage/ledger/webhook/trace; Model-A member auth; Model-B `external_id` resolution (+ gated JIT); governance `'subject'` dimension; subject CRUD + per-subject wallet/key admin; the `failJob` baseline fix; **cross-tenant subject federation (`subject_identity`) + `user↔subject` linking — a unified-person identity layer (decisions #2/#10, lands G-F, §1.6)**; contracts/SDK; frontend operator end-user hub + (optional) end-user console; tests.

**Out (separate specs / later):** double-entry ledger / audit of who-changed-what (records sub-project); RBAC billing sub-role; subscription/recurring billing; per-product hard-isolation (`schema`/`db` isolation modes).

---

## ① Data model

### 1.1 Decision — a NEW `subject` table (not reuse of `user`)

Reusing `user` would force `user.email` nullable + per-tenant-unique (high blast radius on the operator login / OAuth hot path), mix millions of end-users into the table the RBAC guard reads on every request, and lacks soft-delete. A purpose-built table leaves the operator path **byte-for-byte unchanged**. The two stores never JOIN on the hot path (operator → `user`; end-user → `subject`).

**`subject`** (`packages/db/src/schema/identity.ts`):

| column                                     | type                            | notes                                                                      |
| ------------------------------------------ | ------------------------------- | -------------------------------------------------------------------------- |
| `id`                                       | uuid pk default random          | internal FK target                                                         |
| `tenant_id`                                | uuid notNull → tenant.id        | isolation                                                                  |
| `external_id`                              | text NULL                       | Model-B handle                                                             |
| `email`                                    | text NULL                       | Model-A login — **NOT** global-unique                                      |
| `password_hash`                            | text NULL                       | NULL = no local login                                                      |
| `display_name`                             | text NULL                       | label                                                                      |
| **`limit_plan_id`**                        | **uuid NULL → limit_plan.id**   | **per-subject governance plan (see ⑤ — lives HERE, not on `sub_account`)** |
| `status`                                   | text notNull default `'active'` | active \| disabled                                                         |
| `created_at` / `updated_at` / `deleted_at` | timestamptz                     | soft-delete                                                                |

Indexes/checks (all in **M-1**): unique `(tenant_id, external_id) where external_id IS NOT NULL and deleted_at IS NULL`; unique `(tenant_id, email) where email IS NOT NULL and deleted_at IS NULL`; index `(tenant_id)`; check `status IN ('active','disabled')`.

### 1.2 `sub_account` — per-subject wallet (HARD mode)

**`sub_account`** (`packages/db/src/schema/accounts.ts`) — separate table (the tenant `account` is 1:1-unique on tenant):

`id uuid pk`, `tenant_id uuid notNull → tenant`, `subject_id uuid notNull → subject`, `credit_balance bigint notNull default 0`, `credit_held bigint notNull default 0`, `status text notNull default 'active'`, timestamps + `deleted_at`. Constraints mirror `account` exactly: unique `(tenant_id, subject_id) where deleted_at IS NULL`; `credit_balance >= credit_held`; `credit_balance >= 0`; `credit_held >= 0`; `status IN ('active','disabled')`.

> **Note:** the per-subject **governance plan** is `subject.limit_plan_id` (§1.1), NOT a column on `sub_account`. A subject can have caps without a wallet (SHARED mode). `sub_account` is purely the prepaid balance.

### 1.3 Attribution + completeness columns (all nullable, `ON DELETE SET NULL`)

| table             | column       | file         | reason                                                            |
| ----------------- | ------------ | ------------ | ----------------------------------------------------------------- |
| `api_key`         | `subject_id` | identity.ts  | subject-scoped keys                                               |
| `job`             | `subject_id` | execution.ts | attribution + settle routing                                      |
| `ledger_txn`      | `subject_id` | execution.ts | financial attribution (survives delete)                           |
| `usage_log`       | `subject_id` | usage.ts     | per-subject usage / rollup / `windowedUsage`                      |
| `idempotency_key` | `subject_id` | execution.ts | per-subject claim window                                          |
| `webhook_outbox`  | `subject_id` | execution.ts | subject in callback payload                                       |
| `relay_trace`     | `subject_id` | storage.ts   | "which subject hit which model"                                   |
| `redemption_code` | `subject_id` | payment.ts   | per-subject redemptions                                           |
| `payment_intent`  | `subject_id` | payment.ts   | route top-up to `sub_account`                                     |
| `file_object`     | `subject_id` | storage.ts   | **per-end-user media/asset ownership + read isolation** `[delta]` |

`*_subject_idx` on each. **Idempotency uniqueness** is split to preserve today's behavior: keep `unique (tenant_id, key) where subject_id IS NULL`; add `unique (tenant_id, subject_id, key) where subject_id IS NOT NULL`. `claimIdempotency` gains optional `subjectId`.

> **`payment_event`** `[delta]` (`schema/payment.ts:69`) currently has only a `payment_intent_id` FK (`ON DELETE SET NULL`) — no tenant/subject scope, so events become unscopable once an intent is deleted. Add **`tenant_id`** (snapshot at insert, `ON DELETE SET NULL`); `subject_id` deferred to G-E.

### 1.4 Governance CHECK (purely additive)

`limit_usage.subject_type` / `limit_alert.subject_type` have **no CHECK today** (only a comment). Before any `'subject'` row is written (precedes G-D), add `CHECK (subject_type IN ('key','tenant','subject'))` to both — a pure add, no ALTER of an existing constraint. `subject_id` there stays `text` (polymorphic); we write `subject.id::text`. Orphan-on-soft-delete is handled at the app layer (reads filter `subject.deleted_at IS NULL`; ledger is source of truth).

### 1.5 Backward-compat guarantee

Every delta is a new nullable column, a new table, a new index, or a partial-unique split that is a strict superset of today for `subject_id IS NULL`. No existing column changes type/nullability; no existing constraint is dropped. All-NULL subjects reproduce today exactly. (The one exception is the chosen `end_user` backfill, decision #9 — see §9 M-Z.)

### 1.6 Unified-person identity layer (decisions #2 + #10 — chosen to build now; lands G-F)

Two link constructs, both mirroring the existing `user_identity` (OAuth) pattern, unify one human across roles/tenants:

- **`subject_identity`** (cross-tenant federation): `id, subject_id → subject, provider text, provider_user_id text, created_at`; unique `(provider, provider_user_id, subject_id)` + index `(provider, provider_user_id)`. Two subjects in different tenants are the same human iff they share `(provider, provider_user_id)`. Works for **Model-A** subjects (OAuth/email login). **Model-B caveat:** a Model-B subject has only an app-owned `external_id`; actionow cannot infer cross-tenant sameness unless the app supplies a global identity — Model-B federation therefore requires the app to pass a shared `(provider, provider_user_id)` (e.g. the company SSO subject). Federation is **resolve-only** (query by shared identity); never a merge of wallets/usage/limits across tenants.
- **`user↔subject` link**: when a `user_identity` and a `subject_identity` share `(provider, provider_user_id)`, the operator (`user`) and the end-user (`subject`) are the same person — surfaced as a resolvable link. Keep the two principals **separate for isolation** (no FK merge; optionally a thin nullable `user_id` on the matching subject for fast lookup).

Both are additive, independent tables; absence = today. This is an **identity-resolution overlay**, NOT a money/permission merge — a person's tenant-A operator rights never grant tenant-B subject spend, and vice-versa. (This honors the 中台 boundary discipline: identity resolution is platform-generic; it does not absorb any product's business logic.)

---

## ② How A and B map onto one model

The `subject` row is identical; the model is decided by _which fields are populated_ and _which resolution path fires_ — **no tenant-level mode flag**.

| dimension              | Model A (platform-owned)                                 | Model B (app-owned)                                                     |
| ---------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| Identity store         | `subject` with `email`/`password_hash` (or OAuth)        | `subject` with `external_id`, no creds                                  |
| End-user auth          | member-JWT (`{sub:subjectId, tenant_id, typ:'subject'}`) | none — the app authenticates the user                                   |
| Data-plane attribution | subject-scoped `api_key`, or member-JWT on data route    | tenant key + `RunBody.end_user`/`external_id` → resolve to `subject.id` |
| Wallet                 | optional `sub_account` (HARD) or pool + caps (SHARED)    | identical                                                               |
| Key issuance           | operator/subject mints subject-scoped key                | operator/app mints subject keys, or stays tenant-keyed + `external_id`  |

Both coexist in one tenant. **Per-product choice:** greenfield product with no auth → A (core IS the user system); product with its own user system → B (just wants wallet/key/quota primitives keyed by `external_id`).

---

## ③ Settlement semantics

### 3.1 Two wallet modes + the single decision point

- **HARD** — subject has an active `sub_account` → hold/settle debit it via the same atomic conditional `UPDATE … WHERE credit_balance - credit_held >= amount AND status='active'`; insufficient → `insufficient_credits` before job creation.
- **SHARED** — no `sub_account` → debit the tenant `account` (today's path); per-subject spend bounded by governance (`subjectType='subject'`) at admission (402/429), not the wallet.

Decision at **hold time**, given `subjectId`: (1) subject + active `sub_account` → debit sub_account; (2) subject, no sub_account → debit tenant account (SHARED); (3) `subjectId` NULL → debit tenant account (today). Settle/`failJob`/refund/top-up read `job.subject_id` and follow the **same branch the hold took**. Async-worker settlement uses the identical path.

### 3.2 Money invariants (fixes folded in)

- **`failJob` cross-tenant fix (baseline, ship first):** add `tenantId` to `FailJobInput`; `WHERE and(eq(account.id, accountId), eq(account.tenantId, tenantId))` (match `settleJob`). Non-breaking; closes a cross-tenant hold-release race today.
- **Sub_account status guard:** HARD hold/release/settle add `eq(sub_account.status,'active')` so a disabled subject's wallet can't be charged/released mid-lifecycle.
- **Sub-wallet shared across the subject's concurrent jobs** (not per-job): hold uses the atomic conditional UPDATE (the WHERE is the gate; a concurrent over-hold fails with `insufficient_credits`); settle only converts an already-held amount, so it **cannot oversell** and needs no settle-time re-read.
- **Streaming = clamp-to-hold (ground-truth in `stream.ts`):** when measured `finalCost > holdAmount`, settle is **clamped to the hold** (platform absorbs the overage); a no-usage abort settles 0 and releases the full hold. Wallet-agnostic. Hold sizing keeps its existing safety margin.
- **`<=1 settle per job` / µ-unit bigint / no-oversell** unchanged — same conditional-UPDATE pattern; the partial unique `ledger_settle_per_job on (job_id) where type='settle'` is per-job, independent of wallet.
- **Ledger survives deletion:** `ledger_txn.subject_id ON DELETE SET NULL`; `usage_log.subject_id` likewise (mirror is best-effort — the ledger is authoritative).

### 3.3 `transferCredits` + per-subject redemption/payment

`transferCredits({tenantId, subjectId, amount, direction})` — one transaction: debit source (atomic conditional UPDATE), credit destination, write **two ledger rows** (`transfer_out`/`transfer_in`, both `subject_id`). **Same-tenant only; immutable** (a mistake is corrected by an opposite transfer). On subject delete, residual sub_account balance is **swept back to the tenant pool** via a transfer. `redeemCode(..., subjectId?)` and `payment_intent.subject_id` + `fulfill` route the credit to the `sub_account` when set, else the tenant account, via the §3.1 branch; both write a `subject_id` ledger row.

---

## ④ Request / auth flows

- **Operator paths UNCHANGED** — `/admin/*` (AdminGuard) + `/console/*` (ConsoleGuard) untouched, except: **reject `typ==='subject'` before any `findUserById`** (defense-in-depth; admin.guard.ts:66-74, console.guard.ts:60-87).
- **Member-JWT (A):** `{sub:subjectId, tenant_id, typ:'subject'}`. New `POST /auth/register-member` + member login: body `{email, password, tenant_id}`; validates tenant; rejects duplicate email _within that tenant_; creates a **`subject`** (never a tenant); issues a member-JWT.
- **Model-B data-plane resolution (the missing chain, added):**
  1. **ApiKeyGuard** (api-key.guard.ts): `ApiKeyContext += {subjectId, subjectLimitPlanId}`. If `record.subject_id` set → load subject, verify `status='active'`, load `subject.limit_plan_id`; attach. NULL → today.
  2. **AuthService.resolve**: `TenantContext += subjectId?`; project `auth.subjectId`.
  3. **RunService.buildRequest**: if `ctx.subjectId` set → use it; else if `RunBody.end_user`/`external_id` present AND key is tenant-level → `resolveOrCreateSubject(tenantId, externalId)` (new `subject-resolver.service.ts`): found → use; not found + JIT on → create; **not found + JIT off → `invalid_input` (NOT 402)** so a paying user is never silently skipped. Set a real `RunRequest.subjectId` field.
  4. **Engine** — thread `subjectId` into `RunRequest`+`TraceContext` and stamp it at EVERY write site (enumerated `[delta]` so none is missed): `createSnapshotJob` (`execution-service.ts:609` → `job.subject_id`), `holdCredits`/`settleJob`/`failJob` (wallet branch), `mirrorUsageLog` (`:762` → `usage_log.subject_id`), `failBlocking` usage row (`:808`), `buildContext`/relay-trace (`relay-trace.ts:14` → `relay_trace.subject_id`), the **reaper** (`reaper.ts`): its `failJob` call (`:35` — **must pass `tenantId`**, see M-0) and its webhook payload (`:45` — add `subject_id`), and the **worker** media persistence (`createFileObject`/`persistMediaResult` → `file_object.subject_id`).
- **Escalation guard (non-negotiable):** in `buildRequest`, before any spend, if `api_key.subject_id` is set AND a resolved `end_user`/`external_id` maps to a _different_ subject → **403**.
- **Subject soft-delete cascade** (one transactional repo fn): `subject.status='disabled'`+`deleted_at`; subject-scoped `api_key` → `status='disabled'`; residual `sub_account` swept to tenant pool (§3.3) + `status='disabled'`; new runs on a disabled subject → 403; in-flight settlement still succeeds; history survives.
- **Async worker** reads `job.subject_id`, calls settle/fail with `subjectId` (same §3.1 branch — single code path).
- **Legacy `register` (new-tenant-per-user) unchanged**; OAuth gains optional tenant context → create subject in that tenant.

### 4b. Read-path subject isolation (non-negotiable — G-B gate) `[delta]`

The escalation guard (above) covers the **spend/run** path only. Every data-plane **read / list / cancel / download** endpoint MUST ALSO scope by subject when `ctx.subjectId` is set — otherwise a subject-scoped key reads, cancels, or downloads **another subject's** data within the same tenant. Today every read repo filters `WHERE tenant_id = ?` only (verified: `listJobs`, `getJobForTenant`, `listFilesByTenant`, `getFileObject`, `listUsageLogsByTenant`, `listIntentsByTenant`).

When `ctx.subjectId` is set, filter `(tenant_id = ? AND (subject_id = ? OR subject_id IS NULL))` — the `OR IS NULL` lets a subject still see tenant-shared rows. A `GET`/`cancel`/`url` on a row owned by a _different_ subject → **404**.

| endpoint                                     | repo (file)                                           | rule                                                                                              |
| -------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /v1/jobs`                               | `listJobs` (job.ts:114)                               | add `subjectId?`; filter                                                                          |
| `GET /v1/jobs/:id`                           | `getJobForTenant` (job.ts:66)                         | `subjectId?`; 404 on mismatch                                                                     |
| `POST /v1/jobs/:id/cancel`                   | `requireOwnedJob` (jobs.controller)                   | verify subject before `failJob`                                                                   |
| `GET /v1/files`, `/:id`, `/:id/url`, confirm | `listFilesByTenant`/`getFileObject` (files.ts:75,102) | `subjectId?`; 404 on mismatch                                                                     |
| `resolveFileInputs` (run)                    | files.service:157                                     | thread `ctx.subjectId` → `getFileObject` (blocks cross-subject `file_id` exfiltration into a run) |
| `presignUpload` (write)                      | files.service:72                                      | stamp `ctx.subjectId` on the new `file_object`; optional `{tenant}/{subject}/{uuid}` S3 key       |
| `GET /v1/payments/intents/:id`               | `getIntent` (payments.controller:90)                  | verify `intent.subject_id == ctx.subjectId` when set → 404                                        |
| `GET /console/usage-log`                     | `listUsageLogsByTenant` (console.service:131)         | `subjectId?` for the deferred end-user console                                                    |

**Prereq:** `TenantContext`/`ApiKeyContext` must carry `subjectId` (§4.1 covers ApiKeyContext hydration; this makes the read-filter _consumption_ explicit). Operator `/console/*` and `/admin/*` endpoints stay tenant-wide by design (the operator sees all subjects); subject-scoping there is only for the deferred end-user console (G-F). **This lands in G-B with subject-scoped keys, before any subject key is issued**, and gets a dedicated isolation test (§8).

---

## ⑤ Governance integration (reconciled against v1)

> The v1 machinery is polymorphic on `(subject_type, subject_id)`, so adding `'subject'` is mostly _enabling an existing path_. The points below **correct/simplify** the original design after reading `main 12cad95`.

**MUST-FIX — plan binds on `subject`, not `sub_account`.** G-D (governance subject dimension) ships **before** G-E (hard sub-wallets), and SHARED-mode subjects have no `sub_account`. Therefore the per-subject `limit_plan_id` lives on the **`subject`** table (§1.1, created in M-1), making governance independent of wallet existence.

**Changes (small):**

- **`resolveEffectiveRules` — no signature change.** It is already called per-single-plan (2nd arg `null`). Add a third **subject** branch where the others are tagged: in `GovernanceGuard.effectiveRules()` (governance.guard.ts:195-222) resolve `auth.subjectLimitPlanId` and push `{subjectType:'subject', subjectId}` rules; in `accrueLimitUsage` (limit.ts:403-408) push a `subject` entry into the existing `subjects[]` (read plan from `subject.limit_plan_id`, fed via `subjectId`). Sparse-write: one bucket per active binding (key if apiKeyId; tenant always; subject only if subjectId≠null) — no triple-write.
- **`enforceCounter` / `enforceConcurrency` — ZERO change.** Redis keys are already `${subjectType}:${subjectId}:${ruleId}` → `subjectType='subject'` yields `gl:rpm:subject:…` / `gl:conc:subject:…` for free.
- **`getUsage` / `incrUsage` — ZERO change** (text-polymorphic `UsageKey`).
- **`windowedUsage`** (limit.ts:276) — extend the binary `subjectCol` ternary to a third arm `usageLog.subjectId` (needs `usage_log.subject_id`, added M-2).
- **`limitRuleStatus`** (limit.ts:486) — accept `subjectType='subject'` for the `/app` budget view.
- **Usage rollup + analytics filter** `[delta]` — add `'subject'` to `UsageRollupQuery.groupBy` (usage.ts:122) + a `subject` case in `bucketExpr` (`coalesce(subject_id::text,'unknown')`) + a `subjectId?` _filter_ predicate (the spec previously named only `groupBy:'subject'`, not the filter/DTO wiring); add `subjectId` to the console + admin analytics DTOs (console.dto.ts:34, admin.dto.ts:176) and thread through. Fix `/admin/limits/status` (admin.controller.ts:924) which today coerces `subjectType` to `key`/`tenant` — accept `'subject'`.
- **CHECK** — §1.4 (purely additive, precedes G-D).

**`rulesCache` refactor (avoid Model-B bloat).** The guard caches _already-scoped_ rules by `${apiKeyId}:${tenantId}` (governance.guard.ts:196). With subjects the cache key must include `subjectId`, but a tenant-level key serving thousands of subjects (Model B) would bloat this **unbounded in-process Map**. Fix: **cache `plan→rules` by `planId`** (with the 15s TTL) and do the cheap subject-tagging per request — bounded by plan count, not subject count.

**Alert fan-out.** `limit_alert` + the `limit.alert` webhook will now fire per subject. To avoid alert storms with many end-users: subject-level crossings are **row-only by default**; the webhook stays at tenant/key granularity (or add a per-tenant suppression/aggregation toggle).

**Unchanged & reused as-is:** `limit_plan`/`limit_rule` structure, bindings (`setApiKeyLimitPlan`/`setTenantLimitPlan` + a new `setSubjectLimitPlan`), day/month/total materialization vs rolling-over-`usage_log`, 402/429 semantics, "no plan = unlimited" backward compat.

---

## ⑥ Contracts / SDK

zod views/DTOs: `subjectView`, `subAccountView`; `apiKeyView += subject_id?`; `createSubject`/`updateSubject`/`createSubjectApiKey`/`topupSubAccount`/`transferCredits`/`setSubjectLimitPlan`; `createApiKey += subjectId?`; `RunBody += external_id?`; `runResponse`/`runJobView += subject_id?`; webhook payload documents `subject_id`(+`external_id`). **Also add `subject_id` `[delta]` to the admin ops-views** (`jobView`, `ledgerView`, `usageLogView` in `ops-views.ts`) + their `toXyzView` mappers, the console usage-log view, and the **file view** (when `file_object.subject_id` lands). → `gen:openapi` → `@actionow/sdk gen`. Money stays decimal strings; uniform error envelope; keyset pagination.

## ⑦ Frontend (apps/web)

- **Operator end-user hub** (new `AppUsers` page + routes): per-tenant list/create/detail of subjects; per-subject top-up + key mint/rotate; bind a `limit_plan` to a subject; toggle HARD/SHARED. (`L`)
- **Auth:** `AuthProvider`/jwt claims `+= tenant_id?, subjectId?, typ?`; `AuthPage` join mode `?joinTenant=CODE` → `register-member`. (Optional) an end-user self-service console for Model-A subjects (later, G-F).
- `consoleApi`/types + i18n (en/zh-CN); `AppKeys` optional subject dropdown when minting.

## ⑧ Testing

- **DB:** subject CRUD + soft-delete cascade; `sub_account` hold/settle **no-oversell + status guard**; **`failJob` cross-tenant rejected**; NULL subject == unchanged; ledger/usage subject attribution; idempotency per-subject; accrual **sparse-write count**; `transferCredits` two-row + same-tenant-only.
- **Guard:** subject-scoped rules enforced; **subject cache-key isolation** + plan-by-id caching; **escalation 403**; **admin/console reject `typ:'subject'`**; no-subject path identical to today.
- **Engine/run:** Model-B resolve (found / JIT-on create / JIT-off `invalid_input`); subject threaded to job/usage/ledger/webhook/trace.
- **Read-path isolation (§4b)** `[delta]`: a subject-scoped key calling `GET /v1/jobs` / `/v1/files` / `/v1/payments/intents/:id` sees ONLY its own (or NULL) rows; cross-subject `GET`/`cancel`/`url`/`confirm` → 404; `resolveFileInputs` rejects another subject's `file_id`.
- **Live-verify (preview):** two subjects under one tenant with different caps/wallets; one exhausts → 402; cross alert_pct → row (+ webhook policy).

## ⑨ Migration sequence (additive/nullable-first, forward-only)

- **M-0** (baseline, no subjects): `failJob` tenant-scoping (code only). Ships independently.
- **M-1**: `subject` (incl. `limit_plan_id`) + its indexes/checks.
- **M-2**: nullable `subject_id` (+ idx, `ON DELETE SET NULL`) on `api_key, job, ledger_txn, usage_log, webhook_outbox, relay_trace, redemption_code, payment_intent, file_object` (`file_object` added `[delta]`).
- **M-2a**: idempotency unique-index split (§1.3).
- **M-2b** `[delta]`: `payment_event.tenant_id` (snapshot, `ON DELETE SET NULL`) so audit events stay scopable after the intent is deleted.
- **M-3**: `sub_account`.
- **M-3a** (precedes G-D): `CHECK subject_type IN ('key','tenant','subject')` on `limit_usage`+`limit_alert`.
- **M-X** `[delta]` (before G-C): `config jsonb notNull default '{}'` on `tenant` (carries `jit_provisioning_enabled`, decision #1) and `account` (carries `wallet_mode` default, decision #3).
- **M-Y** `[#2/#10]` (G-F): `subject_identity` (provider, provider_user_id; §1.6) + the `user↔subject` resolution (shared-identity lookup, optional nullable `subject.user_id`).
- **M-Z** `[#9]` (G-C): one-time backfill — for each distinct `(tenant_id, job.end_user)` where `end_user IS NOT NULL`, create a Model-B `subject` (`external_id = end_user`) and set `job.subject_id`; then mark `job.end_user` **deprecated** (kept only as the data-plane INPUT alias for `external_id`; the internal column is retired in a later migration once nothing reads it).

Every step **except M-Z** is reversible by drop with no backfill / no column rewrite / no nullability tightening. M-Z is the one (idempotent) data backfill, gated, and reversible by nulling the backfilled `job.subject_id`.

## ⑩ Phased rollout (G-series)

1. **G-A · baseline + primitive + admin CRUD (FIRST SHIPPABLE).** M-0 failJob fix (**repo `settle.ts:122` AND the `reaper.ts:35` call site** `[delta]`); M-1+M-2 (columns written nowhere yet); subject repos (incl. cascade) + `subject-resolver` (JIT OFF); `POST/GET/PATCH/DELETE /admin/tenants/:id/users` + contracts + SDK; `AppUsers` list/create/disable; **`seed-demo.ts` seeds demo subjects + subject-scoped keys** `[delta]` for end-to-end demoability. **Ships:** operators manage end-users; zero data-plane/money change; the cross-tenant bug fixed.
2. **G-B · subject-scoped keys + attribution + read isolation (read-only money).** `api_key.subject_id` + `file_object.subject_id`; guard hydration + AuthService propagation (incl. `TenantContext.subjectId`); `job/usage_log/ledger/relay_trace/webhook/file_object.subject_id` written but still debiting the tenant pool. **Escalation guard + typ-check + read-path subject isolation (§4b) all land here** `[delta]` (security precedes any subject-routed spend) — read isolation MUST land before any subject key is issued. Per-end-user usage reporting (`groupBy:'subject'` + `subjectId` filter).
3. **G-C · Model-B resolution.** `external_id`/`end_user` → resolver (+JIT flag, unknown→`invalid_input`); per-subject idempotency. **`job.end_user` → subjects backfill (M-Z) + deprecation** `[#9]`: `end_user` stays an accepted data-plane INPUT (alias for `external_id`) while `subject_id` becomes canonical; historical `end_user` labels become Model-B subjects.
4. **G-D · governance subject dimension.** Requires M-3a. Subject plan on `subject.limit_plan_id`; guard `effectiveRules` + accrual subject branch; `windowedUsage`/`limitRuleStatus`; rulesCache→by-planId refactor; alert-fanout policy. **Per-end-user spend/rate caps on the shared pool — before any sub-wallet.**
5. **G-E · hard sub-wallets.** M-3 `sub_account`; hold/settle/fail/topUp branching (status-guarded); `transferCredits`; per-subject redemption + payment-intent routing; async-worker path.
6. **G-F · Model-A member auth + console + identity layer.** `register-member`/member-JWT, OAuth tenant context, frontend join-mode + end-user self-service; **`subject_identity` cross-tenant federation + `user↔subject` linking (M-Y, §1.6)** `[#2/#10]`.

Order: **fix → identity → secure attribution → governance (cap pool) → hard wallet → login.** Riskiest money change (G-E) lands after attribution + governance are proven; security guards land with the first spend-routing increment (G-B).

---

## Resolved decisions (Q&A 2026-06-24)

| #   | decision               | resolution                                                                                                                                            |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | JIT provisioning       | **OFF by default; opt-in per TENANT** (`tenant.config.jit_provisioning_enabled`, M-X); unknown `external_id` → `invalid_input`                        |
| 2   | subject identity scope | **per-tenant-unique email + BUILD cross-tenant federation now** (`subject_identity`, §1.6, G-F) — _deviates from defer_                               |
| 3   | default wallet mode    | **SHARED** (tenant pool + per-subject governance caps); HARD opt-in per subject (`account.config.wallet_mode`)                                        |
| 4   | subject soft-delete    | **disable keys + sweep residual `sub_account` → tenant pool + in-flight settle still succeeds + history retained**                                    |
| 5   | `transferCredits`      | **same-tenant only + immutable** (correct via reverse transfer)                                                                                       |
| 6   | `external_id`          | **immutable after creation**; relink only via an explicit audited op                                                                                  |
| 7   | member-JWT             | **`typ:'subject'`**; Admin/Console guards reject it                                                                                                   |
| 8   | alert fan-out          | **subject crossings row-only; `limit.alert` webhook stays tenant/key**                                                                                |
| 9   | `job.end_user`         | **deprecate + backfill `subject_id`** (M-Z) — `end_user` kept only as the data-plane INPUT alias, `subject_id` canonical — _deviates from dual-write_ |
| 10  | `user↔subject` link    | **BUILD now** (§1.6, G-F) — _deviates from defer_                                                                                                     |

**Three deviations from the recommended defaults (#2, #9, #10)** expand scope into a **unified-person identity layer** (cross-tenant federation + operator↔end-user resolution) and a **one-time `end_user`→subject backfill**. All land late (G-C/G-F) and do **NOT** affect the G-A first increment. See §1.6 and §9 (M-Y, M-Z).

**Watch-outs carried into the plan:** (a) #9 — `end_user` is a **public data-plane field** (`RunBody`/`runJobView`); keep accepting it as an input alias for `external_id` so SDK consumers don't break; only the _internal_ column is retired. (b) #2 — **Model-B cross-tenant federation needs an app-supplied global identity**; actionow cannot infer sameness from `external_id` alone.

## Appendix — adversarial + completeness findings → resolution

| finding                                                                                       | sev          | resolved in                                    |
| --------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------- |
| `failJob` cross-tenant hold release                                                           | critical     | §3.2, M-0, G-A                                 |
| Model-B resolver chain absent                                                                 | critical     | §4                                             |
| Escalation guard missing                                                                      | critical     | §4, G-B                                        |
| Streaming settle vs hold-clamp contradiction                                                  | critical     | §3.2 (clamp documented)                        |
| Subject JWT indistinguishable from operator                                                   | high         | §4 (typ-check)                                 |
| Governance lacks 'subject' dimension                                                          | high         | §5, G-D                                        |
| ApiKeyGuard/AuthService no subject hydration                                                  | high         | §4                                             |
| sub_account no status guard                                                                   | high         | §3.2                                           |
| subject plan binding location (sub_account before it exists)                                  | high         | §5 MUST-FIX (`subject.limit_plan_id`)          |
| `subject_type` orphan / no constraint                                                         | high         | §1.4 (M-3a)                                    |
| sub-wallet mid-flight race                                                                    | high         | §3.2 (shared, atomic hold, no settle re-check) |
| idempotency missing subject dimension                                                         | high         | §1.3, M-2a                                     |
| webhook/relay-trace/redemption/payment no subject                                             | high/med     | §1.3, §3.3, §4                                 |
| rate-limit Redis keys no subject                                                              | high         | §5 (free — already parameterized)              |
| usage rollup no 'subject' groupBy                                                             | high         | §5, §6                                         |
| accrual no subject / duplication risk                                                         | high         | §5 (sparse-write)                              |
| rulesCache bloat (Model-B many-subjects-one-key)                                              | high         | §5 (cache by planId)                           |
| alert fan-out storm                                                                           | med          | §5, decision 8                                 |
| `job.end_user` vs `subject_id` ambiguity                                                      | med          | §4 (dual-write, subject_id canonical)          |
| async worker not subject-scoped                                                               | med          | §4                                             |
| `transferCredits` undefined                                                                   | med          | §3.3                                           |
| **read-path subject isolation absent (reads/cancel/download leak across subjects)** `[delta]` | **critical** | **§4b, §8, G-B**                               |
| `file_object` missing `subject_id` (asset attribution + read leak) `[delta]`                  | high         | §1.3, M-2, §4b                                 |
| `payment_event` has no tenant/subject scope `[delta]`                                         | high         | §1.3 note, M-2b                                |
| reaper `failJob` call (no tenantId) + webhook payload (no subject_id) `[delta]`               | high         | §4 item 4, §10 G-A                             |
| usage rollup `subjectId` filter + analytics DTOs not enumerated `[delta]`                     | med          | §5, §6                                         |
| `/admin/limits/status` coerces away `'subject'` `[delta]`                                     | med          | §5                                             |
| JIT / wallet-mode flag has no storage column `[delta]`                                        | med          | §9 M-X, decision 1                             |
| seed has no subjects (demoability) `[delta]`                                                  | med          | §10 G-A                                        |
