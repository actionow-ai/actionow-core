---
name: actionow-integration
description: Use when a third-party app (or its coding agent) needs to integrate with an Actionow / actionow-core AI gateway — authenticating with an ak_ API key or console JWT, calling OpenAI-compatible /v1 chat / embeddings / audio endpoints, creating async tasks via the /v1/tasks family (videos / audio / music) with submit-and-wait 200/202 handling, polling or streaming GET /v1/tasks/:id, discovering models via /v1/gateway/models, onboarding end-users as subjects, handling credit (402) / rate-limit (429) / conflict (409) / streaming errors, or verifying timestamped task-webhook signatures.
---

# Actionow integration

## Overview

**Actionow (actionow-core) is a multi-tenant AI gateway with an OpenAI-compatible `/v1` API.** You call it for chat / image / video / audio / embeddings / rerank, and it handles provider keys, routing, parameter-aware supply selection, fallback, circuit-breaking, a credit ledger, payments, object storage, and a per-end-user billing identity.

Actionow core can be used **two ways** — pick the lighter one that fits:

- **Mode A · Full-modality model gateway (模型中转站).** Point any OpenAI-compatible SDK at core's `/v1` with a single `ak_` key and call **chat / image / video / audio / embeddings / rerank** across every provider core fronts — routing, fallback, circuit-breaking, and one unified credit bill included. **No subjects, no `/console` federation.** Setup: create a tenant + account, fund the pool, mint one **tenant-level** `ak_` key (no `subjectId`), point your SDK at `baseURL`. This is core as your self-hosted multi-modal LLM gateway (think OpenRouter, in-house).
- **Mode B · Build an app on core (应用基座).** Everything in A, **plus** federate _your own_ end-users as **subjects** — per-user `ak_` keys, sub-wallets, per-user limits & spend attribution — so you resell core's capabilities to your users behind your own product.

Mode A is a strict subset of Mode B's mechanics — the _same_ `/v1` calls; Mode B only adds the per-end-user identity layer. **Start with A; adopt B when you need per-user wallets / limits / attribution.**

**Mode B principle — federation, not mirroring:** your app keeps its own database, users, and business logic. It runs a thin server that holds an Actionow credential and calls Actionow, referencing it **only by the stable IDs Actionow returns** — `subject_id`, `file_id`, `task_id`. If it touches a _provider key, a credit, or a stored byte_, it's Actionow's; everything that makes your product yours stays yours. **Mode A skips this entirely** — no app-DB federation, no subjects; you just hold one tenant-level key and call `/v1`.

**If you are a coding agent:** you almost certainly do NOT have Actionow's source code. This skill IS your contract. Do not invent endpoints, parameters, or response shapes — everything you need is in this skill and its `reference/` sub-skills. When unsure, run `scripts/smoke-test.sh` against a live gateway instead of guessing.

## Migration notice — the task-paradigm API replaced /v1/run and /v1/jobs

The gateway shipped a **new task-paradigm API** (model addressing, `POST /v1/tasks` family). The old job face still works during a short migration window but is **deprecated and will be REMOVED**:

| Deprecated (removal scheduled)     | Use instead                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `POST /v1/run/:resourceId`         | `POST /v1/videos/generations` · `POST /v1/audio/music` · `POST /v1/tasks` (body `type`)                |
| `GET /v1/jobs/:id` (+ list)        | `GET /v1/tasks/:id` · `GET /v1/tasks`                                                                  |
| `GET /v1/jobs/:id/stream`          | `GET /v1/tasks/:id/stream`                                                                             |
| `POST /v1/jobs/:id/cancel`         | `POST /v1/tasks/:id/cancel`                                                                            |
| resource addressing (`resourceId`) | **model addressing** (`model` field in the body)                                                       |
| `GET /v1/resources`                | `GET /v1/gateway/models` (operations / paradigms / param contract)                                     |
| job webhook ping `{ job_id }`      | task webhook envelope `{ evt_id, event_type, created_at, task }` with a **timestamped** HMAC signature |

**All NEW integrations must use the task-paradigm API.** Existing `/v1/run`/`/v1/jobs` integrations keep working unchanged during the migration window only. Chat / embeddings / rerank / moderations / TTS / STT keep their OpenAI-compatible wire — no change needed there.

