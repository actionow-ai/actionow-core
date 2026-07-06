# Design — media force-persist switch (watermark enabler) · #2

**Status:** proposed (awaiting go-ahead) · **Scope:** core only · **Date:** 2026-07-05

## Outcome

A core switch that, when on, **guarantees a generated media asset is persisted to
core storage** (and therefore has a stable, core-hosted `public_url` — see #3),
so an integrating app can reliably fetch that durable artifact and embed **its own**
watermark (GB45438 深度合成标识). Core does **not** composite the watermark
(that stays with the app / a provider-plugin); core only guarantees the artifact
exists at a stable URL instead of silently settling on the transient upstream
provider URL.

## Why it's not a one-liner (the settle path)

Today `persistMediaResult` is **best-effort**: on empty assets, a fetch/put error,
or unconfigured storage it returns `persisted:false` and the job **settles on the
raw upstream provider URL** (`packages/engine/src/media-result.ts:104-143`). The
persist closure is invoked **inside the JobRunner settle sequence**
(`packages/engine/src/execution-service.ts`, via the `persistMediaResult` fn passed
from the 3 callers: `apps/worker/.../job-exec.processor.ts`,
`apps/api/.../media-dialect.service.ts`, `apps/api/.../callbacks.service.ts`).
Making persist **required** means: on failure the job must **fail and release its
hold** (not settle) — a change to the billing-critical settle/hold path. That is
why this is planned + reviewed, not cowboyed.

## Mechanism decision — per-request parameter (DECIDED 2026-07-05)

**Per-request `require_persist` on `runBodySchema`** (founder call: caller-controlled,
not config-driven). The flag rides the request and is persisted on the `job` row so
it reaches the worker at settle time.

- `require_persist?: boolean` on `POST /v1/run` body, default `false` (backward-
  compatible — today's best-effort behavior unchanged when omitted/false).
- Requires a `job.require_persist` column (a `boolean NOT NULL DEFAULT false`
  add — metadata-only on PG 11+, no rewrite/lock on the hot table; not an FK, so no
  FK-naming rule; no new index).

_(A settings/tenant-level default was considered and set aside per the founder's
"参数可控，不要配置驱动" call; a tenant default could layer on later.)_

## Changes (per-request)

1. `packages/contracts/src/data-plane.ts` — add `require_persist: z.boolean().optional()`
   (default false) to `runBodySchema`; regenerate openapi + SDK.
2. `packages/db` — migration: `job.require_persist boolean NOT NULL DEFAULT false`.
3. `apps/api/src/execution/run.service.ts` — thread `body.require_persist` into the
   inserted `job` row.
4. `packages/engine/src/media-result.ts` — `persistMediaResult` gains
   `requirePersist?: boolean`; when true and persistence would yield
   `persisted:false` (empty assets / caught error / no storage), **throw**
   `PersistRequiredError` (new typed error) instead of returning `persisted:false`.
5. `packages/engine/src/execution-service.ts` (JobRunner) — the settle path
   catches `PersistRequiredError` → route to `failJob` (releasing the hold) with a
   `persist_required` unified error, **exactly like any other settle-time failure**
   (reuse the existing fail+release path; do not add a new hold path).
6. The 3 callers (`job-exec.processor`, `media-dialect.service`, `callbacks.service`)
   read `job.require_persist` and pass `requirePersist` into `persistMediaResult`.

## Verification

- Unit: `persistMediaResult` throws `PersistRequiredError` when required + (empty |
  put-error | no-storage); returns normally when not required (regression) and when
  required + success.
- Engine: JobRunner fails the job + **releases the hold** (no stuck hold, no charge)
  on `PersistRequiredError`; billing invariant test (hold released == held amount).
- e2e: with `MEDIA_REQUIRE_PERSIST=true` + storage unconfigured, a media run
  **fails** (not settles-on-upstream); with storage configured it succeeds with a
  `public_url`. Default-off path unchanged (existing media e2e stays green).
- Independent verifier on the settle/hold diff before merge.

## Risks / guardrails

- **Billing:** the only risk surface. Mitigated by reusing the existing
  fail+release path and a hold-conservation test. No new charge on failure.
- **No migration** in the recommended design → avoids hot-table lock risk.
- Fail-open default (`false`) → zero behavior change for existing tenants.
