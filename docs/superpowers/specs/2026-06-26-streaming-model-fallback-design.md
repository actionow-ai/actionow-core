# 流式模型降级 (Streaming Model-Fallback) — Design Spec

> ⑤-S, the last open item of 计费与路由 ⑤ ([[route-tagging]] / [[billing-routing-governance]]). Brings the streaming relay to parity with blocking on **model-degradation fallback** (`model.fallbackModels`, 模型降级链): when every channel of the requested model fails _before the stream commits_, degrade to the next model in the chain — exactly as blocking `chat()` already does.

## What exists today (build on, don't duplicate)

- **Blocking model-fallback SHIPPED:** `ChatRelayService.chat()` (`apps/api/src/chat/chat-relay.service.ts:136`) walks `chain = [modelName, ...getModelFallbacks(db, modelName)]`; on a retryable upstream failure it degrades to the next model. `shouldDegradeToNextModel(err)` gates on `DEGRADE_CODES = {upstream_error, upstream_timeout, rate_limited, job_failed}` (client-side codes never fall back). Each attempt is a self-contained `runChat` (hold → route → settle-or-release) with a **distinct idempotency key** (`${key}:fb${i}`) so attempts never double-charge.
- **Streaming cross-channel pre-commit failover SHIPPED, but model-fallback explicitly NOT:** `createChatSettlingStream` (`packages/engine/src/stream.ts`) has a Phase-1 loop that tries each candidate channel of the ONE model, pulling the first event; a retryable error on the first event (or a retryable throw) cools that channel and advances to the next. Once a non-error first event arrives, the channel is **committed** (Phase 2 drains it; a later mid-stream error is forwarded in-band). The `chatStream()` relay method builds ONE request — no model chain. The code comment says _"(Streaming has no model fallback — it commits mid-stream.)"_ and the model-editor i18n says _"仅作用于非流式 / Non-streaming only"_.
- **Timing — the point of no return:** the controller (`apps/api/src/chat/openai.controller.ts`) does `const { events } = await relay.chatStream(...)` then `pipeSse(res, render(events))`. `pipeSse` (`apps/api/src/chat/sse.ts:27`) calls `res.flushHeaders()` **before** draining the (lazy) generator. So today even cross-channel total failure happens _after_ headers flush → the client gets a `200` + an in-band error frame, never an HTTP error. Pre-flush failures (validate + credit hold, inside `runChatStream`) DO surface as real HTTP errors.
- `getModelFallbacks(db, modelName)`, `model.fallbackModels` (schema + contracts + admin persistence + web ModelEditor/Drawer + i18n) all already exist. `ChatStreamOutcome` is an engine-internal type (NOT a wire contract). **No migration, no contracts/SDK change.**

## ① Core idea

Move the streaming **commit** (Phase-1: channel selection + pulling the first event) **out of the lazy generator and into the awaited `runChatStream`**. The first good event is then in hand _before_ the controller flushes SSE headers, which makes two things possible:

1. **Cross-model pre-commit failover at the relay layer** — `chatStream()` loops the `fallbackModels` chain just like blocking `chat()`, because a model's total pre-commit failure now throws (catchable) instead of becoming an in-band frame.
2. **Real HTTP errors on total failure** — if every channel of every model fails before commit, the throw reaches the global `UnifiedErrorFilter` (res untouched) → a real `5xx/4xx`, not a `200` + error frame.

Cross-channel pre-commit failover (already shipped) is preserved — it now simply runs inside the awaited commit (pre-flush). Mid-stream (post-commit) errors stay in-band — you cannot fail over once bytes are on the wire.

**Accepted trade-off:** SSE headers now flush _after_ the first token arrives (a slight delay on slow models), in exchange for correct HTTP status + clean fallback. This is inherent to "don't commit headers until you have a good first event."

## ② Engine — split `stream.ts` into commit + drain

- **`openChatStreamCommit(deps): Promise<CommittedChatStream>`** — today's Phase-1 loop, extracted verbatim: `availableChannels` (breaker-filtered) → `orderForFailover` → per channel: `adapter.streamChat(ir, ctx)` iterator, `await iterator.next()` for the first event, breaker `onFailure`/`onSuccess`, cross-channel pre-commit failover on a retryable first-event error / retryable throw. On a good first event (or an empty `first.done`) → returns `{ iterator, first, servedChannel }`. **On all-channels-exhausted → throws** the accumulated unified error (NOT an in-band yield).
- **`createChatSettlingStream` becomes drain-only** — takes the pre-committed `{ iterator, first, servedChannel }` + deps and runs today's Phase 2 unchanged: yield `first`, drain the rest, tally usage/streamed-bytes, forward a mid-stream error **in-band**, settle-once in `finally` (failure → `failStream` release; success → `settleStream` + `mirrorChatUsageLog`). `measuredUsage()` on disconnect unchanged.
- **`runChatStream(req)`** — `claimIdempotency` (unchanged) → `validateAndHold` (places the hold, persists the job) → `try { committed = await openChatStreamCommit(...) } catch (err) { await failStream(deps, toUnified(err)); throw toEngineError(err) }` → returns `{ jobId, servedModel: req.usageLogModel, events: <drain generator over committed> }`. The commit (open upstream + first event, with channel failover) now happens during the await; a total pre-commit failure releases the hold and throws.

