# 多租户终端用户 (Unified Tenant End-User · A+B) — 开发路线图 / Program Roadmap

> **This is a ROADMAP, not a task-by-task plan.** Per `superpowers:writing-plans` Scope Check, the spec decomposes into **7 independently shippable increments**; each G-phase gets its OWN bite-sized TDD plan (`docs/superpowers/plans/2026-06-24-unified-tenancy-G<X>-*.md`) written when that phase is ready. This file sequences them, sizes them, and sets the acceptance gates.

**Spec:** [`2026-06-24-unified-tenant-enduser-ab-design.md`](../specs/2026-06-24-unified-tenant-enduser-ab-design.md) (Proposed; 10 decisions resolved; completeness-audited).

**Goal:** push wallet + api-key + governance down to each end-user (`subject`) within a tenant, supporting platform-owned (A) and app-owned (B) identity in one model — shipping value at every step with zero behavior change for existing tenant-level traffic.

**Tech stack:** NestJS (apps/api), Drizzle/Postgres (packages/db), Redis (`@actionow/infra`), zod→openapi→`@actionow/sdk` (packages/contracts), engine (packages/engine), React/Vite (apps/web).

---

## 0. The single invariant (holds at EVERY increment)

> **`subject_id IS NULL` ⇒ today's exact behavior.** Every column is nullable, every migration additive (only exception: the gated `end_user` backfill M-Z in G-C). At any phase you can stop and the platform behaves as it does today for all existing tenants/keys. This is the acceptance precondition for merging any phase.

Money invariants preserved throughout: µ-unit bigint, no oversell via atomic conditional UPDATE, ≤1 settle per job, ledger = source of truth.

## 1. Sequencing rationale

**fix → identity → secure attribution → governance (cap the pool) → hard wallet → login + identity layer.**

The riskiest money change (hard sub-wallets, G-E) lands only after attribution (G-B) and governance (G-D) are proven in production. Security guards (escalation 403, `typ` reject, **read-path isolation §4b**) land in G-B — _with the first subject-scoped key_, never after. Identity-graph features (federation, user↔subject) land last (G-F) because they're an overlay on a working system.

## 2. Increment map

| #       | Increment                                              | Ships (user-visible value)                                                              | Migrations  | Size   | Depends on              |
| ------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------- | ----------- | ------ | ----------------------- |
| **M-0** | failJob tenant-scope fix                               | closes a cross-tenant hold-release race (today)                                         | none (code) | **S**  | —                       |
| **G-A** | subject primitive + admin CRUD                         | operators create/list/disable end-users; **zero data-plane/money change**               | M-1, M-2    | **L**  | M-0                     |
| **G-B** | subject-scoped keys + attribution + **read isolation** | per-end-user keys + per-end-user usage reporting; **security: reads scoped to subject** | M-2a        | **XL** | G-A                     |
| **G-C** | Model-B resolution + end_user backfill                 | apps attribute by `external_id` w/o per-user keys; history → subjects                   | M-X, M-Z    | **M**  | G-B                     |
| **G-D** | governance subject dimension                           | per-end-user spend/rate caps on the shared pool                                         | M-3a        | **M**  | G-B (G-C optional)      |
| **G-E** | hard sub-wallets                                       | prepaid per-end-user balances + transfers + topup routing                               | M-3, M-2b   | **L**  | G-D                     |
| **G-F** | member auth + identity layer                           | end-user login/console + cross-tenant federation + user↔subject                         | M-Y         | **L**  | G-A (G-E for wallet UI) |

Rough order of magnitude: S≈½d, M≈2–4d, L≈1–2wk, XL≈2–3wk (one engineer; backend+frontend+tests). G-B is the heaviest because it carries the security-critical read-path isolation across every data-plane read endpoint.

---

## 3. Per-increment detail (task groups)

> Each group below becomes a set of bite-sized TDD tasks in that phase's plan. File refs are from the spec §6 change inventory + the completeness audit.

### M-0 · failJob baseline fix (`S`, independent)

