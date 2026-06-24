# 治理与额度 (Governance & Limits) v1 — Design Spec

> **Status:** Approved (Q&A 2026-06-24). First sub-project of the 计费与路由 (billing & routing) redesign. Sibling sub-projects (records/audit & ledger integrity, RBAC, resilience 2.0, routing depth) are **out of scope** here and get their own specs.

**Goal:** Give operators a reusable, per-subject limit system — spend budgets, usage quotas, throughput rate-limits, and threshold alerts — so they can sell tiered plans and stop runaway spend, enforced at request time with hard rejects.

**Architecture:** A unified `limit_rule` model (one row per limit, typed by `dimension × period`) bundled into reusable `limit_plan` presets bound to API keys and tenants. A `GovernanceGuard` enforces pre-request (reusing the existing Redis `RateLimiter`); a settle-time hook accrues spend/token usage and fires alerts. Money stays integer µUSD; the ledger remains the source of truth for spend.

**Tech stack:** NestJS (apps/api), Drizzle/Postgres (packages/db), Redis via `@actionow/infra` `RateLimiter`, zod contracts → openapi → `@actionow/sdk`, React/Vite console (apps/web).

---

## Context — what already exists (build on, don't duplicate)

- **`RateLimitGuard`** (`apps/api/src/auth/rate-limit.guard.ts`) + **`RateLimiter`** (`packages/infra/src/rate-limit.ts`): Redis fixed-window (Lua `INCR`+`PEXPIRE`), `take(key, limitPerMin) → {allowed, retryAfterMs}`. Today it consults per-tenant, per-(tenant,resource)=`api_key.rateLimit`, per-(tenant,model)=`model.rate_limit` buckets and throws a 429 `rate_limited`. **RPM enforcement therefore already works** — v1 makes RPM caps come from a plan rule instead of only env/hint, and adds the missing dimensions.
- **`ApiKeyGuard`** sets `req.auth` (`tenantId`, `rateLimit`, key id, `routeGroupId`). Guards run in `@UseGuards(ApiKeyGuard, …)` order.
- **Ledger + hold/settle**: `account.creditBalance/creditHeld`, `holdCredits`/`releaseHold`, `appendLedger`; the relay holds (`computeHold`) then settles (`computeFinalCost`) with idempotent settle keyed on jobId. **The ledger is the source of truth for spend.**
- **Binding precedent**: `api_key.route_group_id` (nullable FK → fallback to default). Limit-plan binding mirrors this.
- **`webhook_outbox`**: existing outbound webhook channel — reused for alerts.
- **Money**: integer µUSD throughout (`packages/domain/src/credits.ts`); 1 credit = $1 = 1e6 µUSD.

## Scope

**In:** plan/rule data model; key + tenant binding; `GovernanceGuard` enforcement for spend / requests / tokens / rpm / concurrency; calendar (day/month), rolling (24h/30d), and total periods; optional per-model scoping of a rule; threshold alerts (row + webhook); operator CRUD UI + usage-vs-cap display; tenant `/app` usage/alert surfacing; contracts/SDK; tests.

**Out (separate specs):** audit trail of who-changed-which-limit (records sub-project); RBAC billing sub-role; double-entry ledger / hold rows; circuit-breaker resilience; subscription/recurring billing; payment-provider credentials; per-rule soft/hard toggle (v1 is hard-only).

---

## ① Data model (migration — new tables + 2 FKs)

**`limit_plan`** — a reusable preset (套餐/档位).

- `id uuid pk`, `name text notNull` (unique among live), `description text`, `status text notNull default 'active'` (active|disabled), `created_at`, `updated_at`, `deleted_at` (soft-delete, mirroring `route_group`).

**`limit_rule`** — one limit; many per plan.

