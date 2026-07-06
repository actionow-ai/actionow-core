# 04 · Billing, wallets & governance limits

Actionow meters every billable call in credits and enforces per-subject budgets and rate limits. Your app decides _whether/when to charge your own user_; Actionow only tracks credits spent against its wallets.

## Money: µcredit, always

- `1 credit = 1_000_000 µcredit`. Internally credits are big integers.
- **Response money is a µcredit decimal STRING** (e.g. `cost.credits === "1500"`). Parse with `BigInt`, never `Number` (a JS float silently loses precision).
- **Request money is a human number** in the field's documented unit — e.g. a top-up's `amount_minor` is an integer count of the currency's _minor_ unit (cents, fen).

```js
const credits = BigInt(job.cost.credits); // µcredit
const usd = Number(credits) / 1_000_000; // display only
```

## Two-level wallets

```
        redeem 卡密 / payment intent
                  │
          ┌───────▼───────┐
          │  TENANT POOL  │   your master balance
          └───────┬───────┘
      allocate (conserving — never minted)
     ┌────────────┼────────────┐
 subject A     subject B     subject C (no sub-wallet → spends the shared pool)
 sub-wallet    sub-wallet
```

- **Tenant pool** — one per tenant (your master balance).
- **Per-subject sub-wallet** (HARD mode, optional) — a subject without one spends directly against the pool.
- On the tenant console plane **both `/sub-account/topup` and `/sub-account/transfer` are conserving**: every µcredit entering a sub-wallet is atomically drawn from your tenant pool (`transfer` also moves the other way via `direction: to_subject | to_tenant`). If the pool is short the call fails with `400 invalid_input` — fund the pool (payments / redeem) _before_ allocating to subjects. Only the platform `/admin` plane can mint credit.

## Funding (control plane, USER JWT)

| Goal                                      | Route                                             | Body                                                                               |
| ----------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------- |
| Top up pool with a redemption code (卡密) | `POST /console/redeem`                            | `{ code }` → `{ credited, balance }` (µcredit strings; `balance` = new pool)       |
| Top up pool via payment                   | `POST /console/payments/intents`                  | `{ provider, amount_minor, currency }` → `{ intent_id, redirect_url?, qr? }`       |
| Open a subject sub-wallet                 | `POST /console/subjects/:id/sub-account/open`     | `{ credits? }` (human)                                                             |
| Allocate credits to a subject             | `POST /console/subjects/:id/sub-account/topup`    | `{ credits }` (human)                                                              |
| Move credits pool ↔ subject               | `POST /console/subjects/:id/sub-account/transfer` | `{ credits, direction: "to_subject"                                                | "to_tenant" }` |
| Read a subject's balance                  | `GET /console/subjects/:id/sub-account`           | → `{ id, tenant_id, subject_id, credit_balance, credit_held, status, created_at }` |

The sub-account read returns money as **`credit_balance` / `credit_held`** (µcredit decimal strings) — not `balance` / `held`. A sub-wallet has `status` `active` | `disabled`; a **disabled** sub-wallet blocks holds (calls fail rather than silently falling back to the pool). If the subject has **no sub-wallet, this endpoint 404s — that's SHARED (pool) mode, not an error**; the subject spends the tenant pool, which you check via `GET /console/balance` → `{ balance, held }`.

