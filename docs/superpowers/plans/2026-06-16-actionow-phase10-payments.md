# Actionow Phase 10 — 支付 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. `- [ ]` steps. TDD.

**Goal:** A unified payment layer — `payment_intent` + `payment_event` + a `PaymentProvider` abstraction — used for `topup | order | subscription`. **Stripe = fully-working reference** (Checkout Sessions + `constructEvent` webhook); **Alipay / WeChat-Pay APIv3 / crypto(Coinbase Commerce) = configured stubs** with their verify/sign helpers wired. Success → idempotent fulfillment (topup → credit ledger; order → mark paid), all keyed on a per-provider event id.

**Architecture (research-grounded, verified 2026-06):** new package `@actionow/payments` (`PaymentProvider` interface + 4 impls), imports contracts/domain/infra (NOT db). `payment_intent`/`payment_event` schema + repos in `@actionow/db`. A `PaymentService` in `@actionow/engine` orchestrates create→fulfill (reusing the atomic ledger + idempotency-claim). `/v1/payments/*` in `apps/api` (raw-body webhook). Money in integer minor units; currency→credit rate fixed at intent creation.

**Source:** capabilities-expansion spec §Phase 10 + the Phase-10 research brief.

---

## Conventions

- Repo root, branch `feat/phase-10-payments`. TDD; commit per task (lowercase conventional subject). Don't push.
- Strict ESLint, no `any`. **Raw body for webhooks** (reuse the Phase-8 `rawBody:true` already in `main.ts`). Money integer minor units (`bigint`), never floats. No secret/card/key logging.
- Reuse: `topUp` + `appendLedger` + `claimIdempotency` + `creditsToMicro` (credit→µcredit) for fulfillment; `signPayload`/`crypto` for HMAC.

---

## Task 0 — new package `@actionow/payments` + boundaries

Create `packages/payments` mirroring `packages/adapters` shape (package.json `@actionow/payments`, tsconfig + tsconfig.build.json, vitest.config if needed, src/index.ts). Deps: `@actionow/contracts`, `@actionow/domain`, `@actionow/infra`. **Update `eslint.config.mjs`**: add a per-package `no-restricted-imports` block for `packages/payments/**` forbidding `@actionow/{db,adapters,dify,engine}`; add `@actionow/payments`(+`/*`) to the forbid-lists of contracts/domain/db/infra/adapters/dify (they may not import payments); allow `engine` and `apps/**` to import it. Run `pnpm install`; prove a `payments → db` import is rejected by lint, then revert.

---

## Task 1: `PaymentProvider` + Stripe (real) + stubs + payment schema

**Files:** `packages/contracts/src/payment.ts` (types), `packages/payments/src/{types,stripe,alipay,wechat,crypto,registry}.ts`, `packages/db/src/schema/payment.ts` + migration + `repositories/payments.ts`; tests. Deps: `stripe` (real), `alipay-sdk`, `wechatpay-node-v3` (stubs).

- contracts `payment.ts`: `PAYMENT_PROVIDERS=['stripe','alipay','wechat','crypto']`, `PaymentPurpose=['topup','order','subscription']`, `PaymentStatus=['created','pending','succeeded','failed','expired','refunded']`, `CreateIntentInput`, `IntentResult{providerRef, redirectUrl?, qr?}`, `VerifiedEvent{eventId, type, providerRef, status}`, zod schemas.
- payments `PaymentProvider` interface: `kind`; `createIntent(input): Promise<IntentResult>`; `verifyWebhook(rawBody: Buffer|string, headers): Promise<VerifiedEvent>` (throws on bad signature).
  - **stripe.ts (real reference)**: `stripe` SDK; `createIntent` → `stripe.checkout.sessions.create({mode, line_items|price_data, ...})` → `{providerRef: session.id, redirectUrl: session.url}`; `verifyWebhook` → `stripe.webhooks.constructEvent(rawBody, sig, endpointSecret)`; map `checkout.session.completed`/`payment_intent.succeeded` → `{eventId: event.id, type, providerRef: session.id|pi.metadata, status:'succeeded'}`. Idempotency key on create.
  - **alipay.ts (stub)**: `alipay-sdk` v4, RSA2; `createIntent` → `trade.page.pay` (returns a pay URL); `verifyWebhook` → `sdk.checkNotifySignV2(form)` (avoid the passback_params decode bug); throws if false. Behind config (creds unset → `invalid_input`).
  - **wechat.ts (stub)**: APIv3; `createIntent` → Native (`code_url` → qr); `verifyWebhook` → branch on `Wechatpay-Serial` (`PUB_KEY_ID_*`→public-key / else platform cert), SHA256-RSA verify over `timestamp\nnonce\nbody\n`, then AES-256-GCM decrypt `resource` with the APIv3 key. Behind config.
  - **crypto.ts (stub)**: Coinbase Commerce; `verifyWebhook` → HMAC-SHA256(rawBody, sharedSecret) vs `X-CC-Webhook-Signature` (`timingSafeEqual`); `charge:confirmed`→succeeded.
  - `createPaymentRegistry(cfg)` → resolves a provider by kind from env config.
- db `payment.ts` schema: `payment_intent(id, tenant_id, provider, provider_ref, purpose, target_ref?, amount_minor bigint, currency, credit_amount bigint?, status, idempotency_key?, created_at, updated_at)` (unique(provider, provider_ref)); `payment_event(id, payment_intent_id?, provider, provider_event_id, type, raw_payload jsonb, signature_ok bool, processed_at?, received_at, unique(provider, provider_event_id))`. Repos: `createIntent`, `getIntentByProviderRef`, `setIntentStatus`, `insertEventIfNew(provider, eventId, ...) → {inserted, existing?}` (`ON CONFLICT DO NOTHING`), `markEventProcessed`. Migration.

