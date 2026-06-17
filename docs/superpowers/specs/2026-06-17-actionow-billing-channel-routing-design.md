# Actionow Billing & Channel-Routing Redesign — Design Spec

> Status: **DESIGN ONLY** (no code). Supersedes the ad-hoc per-model pricing for the
> areas below. Implementation is a separate, multi-track effort (gate per track, like
> the hardening plan). Authz model is unchanged.

## Goal

Introduce a **group (分组)** tier and a **USD-anchored money unit** so the operator can:

1. Bind an API key to a **group**; the group scopes which channels the key may use.
2. Serve one model from **multiple channels in a group as a priority-tiered fallback chain** (different fallback → different upstream → possibly different result).
3. Pin **"this route always uses channel X at a fixed price"** = a single-channel group.
4. Price per **(model × group)** deterministically — `price = base_model_price × group_ratio` — while channels handle failover and the operator tracks per-channel **cost/margin**.
5. Keep a curated **official model price table** (your cost basis) that auto-prices models discovered via a channel's `/models` sync.

Two open-source references were studied at source level:

- **new-api** (QuantumNous/new-api, one-api lineage): channel-centric + **group** abstraction; `token.group` selects channels; `abilities(group,model,channel)` index; priority-tiered weighted failover; pricing `group_ratio × model_ratio × (...)`, **per-(model,group), never per-channel**; "fixed channel + fixed price" = single-channel group. ← we adopt this group model.
- **sub2api** (Wei-Shaw/sub2api): account-pool-centric; key→**one** group (1:1); intra-group account failover, **no** cross-model fallback; per-group multiplier; **per-model price table only covers 3 providers, others bill 0** (issue #1211) — a cautionary tale that motivates our official price table + "unmatched ⇒ needs_pricing, never bill 0".

---

## Locked decisions

| #   | Decision                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Money unit = micro-USD (µUSD = 1e-6 USD).** `1 credit = $1`. Balances/charges/ledger/usage all integer µUSD (bigint, int64-safe to ~$9.2e12).                                                                                                           |
| D2  | **Model price unit = µUSD per 1M tokens** (official `$X/1M` → `X×1e6`, exact integer). Cost = `round_half_up(tokens × ratePer1M / 1_000_000)`.                                                                                                            |
| D3  | **Ratios = integer basis points** (`10000 = 1.0×`). No floats for money, ever.                                                                                                                                                                            |
| D4  | **`group_ratio` is per-group, default `1.0` (10000 bps).** Per-`(group,model)` price override = OPTIONAL future extension (table designed-for, not required for v1).                                                                                      |
| D5  | **Group is an orthogonal access+pricing+fallback tier layered over the existing `model→resource→channels` routing** — we do NOT rewrite to new-api's resource-less ability model (Actionow's resource/io_schema carries async-media/dify, which we keep). |
| D6  | **Customer price is fully determined pre-routing** (key→group→group_ratio + model→base price). The served channel affects **cost/margin only**, not price → the hold is deterministic (resolves the earlier per-channel-pricing non-determinism).         |
| D7  | **official_model_price** is a global, admin-curated table; seeded initially by a web search (I produce a draft), maintained manually; the `/models` sync auto-assigns matched prices; **unmatched models → `needs_pricing` + disabled** (never bill 0).   |

---

## Concepts & data model

### New: `route_group` (the "group/分组")

Global, operator-defined access + pricing tier. (Table named `route_group` to avoid the `GROUP` reserved word; referred to as "group" in UI/prose.)

```
route_group {
  id            uuid pk
  name          text  unique (partial, where deleted_at null)
  group_ratio_bps integer not null default 10000   -- 1.0× ; the customer-price knob
  status        text not null default 'active'      -- active|disabled
  description   text
  created_at, updated_at, deleted_at (tz)
}
```

A well-known seed group `default` (ratio 10000) always exists; a key with no group falls back to it.

### New: `route_group_channel` (membership + per-(group,channel) routing knobs)

```
route_group_channel {
  group_id    uuid -> route_group.id
  channel_id  uuid -> upstream_channel.id
  priority    integer not null default 0   -- HIGHER = tried first (fallback tier)
  weight      integer not null default 1   -- weighted-random within a priority tier
  PK (group_id, channel_id)
  index (group_id), index (channel_id)
}
```

Per-(group,channel) priority/weight lets a channel be primary in group A and fallback in group B. (`upstream_channel.weight` stays as a default for any legacy/resource-level path.)

### New: `official_model_price` (your cost basis; admin-curated)

