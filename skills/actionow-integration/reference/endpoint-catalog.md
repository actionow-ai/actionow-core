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
| GET    | `/v1/models`                                  | `{ data:[{ id, owned_by:"actionow" }] }` (free)                                                                                                                                                              |

### Media convenience → [03](03-media-jobs-and-files.md)

| Method | Path                       | Notes                                                  |
| ------ | -------------------------- | ------------------------------------------------------ |
| POST   | `/v1/images/generations`   | `{ prompt, n?, size? }` → `{ data:[{ url }] }`         |
| POST   | `/v1/audio/speech`         | `{ input, voice? }` → **binary** audio                 |
| POST   | `/v1/audio/transcriptions` | multipart `file`+`model` → `{ text }` / text / verbose |

### Resources & runs → [03](03-media-jobs-and-files.md)

| Method | Path                  | Notes                                                                                                                                                               |
| ------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/resources`       | list (keyset) `{ id, kind, modality, provider_type, exec_modes }`                                                                                                   |
| GET    | `/v1/resources/:id`   | + `io_schema`, `pricing`                                                                                                                                            |
| POST   | `/v1/run/:resourceId` | `exec_mode: blocking\|stream\|async-poll\|async-callback`; 200/202/SSE; optional `require_persist` (media only; persistence failure → job **FAILS**, hold released) |

### Jobs → [03](03-media-jobs-and-files.md)

| Method | Path                  | Notes                                    |
| ------ | --------------------- | ---------------------------------------- |
| GET    | `/v1/jobs`            | list your jobs (keyset, newest-first)    |
| GET    | `/v1/jobs/:id`        | one job (status/output/usage/cost/error) |
| GET    | `/v1/jobs/:id/stream` | SSE progress to terminal                 |
| POST   | `/v1/jobs/:id/cancel` | cancel queued + release hold             |

### Files → [03](03-media-jobs-and-files.md)

| Method | Path                       | Notes                                                                                                                                                    |
| ------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/files`                | list (`?status=pending\|ready`); each file includes `public_url` (stable, non-expiring; `null` when unconfigured)                                        |
| POST   | `/v1/files/presign-upload` | `{ filename, content_type, size }` → `{ file_id, upload_url, key, expires_in, public_url }` (`public_url` stable non-expiring, `null` when unconfigured) |
| POST   | `/v1/files/:id/confirm`    | flip to `ready` after PUT                                                                                                                                |
| GET    | `/v1/files/:id/url`        | presigned download `{ url, expires_in, public_url }` (`public_url` stable non-expiring, `null` when unconfigured)                                        |
| GET    | `/v1/files/usage`          | `{ bytes, count, quota_bytes, effective_ttl_days }`                                                                                                      |
| DELETE | `/v1/files/:id`            | soft-delete → 204                                                                                                                                        |

### Self-service payments → [04](04-billing-and-limits.md)

| Method | Path                              | Auth | Notes                                                                                 |
| ------ | --------------------------------- | ---- | ------------------------------------------------------------------------------------- |
| POST   | `/v1/payments/intents`            | AK   | `{ provider, purpose, amount_minor, currency }` → `{ intent_id, redirect_url?, qr? }` |
| GET    | `/v1/payments/intents/:id`        | AK   | intent status                                                                         |
| POST   | `/v1/payments/webhooks/:provider` | Sig  | provider → Actionow (you don't call)                                                  |
| POST   | `/v1/callbacks/:provider`         | Sig  | upstream async callbacks (you don't call)                                             |

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
| POST                        | `/console/subjects/:id/sub-account/topup`                                    | JWT  | `{ credits }` (direct allocation — NOT pool-conserving)                                                               |
| POST                        | `/console/subjects/:id/sub-account/transfer`                                 | JWT  | `{ credits, direction:"to_subject"\|"to_tenant" }` (conserving)                                                       |
| GET                         | `/console/subjects/:id/sub-account`                                          | JWT  | → `{ credit_balance, credit_held, status, … }`                                                                        |
| POST · GET · PATCH · DELETE | `/console/limit-plans[/:id]`                                                 | JWT  | governance-plan CRUD (PATCH replaces `rules`)                                                                         |
| POST                        | `/console/subjects/:id/limit-plan`                                           | JWT  | `{ planId }` bind (planId:null unbinds)                                                                               |
| GET                         | `/console/subjects/:id/limit-status`                                         | JWT  | live usage vs caps                                                                                                    |
| POST · GET · PATCH · DELETE | `/console/users`                                                             | JWT  | tenant seat/RBAC management                                                                                           |
| PATCH                       | `/console/settings`                                                          | JWT  | console-user self-serve (`{ currentPassword, newPassword }`)                                                          |
| GET                         | `/console/balance` · `/console/usage` · `/console/models` · `/console/files` | JWT  | tenant reads                                                                                                          |

> The `/console/subjects/:id/sub-account/*` and `/limit-*` routes are documented in the Actionow repo's `docs/INTEGRATION.md`; confirm exact bodies against your gateway's `/docs`. `/console/api-keys` (+ `/rotate`) is the key-management surface already in the typed SDK; `/console/subjects` create is not.

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
