# 05 · Errors & idempotency

## The gateway error envelope (task-paradigm + new-gateway routes)

**Every** non-2xx response from the task-paradigm endpoints (`/v1/videos|audio/music|tasks`, `GET /v1/tasks*`, `GET /v1/gateway/models`) has this exact shape:

```json
{
  "error": {
    "code": "rate_limited",
    "message": "slow down",
    "retryable": true,
    "failover": false,
    "retry_after_ms": 1000,
    "request_id": "…"
  }
}
```

- `code` — one of the unified codes below.
- `message` — human-readable, sanitized (never contains secrets, URLs, or credentials).
- `retryable` — boolean. **Branch on this, not on the status code.**
- `failover` — whether the gateway already tried failing over internally (diagnostic).
- `retry_after_ms` — present on `rate_limited`; a 429 also carries a `Retry-After` response header (seconds).
- `request_id` — echo of your `X-Request-Id` (or server-generated); quote it in support requests.
- `upstream` — optional `{ provider, rawCode? }` context on upstream errors; the raw upstream body is never forwarded.
- `details` — optional structured context (e.g. which param excluded which supply on `unsupported_parameter`, the offending `idempotencyKey` on `conflict`).

### The gateway codes

| `code`                  | HTTP | `retryable`  | What it means / what to do                                                                          |
| ----------------------- | ---- | ------------ | --------------------------------------------------------------------------------------------------- |
| `invalid_input`         | 400  | false        | Malformed body, bad enum, missing field, zero-match route tag. Fix the request.                     |
| `unsupported_parameter` | 400  | false        | A param (or its EFFECTIVE default) excluded every candidate supply; `details` names it. Fix params. |
| `unauthorized`          | 401  | false        | Missing/invalid/disabled key; disabled subject. Task endpoints REQUIRE a real `ak_` key.            |
| `insufficient_credits`  | 402  | false        | Wallet too low, or a spend/requests/tokens governance cap hit. Top up, then retry.                  |
| `forbidden`             | 403  | false        | Authenticated but not permitted (e.g. cross-tenant access).                                         |
| `model_not_found`       | 404  | false        | Unknown model, not visible to your tenant, excluded by your key's allowlist, or fully disabled.     |
| `task_not_found`        | 404  | false        | No such task (or not yours).                                                                        |
| `conflict`              | 409  | false        | `Idempotency-Key` reused with a DIFFERENT body, or canceling an already-terminal task.              |
| `content_filtered`      | 422  | false        | Upstream safety filter rejected the content.                                                        |
| `rate_limited`          | 429  | true         | RPM/concurrency limit. Back off `retry_after_ms` (also on the `Retry-After` header) and retry.      |
| `upstream_error`        | 502  | provider-set | Upstream provider errored. **Retry only if `retryable` is true.**                                   |
| `upstream_timeout`      | 504  | provider-set | Upstream timed out. Usually retryable, but honor the flag.                                          |
| `task_failed`           | 500  | false        | Task execution failed (see the task's `error`).                                                     |
| `internal_error`        | 500  | false        | Actionow-side error; never exposes the real cause.                                                  |

**Deprecation headers:** a `deprecated` model still serves, but every response carries `Deprecation: true` + `X-Actionow-Model-Deprecated: <model>` — treat these as a migration deadline; after the notice period the model answers `404 model_not_found`.

### The legacy envelope (deprecated `/v1/run` + `/v1/jobs` and untouched relay routes)

The old face keeps its original 11-code envelope (`invalid_input`, `unauthorized`, `forbidden`, `insufficient_credits`, `resource_not_found`, `content_filtered`, `rate_limited`, `upstream_error`, `upstream_timeout`, `job_failed`, `internal_error`) without `failover`/`request_id`. Same discipline applies: branch on `retryable`.

### Recommended client policy

```js
async function callWithRetry(doCall, { max = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await doCall();
    if (res.ok) return res;
    const body = await res.json().catch(() => ({}));
    const err = body.error ?? {};
    if (!err.retryable || attempt >= max)
      throw Object.assign(new Error(err.message || res.statusText), {
        code: err.code,
        status: res.status,
      });
    const wait = err.retry_after_ms ?? 2 ** attempt * 500; // honor server hint, else exp backoff
    await new Promise((r) => setTimeout(r, wait));
  }
}
```

Branch on the `retryable` **flag**, never on the HTTP status or the code name — `upstream_*` retryability is provider-set, not fixed. Never retry `insufficient_credits` (402) without adding credits, `invalid_input`/`unsupported_parameter` (400) without changing the request, or `conflict` (409) without a fresh key — they will just fail again. When you do retry a _billed_ POST, pair it with an `Idempotency-Key` (below) so the retry can't double-charge.

## Streaming error behavior (important, and dialect-specific)

The credit **hold runs before the first SSE byte**, so a **pre-commit failure** (`insufficient_credits`, `invalid_input`, `unauthorized`, `rate_limited`) always comes back as a **real non-2xx HTTP response** with the envelope above — no SSE bytes written. **Always check `res.ok` / `res.status` before consuming any stream.** This holds for every streaming endpoint.

A **post-commit failure** (upstream dies mid-generation) surfaces differently per endpoint:

| Streaming endpoint                        | Post-commit failure looks like                                                                                                                                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/chat/completions` (OpenAI wire) | A terminal `data: {"error": {"message", "type", "param", "code"}}` frame, and the stream ends **without** `data: [DONE]`. The official OpenAI SDKs raise an `APIError` on it; raw consumers should treat a missing `[DONE]` as an abnormal end. |
| `POST /v1/messages` (Anthropic wire)      | A wire `event: error` frame, payload `{ "type":"error", "error":{ "type", "message" } }` (Anthropic's error `type`).                                                                                                                            |
| `GET /v1/tasks/:id/stream`                | A terminal `event: error` frame carrying the final Task view (its `error` field holds the unified error) — or, on stream timeout, a bare unified-error payload. A task stream that ends without `done`/`error` was cut — reconnect or poll.     |
| Gemini wire `streamGenerateContent`       | final `data:` chunk with candidate `finishReason` `"OTHER"` and no parts, then close — NO error frame; treat `finishReason` `OTHER` as post-commit failure.                                                                                     |

## Idempotency — the `Idempotency-Key` header

Retrying a billed POST safely (e.g. after a network blip) risks a double-charge. On the **task-paradigm creates** (`POST /v1/videos/generations`, `/v1/audio/music`, `/v1/tasks`) the `Idempotency-Key` header is first-class and **body-fingerprinted**:

- **First request** with a key: runs normally; the task/result is recorded under the key.
- **Replay** (same key + byte-identical body): the recorded task answers — **202 while still running, 200 once terminal** (a Task body either way; nothing re-executes, nothing re-bills). This also covers streams and sync-shaped calls: any keyed create persists a task row as the replay target.
- **Same key + DIFFERENT body → hard `409 conflict`** (`details.idempotencyKey` names the key). Never a silent replay of the wrong result.
- Scope: the key string is unique **per tenant** (no per-subject window) — two of your users reusing the same literal key WILL collide; namespace keys per user/operation (e.g. `user42:gen:0193f…`).

Use a stable UUID per logical operation (per generation request). The SDK's `submitTaskAndWait` takes `{ idempotencyKey }` and sends the header for you.

**Elsewhere:**

- The **relay routes** (chat completions in all dialects, embeddings, rerank, moderations, audio transcriptions) honor the header with billing-idempotent replay of the original result. Historically NOT body-fingerprinted there — never reuse a key with a different body anywhere.
- The small allowlist of `@Idempotent`-decorated **admin** POSTs replays cached responses; reuse with a different body → `400`.
- The header is a **no-op** on `/v1/files`, and on the deprecated `/v1/run` (which reads a body `idempotency_key` field instead — legacy semantics, see [03](03-media-tasks-and-files.md#the-deprecated-legacy-face-v1run--v1jobs)).
- Secret-minting endpoints (API keys, secrets) intentionally never cache — never assume a key-creation POST is idempotent.
