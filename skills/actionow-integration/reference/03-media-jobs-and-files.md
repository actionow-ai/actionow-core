# 03 · Media, jobs & files

The generic async data-plane path: run a **resource**, get a **job**, poll or get a webhook, resolve output **file_ids**. All data plane (`ak_…`).

## Discover resources · `GET /v1/resources`

```sh
curl -s "$ACTIONOW_BASE_URL/v1/resources" -H "authorization: Bearer $ACTIONOW_API_KEY"
# → { data:[{ id, kind, modality, provider_type, exec_modes:[…] }], next_cursor }
```

`GET /v1/resources/:id` adds `io_schema` (the JSON Schema for `inputs`) and active `pricing`. Keyset-paginated (feed `next_cursor` back as `cursor`).

## Run a resource · `POST /v1/run/:resourceId`

Request body ([data-plane contract]):

```jsonc
{
  "inputs": { /* per the resource's io_schema; a `file` input carries a file_id */ },
  "exec_mode": "blocking" | "stream" | "async-poll" | "async-callback",  // optional
  "callback_url": "https://you.example/webhooks/actionow",   // required for async-callback
  "idempotency_key": "…",        // optional
  "end_user": "user_42",         // optional: YOUR external user handle (subject's external_id, NOT its UUID)
  "estimated_usage": { "images": 1 }  // optional: pre-declares metered dims for the hold
}
```

Response depends on mode:

| exec_mode                        | HTTP    | Body                                                                           |
| -------------------------------- | ------- | ------------------------------------------------------------------------------ | ----- | ---- | ---------------------------------------------- |
| `blocking`                       | 200     | `{ job_id, status:"succeeded", output, usage, cost:{credits} }`                |
| `async-poll` (default for async) | 202     | `{ job_id, status:"queued" }` → poll `GET /v1/jobs/:id`                        |
| `async-callback`                 | 202     | `{ job_id, status:"queued" }` → webhook on terminal (see [06](06-webhooks.md)) |
| `stream`                         | 200 SSE | `event: delta                                                                  | usage | done | error`frames (send`Accept: text/event-stream`) |

`cost.credits` is a **µcredit decimal string**. `status` terminal values: `succeeded` / `failed` / `canceled`. `estimated_usage` keys must be the resource's actual metered dimension names (e.g. `images`, `characters`, `audio_seconds` — discover them via `GET /v1/resources/:id` `pricing.spec`); an unknown key is ignored for the hold.

Runnable submit+poll: [scripts/run-and-poll.mjs](../scripts/run-and-poll.mjs).

## Jobs

| Call                       | Purpose                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /v1/jobs`             | list your jobs (newest-first, keyset-paginated)                                                                   |
| `GET /v1/jobs/:id`         | one job: `{ job_id, status, resource_id, exec_mode, inputs, output, usage, cost, error, created_at, updated_at }` |
| `GET /v1/jobs/:id/stream`  | SSE progress until terminal (`event: snapshot` → `progress` → `done`)                                             |
| `POST /v1/jobs/:id/cancel` | cancel a queued job and release its credit hold                                                                   |

**Polling loop:** call `GET /v1/jobs/:id` every ~1.5 s until `status ∈ {succeeded, failed, canceled}`; back off, and set an overall timeout. `output` is resource-shaped (e.g. `{ images: [{ file_id }] }` or `{ url }`) — resolve any `file_id` via `GET /v1/files/:id/url`.

## OpenAI-compatible media convenience endpoints

Prefer these when you want a familiar single call and don't need job tracking:

| Call                            | Body                                                                                   | Returns                                                |
| ------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| `POST /v1/images/generations`   | `{ model?, prompt, n?, size?, response_format?:"url" }`                                | `{ created, data:[{ url }] }`                          |
| `POST /v1/audio/speech`         | `{ model?, input, voice?, response_format?:"mp3"                                       | …, speed? }`                                           | **binary** audio bytes (`Content-Type: audio/*`) |
| `POST /v1/audio/transcriptions` | multipart: `file`, `model`, `language?`, `prompt?`, `response_format?`, `temperature?` | `{ text }` / plain text / verbose JSON with `segments` |

Images bill per image, TTS per character, transcription per audio second. Transcription uploads are capped at **25 MiB** (an operator may lower it via `STT_MAX_UPLOAD_BYTES`); over-cap → `400 invalid_input`.

## Files (object storage)

Three-step upload; the PUT goes **direct to storage** (no API call, no credits).

```sh
# 1. presign
curl -sX POST "$ACTIONOW_BASE_URL/v1/files/presign-upload" \
  -H "authorization: Bearer $ACTIONOW_API_KEY" -H 'content-type: application/json' \
  -d '{"filename":"a.png","content_type":"image/png","size":12345}'
# → { file_id, upload_url, key, expires_in }

# 2. PUT the bytes to upload_url (the storage host, not the gateway)
curl -sX PUT "$UPLOAD_URL" -H 'content-type: image/png' --data-binary @a.png

# 3. confirm (flips status to "ready" after a HEAD check)
curl -sX POST "$ACTIONOW_BASE_URL/v1/files/$FILE_ID/confirm" -H "authorization: Bearer $ACTIONOW_API_KEY"
```

| Call                    | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- | ------------------------- |
| `GET /v1/files`         | list your files (`?status=pending                        | ready`, keyset-paginated) |
| `GET /v1/files/:id/url` | mint a presigned **download** URL: `{ url, expires_in }` |
| `GET /v1/files/usage`   | `{ bytes, count, quota_bytes, effective_ttl_days }`      |
| `DELETE /v1/files/:id`  | soft-delete (removes the object) → `204`                 |

**Passing a file into a run:** upload it, then reference its `file_id` inside `inputs` where the resource's `io_schema` expects a `file`. An `io_schema` may instead declare a `file_list` field, which expects an **array of `file_id`s** (e.g. multi-image / img2img batches). **Store the `file_id`, never the bytes.**

Two independent size limits apply to a presign: the file must fit within your effective `quota_bytes` **and** within the per-object `STORAGE_MAX_UPLOAD_BYTES` ceiling — exceeding either → `400 invalid_input`. Files may be swept after `effective_ttl_days` if a TTL is configured.

[data-plane contract]: the wire shapes above come straight from Actionow's `packages/contracts/src/data-plane.ts` (the single source of truth the gateway validates against).