- `id uuid pk`, `plan_id uuid notNull → limit_plan(id)`,
- `dimension text notNull` — `spend | requests | tokens | rpm | concurrency`,
- `period text` — `day | month | rolling_24h | rolling_30d | total` for spend/requests/tokens; **`minute`** is implied for `rpm`; **null** for `concurrency` (instantaneous). Validation enforces the dimension↔period pairing in the contract + a CHECK.
- `cap bigint notNull` — **µUSD** for `spend`; integer count for `requests`/`tokens`; RPM for `rpm`; max in-flight for `concurrency`. (`>= 0`.)
- `model_scope text` (nullable) — when set, the rule only applies to requests naming that `model`.
- `alert_pct integer` (nullable, 1–100) — emit an alert when usage crosses this % of `cap`.
- `enforce text notNull default 'hard'` (v1 only writes `hard`; column reserved for the future soft option).

**Bindings** (mirror `route_group_id`):

- `api_key.limit_plan_id uuid` (nullable FK → `limit_plan`).
- `account.limit_plan_id uuid` (nullable FK → `limit_plan`) — the tenant-level plan (one `account` per tenant).

**`limit_usage`** — durable materialized accumulator (fast reads + survives Redis flush + reconcile).

- `subject_type text` (`key`|`tenant`), `subject_id text`, `dimension text`, `period_key text` (e.g. `2026-06` month, `2026-06-24` day, `total`), `model_scope text` (`''` when none), `used bigint notNull default 0`, `period_start timestamptz`, `updated_at`.
- `unique(subject_type, subject_id, dimension, period_key, model_scope)`.
- Used for `day`/`month`/`total` spend+requests+tokens. **Rolling windows are NOT materialized** (see §② counters).

**`limit_alert`** — fired threshold crossings.

- `id`, `subject_type`, `subject_id`, `rule_id`, `dimension`, `period_key`, `used bigint`, `cap bigint`, `pct integer`, `created_at`. (Append-only; drives the UI alert list + the webhook payload.)

**Resolution semantics:** a request's effective rule set = the live, active rules of (the key's plan) **∪** (the tenant/account's plan). A `model_scope` rule is included only when the request names that model. **All matching rules must pass (AND)** — the first failing rule rejects. A subject with no plan = unlimited (backward-compatible; today's behavior).

## ② Enforcement

**`GovernanceGuard`** (`apps/api/src/auth/governance.guard.ts`), declared **after** `ApiKeyGuard`, **replacing/superseding** today's `RateLimitGuard` on the relay routes (it subsumes RPM + model RPM). It loads the effective rules (small TTL cache keyed by key-id+tenant, like the existing model-limit cache) and, per rule:

- **`rpm`** → existing `RateLimiter.take('rl:<subject>:<scope>', cap)` per minute → **429** `rate_limited` (+ `retry_after_ms`).
- **`concurrency`** → Redis in-flight counter: `INCR` an `inflight:<subject>[:model]` key on entry; if `> cap` → `DECR` + **429**; otherwise register a `DECR` on response finish (`finally`). (A short safety TTL guards against leaked decrements.)
- **`requests`** → period counter (see counters): check-then-incr; at/over `cap` → **402** `quota_exceeded`.
- **`tokens` / `spend`** → cost/tokens are unknown pre-request, so **pre-check only**: if the current period usage `>= cap` → **402** (`quota_exceeded` / `budget_exceeded`). The accrual happens at settle. (A request may overshoot the cap by at most one call — the same "deny once exhausted" semantics as the credit balance; acceptable for v1.)

**Settle hook** (in the existing settle path — the relay/worker code that writes the settle ledger row — in the same DB transaction): for every matching rule's subject/period, increment `limit_usage` by the final µUSD cost (`spend`) and token counts (`tokens`); then evaluate `alert_pct` crossings (§③). `requests` was incremented pre-request. **Spend is reconciled against the ledger** (the ledger is authoritative; `limit_usage.spend` is a materialized sum updated in the same transaction as the settle ledger row).

**Counters / storage by period:**

- `day` / `month` / `total` → **`limit_usage`** row (durable; one UPSERT per settle), read directly (hot, indexed). `total` never resets.
- `rolling_24h` / `rolling_30d` → **windowed aggregate** over `usage_log` (requests/tokens) and the ledger (spend) for `[now-window, now]`, behind a short (e.g. 30–60 s) Redis cache. (More expensive; not materialized. Flagged as the slow path.)
- `rpm` → existing Redis fixed-window limiter. `concurrency` → Redis in-flight counter.