- **DB:** `failJob` (`settle.ts:112-122`) — add `tenantId` to `FailJobInput`; `WHERE and(eq(account.id), eq(account.tenantId))` (match `settleJob:65`).
- **Engine:** the **reaper call site** (`reaper.ts:35`) must pass `tenantId` (audit found the spec's M-0 prose missed this).
- **Test:** cross-tenant failJob rejected (0 rows); same-tenant releases hold.
- **Gate:** existing settle/fail e2e green; new isolation test passes.
- _Note:_ the spawned task chip (`task_c2f9b915`) covers the repo half; fold the reaper call site in here.

### G-A · subject primitive + admin CRUD (`L`) — FIRST FEATURE INCREMENT

- **DB / migrations:** **M-1** `subject` table (incl. `limit_plan_id`, per-tenant unique email+external_id partial indexes, status check); **M-2** nullable `subject_id` (+idx, `ON DELETE SET NULL`) on `api_key, job, ledger_txn, usage_log, webhook_outbox, relay_trace, redemption_code, payment_intent, file_object`.
- **Repos:** subject CRUD (`create/find{ById,ByExternalId,ByEmail(tenant)}/update/softDeleteSubject` incl. cascade scaffold); `subject-resolver.service.ts` (resolve-by-external_id only; **JIT OFF** — created, not yet wired to runs).
- **API:** `POST/GET/PATCH/DELETE /admin/tenants/:id/users` (operator CRUD) + guard wiring.
- **Contracts/SDK:** `subjectView`, `createSubject`, `updateSubject` → `gen:openapi` → SDK.
- **Frontend:** `AppUsers` page (list/create/disable; money read-only) + route + nav + i18n.
- **Seed:** `seed-demo.ts` seeds demo subjects (and subject-scoped keys placeholder for G-B).
- **Gate:** operators manage end-users end-to-end in preview; **every data-plane/money path unchanged** (all `subject_id` NULL); M-0 fix included.

### G-B · subject-scoped keys + attribution + read isolation (`XL`) — SECURITY-CRITICAL

- **DB:** `api_key.subject_id` write path; `file_object.subject_id`; **M-2a** idempotency unique-index split.
- **Auth:** `ApiKeyContext += {subjectId, subjectLimitPlanId}` hydration (`api-key.guard.ts`); `TenantContext += subjectId` (`auth.service.ts`); **Admin/Console guards reject `typ:'subject'`**.
- **Engine attribution (enumerated write sites):** `createSnapshotJob` (`:609`), `mirrorUsageLog` (`:762`), `failBlocking` (`:808`), `buildContext`/relay-trace (`relay-trace.ts:14`), reaper webhook payload (`:45` add `subject_id`), worker `createFileObject`/`persistMediaResult`.
- **🔴 Read-path isolation (§4b — the gate):** thread optional `subjectId` into `listJobs`/`getJobForTenant`/`requireOwnedJob`, `listFilesByTenant`/`getFileObject`/`requireFile`, `resolveFileInputs`, `getIntent` (payments); filter `(tenant_id AND (subject_id=? OR IS NULL))`, **404 on cross-subject**; `presignUpload` stamps `subject_id`.
- **Escalation guard:** `buildRequest` — subject-scoped key + a conflicting resolved subject → **403**.
- **Analytics:** `UsageRollupQuery` += `'subject'` groupBy + `subjectId` filter (`usage.ts:122,149`); console/admin analytics DTOs += `subjectId`.
- **Contracts/SDK:** `apiKeyView`+`jobView`+`ledgerView`+`usageLogView`+file view `+= subject_id`; `createSubjectApiKey`.
- **Gate (NON-NEGOTIABLE):** isolation test suite — a subject A key CANNOT read/list/cancel/download subject B's jobs/files/intents; this MUST pass before any subject-scoped key is issued in any environment.

### G-C · Model-B resolution + end_user backfill (`M`)

- **DB:** **M-X** `config jsonb` on `tenant` (`jit_provisioning_enabled`) + `account` (`wallet_mode`); **M-Z** one-time backfill (distinct `(tenant_id, end_user)` → Model-B subject `external_id=end_user`; set `job.subject_id`; idempotent, gated, reversible by nulling).
- **Run path:** `buildRequest` wires `RunBody.end_user`/`external_id` → `resolveOrCreateSubject` (JIT gated by `tenant.config`; unknown + JIT off → `invalid_input`); per-subject idempotency (`claimIdempotency += subjectId`).
- **Contract care (#9 watch-out):** `end_user` STAYS an accepted data-plane input (alias for `external_id`); `subject_id` becomes canonical; internal `job.end_user` column marked deprecated (dropped in a later migration once unread). **Do not remove the public field.**
- **Gate:** app passes `external_id` on a tenant key → spend attributed to the right subject; unknown id with JIT off → `invalid_input`; backfill idempotent + reversible verified.

### G-D · governance subject dimension (`M`)

- **DB:** **M-3a** `CHECK subject_type IN ('key','tenant','subject')` on `limit_usage`+`limit_alert` (additive).
- **Governance:** guard `effectiveRules()` + `accrueLimitUsage.subjects[]` add a `subject` branch (plan from `subject.limit_plan_id`); `windowedUsage`/`limitRuleStatus` accept `'subject'`; **`rulesCache` → cache plan-rules by `planId`** (avoid Model-B per-subject bloat); `/admin/limits/status` accept `'subject'`.
- **Alerts (#8):** subject crossings row-only; `limit.alert` webhook stays tenant/key.
- **Bindings:** `setSubjectLimitPlan` + operator UI to bind a plan to a subject; `/app` budget view per subject.
- **Gate:** a per-subject spend/rpm cap rejects (402/429) on the shared pool without a sub-wallet; key+tenant caps still AND-combine; no-subject path identical to today.

### G-E · hard sub-wallets (`L`)

- **DB:** **M-3** `sub_account`; **M-2b** `payment_event.tenant_id`.
- **Settlement:** `holdCredits`/`releaseHold`/`settleJob`/`failJob`/`topUp` branch to `sub_account` (status-guarded) when subject has one, else tenant pool; `sub-account.ts` (`createSubAccount`, `topupSubAccount`, **`transferCredits`** same-tenant+immutable+two-ledger-rows); redemption + payment-intent routing; async-worker settle path reads `job.subject_id`.
- **Frontend:** per-subject top-up + balance + transfer UI on the subject detail page.
- **Gate:** HARD subject hold/settle no-oversell + status guard; SHARED unaffected; transfer two-row + same-tenant-only; soft-delete sweeps residual to pool (decision #4).

### G-F · member auth + identity layer (`L`)

- **Auth (A):** `POST /auth/register-member` + member login → member-JWT (`typ:'subject'`); OAuth gains optional tenant context → subject in that tenant; legacy `register` unchanged.
- **Identity layer (#2/#10, M-Y):** `subject_identity` (provider, provider_user_id) cross-tenant federation (resolve-only); `user↔subject` resolution via shared identity (optional nullable `subject.user_id`). **Overlay only — never merges money/permissions.** Model-B federation requires app-supplied global identity.
- **Frontend:** `AuthPage` join-mode (`?joinTenant=CODE`); end-user self-service console (subject-filtered, reusing G-B read-isolation).
- **Gate:** a member logs into product A; the same SSO human is resolvable across products A/B and as operator↔end-user — with zero cross-role privilege/money bleed.

---

## 4. Cross-cutting concerns (apply to every phase plan)

- **Backward-compat test in every phase:** a tenant with no subjects behaves byte-for-byte as before (regression suite stays green).
- **Read-path isolation is a recurring gate** from G-B onward: any NEW read endpoint touching subject-owned data must filter by subject.
- **Contract discipline:** money-as-string, uniform error envelope, keyset pagination; regenerate SDK whenever contracts change.
- **The 3 deviation watch-outs:** (#9) keep `end_user` as a public input alias — don't break SDK consumers; (#2) Model-B federation needs app-supplied global identity; (#2/#10) identity layer is resolve-only, never a money/permission merge.
- **Live-verify each phase** in preview per the spec §8, not just unit tests.

## 5. Dependency graph

```
M-0 ──► G-A ──► G-B ──┬─► G-C ──┐
                      ├─► G-D ──┴─► G-E ──► G-F
                      └──────────────────► (G-F member auth needs only G-A;
                                            its wallet UI needs G-E)
```

- G-C and G-D both depend on G-B; they are **independent of each other** (can be built in either order or in parallel).
- G-E depends on G-D (governance proven before hard money).
- G-F member-auth depends only on G-A; its identity-layer (M-Y) is independent; its end-user wallet console wants G-E.

## 6. Parallelism within a phase

- Backend (DB+repos+API) and frontend can proceed in parallel once the contract (zod views) for that phase is fixed first.
- G-B's read-isolation work (jobs / files / payments) splits cleanly into 3 parallel tracks behind the shared `ctx.subjectId` plumbing.

## 7. Relationship to other work

- **Governance v1 (#30)** already shipped — it's the polymorphic foundation G-D enables (not rebuilds).
- **failJob chip** (`task_c2f9b915`) = the repo half of M-0; G-A folds in the reaper call site.
- This sits in the **计费与路由 family** (memory `billing-routing-governance`) as the tenancy foundation; the records/audit, RBAC, resilience-2.0, routing-depth sub-projects remain separate specs.

---

## 8. Next step

Write the **detailed bite-sized TDD plan for G-A** (the first feature increment) → `docs/superpowers/plans/2026-06-24-unified-tenancy-GA-*.md`, then execute via `superpowers:subagent-driven-development`. Subsequent phase plans (G-B…) are written just-in-time, each after the prior phase merges, so they reflect what was learned.
