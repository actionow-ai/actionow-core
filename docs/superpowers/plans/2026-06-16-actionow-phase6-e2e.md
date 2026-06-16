# Actionow Phase 6 — Real End-to-End Testing Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. `- [ ]` steps.

**Goal:** Close the one untested gap — the **async pipeline over real BullMQ/Redis** and **real webhook delivery** — with a full-stack e2e that boots the **real API HTTP server** (`app.listen`) + the **real worker** (BullMQ Workers) against **Testcontainers Postgres + Redis**, and drives the whole system over real HTTP. Existing tests stop at the NestJS `Test` harness with a `noopQueue` (no real server, no real worker, async path never exercised).

**Architecture:** One e2e harness. Testcontainers pg+redis → migrate + seed → boot the api app (`app.listen(0)`) with the **real `BullmqJobQueue`** pointed at the test Redis → boot the worker via a new `startWorkers(runtime, opts)` against the same Redis → drive over `fetch`/supertest. A stub `fake-llm` adapter handles the blocking LLM path (no network); `async-media-mock` (real, in-process on the worker) drives the async path; a tiny in-test HTTP server receives the webhook callback and its HMAC is verified.

**Tech Stack:** Vitest + `@testcontainers/postgresql` + `@testcontainers/redis`, real NestJS HTTP server, real BullMQ, `node:http` callback server.

**Source spec:** §4.1–4.4 (run/jobs/webhook/SSE), §5 (states), §12 (acceptance). Wiring facts in the Phase-6 exploration.

---

## Conventions

- Repo root, branch `feat/phase-6-e2e`. Commit per task (lowercase conventional subject). Don't push.
- Strict ESLint. e2e tests live in `apps/api/test/` (the host app). Add `@actionow/worker` + `@testcontainers/redis` as devDeps of `apps/api`.
- The e2e uses Testcontainers (random ports) — independent of the dev compose (5433/6380). Docker is up.

---

## Task 1: Make the worker boot testable — `startWorkers(runtime, opts)`

**Files:** `apps/worker/src/start.ts` (new), `apps/worker/src/main.ts` (call it), `apps/worker/src/index.ts` (export); small test.

- Extract the BullMQ-Worker boot from `main.ts` into `export function startWorkers(runtime: WorkerRuntime, opts?: { webhookSweepMs?: number; reaperSweepMs?: number; connection?: ConnectionOptions }): { close: () => Promise<void> }`. It creates the 3 Workers (`job-exec`→`createJobExecProcessor`, `webhook-outbox`→`createWebhookOutboxProcessor`, `hold-reaper`→`createHoldReaperProcessor`), registers the repeatable webhook/reaper sweeps using `opts.webhookSweepMs ?? WEBHOOK_SWEEP_MS` / `opts.reaperSweepMs ?? REAPER_SWEEP_MS`, and returns a `close()` that drains+closes all Workers and the queue connections. Default connection = `runtime.env.REDIS_URL`.
- `main.ts` becomes: `const runtime = createWorkerRuntime(); startWorkers(runtime);` (+ keep the `worker ready` log). Behavior unchanged in production.
- Ensure `apps/worker` has a proper `exports`/`main` so `@actionow/api` can import `startWorkers` + `createWorkerRuntime` (the worker package is currently app-only — add `"main": "src/index.ts"` + `exports` and export `startWorkers`, `createWorkerRuntime`, `WorkerRuntime`).

- [ ] **Step 1:** Refactor; keep `main.ts` working (boot check still logs ready). Add a tiny test that `startWorkers` returns a `close()` and binds the 3 queue names (can assert against a Testcontainers redis or a mocked Worker — keep it light).
- [ ] **Step 2:** `pnpm --filter @actionow/worker typecheck` + `eslint` green.
- [ ] **Step 3:** Commit `refactor(worker): extract startWorkers for testability`.

---

## Task 2: Full-stack e2e harness (`apps/api/test/full-stack.e2e.test.ts`)

**Files:** `apps/api/test/full-stack.e2e.test.ts`; helpers as needed; `apps/api/package.json` devDeps (`@actionow/worker`, `@testcontainers/redis`).

**Harness (`beforeAll`):**

1. Start `PostgreSqlContainer('postgres:16-alpine')` + `RedisContainer('redis:7-alpine')`; get their URIs.
2. `createDb(pgUri)`; `migrate(db, { migrationsFolder })`.
3. Build a test `AppEnv` (DATABASE_URL=pgUri, REDIS_URL=redisUri, ADMIN_JWT_SECRET set, rate-limit defaults, **NODE_ENV='production'** so the `x-tenant-id` dev fallback is OFF and auth is real, DEV_TENANT_ID unset).
4. Build the **api adapter registry**: `createDefaultRegistry({ asyncMedia: { readyAfterPolls: 1 } })` then `.register(fakeLlmAdapter)` — a stub `ProviderAdapter` (`providerType: 'fake-llm'`) whose `submit` returns a deterministic `SyncResult { output:{text:'echo: '+inputs.prompt}, usage:{tokens:300} }` (no network).
5. Boot the **real API HTTP server**:
   `Test.createTestingModule({ imports:[AppModule] }).overrideProvider(ENV).useValue(env).overrideProvider(DB).useValue(db).overrideProvider(ADAPTERS).useValue(apiRegistry).overrideProvider(RATE_LIMITER).useValue(new RedisRateLimiter(createRedis(redisUri))).compile()` — **leave `JOB_QUEUE` as the real `BullmqJobQueue`** (it reads `env.REDIS_URL` → test redis). `const app = moduleRef.createNestApplication(); app.useGlobalFilters(new UnifiedErrorFilter()); await app.listen(0);` capture `baseUrl = await app.getUrl()` (or the server port).
