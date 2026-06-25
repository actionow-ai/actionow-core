# 弹性 2.0 (Resilience v2) — 有状态熔断器 + 跨组故障转移 — Design Spec

> Fourth sub-project of 计费与路由 (after ① 治理与额度 / ② 记录系统 / ③ RBAC). Upgrades the channel reliability layer from a **binary cooldown** to a real **stateful circuit breaker** (Closed→Open→HalfOpen) keyed per `(channel, model)`, and adds **cross-group failover** so a request cascades to a fallback `route_group` when its primary group's channels are exhausted. Layered on the existing same-channel fault-policy (#13) + cross-channel failover (#14). Codebase mapped by a 4-agent exploration; **buildable on the existing engine deps-injection + routing machinery, low blast-radius.**

## What exists today (build on, don't duplicate)

- **Same-channel retry** — `runWithFaultPolicy` + `wrapHttpWithTimeouts` (`packages/engine/src/fault-policy.ts`); per-channel retry/backoff/4-timeouts/triggers; bound via `upstream_channel.fault_policy_id` → `fault_policy` table (`packages/db/src/schema/fault-policy.ts`).
- **Cross-channel failover** — `routeBlocking` → `routeWithFailover` (`packages/engine/src/channel-routing.ts`, `packages/adapters/src/routing.ts`); weighted, **priority-tiered** iteration over the candidate set (`orderForFailover`); tiers from `route_group_channel.priority`.
- **Binary cooldown (to be replaced)** — `channel_health` table (`packages/db/src/schema/catalog.ts`: `consecutive_failures`, `cooldown_until`, `last_failure_at`); `recordChannelFailure` (exp-backoff 1s→5min cap, 5min reset window, honors `Retry-After`) + `listCooledDownChannelIds` (`packages/db/src/repositories/catalog.ts`); read in `availableChannels`. **No FSM, no controlled probe** — a cooled channel snaps back to full traffic when the timestamp passes.
- **Candidate building** — `ChannelRoutingService.candidatesFor(resourceId, routeGroupId, modelId)` (`apps/api/src/common/channel-routing.service.ts`) → `listGroupChannelsForResource` (`packages/db/src/repositories/route-group.ts`); model-link demotion via `UNLINKED_PRIORITY_OFFSET`. **Cross-GROUP failover does NOT exist** — exhausting a group throws.
- **Health = passive** (#18), derived from `usage_log` (no synthetic probes). All breaker state in **Postgres** (not Redis/in-memory); API single-process; worker = BullMQ repeatable sweeps.
- **Redis** — `createRedis` (`packages/infra/src/redis.ts`) + Lua fixed-window rate limiter & concurrency limiter (`packages/infra/src/rate-limit.ts`). The breaker reuses these patterns.
- **Audit** — `@Audit`/`AuditService` (`apps/api/src/audit/`, [[records-system-v1]]); `actor_type='system'` for system-initiated events.
- **Latest migration = 0046.** Schema barrel: `export * from './X.js'`.

## ① Scope (v1)

**In:** ① stateful circuit breaker (Closed→Open→HalfOpen) and ② cross-group failover. **Deferred (fast-follow):** per-tenant resilience policy (bind a named resilience policy at tenant/key/group — mirror the `limit_plan` binding pattern when needed).

## ② Architecture & data flow (Approach C — PG-state-driven routing read path + Redis for window & trial gating)

**FSM per `(channel, model)`:**

- **Closed** (normal): traffic flows; each outcome increments a Redis sliding window. When window `volume ≥ min_volume` AND `failure_rate ≥ failure_rate_pct` → **Open**.
- **Open** (tripped): the `(channel,model)` is excluded from candidates; after `open_cooldown` (exponential backoff w/ cap, scaled by `trip_count`) → eligible for **HalfOpen**.
- **HalfOpen** (probing): a Redis atomic gate admits only `half_open_trial` real requests; `half_open_successes` consecutive successes → **Closed** (clear window + `trip_count`); any failure → **Open** (cooldown doubled, capped).

**Single relay data flow:**

1. **Route read** — `candidatesFor` first expands the `fallback_group_id` chain (primary group + fallback groups appended at progressively lower priority tiers), then one breaker query excludes `Open` (and trial-exhausted `HalfOpen`) `(channel,model)`.
2. **Attempt** — unchanged `runWithFaultPolicy` (same-channel retry) → `routeWithFailover` (cross-tier/cross-group failover), iterating candidates.
3. **Outcome write** — each upstream result increments the `(channel,model)` Redis window; evaluate trip/close; **on a state transition** write the PG breaker row + emit an `audit_log` row.
4. All candidates exhausted → throw (unchanged).

**Degrade (fail-open, matches existing best-effort philosophy):** Redis unavailable → treat window as empty / never trip; PG breaker read failure → treat all channels available. The breaker only optimizes; it never fails a request that could have succeeded.

## ③ Data model (migration 0047)

### `channel_breaker` (new; runtime FSM state, PK `(channel_id, model)`)

| column                      | type                                    | meaning                                                                               |
| --------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------- |
| `channel_id`                | uuid NOT NULL, FK `upstream_channel.id` |                                                                                       |
| `model`                     | text NOT NULL                           | model name; `'*'` sentinel for model-less resources                                   |
| `state`                     | text NOT NULL default `'closed'`        | CHECK `in ('closed','open','half_open')`                                              |
| `opened_at`                 | timestamptz                             | when it entered Open                                                                  |
| `cooldown_until`            | timestamptz                             | Open→HalfOpen eligibility time                                                        |
| `trip_count`                | int NOT NULL default 0                  | recent consecutive trips → drives exp-backoff cooldown; reset to 0 on HalfOpen→Closed |
| `half_open_successes`       | int NOT NULL default 0                  | consecutive successes accumulated in HalfOpen                                         |
| `last_failure_at`           | timestamptz                             |                                                                                       |
| `last_transition_at`        | timestamptz                             |                                                                                       |
| `created_at` / `updated_at` | timestamptz NOT NULL default now()      |                                                                                       |
| **PK**                      | `(channel_id, model)`                   |                                                                                       |

`channel_health` is **dropped** in the Task-2 follow-on migration (0047 is purely additive — the breaker table/columns land first so the package builds + tests run; the `DROP TABLE` lands once its consumers are repointed, since dropping the table and removing those consumers must happen together). Its cooldown role (`recordChannelFailure`/`listCooledDownChannelIds`) is superseded by the breaker, and its only other consumer — the ops view `listAllChannelsWithHealth` (`packages/db/src/repositories/catalog.ts`) — is repointed to a per-channel rollup of `channel_breaker` (a channel is "degraded" if any of its `(channel,model)` rows is Open/HalfOpen).

### `fault_policy` — new breaker columns (all nullable → fall back to global defaults)

`breaker_enabled` (boolean, default true), `breaker_window_ms` (int), `breaker_min_volume` (int), `breaker_failure_rate_pct` (int, 0–100), `breaker_half_open_trial` (int), `breaker_half_open_successes` (int), `breaker_open_cooldown_ms` (int), `breaker_open_cooldown_cap_ms` (int).

**Global defaults** (constants in `packages/engine`, overridable via env): window 60_000ms, min_volume 20, failure_rate_pct 50, half_open_trial 3, half_open_successes 2, open_cooldown_ms 5_000, open_cooldown_cap_ms 300_000. Used when a channel has no `fault_policy` or the field is null.

### `route_group.fallback_group_id` (new)

uuid nullable, self-referential FK `route_group.id`. Resolver walks the chain with **cycle detection + max depth 5**.

### Redis keys (reuse the Lua fixed-window pattern from `packages/infra/src/rate-limit.ts`)

- Sliding-window approximation: `breaker:win:{channelId}:{model}:{epoch}` with fields `total`/`fail`, TTL = 2×window; failure_rate computed over the current + previous bucket (fixed-window approximation, consistent with the existing limiter).
- HalfOpen trial gate: `breaker:trial:{channelId}:{model}` — atomic counter capped at `half_open_trial`, TTL = cooldown window (mirrors the concurrency limiter).

## ④ Engine integration (concrete landing points)

**`BreakerStore` abstraction** — interface defined in `packages/engine` and injected via engine deps (same pattern as `http`/`adapters`/`resolveSecret`). Redis window+trial impl in `packages/infra`; PG state read/write in `packages/db`; wired at the app layer in `apps/api` (ExecutionService construction) and `apps/worker` (runtime). Interface:

- `filterAvailable(channels, model, now) → routable[]`
- `onSuccess(channelId, model, now)` / `onFailure(channelId, model, now, retryAfterMs?)`

1. **Read path** — `availableChannels(deps, channels, model)` (`packages/engine/src/channel-routing.ts`) calls `breaker.filterAvailable` instead of `listCooledDownChannelIds`. Per `(channel,model)`: `closed`→include; `open` & not past `cooldown_until`→exclude; `open` & elapsed→lazily transition to `half_open` and try to claim a Redis trial slot (include iff claimed — this request is the probe); `half_open`→try to claim a slot. The resolved `model` (`req.usageLogModel` / resource model; `'*'` if none) is threaded from `req` into the routing deps. Store error → include all.
2. **Write path** — in `routeBlocking`'s attempt wrapper (where `recordChannelFailure` is called today): success → `breaker.onSuccess`, retryable failure (`isFailoverRetryable`) → `breaker.onFailure`. Both increment the Redis window and run the FSM; on a transition, write `channel_breaker` + emit `audit_log`. Best-effort (never blocks/rolls back the relay).
3. **Cross-group resolver** — new shared `listCandidateChannelsWithFallback(db, resourceId, groupId)` (`packages/db` repo, used by both `apps/api` `ChannelRoutingService.candidatesFor` and the worker candidate path): walk `fallback_group_id` (cycle guard, max depth 5), concatenate each group's channels, apply a per-hop priority offset (hop 0 = group's own tiers; hop k subtracts `k×OFFSET` so the fallback group sorts strictly below). Composes with the existing model-link `UNLINKED_PRIORITY_OFFSET`.
4. **Audit / observability** — each transition emits `audit_log` (`actor_type='system'`, `action ∈ {breaker.open, breaker.half_open, breaker.close}`, `target=channel`, `meta={model, failure_rate, window, trip_count}`) via `AuditService`. The ops view (`listAllChannelsWithHealth`) shows per-channel breaker rollup (state / last transition / per-model degraded count).

