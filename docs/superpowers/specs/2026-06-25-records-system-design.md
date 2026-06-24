# 记录系统 (Records: audit_log + ledger integrity) v1 — Design Spec

> Second sub-project of 计费与路由 (after ① 治理与额度 v1, #30). Builds the **system of record** named in [monetization-strategy] as the only real moat: a tamper-evident **who-changed-what** trail over money/governance/identity, plus the records-integrity debt the unified-tenancy (subject) work left behind. Scope frozen 2026-06-25: `subject` is an attribution + governance dimension only.

## Context — what already exists (build on, don't duplicate)

- `ledger_txn` is the spend **source of truth** (append-only; `type ∈ {topup,settle,…}`, `credits_delta`, `balance_after`, `job_id`, `subject_id`). Atomic hold (on `account.credit_held`) + idempotent settle exist. **Today only `settle` + `topup` rows are actually written**; holds/refunds/transfers/sub-wallet moves are not yet explicit ledger rows.
- Auth actors: operator = `req.admin.adminId` (`AdminContext`, AdminGuard); tenant self/member = `req.console.userId` (`ConsoleContext`, ConsoleGuard). Member (end-user) tokens are rejected on operator/console guards.
- Subjects + sub-wallets exist (PR #31): `subject`, `sub_account` (HARD wallet), `subject_id` on ~9 attribution tables. `payment_intent` already has `tenant_id` + `subject_id`.

## Scope (v1)

**IN:** (A) `audit_log` — actor-attributed records of **money + governance + identity mutations**; (B) records-integrity debt: `payment_event.tenant_id`, surface `subject_id` on Job/Ledger/UsageLog views, subject soft-delete **cascade**; (C) a **reconcile** read (ledger Σ vs balance) + operator audit-log UI.

**OUT (deferred to records v2, noted to avoid scope creep):** full double-entry ledger refactor (explicit signed hold/refund/transfer/giftcode rows + a scheduled reconcile job); per-tenant audit export/retention; member-facing audit view. `audit_log` records the **action + actor + intent**, it does NOT duplicate the financial `ledger_txn`.

## ① audit_log (the moat)

New append-only table `audit_log` (no `updated_at`):

| col         | type         | note                                                                                                                     |
| ----------- | ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| id          | uuid pk      |                                                                                                                          |
| created_at  | timestamptz  | default now                                                                                                              |
| actor_type  | text         | `operator` \| `member` \| `system`; CHECK                                                                                |
| actor_id    | text \| null | adminId / userId / null for system                                                                                       |
| tenant_id   | uuid \| null | scope (null = platform-level); index                                                                                     |
| subject_id  | uuid \| null | end-user scope when applicable; index                                                                                    |
| action      | text         | dotted verb, e.g. `tenant.topup`, `limit_plan.update`, `subject.delete`                                                  |
| target_type | text         | `tenant`\|`account`\|`api_key`\|`limit_plan`\|`subject`\|`sub_account`\|`model_grant`\|`payment`                         |
| target_id   | text \| null | the affected row id                                                                                                      |
| meta        | jsonb        | compact, non-secret params (amount µ, planId, before/after status, cascade counts, reason). NEVER credentials/plaintext. |
| request_id  | text \| null | correlation id when available                                                                                            |

Indexes: `(tenant_id, created_at desc)`, `(subject_id, created_at desc)`, `(action)`. Append-only (immutable). Subject/tenant FKs `ON DELETE SET NULL` (records survive deletion — the whole point).

**Repo** (`packages/db/src/repositories/audit.ts`): `appendAuditLog(db, input)` (best-effort, never throws into the caller's txn — wrap failures, log); `listAuditLog(db, filter, page)` keyset on `(created_at,id)` with filters `{tenantId?, subjectId?, actorType?, action?, targetType?, from?, to?}`.

**Emission** — a thin `AuditService` (`apps/api/src/audit/audit.service.ts`) injected into the admin + console controllers; emit AFTER a successful mutation, actor from the guard context. Sites:

- **operator (AdminController, actor=operator):** tenant create/update; account create/topup; api-key create/revoke/group-bind/limit-plan-bind; limit-plan create/update/delete; subject create/update/delete; sub-wallet open/topup/transfer; model grant/revoke.
- **member/self (ConsoleController, actor=member):** console api-key create/rotate/delete; self topup; change-password (action only, never the password).
- **system:** JIT subject provisioning; subject soft-delete cascade effects.

Emission is best-effort and out of the money txn: an audit write failing must NOT roll back or fail the underlying mutation (record-and-continue; log the failure).

## ② records-integrity debt (make the existing ledger trustworthy/scopable)

- **`payment_event.tenant_id`** (+ `subject_id`) snapshot columns (migration), set at `insertEventIfNew` from the resolved intent, so a payment audit event stays scopable after an intent is pruned (`payment_intent_id` is `ON DELETE SET NULL`). Mapper + admin payments view updated.
- **`subject_id` on views:** add to `JobView`, `LedgerView`, `UsageLogView` (+ the console equivalents) and the repo projections that hydrate them, so the ledger "source of truth" is visible per end-user in the UI.
- **Subject soft-delete cascade:** `softDeleteSubject` becomes transactional — (a) sweep any residual `sub_account` balance back to the tenant pool via the existing `transferCredits` (writing a ledger row), (b) disable the subject's subject-scoped api keys, (c) flip `deleted_at`/`status`. Emits a `subject.delete` audit with cascade meta (sweptMicro, disabledKeys).

## ③ reconcile + UI

- **Reconcile read** `GET /admin/records/reconcile?tenantId=` → per account (+ sub_accounts): `{ balance, ledgerSum, drift }` where `ledgerSum` = Σ`credits_delta`. Drift ≠ 0 flags an integrity break (today it can be non-zero because holds aren't ledgered — v1 documents this as expected for `hold`-class drift; the value is the operator signal, full zero-drift is a v2 double-entry goal).
- **Audit-log endpoint** `GET /admin/audit-log` (filters above, keyset). Contract `auditLogViewSchema`. Consumed via `rawClient` (admin route, not in SDK path set — matches limit-plan precedent).
- **Frontend:** a 审计日志 (audit log) page under a new **记录 (records)** nav group (or appended to 运营), a filterable `DataTable` (time, actor, action, target, tenant/subject, meta). Surface the new `subject_id` on the tenant-drawer ledger/jobs tabs and `/app` usage. i18n zh-CN + en.

## ④ Testing

- **Repo:** `audit.int` (append + keyset list + every filter); `payment_event.tenant_id` set on insert; soft-delete cascade (sweep sub-wallet → pool ledger row + keys disabled + audit row).
- **Service/guard:** emission writes the right actor/action/target for a representative operator mutation + a console mutation; an audit-write failure does NOT fail the mutation.
- **Contracts:** `auditLogViewSchema` + the `subject_id`-extended Job/Ledger/UsageLog view fixtures.
- **Regression:** existing settle/topup/admin-crud/provision e2e stay green (additive only).

## ⑤ Migration & rollout

Additive migrations only: `audit_log` (new table); `payment_event.tenant_id`+`subject_id` (nullable). No backfill — audit starts recording from deploy; `subject_id` on views reads existing nullable columns. Zero behavior change to money paths (audit is side-effect, out-of-txn).

## Phases (one branch `feat/records-audit-log`, phased commits → one PR → squash-merge)

1. **R1 schema+repo:** `audit_log` + `appendAuditLog`/`listAuditLog`; `payment_event.tenant_id`/`subject_id`; migrations; db int tests.
2. **R2 AuditService + operator emission:** wire into AdminController money/governance/identity mutations.
3. **R3 member emission + soft-delete cascade:** ConsoleController emits; transactional subject cascade (sweep+disable+audit) + tests.
4. **R4 contracts + read endpoints:** `auditLogViewSchema`, `GET /admin/audit-log`, `GET /admin/records/reconcile`, `subject_id` on Job/Ledger/UsageLog (+console) views/mappers/repos; web api helpers.
5. **R5 frontend:** 审计日志 page + 记录 nav + subject_id surfacing + i18n; live-verify.
6. **R6 gate:** full typecheck/lint/tests; memory update; PR → squash-merge.
