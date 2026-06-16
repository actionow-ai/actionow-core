# Tracked follow-ups (non-blocking tech debt)

Items surfaced during phase reviews that were intentionally deferred. None block the scaffold; each has a documented workaround.

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
- **Seed CLI prints the dev admin password to stdout** (`apps/api/src/seed/seed.ts`, `main()`). The printed value is `SEED_ADMIN_PASSWORD`, a hardcoded well-known **dev** constant — not a real secret — but printing it widens the intended-stdout surface (the one-time API-key plaintext) beyond what's necessary. → Print only a "use the dev password from docs" hint instead of the literal password.

## Testing / CI

- **Integration-test parallelism flakiness.** `turbo run test` runs the `db`/`engine`/`api` Testcontainers suites concurrently; each spins its own Postgres container, which can transiently contend (an occasional task failure that passes on re-run). → cap integration concurrency (e.g. `turbo run test --concurrency=1` for a CI "integration" lane, or a shared-container fixture / vitest `poolOptions` single-fork), or split unit vs integration test lanes.

## Runtime / boot (Phase 6)

- **API standalone boot needs the compiled output + a TS loader for deps.** `tsx`/esbuild cannot emit NestJS `emitDecoratorMetadata` (Nest DI fails: "Parameter decorators only work when experimental decorators are enabled"), and `node dist/main.js` can't load the workspace deps (their `package.json main` points at TS `src/index.ts`). The working command is therefore `nest build` (emits decorator metadata into `dist/`) then `node --import tsx dist/main.js` (tsx transpiles the _dep_ TS, which has no decorators). This is now the `apps/api` `start` script. The worker has no decorators so it runs from source: `node --import tsx src/main.ts`. → For a real deploy, build every workspace package to `dist` and add a `production` exports condition so plain `node` can run without `tsx`.

## Phase 7 (minor)

- **`resolveFileInputs` not yet wired into `RunService`** (`apps/api/src/files/files.service.ts`). The helper that maps io_schema `file`/`file_list` inputs → presigned GET URLs is implemented + tested but not called in the execution path; wire it when an adapter consumes file inputs (and add media-output upload). → fold into a later exec pass.
- **`markFileReady` updates by id only** (tenant predicate enforced at the call site via `requireFile`); add a tenant-scoped WHERE for defense-in-depth.
