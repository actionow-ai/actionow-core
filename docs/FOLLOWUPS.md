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