```
official_model_price {
  id            uuid pk
  provider      text not null               -- 'openai' | 'anthropic' | 'google' | ...
  model_slug    text not null               -- normalized canonical slug
  display_name  text
  input_price_per_1m   bigint not null       -- µUSD per 1M input tokens  ($X/1M × 1e6)
  output_price_per_1m  bigint not null       -- µUSD per 1M output tokens
  cached_input_price_per_1m bigint           -- optional
  source_url    text                         -- where the price was read
  effective_at  timestamptz                  -- provider's stated effective date
  notes         text
  updated_by    text                         -- audit (admin id/email)
  created_at, updated_at, deleted_at (tz)
  unique (provider, model_slug) partial where deleted_at null
}
```

### Optional future: `route_group_model_price` (per-(group,model) override)

```
route_group_model_price { group_id, model_id, input_price_per_1m, output_price_per_1m, PK(group_id,model_id) }
```

When present for the served (group, model), it REPLACES `base × group_ratio` for that pair. Not built in v1 (D4); the schema slot is reserved so adding it later is additive.

### Altered existing tables

- **`api_key`**: add `route_group_id uuid` (FK `route_group`, nullable → `default` group). The key's group scopes routing + sets the price ratio.
- **`model`**:
  - `input_price` / `output_price` **semantics change** to **µUSD per 1M tokens** (was "µcredit per token"). Requires a one-time rescale (see Migration).
  - add `needs_pricing boolean not null default false` (set when sync found no official match). Such a model is created **disabled**.