## ⑤ Admin / ops surface

- **容错策略 page** (existing `fault_policy` CRUD) — extend the form + view columns with the breaker threshold fields. Contracts: extend `faultPolicyViewSchema` + create/update request schemas; `gen:openapi` → SDK regen.
- **Route-group editor** — add a `fallback_group_id` selector (dropdown of other live groups). Contracts: route-group view/request add `fallback_group_id`; cycle/depth validated server-side.
- **Breaker status surface** — `GET /admin/breakers` (list `channel_breaker` joined with channel/model names: state, cooldown_until, trip_count, recent window failure_rate) + `POST /admin/breakers/:channelId/:model/reset` (clear back to Closed — ops un-stick). Force-open is out of scope (use the existing channel disable). Web: a 熔断 panel (or a section on the existing health/status page).

## ⑥ Testing

- **Engine unit** (fake clock + fake `BreakerStore`): Closed→Open on rate threshold; no trip below `min_volume`; Open→HalfOpen after cooldown; HalfOpen→Closed on `half_open_successes`; HalfOpen→Open on a failure (cooldown doubled, capped); degrade (store error → all available).
- **Redis window/trial** (real Redis integration, mirroring the rate-limit tests): window counting + trial-slot atomicity.
- **Cross-group resolver** unit: chain expansion + cycle detection + depth cap + tier offsets.
- **e2e**: all primary-group channels Open → request fails over to a fallback-group channel and succeeds.
- **Contracts**: `fault_policy` + `route_group` view/request fixtures with the new fields.
- **Regression**: existing routing/failover/fault-policy tests stay green; `channel_health` removal updates its references/tests.

