# 路由染色 + 标签路由 (Route Tagging) — Design Spec

> First piece (**R**) of ⑤ 路由深度+前端打磨, the last sub-project of 计费与路由. Adds **channel tags** + a per-request **canary header** that hard-pins a request to channels carrying a given tag — unifying 流量染色 (traffic coloring) and 标签路由 (tag routing). The chosen tag is recorded on the call's records (`relay_trace` + `usage_log`) so canary traffic is filterable/analyzable.
>
> Scope note: a 4-agent exploration found two originally-listed ⑤ items are **already shipped** — the pricebook/official-prices UI is fully real (not mock; the memory was stale) and plugin channels are already routable+executable. The remaining ⑤ pieces are **R (this spec)**, **S streaming 模型降级**, and **P 前端打磨 (bulk endpoints + audit/version badges)** — each its own spec→plan→ship cycle.

## What exists today (build on, don't duplicate)

- **Routing inputs:** `candidatesFor(resourceId, routeGroupId, modelId?)` (`apps/api/src/common/channel-routing.service.ts`) assembles the candidate set from the key's `route_group` (priority/weight tiers) + `fallback_group_id` chain (`listCandidateChannelsWithFallback`) + model-link demotion (`UNLINKED_PRIORITY_OFFSET`); the engine then excludes Open breakers and runs weighted failover (`packages/engine/src/channel-routing.ts`).
- **No per-request routing override exists.** `ApiKeyGuard` reads only the key/headers for auth; routing is fully pre-authenticated (the key's bound group). No `x-channel`/`x-route`/canary header is honored anywhere.
- **Tags:** `model.tags text[]` exists (faceting only, never gates routing); `upstream_channel` and `route_group` have **no** tags column.
- **Records:** `relay_trace` (`packages/db/src/schema/relay-trace.ts`) is the per-upstream-call audit (one row per attempt, written by `TracingHttpClient`); `usage_log` (`packages/db/src/schema/usage.ts`) is the per-settled-run mirror (`mirrorUsageLog`). Both carry `tenant_id`/`channel_id`/`subject_id`.
- **Model tags UI precedent:** the model editor has a multi-tag chips input + the catalog list has faceted filtering (P1–P3) — mirror it for channels.
- Latest migration = **0048**. Schema barrel: `export * from './X.js'`.

## ① Behavior

- **Header:** `X-Actionow-Route-Tag: <tag>` (a single tag, v1). Absent → behavior is completely unchanged (no coloring).
- **Hard pin:** when present, the request routes **only** to channels whose `tags` contain `<tag>` — still subject to the existing breaker/health exclusion, failover, same-channel retry, and billing (all unchanged).
- **Narrow-only (no escalation):** the tag filter is applied **on top of** the key's already-resolved candidate set (group + fallback + model-link). It can only RESTRICT — a caller can never reach a channel they couldn't already route to. Therefore any caller may use the header with no extra gating.
- **Zero match → hard fail:** if no channel in the resolved candidate set carries `<tag>`, throw `engineInvalidInput` → HTTP 400 `no channel matches route tag "<tag>"`. (If tag-matched channels exist but are all Open/cooled, the engine exhausts them and throws as it does today for an exhausted candidate set — no silent leak to non-tagged channels.)
- **Observability coloring:** the chosen tag is recorded as `route_tag` on **`relay_trace`** (per upstream call) AND **`usage_log`** (per settled run), so canary traffic is filterable (traces) and aggregatable (cost/latency/availability).

## ② Architecture & data flow (Approach A — filter at the candidate-resolution layer)

1. **Parse:** the relay entrypoints — chat (`chat-relay.service.ts`), `/v1` relay, and media-dialect — read `X-Actionow-Route-Tag` from the request and pass `routeTag` into their run-request builder (empty → skip the whole feature).
2. **Intersect:** `candidatesFor(resourceId, routeGroupId, modelId, routeTag?)` assembles the candidate set as today, then — when `routeTag` is set — keeps only channels whose `tags` include it. The narrow-only property is automatic because the filter runs on the already-resolved set.
3. **Zero match → throw** `engineInvalidInput`.
4. **Thread + color:** `RunRequest.routeTag` flows into the engine; the `relay_trace` sink records it per attempt and `mirrorUsageLog` records it on the settled `usage_log` row.
5. Everything else (breaker, cross-group failover, same-channel retry/fault-policy, pricing) is unchanged.

**Safety:** coloring only NARROWS candidates, never widens; unaffected for header-less requests; `routeTag` is a channel-filter + a record field only — it never enters a URL and never participates in an authorization decision.

## ③ Data model (migration 0049)

- `upstream_channel.tags text[] NOT NULL DEFAULT '{}'` (mirrors `model.tags`).
- `relay_trace.route_tag text` (nullable).
- `usage_log.route_tag text` (nullable).

**Repos:**

- The channel candidate queries (`listGroupChannelsForResource`, `listChannels`, `listCandidateChannelsWithFallback` in `packages/db/src/repositories/`) add `tags` to their channel-row selection so `candidatesFor` can filter.
- `candidatesFor` gains a `routeTag?: string` param + the intersect filter + the empty→`engineInvalidInput` throw.
- `RunRequest` gains `routeTag?: string`; the engine threads it into the `relay_trace` insert and `mirrorUsageLog`.
- Channel admin create/update repos accept `tags`.

## ④ Contracts

- `ChannelView` + `tags: z.array(z.string())`; channel create/update request bodies + `tags?` (admin).
- `RelayTraceView` + `route_tag: z.string().nullable()`.
- `UsageLogView` + `route_tag: z.string().nullable()`.
- `gen:openapi` → SDK regen. (The header is not a contract body — the relay entrypoints read it directly.)

## ⑤ Admin / frontend

- **Channel editor:** a multi-tag chips input (mirror the model-tags editor); channel cards show tag chips.
- **中转追踪 page (`RelayTracesPage`):** add a `route_tag` column + filter — the place to _see_ colored/canary traffic.
- **Channel-list tag faceting:** nice-to-have (mirror the model catalog facets); optional for v1.
- i18n: new strings in BOTH zh-CN and en.

## ⑥ Testing

- `candidatesFor` unit/int: tag intersect keeps only matching channels (narrow-only — a tag the key can't reach yields empty, not escalation); empty set → `engineInvalidInput`; no `routeTag` → candidate set unchanged.
- e2e: a request with `X-Actionow-Route-Tag=canary` routes only to the canary-tagged channel; a non-matching tag → 400; `relay_trace` + `usage_log` rows carry `route_tag`.
- Contracts fixtures: `ChannelView.tags`, `RelayTraceView.route_tag`, `UsageLogView.route_tag`.
- Schema constraint: `channel.tags` defaults to `'{}'`.
- Regression: existing routing/failover/breaker tests stay green (additive; header-less path unchanged).

## ⑦ Phasing (one branch `feat/route-tagging`, phased commits → one PR → squash-merge)

1. **Data + repos + contracts:** mig 0049 (`channel.tags` + `relay_trace.route_tag` + `usage_log.route_tag`); candidate queries select `tags`; channel admin repos accept `tags`; contracts (`ChannelView.tags`, trace/usage `route_tag`, channel create/update `tags`) + SDK regen. No behavior change.
2. **Routing filter:** `candidatesFor` `routeTag` intersect + empty→`engineInvalidInput`; thread `RunRequest.routeTag`; record on `relay_trace` + `usage_log`; engine/unit tests.
3. **Header plumbing:** parse `X-Actionow-Route-Tag` in chat / `/v1` relay / media-dialect entrypoints → `routeTag` into the run-request builder; e2e.
4. **Admin / frontend:** channel editor tags input + card chips; `RelayTracesPage` `route_tag` column/filter; (optional) channel-list faceting; i18n.
5. **Gate:** full typecheck/lint/tests; live-verify; memory; PR.

## Out of scope (future)

Multi-tag headers (AND/OR sets); soft "prefer" mode (v1 is hard-pin only); tag-based pricing/limits; tags on route_groups; per-key/tenant opt-in gating (unnecessary given narrow-only); the other ⑤ pieces (**S** streaming 模型降级, **P** bulk endpoints + audit/version badges).
