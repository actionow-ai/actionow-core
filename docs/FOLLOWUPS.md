# Tracked follow-ups (non-blocking tech debt)

Items surfaced during phase reviews that were intentionally deferred. None block the scaffold; each has a documented workaround.

## Hardening pass — risk register (branch `harden/risk-register-fixes`)

A multi-dimensional design review produced a prioritized risk register; **all P0/P1/P2 items were fixed** (one commit each, with tests): relay idempotency (P0-1), `callback_url` SSRF guard + ingress validation (P0-2), payment-webhook atomicity (P0-3), streaming idle timeout (P1-4), BullMQ retry/backoff/DLQ + graceful shutdown + enqueue-fail release (P1-5), seed prod-guard + password policy + login throttle (P1-6), adapter audio/file rejection + file gate (P2-7), money/audit FKs + tenant-scoped money writes (P2-8). The remaining **P3 maturity items carry no runtime risk** and are deferred as dedicated, reviewed efforts rather than rushed at the tail of the fix sequence:

- **Engine persistence port (unweld `DbOrTx`).** `ExecutionServiceDeps.db: DbOrTx` welds the framework-free engine to a concrete drizzle handle typed over the full schema. → Define a narrow repository port (in contracts/engine) covering only the ops the engine calls, have `@actionow/db` implement it, and depend the engine on the port. Large, portability-only; zero runtime impact.
- **Extract relay pricebook / hold-estimation into the engine.** The chat relay's pricebook-spec construction + stream-hold byte heuristic live in the API app, so the worker / third-party extenders can't reuse them. → Move into the engine behind the existing snapshot DTO.
- **Decompose the admin god-files** (`admin.service.ts` ~1.5k LOC, `admin.controller.ts` ~1.4k LOC) into per-domain sub-services (tenants/keys, channels/route-groups, pricing/catalog, payments) — also makes per-resource authz easier to audit.
- **Metrics + structured logging.** Replace `console.log`/`console.error` in the worker/engine with a structured logger and emit counters/histograms (job latency, settle counts, webhook delivery, channel failover). Observability only.
- **Capability-aware channel routing (follow-up to P2-7).** Adapters now _reject_ content parts they can't represent (no silent base64-as-text downgrade), but the dispatch gate still keys off the resolved MODEL row, not the serving channel's `AdapterCapabilities`. → Re-gate at dispatch (or filter candidate channels by adapter capability) so a multimodal request fails _over_ to a capable channel instead of erroring on a misconfigured mixed-capability resource.
- **`failJob` tenant-scoping (follow-up to P2-8).** `settleJob`/`topUp`/`holdCredits` money writes are now tenant-scoped; `failJob` (a `credit_held` release only, no balance movement) still keys on `accountId` alone. → Thread `tenantId` into `FailJobInput` for symmetry.

## Ledger / accounting

- **`hold` produces no ledger row** (Phase 3). `holdCredits` reserves into `account.credit_held` but writes no `ledger_txn` of type `hold`; only the final `settle` row is written. Funds are always correct, but the ledger is not a _complete_ append-only history of every balance event (a §5/§6.2 goal). `appendLedger` already supports a `hold`-typed row. → Add a `hold` ledger row (and matching `release`/`refund` rows) for full auditability.
- **`job` has no `account_id`** (Phase 3). `settle`/`fail`/`reaper` resolve the account via a `tenant_id` join (`getAccountByTenant` / `listExpiredHolds`), which assumes **one account per tenant** (true for current seeds). The unused `job.hold_id` column exists for this. → Persist `account_id` (or use `hold_id`) on `job` before multi-account billing lands; update the reaper join.

## Auth / pricing (planned for Phase 5)

- **Stub tenant auth** — `apps/api` resolves tenant from an `x-tenant-id` header / `DEV_TENANT_ID`; real API-key auth (hash lookup, `resource_allowlist`, per-key rate-limit) is Phase 5.
- **Modifier scope filtering deferred** — `listActiveModifiers` returns all active modifiers and lets `applyModifiers`/`whenExpr` decide; per-tenant/per-resource scope filtering is Phase 5.
- **Secret resolution is env-based stub** — `resolveSecret` reads `process.env`; the real vault-backed `secret_ref` resolution is a later concern (§10).

## Domain (Phase 1 minor)

- **`creditsToMicro` float boundary** — converts via `Math.round(credits * 1e6)`; safe for normal values, imprecise for credit amounts beyond ~9e9. It's the admin/import boundary, not the money hot path. → Parse via string/integer for full robustness.

## Phase 5 (minor)