**Errors:** reuse `engineRateLimited` (429 + `retry_after_ms`) for rpm/concurrency; add `engineBudgetExceeded`/`engineQuotaExceeded` → **402** with `{ dimension, period, cap, used }` in the unified error body.

## ③ Alerts

At settle/accrual (and at request-count incr), when a counter crosses `alert_pct` of `cap` for the first time in that period: insert a `limit_alert` row and enqueue a `webhook_outbox` event (`limit.alert`, payload = subject, dimension, period, used/cap, pct). Idempotent per (subject, rule, period_key, pct) so it fires once per period. Low-balance reuses the same mechanism (a virtual `spend`-vs-balance threshold). **Soft only — never blocks.**

## ④ Frontend (计费与路由 group)

- **「额度套餐」 page** (`/console/limit-plans`, new nav item in the billing group): list plans (name, status, rule count, bound key/tenant counts); a plan editor = plan fields + an editable `limit_rule` list (dimension select → period select constrained by dimension → cap input with unit hint µUSD/credits vs count vs rpm → optional model scope → optional alert %). Reuse `DataTable`/`Drawer`/`FilterMenu` conventions.
- **Bind a plan**: a plan picker in the API-key editor and in the tenant detail drawer (mirroring the route-group binding UI).
- **Usage vs cap**: on the key/tenant views, render progress bars (current period `used` / `cap`) per active rule, sourced from a new `GET /admin/limits/usage?subject=…` endpoint.
- **Tenant `/app`**: budget/quota progress + low-balance/over-threshold alert banner (reads the tenant's own usage + alerts).

## ⑤ Contracts / SDK

zod views + CRUD DTOs for `limit_plan` (+ nested rules), the bindings, and the usage/alert read views → `gen:openapi` → `@actionow/sdk gen`. Admin endpoints: `GET/POST/PATCH/DELETE /admin/limit-plans`, `GET /admin/limits/usage`, `GET /admin/limits/alerts`, and `limit_plan_id` on the key/tenant update DTOs. Per the existing pattern, admin-only reads not in the SDK use `rawClient`.

## ⑥ Testing

- **Repo**: plan/rule CRUD; effective-rule resolution (key ∪ tenant, model_scope match, AND); `limit_usage` UPSERT + period_key bucketing; rolling-window aggregate.
- **Guard**: each dimension rejects at cap (429 rpm/concurrency, 402 requests/tokens/spend); no-plan = unlimited; model_scope only applies to the named model; cache invalidation.
- **Settle hook**: spend/token accrual matches the ledger; alert fires once per period at threshold.
- **Contracts**: view fixtures (+ new fields); dimension↔period validation.
- **Regression**: the existing `RateLimitGuard` behavior is preserved (or fully migrated into `GovernanceGuard`) — the per-tenant/resource/model RPM e2e stays green.
- Live-verify in preview: create a plan with a small spend cap, bind to a key, exhaust it → 402; cross alert_pct → alert row + webhook.

## ⑦ Migration & rollout

- One additive migration: `limit_plan`, `limit_rule`, `limit_usage`, `limit_alert` + `limit_plan_id` on `api_key` and `account`. No backfill — absent plan = unlimited, so existing traffic is unaffected.
- `GovernanceGuard` replaces `RateLimitGuard` on the relay routes; if no plan is bound it falls back to today's env-default RPM buckets (zero behavior change until an operator creates+binds a plan).

## Phases

1. **Data + repos**: tables/migration + `limit_plan`/`limit_rule`/`limit_usage`/`limit_alert` repos + effective-rule resolver + tests.
2. **Contracts/SDK + admin CRUD**: views/DTOs, endpoints, bindings on key/tenant.
3. **GovernanceGuard**: enforcement for all five dimensions (subsuming RateLimitGuard) + counters; regression gate.
4. **Settle accrual + alerts**: settle hook accrues `limit_usage`, fires `limit_alert` + webhook.
5. **Frontend**: 额度套餐 page + plan binding + usage bars + tenant `/app` surfacing.