## When to use

- Using core as a plain multi-modal model gateway — one tenant-level `ak_` key against `/v1`, no subjects/federation (Mode A).
- Building an app _on top of_ an Actionow gateway (chatbot, image/video generator, RAG, agent backend).
- Wiring up auth, credits/billing, async tasks, file uploads, or webhooks against `/v1/*` or `/console/*`.
- Debugging a `401 / 402 / 409 / 429` from an Actionow gateway, or a mid-stream SSE error.

**Not for:** operating/deploying Actionow itself (that's the platform operator's `/admin` plane + `docs/DEPLOYMENT.md`), or provider-dialect authoring.

## The mental model — four planes

Every request belongs to exactly one plane, and each plane has its own credential. **An app backend almost only ever touches the first two.**

| Plane             | Routes                                                                                                                       | Credential                          | Who holds it                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------ |
| **Data plane**    | `/v1/*` (chat, tasks, files, embeddings, gateway/models…)                                                                    | `ak_…` API key (per end-user)       | Your server, on the user's behalf                      |
| **Control plane** | `/console/*` + `/auth/login` (subjects, keys, wallets, limits, payments)                                                     | Console **USER JWT** (tenant-admin) | Your server ONLY — high trust, never ship to a browser |
| **Member plane**  | `/member/*` (self-service: read own identity/usage/balance/limits + edit profile/password + self-mint/revoke own `ak_` keys) | Member JWT (`typ:subject`)          | An end-user, only if you use Model-A auth              |
| **Admin plane**   | `/admin/*` (platform operator)                                                                                               | `at_…` service token                | Platform operators — **not** an app backend            |

Send any credential as `Authorization: Bearer <credential>`. The data-plane key also accepts `x-api-key: ak_…`. **The task-paradigm endpoints require a REAL `ak_` key** (the dev `x-tenant-id` fallback is rejected there with `401`).

## Two tenancy models for your end-users

- **Model-B (recommended):** your app authenticates its own users. Mirror each as a **subject** with `external_id` = your user id (immutable → perfect reverse-join key), and mint each an `ak_…` key. Actionow never sees a password.
- **Model-A:** Actionow authenticates the end-user (email+password under your tenant) via `/auth/register-member` / `/auth/login-member`, issuing a member JWT for the self-service `/member/*` plane.

Both attribute spend, limits, and ownership down to the individual subject. On the **task-paradigm endpoints attribution rides the key**: use a subject-scoped `ak_` per user (the legacy `end_user` body field only exists on the deprecated `/v1/run`). See [reference/01-authentication.md](reference/01-authentication.md).

## Golden path (Model-B)

```
1. POST /auth/login                     → USER JWT           (once, server-side)
2. POST /console/subjects               → subject_id         (once per end-user; external_id = your user id)
3. POST /console/api-keys {subjectId}   → ak_…  (returned ONCE — store it now)
4. (fund) POST /console/redeem | /console/payments/intents | subject sub-wallet topup
5. POST /v1/chat/completions            → chat, with the user's ak_…
   POST /v1/videos/generations | /v1/tasks → media/async tasks (model addressing)
```

Persist `subject_id` (and optionally the `ak_…`) on your user row; every later call keys off them. Full runnable version: [scripts/onboard-subject.mjs](scripts/onboard-subject.mjs).

## The task paradigm — one flow, two server-decided shapes

Create a task by **model name** (not resource id). The server alone decides the response shape (自动升格 is pure server-side, no client opt-in):

```
POST /v1/videos/generations | /v1/audio/music | /v1/tasks   { "model": "...", ...params }
  → 200  sync result   (fast model on a sync-capable operation) — the body IS the output
  → 202  Task object   (slow/async)  → poll GET /v1/tasks/:id to a terminal status
                                      → or SSE GET /v1/tasks/:id/stream
                                      → or webhook via callback_url (signed envelope)
```

Task terminal statuses: `succeeded | failed | canceled | expired`. Always handle BOTH 200 and 202 — the SDK's `submitTaskAndWait` does it in one call ([07](reference/07-sdk-reference.md)); pre-judge with the `slow` marker on `GET /v1/gateway/models` if you want a progress UI up front. Details: [03](reference/03-media-tasks-and-files.md).

