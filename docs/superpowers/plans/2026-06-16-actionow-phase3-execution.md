# Actionow Phase 3 — Execution Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. `- [ ]` steps. TDD; integration tests use Testcontainers (Docker is up; random ports).

**Goal:** Build the runtime spine (§4/§5/§9.4): atomic ledger IO (hold/settle/release) + job/idempotency repositories in `@actionow/db`, the `ExecutionService` orchestration + async `JobRunner` in a new `@actionow/engine` package, the webhook outbox dispatcher + HMAC signing + orphan-hold reaper, and the `apps/api` `/v1/run` + `/v1/jobs` endpoints and `apps/worker` processors. The review's correctness fixes (#3 routing, #10 atomic hold, #11 settle dedup + transactional outbox, #12 reaper, idempotency) are implemented here.

**Architecture:** Pure domain functions (Phase 1) are _called_ by IO code. `@actionow/db` owns multi-table atomic transactions (drizzle). New `@actionow/engine` orchestrates: `validateInputs` → `quote`+modifiers → `holdCredits` → `createJob` (frozen snapshot) → blocking (route → adapter.submit → `settleJob`) or async (enqueue → worker `JobRunner` → `settleJob`). `apps/api` and `apps/worker` are thin layers over `engine`.

**Tech Stack:** NestJS 11, Drizzle (orm 0.45.2), BullMQ, ioredis, `node:crypto` HMAC, Vitest + Testcontainers.

**Source spec:** `docs/superpowers/specs/2026-06-16-actionow-backend-scaffold-design.md` — §4.1–4.4 (run/jobs/webhook/SSE), §4.7 (errors), §5 (state machine), §9.4 (quote/hold/settle), §10 (data model).

---

## New package: `@actionow/engine`

Add `packages/engine` mirroring an existing package's shape (`package.json` `@actionow/engine`, `tsconfig.json` + `tsconfig.build.json`, `src/index.ts`, vitest). Deps: `@actionow/contracts`, `@actionow/domain`, `@actionow/db`, `@actionow/adapters`, `@actionow/infra` (+ bullmq, ioredis as needed). **Update `eslint.config.mjs` boundaries** `element-types` rules: add `{ from: [['pkg', { package: 'engine' }]], allow: [['pkg', { package: ['contracts','domain','db','adapters','infra','dify'] }]] }`. `apps` already allow all pkgs. Verify a probe (engine importing infra OK; db importing engine → error).

---

## Conventions

- Repo root, branch `feat/phase-3-execution`. TDD, commit per task (lowercase conventional subject). Don't push.
- Strict ESLint. Integration tests: spin Postgres via `@testcontainers/postgresql`, run `migrate(db,{migrationsFolder})` pointing at `packages/db/drizzle`, then exercise real SQL. Redis-dependent tests: use an in-memory fake or a Testcontainers redis where needed; prefer unit-testing queue _logic_ with injected fakes over standing up BullMQ in tests.
- All money is `bigint` µcredits (Phase 1). Never reintroduce floats.

---

## Task 1: Account/ledger atomic repository (`@actionow/db`)

**Files:** `packages/db/src/repositories/account.ts`, `ledger.ts`; test `packages/db/test/ledger.int.test.ts`.

Implement (drizzle, `bigint` mode):