## ⑦ Phasing (one branch `feat/resilience-v2`, phased commits → one PR → squash-merge)

1. **Data model** — migration 0047 (`channel_breaker` + `fault_policy` breaker columns + `route_group.fallback_group_id`; drop `channel_health`); repos (breaker PG read/write, fallback-chain candidate query); contracts for the new `fault_policy`/`route_group` fields + SDK regen. No behavior change (breaker not yet wired).
2. **BreakerStore** — engine interface + Redis impl (infra) + PG impl (db) + global defaults; FSM unit tests (fake clock/store).
3. **Engine wiring (read + write)** — `availableChannels`→`filterAvailable`, outcome→`onSuccess`/`onFailure`, thread `model`; replace `recordChannelFailure`/`listCooledDownChannelIds`; audit on transitions; engine + e2e tests.
4. **Cross-group failover** — `listCandidateChannelsWithFallback` + wire `candidatesFor` (API) + worker; cycle/depth guards; tests.
5. **Admin / ops surface** — `fault_policy` breaker fields in 容错策略 page; route-group fallback selector; breaker status view + reset endpoint + UI; i18n (zh-CN + en).
6. **Gate** — full typecheck/lint/tests; live-verify; memory; PR squash-merge.

## Out of scope (future)

Per-tenant resilience policy (named policy bound at tenant/key/group); synthetic active probing (worker-driven half-open probe); manual force-open of a breaker (use channel disable); breaker as a hard gate (it stays an optimization, never a deny); cross-region/multi-cluster breaker coordination beyond the shared Redis+PG.
