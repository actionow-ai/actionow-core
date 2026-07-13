# 03 · Media, tasks & files

The async data-plane path: create a **task** by **model name**, get back a sync result (200) or a **Task** (202), then poll / stream / receive a webhook, and fetch the output artifact URLs. All data plane (`ak_…`). Every create accepts the same `X-Actionow-Route-Tag` supply-pinning header as chat — see [02 · Pinning a channel](02-chat-and-relay.md#pinning-a-channel-multi-channel-routing--渠道指定).

> **Legacy note:** this family replaces the deprecated `POST /v1/run/:resourceId` + `GET /v1/jobs/*` face (resource addressing, `exec_mode`). The old endpoints keep their OLD semantics during the migration window only — see [the deprecated face](#the-deprecated-legacy-face-v1run--v1jobs) at the bottom. Build new work on `/v1/tasks`.

## Discover models · `GET /v1/gateway/models`

```sh
curl -s "$ACTIONOW_BASE_URL/v1/gateway/models" -H "authorization: Bearer $ACTIONOW_API_KEY"
# → { object:"list", data:[{ id, object:"model", display_name, modality, status,
#      operations:[{ operation, paradigms:["sync"|"stream"|"task"], slow,
#                    params:[{ name, type, required, billing_relevant, default?, values?, min?, max? }] }],
#      capabilities:[…] }] }
```

Returns exactly the models this caller can use (tenant visibility ∩ key model-allowlist). Each model lists its **operations** (`chat.completions`, `images.generation`, `video.generation`, `music.generation`, `tts`, `asr`, …), the paradigms each supports, a `slow` marker (⇒ sync endpoints auto-upgrade to 202 + Task), and the **canonical parameter contract** — the single source of truth for what you may send. The old `GET /v1/models` still exists and returns the bare OpenAI list shape.

## Create a task · model addressing

Three creates share one wire discipline. The **operation** comes from the route (resource style) or from `type` in the body (generic):

```jsonc
// resource style — POST /v1/videos/generations · POST /v1/audio/music
{
  "model": "seedance-pro",          // REQUIRED: the model's external name (routing address)
  "prompt": "a red bicycle riding itself",
  "resolution": "1080p",            // any other key = a canonical param of the model's contract
  "callback_url": "https://you.example/webhooks/actionow-tasks",  // optional webhook (see 06)
  "artifact_mode": "signed",        // optional: "signed" (default, expiring URL) | "public" (stable URL, tenant-policy gated)
  "require_persist": true           // optional: persistence failure ⇒ task FAILS, no charge
}

// generic — POST /v1/tasks (identical, plus:)
{ "type": "video.generation", "model": "seedance-pro", "prompt": "…" }
```

Reserved envelope keys: `model`, `type`, `stream`, `callback_url`, `artifact_mode`, `require_persist`. **Everything else is validated against the model's param contract** — an unknown/out-of-range param is a `400 unsupported_parameter` naming what excluded which supply (nothing is silently dropped).

### The two response shapes (server-decided auto-upgrade)

| HTTP | Body                                                         | When                                                     |
| ---- | ------------------------------------------------------------ | -------------------------------------------------------- |
| 200  | the sync result (`output`, `usage`, `served_by`, `warnings`) | fast model on a sync-capable operation                   |
| 202  | a **Task** object (`object: "task"`)                         | task paradigm, or a slow model auto-upgraded server-side |

There is **no client opt-in** — always handle both. Discriminate on the body's `object === "task"`, not the status (an idempotent replay of an already-terminal task answers 200 with a Task body). `@actionow/sdk`'s `submitTaskAndWait` digests both shapes in one call ([07](07-sdk-reference.md)); runnable raw version: [scripts/run-and-poll.mjs](../scripts/run-and-poll.mjs).

### The Task object

```jsonc
{
  "id": "…", "object": "task",
  "type": "video.generation",
  "model": "seedance-pro",
  "status": "pending",              // pending | running | succeeded | failed | canceled | expired
  "progress": 42,                   // 0–100 | null
  "output": null,                   // normalized result payload once succeeded
  "usage": { "metrics": {…}, "billing_dims": {…}, "estimated": false },  // null until settled
  "error": null,                    // the unified error when failed
  "served_by": { "offering_id": "…" },
  "created": 1760000000, "started": null, "finished": null,   // unix seconds
  "expires_at": 1760604800          // signed-track artifact expiry (unix seconds) | null
}
```

Terminal = `succeeded | failed | canceled | expired`. `usage.estimated: true` marks platform-estimated (not upstream-reported) usage. For media, `output` carries artifact URLs: **signed** track URLs expire at `expires_at` (the task then reads `expired`); **public** track URLs are stable non-expiring (gallery mode; subject to tenant policy — a denied `artifact_mode: "public"` degrades to signed with a warning in `warnings[]`).

## Task queries

| Call                        | Purpose                                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/tasks`             | list your tasks newest-first, keyset-paginated (`{ data, next_cursor, has_more }`); filters `?status=` & `?type=`                                                                                                                                                                                                                                    |
| `GET /v1/tasks/:id`         | one task (tenant/subject isolated — an unowned id is a 404 `task_not_found`)                                                                                                                                                                                                                                                                         |
| `GET /v1/tasks/:id/stream`  | SSE until terminal: `event: snapshot` (Task view) → `progress`\* (one per task event: `{ seq, from_status, to_status, payload, created_at }`) → terminal `done` (succeeded) OR `error` (failed/canceled/expired) carrying the final Task view; ignore `:` heartbeat comments (~15 s); the stream caps at ~10 min — reconnect or fall back to polling |
| `POST /v1/tasks/:id/cancel` | cancel a pending/running task and release its hold; idempotent on an already-`canceled` task (200); any OTHER terminal state → `409 conflict`                                                                                                                                                                                                        |

**Polling loop:** call `GET /v1/tasks/:id` every ~2 s until terminal; back off, and set an overall timeout (media tasks run long — the SDK default is 10 min). A canceled task still bills any usage the upstream already produced; late upstream results after a cancel are discarded.

## OpenAI-compatible sync endpoints (may auto-upgrade)

Prefer these for the OpenAI-familiar single call. **A `slow`-marked model makes these answer `202 + Task` instead of their usual shape** — handle both (the `slow` marker on `GET /v1/gateway/models` is your pre-judgment hint):

| Call                            | Body                                                                                   | Usual return                                           |
| ------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `POST /v1/images/generations`   | `{ model, prompt, n?, size?, response_format?:"url" }`                                 | `{ created, data:[{ url }] }`                          |
| `POST /v1/audio/speech`         | `{ model, input, voice?, response_format?, speed? }`                                   | **binary** audio bytes (`Content-Type: audio/*`)       |
| `POST /v1/audio/transcriptions` | multipart: `file`, `model`, `language?`, `prompt?`, `response_format?`, `temperature?` | `{ text }` / plain text / verbose JSON with `segments` |

Images bill per image, TTS per character, transcription per audio second. Transcription uploads are capped at **25 MiB** (operator-lowerable via `STT_MAX_UPLOAD_BYTES`) — validate size client-side.

## Files (object storage)

Three-step upload; the PUT goes **direct to storage** (no API call, no credits).

```sh
# 1. presign
curl -sX POST "$ACTIONOW_BASE_URL/v1/files/presign-upload" \
  -H "authorization: Bearer $ACTIONOW_API_KEY" -H 'content-type: application/json' \
  -d '{"filename":"a.png","content_type":"image/png","size":12345}'
# → { file_id, upload_url, key, expires_in, public_url }

# 2. PUT the bytes to upload_url (the storage host, not the gateway)
curl -sX PUT "$UPLOAD_URL" -H 'content-type: image/png' --data-binary @a.png

# 3. confirm (flips status to "ready" after a HEAD check)
curl -sX POST "$ACTIONOW_BASE_URL/v1/files/$FILE_ID/confirm" -H "authorization: Bearer $ACTIONOW_API_KEY"
```

| Call                    | Purpose                                                              |
| ----------------------- | -------------------------------------------------------------------- |
| `GET /v1/files`         | list your files (`?status=pending\|ready`, keyset-paginated)         |
| `GET /v1/files/:id/url` | mint a presigned **download** URL: `{ url, expires_in, public_url }` |
| `GET /v1/files/usage`   | `{ bytes, count, quota_bytes, effective_ttl_days }`                  |
| `DELETE /v1/files/:id`  | soft-delete (removes the object) → `204`                             |

Every file row also carries a `public_url` (stable, non-expiring; `null` when the deployment hasn't configured a public base URL).

**Passing a file into a task:** upload it, then reference the `file_id` in the param the model's contract types as a `file` (a `file`-typed param may accept a single id or an array — check the contract on `GET /v1/gateway/models`). Input files are MIME-checked and validated against the model's declared input constraints. **Store the `file_id`, never the bytes.**

Two independent size limits apply to a presign: the file must fit within your effective `quota_bytes` **and** within the per-object `STORAGE_MAX_UPLOAD_BYTES` ceiling — exceeding either → `400 invalid_input`. Files may be swept after `effective_ttl_days` if a TTL is configured.

## The deprecated legacy face (`/v1/run` + `/v1/jobs`)

> **Deprecated — removal scheduled after the migration window.** Kept here only so an agent maintaining an OLD integration recognizes it. Do not use for new work; the two faces do NOT bridge (a `/v1/run` job never appears under `/v1/tasks` and vice versa).

- `GET /v1/resources` / `GET /v1/resources/:id` — the old discovery (resource addressing + `io_schema`).
- `POST /v1/run/:resourceId` — body `{ inputs, exec_mode: blocking|stream|async-poll|async-callback, callback_url?, idempotency_key?, end_user?, estimated_usage?, require_persist? }`. Note the OLD semantics: idempotency rides the **body** field, `end_user` (the subject's `external_id`) resolves attribution, and webhooks deliver the minimal `{ job_id }` ping signed WITHOUT a timestamp.
- `GET /v1/jobs` / `GET /v1/jobs/:id` / `GET /v1/jobs/:id/stream` / `POST /v1/jobs/:id/cancel` — job status/output/cost, SSE, cancel.

Migration mapping is in [SKILL.md](../SKILL.md#migration-notice--the-task-paradigm-api-replaced-v1run-and-v1jobs). The biggest behavioral differences when you migrate: model addressing replaces resource ids; params are contract-validated (no free-form `inputs`); the `Idempotency-Key` **header** (body-fingerprinted, 409 on mismatch) replaces the body key; attribution rides the subject-scoped key (no `end_user`); webhooks carry the full Task and a timestamped signature.