## Quick reference — most-used endpoints

| Do this                                   | Call                                                                                             | Plane   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ | ------- |
| Chat (OpenAI wire, `stream:true` for SSE) | `POST /v1/chat/completions`                                                                      | data    |
| Anthropic / Gemini wire                   | `POST /v1/messages` · `POST /v1beta/models/:model:generateContent`                               | data    |
| Embeddings · rerank · moderation          | `POST /v1/embeddings` · `/v1/rerank` · `/v1/moderations`                                         | data    |
| Discover models + operations + params     | `GET /v1/gateway/models` (rich) · `GET /v1/models` (bare OpenAI list)                            | data    |
| Create a video / music task               | `POST /v1/videos/generations` · `POST /v1/audio/music`                                           | data    |
| Create any task (generic)                 | `POST /v1/tasks` (body `type` names the operation)                                               | data    |
| Poll / stream / cancel / list tasks       | `GET /v1/tasks/:id` · `GET /v1/tasks/:id/stream` · `POST /v1/tasks/:id/cancel` · `GET /v1/tasks` | data    |
| Image gen · TTS · STT (OpenAI wire)       | `POST /v1/images/generations` · `/v1/audio/speech` · `/v1/audio/transcriptions`                  | data    |
| Upload a file                             | `POST /v1/files/presign-upload` → PUT → `POST /v1/files/:id/confirm`                             | data    |
| Download a file                           | `GET /v1/files/:id/url`                                                                          | data    |
| Onboard end-user                          | `POST /console/subjects` → `POST /console/api-keys`                                              | control |
| Fund                                      | `POST /console/redeem` · `POST /console/payments/intents`                                        | control |

Full catalog of every public endpoint: [reference/endpoint-catalog.md](reference/endpoint-catalog.md).

## Critical gotchas (what agents get wrong)

1. **Chat is standard OpenAI wire.** Send `{"model","messages":[{"role","content"}],"stream"}` — the same body you'd send OpenAI. Nothing custom.
2. **Money in responses is a µcredit decimal STRING**, not a number. `1 credit = 1_000_000 µcredit`. Parse with `BigInt`, never `Number`. Money in _request_ bodies is a human number (e.g. `amount_minor` in cents/fen).
3. **Task creates answer 200 OR 202 and the server decides.** Never assume a media model is async — a fast model may answer 200 inline, a slow one 202 + Task (`object: "task"`). Discriminate on the body's `object` field (`"task"`), not the status alone (an idempotent replay of a finished task answers 200 with a Task body). Use `submitTaskAndWait`.
4. **The credit hold runs BEFORE the first SSE byte**, so a pre-commit failure (`insufficient_credits` / `invalid_input` / `unauthorized` / `rate_limited`) is a real non-2xx HTTP error — check `res.ok` first. Post-commit errors are in-band, **dialect-specific** frames: OpenAI-wire chat emits a terminal `data: {"error": …}` frame and ends **without** `[DONE]`; `/v1/tasks/:id/stream` emits an `error` event frame. See [05](reference/05-errors-and-idempotency.md).
5. **Task webhooks deliver the FULL Task in a signed envelope** `{ evt_id, event_type, created_at, task }` — dedupe on `evt_id` (retries reuse it), and verify the **timestamped** signature `X-Actionow-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>` over the **RAW request bytes**. The signing secret is **tenant-level configuration** (not per-request). `callback_url` must be a **public** http(s) URL. See [06](reference/06-webhooks.md).
6. **`Idempotency-Key` on task creates is body-fingerprinted**: same key + same body replays the recorded task (202 while live, 200 once terminal); same key + **different body is a hard `409 conflict`** — never a silent replay. The key is scoped per (tenant, key string) — no per-subject window. Send a fresh key per logical operation. See [05](reference/05-errors-and-idempotency.md).
7. **Params are validated against the model's contract** (`GET /v1/gateway/models` → `operations[].params`). An unsupported parameter or out-of-range value is a `400 unsupported_parameter` naming the offending param — nothing is silently dropped. `model_not_found` (404) covers unknown, invisible, allowlist-excluded, and fully-disabled models alike.
8. **Store IDs, not data.** Keep `subject_id`, `file_id`, `task_id`; never mirror Actionow's rows into your DB.
9. **`served_by` on responses names the actual supply** — sync responses carry `served_by.offering_id/channel_id/provider`; a deprecated model additionally returns `Deprecation: true` + `X-Actionow-Model-Deprecated: <model>` headers (migrate before it 404s). Do not assert the serving channel.
10. **The legacy job face (`/v1/run`, `/v1/jobs`, `GET /v1/resources`) is deprecated** — it still works during the migration window, with its OLD semantics (body `idempotency_key`, minimal webhook ping, `end_user` resolution). Do not build anything new on it.

