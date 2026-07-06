# 02 · Chat & synchronous relay

All endpoints here are **data plane** (`ak_…` key). They are single-call, synchronous relays (chat may stream). Optional headers on every one: `Idempotency-Key` (dedupe; see [05](05-errors-and-idempotency.md)) and `X-Actionow-Route-Tag` (canary routing).

## Chat — OpenAI wire · `POST /v1/chat/completions`

Send the **exact body you'd send OpenAI**. Actionow parses it, relays to whatever upstream serves `model`, and renders the reply back in OpenAI shape.

### Blocking

```sh
curl -sX POST "$ACTIONOW_BASE_URL/v1/chat/completions" \
  -H "authorization: Bearer $ACTIONOW_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'
```

Response is a `chat.completion` object: `choices[0].message.content`, plus `usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`). Token breakdowns, when the upstream reports them, are **nested** in OpenAI-standard sub-objects — not top-level: `usage.prompt_tokens_details.{cached_tokens, audio_tokens}` and `usage.completion_tokens_details.{reasoning_tokens, audio_tokens}`. The served model may differ from the requested one (fallback chain) and is echoed in `model`. The serving channel's **provider type** (e.g. `"openai"`) is in the `x-actionow-channel` response header — but **only on the blocking response**; a streaming request does not set it.

Common optional fields (forwarded when the model supports them): `temperature`, `top_p`, `max_tokens`, `stop`, `seed`, `tools`, `tool_choice`, `response_format` (`json_object` / `json_schema`, with the schema at `response_format.json_schema.schema`), `reasoning_effort`. Any unrecognized top-level OpenAI body key is forwarded generically to the upstream (`n`, `top_k`, `logprobs`, `logit_bias`, penalties, `parallel_tool_calls`, …).

### Streaming (SSE)

Set `stream:true`. Frames are OpenAI `chat.completion.chunk` objects; the stream ends with a literal `data: [DONE]`.

```js
const res = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-4o', messages, stream: true }),
});
// consume SSE: read each `data:` line, stop on `[DONE]`
for await (const dataLine of sseDataLines(res)) {
  if (dataLine === '[DONE]') break;
  const chunk = JSON.parse(dataLine);
  process.stdout.write(chunk.choices?.[0]?.delta?.content ?? '');
}
```

Runnable, with the SSE parser inlined: [scripts/chat.mjs](../scripts/chat.mjs).

> **The credit hold happens before the first byte.** A pre-commit failure (`insufficient_credits`, `invalid_input`, `unauthorized`, `rate_limited`) is a real non-2xx HTTP response — check `res.ok` / `res.status` before reading the stream.
>
> **OpenAI-dialect streams DO emit an error frame.** A post-commit upstream failure is rendered as a `data: {"error": {"message", "type", "param", "code"}}` frame and the stream ends **without** `data: [DONE]` — the official OpenAI SDKs raise an `APIError` on it, and raw consumers should treat a missing `[DONE]` as an abnormal end. `error.code` carries the unified code (e.g. `upstream_error`); `error.type` is the OpenAI-style class (`server_error`, `rate_limit_error`, …). See [05-errors-and-idempotency.md](05-errors-and-idempotency.md#streaming-error-behavior-important-and-dialect-specific). A usage-bearing final chunk carries an empty `choices: []`.

## Anthropic wire · `POST /v1/messages`

Same neutral engine, Anthropic request/response shape (`type:"message"`, `content` blocks, `stop_reason`). Supports streaming SSE (`message_start` / `content_block_delta` / `message_stop`).

## Gemini wire

- `POST /v1beta/models/:model:generateContent` — blocking, Gemini `candidates[]` shape.
- `POST /v1beta/models/:model:streamGenerateContent` — SSE.

Use whichever dialect your existing SDK already speaks; all three bill identically.

## Embeddings · `POST /v1/embeddings`

```sh
curl -sX POST "$ACTIONOW_BASE_URL/v1/embeddings" \
  -H "authorization: Bearer $ACTIONOW_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"text-embedding-3-small","input":["hello","world"]}'
# → { object:"list", data:[{ index, embedding:[…] }], model, usage:{ prompt_tokens, total_tokens } }
```

`input` is a string or array of strings. Optional: `encodingFormat` (`float`|`base64`), `dimensions`, `user`. Billed per input token.

> Field casing: this endpoint uses **`encodingFormat` (camelCase)** — an OpenAI SDK's snake_case `encoding_format` is silently ignored. `dimensions` / `user` are spelled the same either way.

## Rerank · `POST /v1/rerank`

```sh
curl -sX POST "$ACTIONOW_BASE_URL/v1/rerank" \
  -H "authorization: Bearer $ACTIONOW_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"rerank-…","query":"q","documents":["a","b","c"],"topN":2}'
# → { model, results:[{ index, relevance_score, document? }], usage:{ input_tokens } }
```

`results[].index` points back into your original `documents` array. Billed per input token (query + all docs).

## Moderation · `POST /v1/moderations`

```sh
curl -sX POST "$ACTIONOW_BASE_URL/v1/moderations" \
  -H "authorization: Bearer $ACTIONOW_API_KEY" -H 'content-type: application/json' \
  -d '{"model":"omni-moderation-latest","input":"text to check"}'
# → { id, model, results:[{ flagged, categories:{…}, category_scores:{…} }] }
```

## Model discovery · `GET /v1/models`

```sh
curl -s "$ACTIONOW_BASE_URL/v1/models" -H "authorization: Bearer $ACTIONOW_API_KEY"
# → { object:"list", data:[{ id, object:"model", owned_by:"actionow" }] }
```

Returns exactly the models the caller's tenant may use (public active + tenant-granted). The `id` is what you pass as `model`. This call is free.

## Audio & image are here too, but async-shaped

Text-to-speech (`POST /v1/audio/speech`, returns binary audio), transcription (`POST /v1/audio/transcriptions`, multipart), and image generation (`POST /v1/images/generations`) exist as OpenAI-compatible convenience endpoints — see [03-media-jobs-and-files.md](03-media-jobs-and-files.md), which also covers the generic `/v1/run` job path.