6. Boot the **real worker**: build a `WorkerRuntime` { env, db, adapters: `createDefaultRegistry({asyncMedia:{readyAfterPolls:1}})`, http: `fetchHttpClient`, resolveSecret: env-based (+ a known webhook signing secret if the dispatcher resolves one — read `packages/engine/src/webhook.ts` to wire the secret the same way the worker processor does, and capture it for verification) }. `const workers = startWorkers(runtime, { webhookSweepMs: 250, reaperSweepMs: 500 })`.
7. Start a `node:http` **callback server** on an ephemeral port that pushes each received `{ headers, body }` into an array.
8. Seed: call `seedAll(db, ...)` OR inline-create the fixtures the tests need (admin user, a tenant + funded account + api key + a `fake-llm` blocking resource + pricebook + channel, and an `async-media-mock` resource + pricebook + channel). Capture the plaintext api key + admin JWT (login via HTTP).

**Tests (all over real HTTP via `fetch(baseUrl + ...)`):**

- [ ] **Blocking run** — `POST /v1/run/<fake-llm resource>` with `Authorization: Bearer <key>` → 200, body has `output.text`, `usage`, `cost.credits`; assert a `settle` ledger row + account debited (query db).
- [ ] **ASYNC run over real BullMQ (the headline test)** — `POST /v1/run/<async-media-mock resource>` → **202 `{job_id, status:'queued'}`**; then poll `GET /v1/jobs/<job_id>` (with backoff, up to ~10s) until `status==='succeeded'`; assert `output` has `image_url`/`video_url`, a `settle` ledger row exists, and the account was debited. (This proves the api→Redis→worker→JobRunner→poll→settle path end to end.)
- [ ] **Webhook delivery + HMAC** — async `POST /v1/run` with `callback_url: http://127.0.0.1:<cbPort>/hook`; wait until the callback server received a POST (≤ ~3s given 250ms sweep); assert the body is the terminal job object and the `X-Actionow-Signature` header equals `signPayload(secret, rawBody)` (HMAC-SHA256) — recompute and compare.
- [ ] **Rate limit (real Redis)** — create/use an api key with a tiny `rateLimit` (e.g. 2/min); fire 3 quick `POST /v1/run` → the 3rd is **429** with `error.code==='rate_limited'` and numeric `retry_after_ms`.
- [ ] **Auth** — missing/invalid key → **401 `unauthorized`**; **insufficient_credits** on a low-balance account → **402** with no job; **idempotency** replay (same `idempotency_key`) → same `job_id`, no double charge.
- [ ] **Admin + dify over HTTP** — `POST /admin/auth/login` → JWT; `POST /admin/dify/import` (BYO workflow yaml, pricingModel `fixed`) → 200 with io_schema; `GET /v1/resources/<id>` (api key) shows the io_schema. BYO+metered import → 400 `metered_not_allowed`.

**Teardown (`afterAll`):** `await workers.close(); await app.close(); cbServer.close(); await redisClient.quit(); await pg.stop(); await redis.stop();` — no hanging handles.

- [ ] **Step 1–4:** Build the harness + tests; make them pass. Use generous timeouts (`testTimeout: 60000`, `hookTimeout: 120000`). If the async poll/webhook timing is flaky, increase the worker sweep cadence (smaller `webhookSweepMs`) and the poll budget — but the async job MUST actually complete via the worker, not be shortcut.
- [ ] **Step 5:** Commit `test(e2e): full-stack async pipeline + webhook over real bullmq/redis`.

---

## Task 3: `pnpm e2e` script + gate

**Files:** root `package.json` (`"e2e": "..."`), `apps/api/package.json`.

- Add a root `e2e` script that runs ONLY the full-stack e2e (e.g. `pnpm --filter @actionow/api exec vitest run test/full-stack.e2e.test.ts`) so it can be run/scaled independently of the unit lane.
- [ ] **Gate:** `pnpm typecheck && pnpm lint && pnpm build` green; `pnpm e2e` green (Docker up); the existing `pnpm test` suite still green. Boundaries intact (apps importing `@actionow/worker` is allowed — apps are unrestricted; confirm lint clean).
- [ ] Commit `chore(e2e): add e2e script + phase-6 gate`.

---

## Phase 6 Definition of Done

- A full-stack e2e boots the **real API HTTP server** + **real BullMQ worker** against **Testcontainers Postgres + Redis** and passes:
  - blocking run (200 + ledger settle),
  - **async run completing through the real worker** (202→poll→succeeded + ledger settle),
  - **real webhook delivery with a verified HMAC signature**,
  - rate-limit 429 over real Redis, 401/402/idempotency over real HTTP,
  - admin login + dify import + resource discovery over HTTP.
- `startWorkers` extracted so the worker boot is reusable/testable; `main.ts` unchanged in behavior.
- `pnpm typecheck/lint/build/test` green and `pnpm e2e` green; no leaked handles on teardown.

> After this, the system is verified end-to-end with real infrastructure — the async/queue/webhook paths that only ran via fakes before are proven against real BullMQ/Redis/Postgres/HTTP.