The data-plane equivalents for a self-service payment (`POST /v1/payments/intents` — note this one _does_ take a required `purpose` field, and also returns `{ intent_id, redirect_url?, qr? }`; `GET /v1/payments/intents/:id`) exist for apps that let the end-user pay directly. Provider webhooks land at `POST /v1/payments/webhooks/:provider` (signature-verified; you don't call it).

## How a call is billed: hold → settle

1. **Hold** — before running, Actionow estimates the cost and reserves that many µcredit on the charged wallet (subject sub-wallet if present, else pool). If the balance can't cover it → **`402 insufficient_credits`** (thrown _before_ any streaming byte). **Streaming chat holds are sized from an over-estimate**: `max_tokens` if you send it, else a 32,768-output-token ceiling, plus roughly `promptBytes / 4 × 2` prompt tokens, all at the model's rates. Send `max_tokens` to shrink the hold, and size sub-wallet balances to cover the **hold** of your most expensive streamed call — not just its expected settle. The over-hold is refunded at settle.
2. **Settle** — on success, the hold is released and the _final_ cost debited. One append-only ledger row is written. Caveat: **streaming and media/STT settles are capped at the hold** (media/STT also floored at a `minimumHold` so a call never bills 0 improperly), but **blocking (non-streaming) chat prices at settle-time and is not capped** (its hold is floored at 0). So don't size a budget off a blocking-chat pre-flight hold — it can settle higher.
3. **Fail / cancel** — the hold is released, nothing is charged.

Settlement is idempotent (guarded by status transition) — a client disconnect mid-stream still settles exactly once and never double-charges.

## Governance limits (rate / spend / token caps)

**Baseline always-on rate limits** apply independently of limit plans: by default **600 req/min per tenant** and **120 req/min per API key** (a per-key `rateLimit` overrides the key default; both are operator-tunable via `/admin/settings`), plus optional per-model RPM caps. Breaching any of these → `429 rate_limited` with `retry_after_ms`.

Separate from wallets. Define a reusable **limit plan** (a set of rules) and bind it to a subject. The subject's `ak_…` is then automatically limited.

```
POST   /console/limit-plans                 { name, rules:[…] }   → { id, … }
GET    /console/limit-plans                                       → list
GET    /console/limit-plans/:id
PATCH  /console/limit-plans/:id             { rules:[…] }         → REPLACES the whole rule set
DELETE /console/limit-plans/:id                                  → 204 (soft-delete)
POST   /console/subjects/:id/limit-plan     { planId }           → bind ({ ok:true }); planId:null unbinds
GET    /console/subjects/:id/limit-status                        → live usage vs caps
```

Each **rule** is `{ dimension, period?, cap, modelScope?, alertPct? }`:

- `cap` is a **base-unit integer on the way IN** (µUSD for `spend`, a plain count otherwise) but serializes as a **decimal string on the way OUT**.
- `period` is constrained by dimension: `rpm` requires `period:"minute"`; `concurrency` takes no period; accumulating dims (`spend`/`requests`/`tokens`) take `day`/`month`/`rolling_24h`/`rolling_30d`/`total`.
- `modelScope` (optional) limits the rule to one model; `alertPct` (1–100, optional) fires a soft alert at that fraction of the cap.

Dimension → breach behavior:

| Dimension     | Meaning             | On breach                               |
| ------------- | ------------------- | --------------------------------------- |
| `spend`       | µUSD budget         | `402 insufficient_credits`              |
| `requests`    | request count       | `402 insufficient_credits`              |
| `tokens`      | LLM token budget    | `402 insufficient_credits`              |
| `rpm`         | requests per minute | `429 rate_limited` (+ `retry_after_ms`) |
| `concurrency` | in-flight requests  | `429 rate_limited`                      |

Periods: `minute`, `day`, `month`, `rolling_24h`, `rolling_30d`, `total`, or `null` (instantaneous, for `concurrency`). **Every rule hard-enforces in v1** (`enforce` is reserved and cannot be set via the API); `alertPct` is the only soft mechanism — it fires an alert at that fraction of the cap while the cap itself still enforces.

Two breach subtleties: **concurrency-limit 429s carry `retry_after_ms: 0`** — there's no timed window, so back off until one of your in-flight requests completes. And `spend`/`tokens` caps are **pre-checked but accrue at settle**: the call that crosses the cap succeeds, and only the _next_ call gets `402` — budgets can overshoot by one call.

## Checking balance & usage

- **End-user (Model-A):** `GET /member/balance`, `GET /member/usage`, `GET /member/limits`.
- **Your app (per subject):** `GET /console/subjects/:id/sub-account` (balance; 404 = no sub-wallet → shared-pool mode, read `GET /console/balance` instead) and `GET /console/subjects/:id/limit-status`.
- **Reconcile spend:** relay calls (chat / embeddings / rerank / moderation / STT) and media jobs write `usage_log` rows with the final `cost`, listable via the console usage endpoints — but generic `/v1/run` calls appear **only in the ledger**, so reconcile against the ledger for completeness.

**Design tip:** watch for `402` and pre-emptively top up (or block your user) rather than letting calls fail. Treat `402` as _not retryable_ until you add credits; treat `429` as retryable after `retry_after_ms` (a concurrency-limit `429` has `retry_after_ms: 0` — retry once an in-flight request finishes). Remember `spend`/`tokens` caps overshoot by one call: the crossing call succeeds and the next one 402s.