- `holdCredits(db, accountId, amount): Promise<boolean>` — **single atomic conditional update** (review #10):
  `UPDATE account SET credit_held = credit_held + amount WHERE id = accountId AND credit_balance - credit_held >= amount RETURNING id` → `true` iff 1 row. (Use `and(eq(account.id,…), gte(sql\`${account.creditBalance} - ${account.creditHeld}\`, amount))`.)
- `releaseHold(db, accountId, amount)` — `credit_held = credit_held - amount`.
- `appendLedger(db, txn)` — insert a `ledger_txn` row (caller supplies type/delta/balanceAfter/jobId/snapshot).
- `topUp(db, accountId, tenantId, amount)` — `credit_balance += amount` + a `topup` ledger row (balanceAfter read post-update), in one transaction. (Needed for seeds/tests.)

- [ ] **Step 1: Failing integration test** `ledger.int.test.ts` (Testcontainers): migrate; create tenant+account(balance=100µ? use realistic e.g. 1_000_000n); assert:
  - `holdCredits` succeeds when balance−held ≥ amount, increments `credit_held`.
  - `holdCredits` returns `false` and does NOT change `credit_held` when insufficient (review #10 — no oversell). Also assert the DB `CHECK` would block any oversell.
  - **Concurrency:** fire N=20 concurrent `holdCredits(amount)` where only K can fit; assert exactly K succeed and `credit_held ≤ credit_balance` always.
- [ ] **Step 2–4:** Implement, run green, add `releaseHold`/`appendLedger`/`topUp` cases.
- [ ] **Step 5:** Commit `feat(db): atomic credit hold/release + ledger append repository`.

---

## Task 2: Job repository + atomic settle transaction (`@actionow/db`)

**Files:** `packages/db/src/repositories/job.ts`, `settle.ts`; test `packages/db/test/settle.int.test.ts`.

- `createJob(db, input): Job` — insert `job` (status `queued`, frozen snapshot fields: resourceVersion, pricebookEntryId, pricebookVersion, modifiersSnapshot, quotedCredits, holdId, holdExpiresAt, callbackUrl, idempotencyKey, endUser, inputs).
- `transitionJob(db, jobId, from: JobStatus[], to: JobStatus): boolean` — `UPDATE job SET status=to, updated_at=now() WHERE id=jobId AND status IN from RETURNING id` → `rows===1`.
- `getJob(db, jobId)`, `listJobs(db, tenantId, cursor?, limit)`.
- **`settleJob(db, p): Promise<{ settled: boolean }>`** — the single idempotent settle (review #11), one transaction:
  1. `moved = transitionJob(tx, jobId, ['queued','running'], 'succeeded')` with cost/usage/output set; if `!moved` → return `{settled:false}` (dedup, no double-charge).
  2. `UPDATE account SET credit_held = credit_held − p.holdAmount, credit_balance = credit_balance − p.finalCost WHERE id=p.accountId`.
  3. read `balance_after`; insert `ledger_txn` (`type:'settle'`, `creditsDelta: -finalCost`, `balanceAfter`, jobId, pricebookVersion, modifiersApplied, usageVector).
  4. if `p.outbox` → insert `webhook_outbox` (jobId, url, payload). **All in the same tx** (transactional outbox).
     Unique `ledger_settle_per_job` is the DB backstop.
- **`failJob(db, p)`** — `transitionJob(…,'failed'|'canceled')`; release hold; write a `refund`/release ledger row if policy says refund (default: release hold, no charge); optional outbox. Idempotent via the same guard.

- [ ] **Step 1: Failing integration test** `settle.int.test.ts`: create account(balance 1_000_000n)+job(hold 500_000n). Assert:
  - `settleJob(finalCost=300_000n)` → balance 700_000n, held 0, one `settle` ledger row with `balanceAfter=700000`.
  - **Dedup:** calling `settleJob` again (or `failJob`) on the same job → `{settled:false}`, NO second ledger row, balances unchanged (review #11).
  - `failJob` on a fresh job releases the hold (held→0) without debiting balance.
- [ ] **Step 2–4:** Implement; run green; add list/get cases.
- [ ] **Step 5:** Commit `feat(db): job repository + atomic idempotent settle/fail transaction`.

---

## Task 3: Idempotency repository (`@actionow/db`)

**Files:** `packages/db/src/repositories/idempotency.ts`; test (integration).

- `claimIdempotency(db, tenantId, key, jobId): Promise<{ claimed: boolean; existingJobId?: string }>` — `INSERT ... ON CONFLICT (tenant_id,key) DO NOTHING RETURNING job_id`; if no row inserted, `SELECT` the existing `job_id` and return `{claimed:false, existingJobId}`.

- [ ] TDD: first claim → `{claimed:true}`; same key again → `{claimed:false, existingJobId}` (the original). Commit `feat(db): idempotency-key claim repository`.

---

## Task 4: Engine — `ExecutionService` blocking path (`@actionow/engine`)

**Files:** create the package; `packages/engine/src/execution-service.ts`, `errors.ts`, `index.ts`; test (integration).

`ExecutionService.run(req): Promise<RunOutcome>` where `req = { resource:{id,version,modality,ioSchema,execModes,providerType}, pricebookEntry, modifiers, channels: {id,weight,credentialRef,model,endpoint}[], inputs, execMode, tenantId, accountId, callbackUrl?, idempotencyKey?, endUser? }` and the service is constructed with `{ db, adapters: AdapterRegistry, resolveSecret: (ref)=>Promise<string|undefined>, http: HttpClient, now: ()=>Date, enqueue: (jobId)=>Promise<void> }`.

Blocking/sync flow (§4.1, §9.4):

1. If `idempotencyKey`, `claimIdempotency`; if already claimed → return the existing job (fetch + map).
2. `validateInputs(resource.ioSchema, inputs)` (domain) → `invalid_input` on failure.
3. **quote:** pre methods → `quote(pricebookEntry, inputs)`; post → an upper-bound `M` (for unit, caller may pass `req.maxUsage`; for the scaffold, if no estimate, hold a configured floor or the quoted amount). Run `applyModifiers(base, modifiers)` → `holdAmount`.
4. `holdCredits(accountId, holdAmount)`; if false → `insufficient_credits` (do NOT create a job).
5. `createJob` (status queued, snapshot, holdId = the ledger context, holdExpiresAt = now + resource max ttl).
6. Resolve channel secrets; build `AdapterContext`; `routeWithFailover(channels, rng, c => adapter.submit({...,ctx}), isRetryableAdapterError)`.
   - **blocking** → adapter returns `SyncResult`: compute `finalCost` (post: `settle(pricebookEntry, usage)`; pre: confirmed quote) → `applyModifiers` → `settleJob({jobId, accountId, holdAmount, finalCost, usage, output, outbox: callbackUrl?})`. Return `{ jobId, status:'succeeded', output, usage, cost:{credits: finalCost, ...} }`.
   - on adapter throw after all channels → `failJob` (release hold) → return/raise the `UnifiedError` (`upstream_error`).
7. **async** execMode (or resource only supports async) → after hold+createJob, `enqueue(jobId)`, return `{ jobId, status:'queued' }`.

- [ ] **Step 1: Failing integration test** (Testcontainers pg + the `async-media-mock`/a fake LLM adapter): seed tenant/account(1_000_000n)/resource/pricebook; run a blocking call against a fake adapter returning `{text}`+usage; assert job succeeded, ledger has hold+settle, balance debited by final cost, output returned. Assert `insufficient_credits` when balance too low (no job created). Assert idempotent replay returns the same job.
- [ ] **Step 2–4:** Implement; green; add the routing-failover case (first channel adapter throws retryable → second succeeds).
- [ ] **Step 5:** Commit `feat(engine): execution service blocking run with hold→settle`.

---

## Task 5: Engine — async `JobRunner` + queue ports (`@actionow/engine`)

**Files:** `packages/engine/src/job-runner.ts`, `packages/engine/src/queue.ts` (port interfaces); test.

- `queue.ts`: define `JobQueuePort { enqueueExec(jobId): Promise<void> }` and `interfaces` for the worker — keep BullMQ out of `engine` core logic; engine depends on a port, the worker provides the BullMQ impl.
- `JobRunner.process(jobId)`: load job; `transitionJob(queued→running)`; resolve resource/channels (via an injected loader); `adapter.submit` (async → `UpstreamJobHandle`); then poll loop `adapter.poll(handle)` until terminal (bounded iterations / delay injected) OR (for async-callback) leave for the callback handler; on `succeeded` → `settleJob`; on `failed` → `failJob`.
- Provide `handleCallback(payload)` that maps `parseCallback` → `settleJob`/`failJob` (idempotent; works even if poll also fires — settle dedup protects).

- [ ] **Step 1: Failing integration test** using `createAsyncMediaMock({readyAfterPolls:1})`: enqueue (fake port), `JobRunner.process` drives queued→running→succeeded, ledger settles, output has `image_url`. Assert poll+callback double-settle is deduped (call settle path twice → one ledger row).
- [ ] **Step 2–4:** Implement; green.
- [ ] **Step 5:** Commit `feat(engine): async job runner with poll/callback settle (dedup-safe)`.

---

## Task 6: Webhook outbox dispatcher + HMAC + reaper (`@actionow/engine`)

**Files:** `packages/engine/src/webhook.ts`, `packages/engine/src/reaper.ts`; tests.

- `signPayload(secret, body): string` — `crypto.createHmac('sha256', secret).update(body).digest('hex')`; header `X-Actionow-Signature`.
- `WebhookDispatcher.dispatchDue(db, http, now)`: select `webhook_outbox` rows `status='pending' AND next_attempt_at<=now` (bounded batch); POST the job object with the signature header; on success → `status='sent'`; on failure → increment `attempts`, set `next_attempt_at = now + backoff(attempts)`, after max attempts → `status='dead'`. Idempotent per row; dedup by `job_id` is inherent (one settle → one outbox row).
- `Reaper.reapExpiredHolds(db, now)` (review #12): select jobs with `hold_expires_at < now` AND status ∈ (queued,running); for each, `failJob` with `canceled` (release hold). Returns count.

- [ ] TDD with fake `HttpClient`/in-memory: signature stable & verifiable; failed POST → backoff + attempts++ then dead; reaper cancels an expired in-flight job and releases its hold (assert held→0). Commits: `feat(engine): webhook outbox dispatcher with hmac signing` and `feat(engine): orphan-hold reaper`.

---

## Task 7: `apps/api` run/jobs endpoints + `apps/worker` processors

**Files:** `apps/api/src/execution/*` (module, controller, a `RunService` that loads resource+pricebook+channels from db and calls `engine.ExecutionService`), `apps/api/src/jobs/*` (`GET /v1/jobs/:id`, `POST /v1/jobs/:id/cancel`, `GET /v1/jobs`); `apps/worker/src/processors/*` (job-exec → `JobRunner.process`; webhook-outbox → `dispatchDue`; hold-reaper → `reapExpiredHolds` on a repeatable schedule); wire `apps/api/src/app.module.ts` + `apps/worker/src/main.ts`.

- API: `POST /v1/run/:resourceId` → `RunService.run` → 200 sync `{job_id,status,output,usage,cost}` or 202 `{job_id,status:'queued'}`. Map `DomainError`/`UnifiedError` → §4.7 error filter (a global `ExceptionFilter`). For Phase 3, **tenant/account come from a stub middleware** (a fixed dev tenant via a header `x-tenant-id` or seed default) — real API-key auth is Phase 5; clearly mark the stub.
- Worker: register BullMQ processors implementing the engine ports; reaper as a repeatable job (every ~30s).

- [ ] **Step 1:** e2e (NestJS Test + Testcontainers pg, real engine, fake/registered adapters incl. async-media-mock; Redis via Testcontainers or BullMQ in-memory if feasible — otherwise unit-test the processor functions directly and keep the e2e to the blocking path which needs no queue). Assert: blocking `POST /v1/run/:id` against a seeded openai-style resource with a stubbed HttpClient returns output+cost and a settle ledger row; `GET /v1/jobs/:id` returns it; `insufficient_credits` path returns the unified error; `POST /v1/jobs/:id/cancel` cancels a queued job.
- [ ] **Step 2–4:** Implement; green.
- [ ] **Step 5:** Commit `feat(api,worker): /v1/run + /v1/jobs endpoints and queue processors`.

---

## Task 8: Verification gate

- [ ] `pnpm typecheck && pnpm lint && pnpm build` green; `pnpm test` green (engine + db integration + api e2e; Docker up).
- [ ] Boundaries: `engine` rule added & proven (engine→db OK; db→engine → lint error, then revert). `apps` import engine fine.
- [ ] Confirm: no floats on money path (grep engine/db repos); secret values never logged (the api request logger, if any, redacts URLs/headers — esp. gemini `?key=`).
- [ ] Commit any fixups `chore: phase-3 execution verification gate green`.

---

## Phase 3 Definition of Done

- Blocking `/v1/run` works end-to-end: validate → quote+modifiers → atomic hold → job → routed adapter → atomic idempotent settle → ledger debited; `insufficient_credits` blocks before job creation; idempotency replay returns the same job.
- Async path: enqueue → worker `JobRunner` drives queued→running→succeeded via poll, settles; poll/callback double-settle is deduped.
- Webhook outbox signs (HMAC) + retries with backoff; orphan-hold reaper cancels expired in-flight jobs and releases holds.
- `GET/POST /v1/jobs` lifecycle endpoints exist; unified error filter maps domain/adapter errors to §4.7 codes.
- `@actionow/engine` boundary enforced; `pnpm typecheck/lint/build/test` all green. (API-key auth + rate-limit are Phase 5.)

> **Next:** Phase 4 — Dify DSL parse → io_schema + BYO registration; then Phase 5 — API-key auth, rate-limit, admin CRUD, OpenAPI.
