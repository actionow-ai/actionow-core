# Endpoint catalog

Every public endpoint a third-party app touches, by plane. Auth column: **AK** = data-plane `ak_…` key · **JWT** = console USER JWT · **JWT-A** = console JWT with **tenant-admin** seat · **Member** = member JWT · **Sig** = HMAC signature (you don't call these; they receive them) · **—** = public. Money in responses is a µcredit decimal string. Note: the console **mutation** rows (key mint/rotate/revoke, payments/intents, redeem, subjects, sub-account, limit-plans, users, file writes) are tenant-admin-gated — a member seat gets `403`.

> This catalog is a map. For request/response detail see the numbered sub-skills. If a shape here disagrees with a live gateway's `/docs` (Swagger UI at `GET /docs`), trust the live gateway and the OpenAPI spec.

## Data plane · `/v1/*` (auth: AK)

### Chat & synchronous relay → [02](02-chat-and-relay.md)

| Method | Path                                          | Notes                                                                                                                                                                                                        |
| ------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/v1/chat/completions`                        | OpenAI wire; `stream:true` → SSE; clean end = `data: [DONE]`; mid-stream failure = terminal `data: {"error":{…}}` frame, stream ends **without** `[DONE]` — treat a stream ending without `[DONE]` as failed |
| POST   | `/v1/messages`                                | Anthropic wire (+ streaming)                                                                                                                                                                                 |
| POST   | `/v1beta/models/:model:generateContent`       | Gemini wire, blocking                                                                                                                                                                                        |
| POST   | `/v1beta/models/:model:streamGenerateContent` | Gemini wire, SSE                                                                                                                                                                                             |
| POST   | `/v1/embeddings`                              | `{ model, input }` → `{ data:[{ index, embedding }], usage }`                                                                                                                                                |
| POST   | `/v1/rerank`                                  | `{ model, query, documents, topN? }` → `{ results:[{ index, relevance_score }] }`                                                                                                                            |
| POST   | `/v1/moderations`                             | `{ model, input }` → `{ results:[{ flagged, categories, category_scores }] }`                                                                                                                                |

### Discovery → [02](02-chat-and-relay.md), [03](03-media-tasks-and-files.md)

| Method | Path                 | Notes                                                                                                           |
| ------ | -------------------- | --------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/gateway/models` | **NEW discovery face**: usable models (visibility ∩ key allowlist) + operations/paradigms/`slow`/param contract |
| GET    | `/v1/models`         | bare OpenAI list shape `{ data:[{ id, owned_by:"actionow" }] }` (free)                                          |

### Tasks (the task paradigm) → [03](03-media-tasks-and-files.md)

| Method | Path                     | Notes                                                                                                                                                          |
| ------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/v1/videos/generations` | model addressing; 200 sync result OR 202 + Task (server-decided); envelope keys `model/stream/callback_url/artifact_mode/require_persist`, rest = model params |
| POST   | `/v1/audio/music`        | same wire, music generation                                                                                                                                    |
| POST   | `/v1/tasks`              | generic create — operation rides body `type`                                                                                                                   |
| GET    | `/v1/tasks`              | list your tasks (keyset, newest-first; `?status=` & `?type=`)                                                                                                  |
| GET    | `/v1/tasks/:id`          | one Task (status/progress/output/usage/error/served_by/expires_at); unowned id → 404 `task_not_found`                                                          |
| GET    | `/v1/tasks/:id/stream`   | SSE to terminal: `snapshot` → `progress`\* → `done`/`error`                                                                                                    |
| POST   | `/v1/tasks/:id/cancel`   | cancel + hold release; idempotent on `canceled`; other terminal → 409                                                                                          |

### Media convenience (may auto-upgrade to 202 + Task) → [03](03-media-tasks-and-files.md)

| Method | Path                       | Notes                                                                           |
| ------ | -------------------------- | ------------------------------------------------------------------------------- |
| POST   | `/v1/images/generations`   | `{ model, prompt, n?, size? }` → `{ data:[{ url }] }` (slow model ⇒ 202 + Task) |
| POST   | `/v1/audio/speech`         | `{ model, input, voice? }` → **binary** audio (slow model ⇒ 202 + Task)         |
| POST   | `/v1/audio/transcriptions` | multipart `file`+`model` → `{ text }` / text / verbose                          |

### DEPRECATED legacy job face (migration window only — removal scheduled) → [03](03-media-tasks-and-files.md#the-deprecated-legacy-face-v1run--v1jobs)

| Method | Path                  | Replaced by                                                     |
| ------ | --------------------- | --------------------------------------------------------------- |
| GET    | `/v1/resources[/:id]` | `GET /v1/gateway/models`                                        |
| POST   | `/v1/run/:resourceId` | `POST /v1/videos/generations` · `/v1/audio/music` · `/v1/tasks` |
| GET    | `/v1/jobs[/:id]`      | `GET /v1/tasks[/:id]`                                           |
| GET    | `/v1/jobs/:id/stream` | `GET /v1/tasks/:id/stream`                                      |
| POST   | `/v1/jobs/:id/cancel` | `POST /v1/tasks/:id/cancel`                                     |

### Files → [03](03-media-tasks-and-files.md)

| Method | Path                       | Notes                                                                                                             |
| ------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/files`                | list (`?status=pending\|ready`); each file includes `public_url` (stable, non-expiring; `null` when unconfigured) |
| POST   | `/v1/files/presign-upload` | `{ filename, content_type, size }` → `{ file_id, upload_url, key, expires_in, public_url }`                       |
| POST   | `/v1/files/:id/confirm`    | flip to `ready` after PUT                                                                                         |
| GET    | `/v1/files/:id/url`        | presigned download `{ url, expires_in, public_url }`                                                              |
| GET    | `/v1/files/usage`          | `{ bytes, count, quota_bytes, effective_ttl_days }`                                                               |
| DELETE | `/v1/files/:id`            | soft-delete → 204                                                                                                 |

### Self-service payments → [04](04-billing-and-limits.md)

| Method | Path                                | Auth | Notes                                                                                 |
| ------ | ----------------------------------- | ---- | ------------------------------------------------------------------------------------- |
| POST   | `/v1/payments/intents`              | AK   | `{ provider, purpose, amount_minor, currency }` → `{ intent_id, redirect_url?, qr? }` |
| GET    | `/v1/payments/intents/:id`          | AK   | intent status                                                                         |
| POST   | `/v1/payments/webhooks/:provider`   | Sig  | provider → Actionow (you don't call)                                                  |
| POST   | `/v1/gateway/callbacks/:offeringId` | Sig  | upstream async callbacks, new gateway (you don't call)                                |
| POST   | `/v1/callbacks/:provider`           | Sig  | upstream async callbacks, legacy face (you don't call)                                |

## Control plane · `/console/*` + `/auth/*` (auth: JWT) → [01](01-authentication.md), [04](04-billing-and-limits.md)

| Method                      | Path                                                                         | Auth | Notes                                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------- |
| POST                        | `/auth/register`                                                             | —    | provisions a **NEW tenant** + billing account + user; `{ email, password }` → token pair                              |
| POST                        | `/auth/login`                                                                | —    | `{ email, password }` → `{ token, accessToken, refreshToken, expiresIn }` (**not in the typed-SDK spec** → use fetch) |
| POST                        | `/auth/refresh`                                                              | —    | `{ refreshToken }` → new token pair (in OpenAPI)                                                                      |
| POST                        | `/auth/logout`                                                               | —    | `{ refreshToken }` in body → `204` (in OpenAPI; not Bearer-gated)                                                     |
| POST                        | `/auth/register-member` · `/auth/login-member`                               | —    | Model-A; `tenantId` **required** in body                                                                              |
| POST                        | `/console/subjects`                                                          | JWT  | create subject; `{ externalId\|email, displayName?, limitPlanId? }` (**not in the typed-SDK spec** → use fetch)       |
| GET                         | `/console/subjects` · `/console/subjects/:id`                                | JWT  | list / fetch subjects                                                                                                 |
| PATCH                       | `/console/subjects/:id`                                                      | JWT  | update displayName/status/email/limitPlanId (external_id immutable)                                                   |
| DELETE                      | `/console/subjects/:id`                                                      | JWT  | soft-delete → `{ id, status:"deleted" }` (sweeps sub-wallet, disables keys)                                           |
| GET                         | `/console/api-keys`                                                          | JWT  | masked key list (typed)                                                                                               |
| POST                        | `/console/api-keys`                                                          | JWT  | `{ subjectId?, resourceAllowlist?, rateLimit? }` → `{ id, plaintext }` (typed)                                        |
| POST                        | `/console/api-keys/:id/rotate`                                               | JWT  | one-shot rotate → new `{ id, plaintext }`, old disabled (typed)                                                       |
| DELETE                      | `/console/api-keys/:id`                                                      | JWT  | revoke                                                                                                                |
| POST                        | `/console/redeem`                                                            | JWT  | `{ code }` → `{ credited, balance }`                                                                                  |
| POST                        | `/console/payments/intents`                                                  | JWT  | `{ provider, amount_minor, currency }` (no `purpose`)                                                                 |
| GET                         | `/console/payments/intents/:id`                                              | JWT  | poll topup intent status                                                                                              |
| GET                         | `/console/payments`                                                          | JWT  | payment history                                                                                                       |
| POST                        | `/console/subjects/:id/sub-account/open`                                     | JWT  | `{ credits? }`                                                                                                        |
| POST                        | `/console/subjects/:id/sub-account/topup`                                    | JWT  | `{ credits }` (pool-conserving)                                                                                       |
| POST                        | `/console/subjects/:id/sub-account/transfer`                                 | JWT  | `{ credits, direction:"to_subject"\|"to_tenant" }` (conserving)                                                       |
| GET                         | `/console/subjects/:id/sub-account`                                          | JWT  | → `{ credit_balance, credit_held, status, … }`                                                                        |
| POST · GET · PATCH · DELETE | `/console/limit-plans[/:id]`                                                 | JWT  | governance-plan CRUD (PATCH replaces `rules`)                                                                         |
| POST                        | `/console/subjects/:id/limit-plan`                                           | JWT  | `{ planId }` bind (planId:null unbinds)                                                                               |
| GET                         | `/console/subjects/:id/limit-status`                                         | JWT  | live usage vs caps                                                                                                    |
| POST · GET · PATCH · DELETE | `/console/users`                                                             | JWT  | tenant seat/RBAC management                                                                                           |
| PATCH                       | `/console/settings`                                                          | JWT  | console-user self-serve (`{ currentPassword, newPassword }`)                                                          |
| GET                         | `/console/balance` · `/console/usage` · `/console/models` · `/console/files` | JWT  | tenant reads                                                                                                          |

## Member plane · `/member/*` (auth: Member, Model-A only) → [01](01-authentication.md)

| Method | Path                                                                                       | Notes                                                               |
| ------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| GET    | `/member/me` · `/member/usage` · `/member/balance` · `/member/api-keys` · `/member/limits` | read own data                                                       |
| PATCH  | `/member/me`                                                                               | update display name                                                 |
| POST   | `/member/me/password`                                                                      | change password                                                     |
| POST   | `/member/api-keys`                                                                         | self-mint key → `{ id, plaintext }` (`id` needed for DELETE revoke) |
| DELETE | `/member/api-keys/:id`                                                                     | revoke own key                                                      |

## Infra · public (auth: —)

| Method | Path                     | Notes                                 |
| ------ | ------------------------ | ------------------------------------- |
| GET    | `/health`                | liveness (always 200)                 |
| GET    | `/readyz`                | readiness (200 ready / 503 degraded)  |
| GET    | `/.well-known/jwks.json` | JWKS for RS256 token verification     |
| GET    | `/docs`                  | Swagger UI over the live OpenAPI spec |