- [ ] **Step 1:** TDD: Stripe `verifyWebhook` with a **correctly-signed** test event (construct via `stripe.webhooks.generateTestHeaderString` or HMAC the way Stripe does) → parses; bad sig → throws. crypto HMAC verify (good/bad). alipay/wechat verify-helper unit tests with canned signatures (or at minimum: creds-unset → `invalid_input`, and the signature-string assembly is correct). db repo integration test: `insertEventIfNew` is idempotent (2nd same eventId → not inserted). **Step 2–4:** implement; green. **Step 5:** Commits: `feat(payments,contracts,db): payment provider abstraction + stripe + schema` (+ a stubs commit if cleaner).

---

## Task 2: `PaymentService` (create + idempotent fulfill) — `@actionow/engine`

**Files:** `packages/engine/src/payment-service.ts`; tests.

`PaymentService` constructed with `{ db, providers: PaymentRegistry, creditRate }`:

- `createIntent({tenantId, provider, purpose, amountMinor, currency, targetRef?})`: resolve `credit_amount = currency→µcredit at creRate` (for topup); `provider.createIntent(...)`; persist `payment_intent(status:'created', provider_ref)`; return `{intentId, redirectUrl|qr}`.
- `handleWebhook(provider, rawBody, headers)`: `providers.get(provider).verifyWebhook(rawBody, headers)` (throws → caller 401); **`insertEventIfNew(provider, eventId, rawPayload, signature_ok:true)`** — if not inserted (duplicate) → return `{duplicate:true}` (200, no-op); else match `payment_intent` by `provider_ref`, transition status; if `succeeded` → **one DB transaction**: `purpose==='topup'` → `topUp(account, credit_amount)` (idempotency keyed by event id so retries never double-credit) ; `purpose==='order'` → set intent `succeeded` + (caller marks order); mark `payment_event.processed_at`. Return `{fulfilled:true}`.

- [ ] **Step 1: integration test** (Testcontainers pg + a fake PaymentProvider whose `verifyWebhook` returns a canned `VerifiedEvent`): create a topup intent → `handleWebhook(succeeded)` credits the account ledger by `credit_amount` (one `topup` ledger row, balance up); **duplicate event** (same eventId) → no second credit, balance unchanged; bad signature (provider throws) → propagates, no event row. **Step 2–4:** implement; green. **Step 5:** Commit `feat(engine): payment service with idempotent webhook fulfillment`.

---

## Task 3: `/v1/payments` endpoints (`apps/api`)

**Files:** `apps/api/src/payments/` (module/controller/service/DTOs); a `PAYMENTS` provider built from env config; admin payment list; tests.

- Env (`packages/infra/src/config.ts`, all optional): `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`, `ALIPAY_*`, `WECHAT_*`, `CRYPTO_WEBHOOK_SECRET`, `CREDIT_RATE` (µcredits per currency-minor-unit, default e.g. 1000). Build a `PaymentRegistry` from whatever creds are present; a provider with no creds → its routes return `invalid_input`.
- Endpoints:
  - `POST /v1/payments/intents {provider, purpose, amount_minor, currency, target_ref?}` (`@UseGuards(ApiKeyGuard)`) → `PaymentService.createIntent` → `{intent_id, redirect_url|qr}`.
  - `POST /v1/payments/webhooks/:provider` (**NOT** ApiKeyGuard — signature is auth; raw body via the existing `rawBody:true`) → `PaymentService.handleWebhook(provider, req.rawBody, req.headers)` → 200 (always 200 on verified+processed/duplicate; 401 on bad signature) — **fulfill only here, never on a redirect**.
  - `GET /v1/payments/intents/:id` (ApiKeyGuard, tenant-scoped) → the intent.
  - Admin: `GET /admin/payments` (tenant-scoped list).

- [ ] **Step 1: e2e** (Testcontainers pg): seed a tenant+account+key; `POST /v1/payments/intents {provider:'stripe', purpose:'topup', amount_minor:1000, currency:'usd'}` → intent created (mock the Stripe SDK's `checkout.sessions.create`, or inject a fake provider for the e2e). Then `POST /v1/payments/webhooks/stripe` with a **correctly-signed** `checkout.session.completed` body → the account is credited by `credit_amount` (one topup ledger row); **duplicate webhook** → balance unchanged (one row); **bad signature** → 401, no credit. `GET /v1/payments/intents/:id` tenant-scoped (cross-tenant → 404). **Step 2–4:** implement; green. **Step 5:** Commit `feat(api): /v1/payments intents + signed webhook fulfillment`.

---

## Task 4: Verification gate

- [ ] `pnpm typecheck && pnpm lint && pnpm build && pnpm test` green (Docker up). Boundaries: `payments` rule added & proven (payments→db rejected). No secret logging (webhook secrets, signatures, Stripe keys, card data). Commit any fixups `chore: phase-10 payments verification gate green`.

---

## Phase 10 Definition of Done

- `@actionow/payments`: `PaymentProvider` + Stripe (real, `constructEvent`-verified) + Alipay/WeChat/crypto stubs (verify helpers wired, creds-gated).
- `payment_intent` + `payment_event` (`unique(provider, event_id)` idempotency); `PaymentService` create → **idempotent webhook fulfillment** (topup credits the ledger once; duplicates no-op; bad signature rejected).
- `/v1/payments/intents` + signed `/v1/payments/webhooks/:provider` (fulfill only on webhook) + tenant-scoped read; money in integer minor units, credit rate fixed at create.
- `pnpm typecheck/lint/build/test` green; the `payments` boundary enforced; no secret leakage.

> This completes the capabilities expansion (Phases 7–10).