- **`upstream_channel`**: add `input_cost_per_1m bigint` / `output_cost_per_1m bigint` (µUSD/1M; the operator's ACTUAL cost on this channel — direct provider ≈ official, codex-oauth ≈ 0). Used for margin only, never for the customer price.
- **`usage_log`**: add `provider_cost bigint` (µUSD, the served channel's cost for this call) so `margin = cost − provider_cost` is queryable per request/channel/group.
- **`account` / `ledger_txn`**: balances/amounts reinterpreted as µUSD (rescale).

---

## Pricing model (the layered chain)

```
official_model_price ($X/1M → ×1e6 = µUSD/1M)
   └─►(sync auto-assign) model.input_price/output_price  (µUSD/1M, base = your cost basis)
        └─► × route_group.group_ratio_bps / 10000        (the per-group customer markup; default 1.0)
              = CUSTOMER PRICE (µUSD/1M)
served upstream_channel.{input,output}_cost_per_1m  ──► provider_cost (µUSD)  ──► margin = cost − provider_cost
```

**Settle (chat), all integer µUSD:**

```
base   = in_tok × model.input_price_per_1m + out_tok × model.output_price_per_1m   // µUSD·(per-1M units)
cost   = round_half_up(base / 1_000_000 × group_ratio_bps / 10000)                 // customer charge, µUSD
provider_cost = round_half_up((in_tok×ch.input_cost_per_1m + out_tok×ch.output_cost_per_1m) / 1_000_000)
```

- The existing `model_token` pricebook method + `computeFinalCost` settle path is reused; the only change is (a) the unit is µUSD/1M, (b) the `group_ratio` multiply (a `Modifier`-style or a first-class factor), (c) the parallel `provider_cost` computation for the served channel → `usage_log`.
- **Hold sizing stays deterministic**: price depends only on (model, group) — both known at request time from the key — so the hold = `estimated_usage × customer_rate` exactly. The served channel does not change the price.
- `/v1/run` (media/dify) pricebook (resource-scoped) is unchanged except for the µUSD re-anchor; `group_ratio` may optionally apply to it too (decision: apply group_ratio uniformly at settle for both chat and run).

---

## Routing + fallback chain (兜底链)

For a request `(model_name, api_key)`:

1. `group = api_key.route_group_id ?? default`.
2. `resource = resolve(model_name).resourceId` (unchanged model→resource resolution).
3. `candidates = channels(resource) ∩ route_group_channel(group)` (active, `deleted_at IS NULL`, `channel_health` not cooled).
4. Order by `route_group_channel.priority DESC`, then weighted-random by `route_group_channel.weight` within a tier.
5. **Failover cascades to the next-lower priority tier** on a retryable adapter error (reuse P0a `orderForFailover`/`routeWithFailover` + the engine's blocking/stream failover) — re-rolling the weighted pick within each tier.
6. The served channel id is recorded (already threaded to `usage_log.channel_id`, P1b) + drives `provider_cost`.

- **"固定走某渠道 + 固定收费"** = a group whose `route_group_channel` has exactly one channel, with that group's `group_ratio` (and/or a future per-(group,model) override) pinning the charge.
- Empty candidate set (model not offered in the key's group) → `not_found`/`forbidden` (the group gates access, like new-api).

---

## Official price seeding + auto-match on `/models` sync

1. **Seed (one-time, assisted):** I web-search current official prices (OpenAI / Anthropic / Google / …), produce a draft `official_model_price` set ($X/1M → µUSD/1M), admin reviews + records (with `source_url`/`effective_at`).
2. **Maintain:** admin edits as providers change prices; optional "diff against latest" report (I re-search on request).
3. **Sync auto-price** (extends the existing `sync-models`): for each slug from `adapter.listModels()`:
   - match `(provider, normalize(slug))` against `official_model_price` (normalize = lowercase, strip date suffix `-YYYY-MM-DD`, apply an alias map e.g. codex `gpt-5.5`→its official counterpart).
   - **match → assign** `model.input_price/output_price` from the official row (µUSD/1M).
   - **no match → create the model `disabled` with `needs_pricing=true`** (never 0-priced/billable).
   - **never overwrite** a price an admin already tuned (continue the sync rule "new→assign, existing→preserve"); a separate explicit "re-apply official prices" action can backfill.

---

## Mapping to current Actionow (what changes)

| Today                                                          | After                                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `api_key.resourceAllowlist` gates per-resource                 | + `api_key.route_group_id` gates per-group (the primary access+price tier); allowlist can remain as a finer filter |
| `model.inputPrice/outputPrice` = µcredit/token, per-model only | = µUSD/1M; base cost basis (auto from official table); customer price = base × group_ratio                         |
| `upstream_channel`: weight, no priority, no group              | + membership in `route_group` with per-(group,channel) priority/weight; + optional `*_cost_per_1m` for margin      |
| routing: model→resource→channels (weighted+failover)           | same, **filtered by the key's group** + priority-tiered fallback                                                   |
| money: µcredit (via CREDIT_RATE)                               | µUSD (1 credit=$1); CREDIT_RATE retired/fixed                                                                      |
| no per-channel cost/margin                                     | `usage_log.provider_cost` + channel cost columns → margin analytics                                                |

---

## Migration impact (additive where possible; one re-anchor)

- **New tables**: `route_group`, `route_group_channel`, `official_model_price` (+ reserved `route_group_model_price`). All additive.
- **Altered**: `api_key.route_group_id`, `model.needs_pricing`, `upstream_channel.*_cost_per_1m`, `usage_log.provider_cost` — additive columns.
- **Re-anchor (the one non-additive bit)**: reinterpret existing µcredit amounts (account balances/held, ledger, usage_log.cost) and model prices into µUSD + µUSD/1M. Dev DB has only seed data → **reset + re-seed** is acceptable; no production data exists. Document the scale factor and retire `CREDIT_RATE`.
- **Backward-compat / BREAKING**: model price semantics change (µcredit/token → µUSD/1M); display/console show USD; the admin frontend must read USD + the new group fields. Acceptable pre-1.0.
- **Seed**: seed creates the `default` group (ratio 10000) and binds the seeded key to it; the codex channel joins a group.

---

## Determinism, safety, edge cases

- **Price determinism**: guaranteed (price = f(model, group), both known from the key pre-routing). Channel choice ≠ price.
- **Never bill 0**: unmatched/needs_pricing models are disabled until priced.
- **Integer-only money**: µUSD amounts + bps ratios; single round-half-up at settle (matches existing markup rounding).
- **Subscription channels (codex)**: no per-token official $ price → official table holds an "equivalent API reference price" as the customer base; channel `*_cost_per_1m ≈ 0` → margin ≈ full price.
- **Group cache coherence** (new-api lesson): changing a channel's group membership must invalidate any routing cache; keep routing a live DB query or add an explicit "rebuild routing index" action.
- **`auto`-group cross-group fallback** (new-api feature) = OUT OF SCOPE for v1 (single group per key).

---

## Out of scope (v1)

- Per-`(group,model)` price override (`route_group_model_price`) — designed-for, deferred.
- `auto` group / cross-group fallback; multi-group keys (sub2api #728-style) — single group per key for v1.
- Non-USD settlement currency / FX (handle at the topup boundary only if needed later).
- Fixed per-call (not per-token) pricing (new-api `model_price` mode) — deferred.

---

## Implementation tracks (when approved → turn into a plan)

1. **Money re-anchor to µUSD** (units, rescale, retire CREDIT_RATE, display) — foundational.
2. **official_model_price** table + admin CRUD + web-seeded draft + matcher; wire into `sync-models` (auto-price, needs_pricing).
3. **route_group + membership** schema + admin CRUD; `api_key.route_group_id`; seed `default` group.
4. **Group-scoped routing + priority-tiered fallback** in the engine (filter by group, per-(group,channel) priority/weight; reuse P0a failover).
5. **Pricing**: `group_ratio` factor at settle (chat + run) + `provider_cost`/margin in usage_log + channel cost columns.

Each track: TDD, gated, merged before the next (migrations sequential).
