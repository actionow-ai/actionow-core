# 05 · Errors & idempotency

## The uniform error envelope

**Every** non-2xx response (control and data plane) has this exact shape:

```json
{
  "error": {
    "code": "rate_limited",
    "message": "slow down",
    "retryable": true,
    "retry_after_ms": 1000
  }
}
```

- `code` — one of the 11 unified codes below.
- `message` — human-readable, sanitized (never contains secrets, URLs, or credentials).
- `retryable` — boolean. **Branch on this, not on the status code.**
- `retry_after_ms` — present only on rate-limited / retryable-upstream errors. Wait this long before retrying.

Upstream provider errors are wrapped, not leaked: an `upstream_error` / `upstream_timeout` carries provider context (e.g. the provider name) but the raw upstream body is never forwarded. (That `upstream` context object is emitted on the wire but is **not** part of the typed SDK `ErrorView`, so SDK clients won't see it typed.)

## The 11 codes

| `code`                 | HTTP | `retryable`  | What it means / what to do                                                                        |
| ---------------------- | ---- | ------------ | ------------------------------------------------------------------------------------------------- |
| `invalid_input`        | 400  | false        | Malformed body, bad enum, missing field, zero-match route tag. Fix the request.                   |
| `unauthorized`         | 401  | false        | Missing/invalid/disabled key or JWT; disabled subject; key not allowed for this resource.         |
| `forbidden`            | 403  | false        | Authenticated but not permitted (e.g. cross-tenant access).                                       |
| `insufficient_credits` | 402  | false        | Wallet too low, or a spend/requests/tokens governance cap hit. Top up, then retry.                |
| `resource_not_found`   | 404  | false        | No such resource/job/file (or not yours).                                                         |
| `content_filtered`     | 422  | false        | Upstream safety filter rejected the content.                                                      |
| `rate_limited`         | 429  | true         | RPM/concurrency limit. Back off `retry_after_ms` and retry.                                       |
| `upstream_error`       | 502  | provider-set | Upstream provider errored. **Retry only if `retryable` is true** — it is not fixed for this code. |
| `upstream_timeout`     | 504  | provider-set | Upstream timed out. Usually retryable, but honor the `retryable` flag.                            |
| `job_failed`           | 500  | false        | Async job execution failed (see the job's `error`).                                               |
| `internal_error`       | 500  | false        | Actionow-side error; never exposes the real cause.                                                |

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

Branch on the `retryable` **flag**, never on the HTTP status or the code name — `upstream_*` retryability is provider-set, not fixed. Never retry `insufficient_credits` (402) without adding credits, or `invalid_input` (400) without changing the request — they will just fail again. When you do retry a _billed_ POST, pair it with an idempotency guard (below) so the retry can't double-charge.

## Streaming error behavior (important, and dialect-specific)

The credit **hold runs before the first SSE byte**, so a **pre-commit failure** (`insufficient_credits`, `invalid_input`, `unauthorized`, `rate_limited`) always comes back as a **real non-2xx HTTP response** with the envelope above — no SSE bytes written. **Always check `res.ok` / `res.status` before consuming any stream.** This holds for every streaming endpoint.

A **post-commit failure** (upstream dies mid-generation) surfaces differently per endpoint — this is a real footgun:

| Streaming endpoint                        | Post-commit failure looks like                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/chat/completions` (OpenAI wire) | A terminal `data: {"error": {"message", "type", "param", "code"}}` frame, and the stream ends **without** `data: [DONE]`. The official OpenAI SDKs raise an `APIError` on it; raw consumers should treat a missing `[DONE]` as an abnormal end. `error.code` is the unified code; `error.type` is the OpenAI-style class (`server_error`, `rate_limit_error`, …). |
| `POST /v1/messages` (Anthropic wire)      | A wire `event: error` frame, payload `{ "type":"error", "error":{ "type", "message" } }` (Anthropic's error `type`, **not** the unified `code`/`retryable`).                                                                                                                                                                                                      |
| `POST /v1/run/:id` (`exec_mode:stream`)   | A terminal `event: error` frame, payload `{ "kind":"error", "error":{ code, message, retryable } }` (the unified error).                                                                                                                                                                                                                                          |

The `retryable` / `retry_after_ms` fields live **only** on the non-2xx HTTP envelope (pre-commit) and on the `/v1/run` error frame; the OpenAI-wire error frame carries the unified `code` but not the retry hints.

## Idempotency

Retrying a POST safely (e.g. after a network blip) risks a double-charge. There are **two different mechanisms** — pick the right one for the route:

**For `/v1/run/:id` (the data-plane job path): use the body field `idempotency_key`.** The engine claims that key and replays the same job instead of running (and charging) twice. This is the mechanism a third-party app actually relies on for billed calls.

```jsonc
POST /v1/run/image-relay
{ "inputs": { … }, "idempotency_key": "<stable-uuid-per-logical-op>" }
```

**The `Idempotency-Key` HTTP header** is honored **only** on the small allowlist of `@Idempotent`-decorated admin/console mutation POSTs. On `/v1/run`, `/v1/chat/completions`, and the other `/v1/*` calls the **header is a no-op** — do not rely on it there. Where it _is_ honored:

- **First request** with a key: runs normally; the response is cached under `(METHOD, path, key)`.
- **Replay** (same key, same route, same body): the cached `{status, body}` is returned verbatim — the handler does not re-run.
- **Reused key with a _different_ body** → `400 invalid_input` ("Idempotency-Key reused with a different request body").
- Replay is **best-effort** (store failures / concurrent-duplicate races are swallowed) and responses over 64 KiB are not cached — don't treat it as a hard exactly-once guarantee.

Use a stable UUID per logical operation (per user message, per generation request). Secret-minting endpoints (creating API keys, secrets) intentionally do **not** cache — never assume a key-creation POST is idempotent.