- **`RateLimitGuard` over-counts the resource window on a tenant-blocked request** (`apps/api/src/auth/rate-limit.guard.ts`). The guard increments both fixed-window buckets via `Promise.all` before checking either, so a request rejected by the tenant bucket still consumes one slot of the per-(tenant, resource) window. The over-count is benign (a single slot in a fixed window that self-heals when the window rolls over) and never under-charges the limit. → Short-circuit on the tenant bucket first; only touch the resource bucket once the tenant check passes.
- ~~**Seed CLI prints the dev admin password to stdout**~~ — **RESOLVED (hardening pass P1-6).** The CLI now refuses to provision the default-credential admin in `NODE_ENV=production` (requires `SEED_ALLOW_PRODUCTION=true` + an operator `SEED_ADMIN_PASSWORD`) and never echoes an operator-supplied password; the dev-default password is printed only outside production.

## Testing / CI

- **Integration-test parallelism flakiness.** `turbo run test` runs the `db`/`engine`/`api` Testcontainers suites concurrently; each spins its own Postgres container, which can transiently contend (an occasional task failure that passes on re-run). → cap integration concurrency (e.g. `turbo run test --concurrency=1` for a CI "integration" lane, or a shared-container fixture / vitest `poolOptions` single-fork), or split unit vs integration test lanes.

## Runtime / boot (Phase 6)

- **API standalone boot needs the compiled output + a TS loader for deps.** `tsx`/esbuild cannot emit NestJS `emitDecoratorMetadata` (Nest DI fails: "Parameter decorators only work when experimental decorators are enabled"), and `node dist/main.js` can't load the workspace deps (their `package.json main` points at TS `src/index.ts`). The working command is therefore `nest build` (emits decorator metadata into `dist/`) then `node --import tsx dist/main.js` (tsx transpiles the _dep_ TS, which has no decorators). This is now the `apps/api` `start` script. The worker has no decorators so it runs from source: `node --import tsx src/main.ts`. → For a real deploy, build every workspace package to `dist` and add a `production` exports condition so plain `node` can run without `tsx`.

## Phase 7 (minor)

- **`resolveFileInputs` not yet wired into `RunService`** (`apps/api/src/files/files.service.ts`). The helper that maps io_schema `file`/`file_list` inputs → presigned GET URLs is implemented + tested but not called in the execution path; wire it when an adapter consumes file inputs (and add media-output upload). → fold into a later exec pass.
- **`markFileReady` updates by id only** (tenant predicate enforced at the call site via `requireFile`); add a tenant-scoped WHERE for defense-in-depth.

## Phase 8 (minor)

- **Callback replay window is opt-in** (`apps/api/src/callbacks/callbacks.service.ts`): the ~5min timestamp check only runs when `x-actionow-timestamp` is present; a provider that never sends a timestamp gets HMAC integrity but no replay defense. → make the timestamp header required per-provider.
- **Channel `credentialRef` doubles as upstream key AND callback HMAC secret** (`resolveJobSecret`); multi-channel resources only try the first channel's secret. → give bindings a distinct callback-signing secret (and try all channels) when real provider callbacks land.
- **Stream-mode idempotency is no-replay** (a reused `idempotency_key` on a stream run → `invalid_input`, since a live stream can't be replayed). Documented behavior, noted for API consumers.

## Phase 10 (minor)

- ~~**`getIntentByProviderRef` + `insertEventIfNew` run outside the fulfillment transaction**~~ — **RESOLVED (hardening pass P0-3).** Event-recording and fulfillment now run in ONE transaction, so a crash/abort after the event row would otherwise commit rolls it back too and the provider retry re-runs cleanly (instead of being mis-classified as a duplicate and silently losing the topup credit).
- **`setIntentStatus` has no terminal-state guard** — unconditionally sets `succeeded` on a verified succeeded event. Not reachable now (only succeeded events fulfill; idempotency prevents reprocessing), but a future refund/failed flow needs a status-transition guard.
- **`order`/`subscription` purposes** record payment (intent succeeded, event processed) but carry no fulfillment hook yet — wire the order/subscription grant when those products land.
- **WeChat legacy platform-certificate serial branch** is out of scope (unknown serial rejected); add cert-mode verify if a merchant predates the public-key migration.

## Phase 10 (test infra)

- **e2e env stubs are inline & incomplete** — each api e2e builds an `ENV` override literal, so every new _required_ env field (ADMIN_JWT_SECRET, then CREDIT_RATE) silently breaks ~11 old stubs (AppModule init crashes). Phase-10's `CREDIT_RATE` did this; fixed by adding it to every stub. → extract a shared `makeTestEnv(overrides?): AppEnv` helper (one complete base) and route all e2e overrides through it so a new field never breaks old tests. (The Testcontainers parallelism flakiness is now fixed via `fileParallelism:false` on the integration packages.)