`ChatStreamOutcome` gains an optional `servedModel?: string` (engine-internal type only).

## ③ Relay — `chatStream()` mirrors `chat()`

```
async chatStream(modelName, ir, ctx, idempotencyKey?, routeTag?): Promise<ChatStreamOutcome> {
  const chain = [modelName, ...(await getModelFallbacks(this.db, modelName))];
  let lastError: unknown;
  for (const [i, model] of chain.entries()) {
    const isLast = i === chain.length - 1;
    const idem = idempotencyKey === undefined || i === 0 ? idempotencyKey : `${idempotencyKey}:fb${i}`;
    try {
      const req = await this.buildChatRunRequest(model, ir, ctx, 'stream', idem, routeTag);
      return await this.buildService().runChatStream(req);
    } catch (err) {
      lastError = err;
      if (isLast || !shouldDegradeToNextModel(err)) throw err;
    }
  }
  throw lastError;
}
```

Identical control flow to blocking `chat()` — reuses the same `DEGRADE_CODES`/`shouldDegradeToNextModel` and distinct-idempotency-key scheme. Each model attempt is a self-contained `runChatStream` (its own `model_token` pricebook + `estimatedUsage` hold); only the committed model settles → no double-charge; `usageLogModel` = the actually-served model.

## ④ Controller / SSE

Shape unchanged: `const { events, servedModel } = await relay.chatStream(...)` now blocks until commit-or-throw. A throw hits the global `UnifiedErrorFilter` → real HTTP status (res never touched, headers not flushed). On success, `pipeSse(res, renderOpenAIChatStream(events, servedModel ?? ir.model))` flushes + drains; the renderer labels chunks with the **served** model (parity with blocking, which returns the served model's response). The same treatment applies to the Anthropic/Gemini dialect controllers if they have a streaming branch (mirror the OpenAI one).

## ⑤ Correctness & observability

- **Pricing:** per-model self-contained hold/settle (like blocking) keeps pricing correct across a fallback — the committed model's `model_token` pricebook prices the settle.
- **Charging:** only the committed model settles; every failed-pre-commit model releases its hold. No double-charge (distinct idempotency keys).
- **usage_log / relay_trace:** record the served model + channel (the engine already mirrors `usageLogModel` + served channel).
- **Breaker:** the same `onFailure`/`onSuccess` calls, moved into the awaited commit.
- **Settle-once:** unchanged (`settled` guard + DB transition guard), still robust to client disconnect during drain.

## ⑥ Testing

- **Engine (`packages/engine`):** `openChatStreamCommit` fails over across channels pre-commit; **all-channels-fail throws** a unified error (not an in-band frame); the drain generator yields `first` then the rest and settles exactly once; a post-commit mid-stream error is forwarded in-band and releases (no charge). Reuse the existing stream test harness / fake adapter.
- **Relay e2e (`apps/api`, fake adapter switchable fail-on-first-event vs stream-ok):**
  - primary model's only upstream fails retryably (e.g. `upstream_error` on first event) + `fallbackModels=[good]` → the stream **commits to the fallback model**, the client receives content frames, and `usage_log` records the served (fallback) model.
  - primary fails **non-retryably** (`content_filtered`) → **no** fallback, real HTTP error.
  - **all** models fail pre-commit → real HTTP error (NOT `200` + error frame).
  - a **post-commit** mid-stream error → still in-band (unchanged), hold released.
  - distinct idempotency keys per attempt (a failed claim can't block the next model).
- **Regression:** existing streaming suite + blocking model-fallback suite stay green; non-fallback streaming is byte-for-byte unchanged (single-model chain = one commit, then drain).

## ⑦ Copy / docs

- `apps/web/src/i18n/locales/{zh-CN,en}/console.json` → `models.tip.fallbackModels`: drop "仅作用于非流式 / Non-streaming only" (now applies to streaming too); reword to "阻塞式与流式均生效 / applies to both blocking and streaming".
- `chat-relay.service.ts` `chatStream`/`chat` doc-comments: remove "(Streaming has no model fallback …)"; describe the unified chain behavior.

## ⑧ Out of scope (YAGNI)

- Post-commit (mid-stream) failover — impossible without buffering/replaying the whole stream; stays in-band.
- Any change to blocking `chat()` (already correct).
- New schema / migration / contracts / SDK changes (`fallbackModels` already exists end-to-end).
- Per-model retry-within-a-model for streaming (streaming has no same-channel retry by design; only cross-channel/cross-model failover).

## ⑨ Phasing (one branch `feat/streaming-model-fallback`, phased commits → one PR → squash-merge)

1. **Engine refactor:** extract `openChatStreamCommit`; make `createChatSettlingStream` drain-only; `runChatStream` awaits commit + throws on total pre-commit failure; `ChatStreamOutcome.servedModel`. Engine tests. No behavior change for a single committing channel.
2. **Relay + controller:** `chatStream()` loops the `fallbackModels` chain; controllers label chunks with the served model. Relay e2e.
3. **Copy + gate:** i18n + doc-comment updates; full-suite + live-verify; memory; PR.
