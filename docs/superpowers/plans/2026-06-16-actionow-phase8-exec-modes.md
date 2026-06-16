# Actionow Phase 8 — 执行模式:SSE 流式 + async-callback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. `- [ ]` steps. TDD.

**Goal:** Add `stream` (SSE) and `async-callback` execution modes on top of the existing blocking + async-poll. Streaming proxies LLM tokens, captures final usage, and **settles exactly once at stream end (incl. client disconnect)**. Callbacks accept signed upstream webhooks and route to the already-dedup-safe `engine.handleCallback`.

**Architecture (research-grounded, verified 2026-06):**

- `ProviderAdapter.stream?()` → `AsyncIterable<StreamEvent>` (raw `fetch` SSE parsing, no heavy SDKs). `FetchHttpClient` gains a streaming variant.
- Engine `ExecutionService.runStream()` returns an async **generator** whose `try/finally` does `settleJob` once (finally runs on normal end AND on consumer `return()` = disconnect; settle's transition-guard keeps it idempotent — same property poll/callback rely on).
- NestJS `@Sse()` controller does **validate→quote→hold BEFORE returning the stream** (Nest opens the SSE connection before the handler body, so 402/400 must surface as real HTTP first), then pipes the generator to `MessageEvent`s.
- `POST /v1/callbacks/:provider` (no ApiKeyGuard — HMAC is auth): raw body + per-binding-secret HMAC verify + timestamp replay window → `engine.handleCallback`.

**Source:** capabilities-expansion spec §Phase 8 + the Phase-8 research brief.

---

## Conventions

- Repo root, branch `feat/phase-8-exec-modes`. TDD; commit per task (lowercase conventional subject). Don't push.
- Strict ESLint, no `any`. Tests use injected fakes / a mock-stream adapter — **no network**. Money stays bigint µcredits.
- Reuse: `computeFinalCost`/`settleJob`/`failJob` (engine), `signPayload`/`getJobByUpstreamHandle`, the `EXEC_MODES` already typed in contracts.

---

## Task 1: `StreamEvent` + `adapter.stream()` + streaming HttpClient

**Files:** `packages/contracts/src/adapter.ts` (+`StreamEvent`), `packages/adapters/src/types.ts` (+`stream?`), `packages/infra/src/http.ts` (+streaming method), `packages/adapters/src/internal/sse.ts` (SSE parser); tests.

```ts
// contracts/adapter.ts
export interface StreamEvent {
  kind: 'delta' | 'usage' | 'done' | 'error';
  text?: string; // kind:'delta'
  usage?: UsageVector; // kind:'usage' | 'done'  (normalized {input_tokens,output_tokens})
  error?: UnifiedError; // kind:'error'
}
// also add a streaming HTTP contract:
export interface HttpStreamResponse {
  status: number;
  ok: boolean;
  lines: AsyncIterable<string>;
} // decoded UTF-8 text chunks
export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
  stream?(req: HttpRequest): Promise<HttpStreamResponse>; // optional streaming variant
}
```

```ts
// adapters/types.ts
stream?(input: SubmitInput, ctx: AdapterContext): AsyncIterable<StreamEvent>;
```

- `infra/http.ts`: `FetchHttpClient.stream(req)` → `fetch(...)` with the body, return `{status, ok, lines}` where `lines` async-iterates UTF-8 chunks of `res.body` (Node `Readable`/web `ReadableStream` async iteration). Keep the buffered `request()` unchanged.
- `adapters/internal/sse.ts`: `parseSse(lines: AsyncIterable<string>): AsyncIterable<{event?: string; data: string}>` — SSE framing (buffer partial lines, split on `\n\n`, collect `event:`/`data:` fields; ignore comments/`: ` heartbeats). Pure; unit-test with a canned async iterable.

- [ ] **Step 1:** TDD `parseSse` (multi-chunk frames, `event:`+`data:` lines, `[DONE]` sentinel, partial-line buffering). **Step 2:** add the types + `FetchHttpClient.stream` (test it with `vi.stubGlobal('fetch', …)` returning a `ReadableStream` of two SSE frames; assert lines iterate). **Step 3:** Commit `feat(contracts,infra,adapters): streaming http + StreamEvent + sse parser`.

---

## Task 2: openai/anthropic/gemini `stream()` + a `mock-stream` adapter

**Files:** add `stream()` to `packages/adapters/src/{openai,anthropic,gemini}.ts`; new `packages/adapters/src/mock-stream.ts`; register in default registry; tests.

Each `stream()` builds a streaming request (`stream:true`) via `ctx.http.stream`, runs `parseSse`, yields `{kind:'delta', text}` per token, captures final usage, yields `{kind:'usage', usage}` then `{kind:'done', usage}`:

- **openai**: body `{model, messages, stream:true, stream_options:{include_usage:true}}`; delta text = `choices[0].delta.content`; final usage = the trailing chunk whose `choices:[]` is empty and `usage` set (`prompt_tokens`/`completion_tokens` → input/output_tokens); stop on `data:[DONE]`.
- **anthropic**: body `{model,max_tokens,messages,stream:true}`; events: `message_start`→`message.usage.input_tokens`; `content_block_delta`→`delta.text`; `message_delta`→`usage.output_tokens` (cumulative, final).
- **gemini**: `:streamGenerateContent?alt=sse`; each chunk a full `GenerateContentResponse`; delta = `candidates[0].content.parts[0].text`; final `usageMetadata.promptTokenCount`/`candidatesTokenCount` on the last chunk.
- **mock-stream** (`providerType:'mock-stream'`, modality text): `stream()` yields a few deterministic `delta`s (e.g. `['hel','lo']`) then `{kind:'usage', usage:{input_tokens:10,output_tokens:5}}` + `{kind:'done'}`; no network. (Used by the e2e.) Also give it a trivial `submit` (so blocking still works) + `extractUsage`/`mapError`.

- [ ] TDD each with a fake `HttpClient.stream` returning canned SSE frames (openai/anthropic/gemini): assert delta sequence + final usage extraction; mock-stream pure. Register `createMockStream()` in `createDefaultRegistry`. Commits: `feat(adapters): openai/anthropic/gemini streaming` + `feat(adapters): mock-stream adapter`.

---

## Task 3: engine `runStream()` (hold → stream → settle-once)

**Files:** `packages/engine/src/execution-service.ts` (+`runStream`), `packages/engine/src/stream.ts` (the settling generator); tests.

`runStream(req): Promise<{ jobId: string; events: AsyncIterable<StreamEvent> }>`:

1. (await, before returning) idempotency → `validateInputs` → quote → `applyModifiers` → `holdCredits` (false → throw `insufficient_credits`) → `createJob(status running)`. (Errors here throw → become HTTP 4xx in the controller, before any SSE.)
2. Return `events` = an **async generator** that:
   - resolves channel secret, builds ctx, calls `adapter.stream(input, ctx)`;
   - `for await` yields each upstream `StreamEvent` to the consumer (delta/usage), tracking the latest `usage`;
   - on `error` event → throw (caught below);
   - **`finally`**: compute `finalCost = computeFinalCost(entry, usage ?? estimateFromHold, inputs, modifiers)`; `settleJob({jobId, ..., outbox: callbackUrl?})` **once** (idempotent guard); emit a final `{kind:'done', usage, cost}` is done by the controller from the settle result (or have the generator yield `done` just before `finally` completes settle — keep the cost in a shared ref the controller reads). Simplest: the generator yields `delta`/`usage`, and `runStream` also returns a `settle()` the controller calls in `finalize`; **but** to guarantee settle on disconnect, prefer the generator's `finally` doing settle and pushing a final `done` event with cost via the same stream. Pick the approach the tests prove: settle happens exactly once on (a) normal completion, (b) thrown upstream error (→ `failJob`/settle on partial), (c) consumer early-return (disconnect). Use a `settled` boolean guard + the DB transition-guard as the backstop.

- Add a `'stream'` branch in `execute()`'s mode handling (do NOT fold into BLOCKING_MODES).

- [ ] **Step 1: integration test** (Testcontainers pg + `mock-stream` adapter + a fake context loader): drive `runStream`, consume the generator fully → assert delta sequence, a single `settle` ledger row with cost from the mock usage, account debited. Then a **disconnect test**: consume only the first delta then `return()` the iterator → assert `finally` still settled exactly one row (against held/partial). `insufficient_credits` before any event. **Step 2–4:** implement; green. **Step 5:** Commit `feat(engine): runStream with settle-once on completion/disconnect`.

---

## Task 4: API SSE on `/v1/run` + `POST /v1/callbacks/:provider`

**Files:** `apps/api/src/execution/run.controller.ts` (+SSE branch or a sibling), `apps/api/src/callbacks/*` (module/controller), `apps/api/src/main.ts` (raw-body for callbacks); tests.

**SSE**: when `POST /v1/run/:id` has header `Accept: text/event-stream` (or a dedicated `@Sse()` handler the controller delegates to), the handler:

- is `async`, does `await runService.runStream(...)` (this performs hold; **throws → real HTTP 402/400** because nothing is written yet);
- then returns an `Observable<MessageEvent>` built from the generator (`from(asyncIterableToObservable(events))`), mapping each `StreamEvent` to `{type: ev.kind, data: ev}` (so clients get `event: delta/usage/done/error`);
- attach `.pipe(finalize(...))` is unnecessary if the generator owns settle, but ensure the generator is `return()`-ed on unsubscribe (NestJS does this) so its `finally` runs.
- Verify `@Sse()` works with `async` handler + POST in this NestJS 11 setup; if not, fall back to manual `@Res()` SSE (set `text/event-stream`, `no-cache`, `keep-alive`, `X-Accel-Buffering:no`, write `event:`/`data:` frames, `res.on('close')` → settle). Pick whichever the e2e proves reliable.
- `cost.credits` stays a µcredit decimal string.

**Callbacks**: `POST /v1/callbacks/:provider` (NOT behind ApiKeyGuard):

- `main.ts`: mount `express.raw({type:'*/*'})` (or `express.json({verify})`) scoped to `/v1/callbacks` so `req.rawBody` is the exact bytes.
- controller: parse the body minimally to find the upstream job id → load the job + its binding/channel secret → **HMAC verify** `signPayload(secret, rawBody)` vs the provider signature header with `timingSafeEqual` + timestamp window (~5min) → on pass call `engine.handleCallback(parsedPayload)` (dedup-safe) → 200; on fail → 401/`unauthorized`. (Per-provider signature framing belongs in the adapter `verifyCallback`/`parseCallback`; for the scaffold a generic `X-Actionow-Signature` HMAC over raw body is the reference, used by the mock/dify.)

- [ ] **Step 1: e2e** — (a) **SSE**: seed a `mock-stream` resource; `POST /v1/run/:id` with `Accept: text/event-stream` over the real server (or via supertest reading the chunked body) → collect `delta` events, a `done` with `cost`, assert exactly one settle ledger row + debit; **insufficient_credits** → 402 (no SSE). (b) **callbacks**: a job awaiting callback; POST a correctly-signed body → settles (one ledger row); wrong signature → 401; duplicate → still one row. **Step 2–4:** implement; green. **Step 5:** Commit `feat(api): SSE streaming run + signed async-callback ingress`.

---

## Task 5: Verification gate

- [ ] `pnpm typecheck && pnpm lint && pnpm build && pnpm test` green (Docker up). Boundaries intact. No secret logging (callback secrets/signatures, upstream keys). Commit any fixups `chore: phase-8 exec-modes verification gate green`.

---

## Phase 8 Definition of Done

- `ProviderAdapter.stream()` + a streaming `FetchHttpClient`; openai/anthropic/gemini stream tokens + final usage; a `mock-stream` adapter for tests.
- `POST /v1/run` with `Accept: text/event-stream` streams `delta/usage/done/error` and **settles exactly once** on completion AND on client disconnect (proven), `insufficient_credits` surfaces as 402 before any event.
- `POST /v1/callbacks/:provider` verifies a per-binding HMAC over the raw body and routes to the dedup-safe `handleCallback`; bad signature → 401; duplicates → one ledger row.
- `pnpm typecheck/lint/build/test` green; boundaries enforced; no secret leakage.

> **Next:** Phase 9 — OAuth + unified identity (admin_user → user).