## Sub-skills (`reference/`)

| File                                                                   | Read it when                                                                                                |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [01-authentication.md](reference/01-authentication.md)                 | Credentials, Model-A vs B, onboarding subjects, minting/rotating keys, allowlists                           |
| [02-chat-and-relay.md](reference/02-chat-and-relay.md)                 | Chat (OpenAI/Anthropic/Gemini), streaming, embeddings, rerank, moderation, model discovery, channel pinning |
| [03-media-tasks-and-files.md](reference/03-media-tasks-and-files.md)   | The `/v1/tasks` family, 200/202 dual shape, polling/streaming/cancel, images/TTS/STT, file upload/download  |
| [04-billing-and-limits.md](reference/04-billing-and-limits.md)         | µcredit money, tenant pool + sub-wallets, hold→settle, funding, governance limits, checking balance/usage   |
| [05-errors-and-idempotency.md](reference/05-errors-and-idempotency.md) | Error envelopes (new taxonomy + legacy), retry semantics, `Idempotency-Key` 409, streaming error behavior   |
| [06-webhooks.md](reference/06-webhooks.md)                             | Task webhooks: signed envelope, timestamped HMAC verification, retry ladder, receiver template              |
| [07-sdk-reference.md](reference/07-sdk-reference.md)                   | `@actionow/sdk` client, `submitTaskAndWait` / `waitForTask` / `verifyTaskWebhookSignature`, conventions     |

## Scripts (`scripts/`) — runnable, zero-dependency

| Script                                             | What it does                                                                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [smoke-test.sh](scripts/smoke-test.sh)             | curl preflight: health → readyz → discover models → blocking chat → optional task submit+poll. **Run this first to prove connectivity + auth.** |
| [chat.mjs](scripts/chat.mjs)                       | Node (global `fetch`) chat, blocking and `--stream`, with an inline SSE parser                                                                  |
| [run-and-poll.mjs](scripts/run-and-poll.mjs)       | Task submit-and-wait over `POST /v1/tasks`: handles the 200/202 dual shape and polls `GET /v1/tasks/:id` to terminal                            |
| [onboard-subject.mjs](scripts/onboard-subject.mjs) | Model-B onboarding: login → create subject → mint `ak_…` key                                                                                    |
| [verify-webhook.mjs](scripts/verify-webhook.mjs)   | Standalone timestamped-HMAC verifier + a tiny raw-body task-webhook receiver                                                                    |

## Setup — environment variables

The live gateway for this org is **`https://core.actionow.ai`** (Swagger UI: `https://core.actionow.ai/docs`). All scripts and examples read these:

```sh
export ACTIONOW_BASE_URL="https://core.actionow.ai"      # the gateway origin (no trailing slash)
export ACTIONOW_API_KEY="ak_…"                           # a data-plane key (for /v1/*)
export ACTIONOW_CONSOLE_EMAIL="admin@yourapp.example"    # tenant-admin login (for /console/*)
export ACTIONOW_CONSOLE_PASSWORD="…"
export ACTIONOW_WEBHOOK_SECRET="…"                       # tenant webhook secret for task-webhook verification
```

## Verify your integration (do this before writing app code)

```sh
ACTIONOW_MODEL=gpt-4o ./scripts/smoke-test.sh
```

Green output = the gateway is reachable, your key authenticates, and chat bills successfully. Only then wire it into your app. **Evidence before assertions: never claim the integration works without a passing smoke test or a real 2xx response.**
