# 流式模型降级 (Streaming Model-Fallback) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the streaming relay to parity with blocking on model-degradation fallback (`model.fallbackModels`): when every channel of the requested model fails _before the stream commits_, degrade to the next model in the chain.

**Architecture:** Split `packages/engine/src/stream.ts` so Phase-1 (channel selection + pulling the first event) becomes an awaitable `openChatStreamCommit` that **throws** on total pre-commit failure; `createChatSettlingStream` becomes a **drain-only** generator over the pre-committed stream. `runChatStream` awaits the commit before returning (so a throw releases the hold and surfaces as a real HTTP error pre-flush). The relay's `chatStream()` then loops the `[primary, ...fallbackModels]` chain exactly like blocking `chat()`.

**Tech Stack:** NestJS (apps/api), TS engine (packages/engine), vitest; api e2e use `@testcontainers/postgresql`. **No migration, no contracts/SDK change** (`fallbackModels`, `getModelFallbacks`, `DEGRADE_CODES`/`shouldDegradeToNextModel` all already exist; `ChatStreamOutcome` is an engine-internal type).

**Spec:** `docs/superpowers/specs/2026-06-26-streaming-model-fallback-design.md`. Branch: `feat/streaming-model-fallback` (spec committed).

**Conventions (follow exactly):**

- **GIT IS GATED on the Xcode license:** prefix EVERY git command with `DEVELOPER_DIR=/Library/Developer/CommandLineTools`. The pre-commit hook works under it. NEVER run sudo / `xcodebuild -license`.
- commitlint: lowercase imperative subject, header ≤100 chars; commit body ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do NOT push / open PRs (phase 3 is the controller's).
- i18n: user-facing strings in BOTH `apps/web/src/i18n/locales/zh-CN` and `/en`.
- GROUND TRUTH OVER PLAN: read `packages/engine/src/stream.ts` (the Phase-1 loop is ~lines 276-431) and `packages/engine/src/execution-service.ts` (`runChatStream` ~lines 370-411) before editing; adapt to real names. **Invariants:** a single committing channel streams byte-for-byte as today; only the committed model settles (no double-charge); mid-stream (post-commit) errors stay in-band; cross-channel pre-commit failover is preserved (just moved into the awaited commit).

---

## Phase 1 — Engine: split commit from drain

### Task 1: `openChatStreamCommit` + drain-only `createChatSettlingStream` + `runChatStream` awaits commit

**Files:**

- Modify: `packages/engine/src/stream.ts`, `packages/engine/src/execution-service.ts` (`runChatStream` + `ChatStreamOutcome` type)
- Test: `packages/engine/test/stream.*.test.ts` (extend the existing stream test; reuse its fake adapter harness)

- [ ] **Step 1: Read** `packages/engine/src/stream.ts` (whole file) and the `runChatStream` method + `ChatStreamOutcome` type in `execution-service.ts`. Identify the fake-adapter test harness in `packages/engine/test/`.

- [ ] **Step 2: Failing engine test(s)** in the stream test file:
  - `openChatStreamCommit` with a candidate list whose first channel yields a `retryable` error on the first event and second channel yields a good first event → resolves to a committed stream served by the SECOND channel (cross-channel pre-commit failover preserved).
  - `openChatStreamCommit` with ALL channels failing on the first event (retryable) → **rejects/throws** a `EngineError` (NOT an in-band error event). Assert the thrown error's `unified.code` is the last channel's code.
  - `openChatStreamCommit` with a non-retryable first error → throws that unified error.
  - The drain generator over a committed stream yields `first` then the rest, and a post-commit mid-stream `error` event is forwarded **in-band** (yielded, not thrown) and releases the hold.
    Run, expect FAIL.

- [ ] **Step 3: Extract `openChatStreamCommit`.** Move the Phase-1 body (current `stream.ts` ~lines 287-382: `availableChannels` → empty-check → `orderForFailover` → the per-channel `for` loop with `adapter.streamChat`, first-event pull, `recordFailureSafe`/`recordCommitSafe`, cross-channel failover) into:

```ts
export interface CommittedChatStream {
  readonly iterator: AsyncIterator<ChatStreamEvent>;
  /** The first event already pulled (undefined for an empty stream). */
  readonly first: ChatStreamEvent | undefined;
  readonly servedChannel: RunChannel;
}

/**
 * Phase 1: pick a LIVE channel and pull the first event, with breaker-aware
 * cross-channel pre-commit failover. Resolves once a channel commits (first
 * event is non-error, or the stream is empty). THROWS an EngineError when every
 * channel is exhausted / a non-retryable first error / no streamable channel —
 * the caller (runChatStream) releases the hold and the throw becomes a real HTTP
 * error (pre-flush) or drives the relay's model fallback.
 */
export async function openChatStreamCommit(deps: SettlingStreamDeps): Promise<CommittedChatStream> {
  const ir = /* deps.inputs.__ir guard, same EngineError as today */;
  const rng = deps.rng ?? Math.random;
  const now = deps.now ?? (() => new Date());
  const model = deps.req.usageLogModel ?? '*';
  // recordFailureSafe / recordCommitSafe (same fire-and-forget breaker hooks)
  const available = await availableChannels({ db: deps.db, now, rng, breaker: deps.breaker }, deps.req.channels, model);
  if (available.length === 0) {
    throw new EngineError({ code: 'internal_error', message: 'no upstream channel to route to', retryable: false });
  }
  const ordered = orderForFailover(available.map((c) => ({ id: c.id, weight: c.weight, priority: c.priority, value: c })), rng);
  let lastError: UnifiedError | undefined;
  for (let i = 0; i < ordered.length; i += 1) {
    const channel = ordered[i]?.value;
    if (channel === undefined) continue;
    const isLast = i === ordered.length - 1;
    const adapter = deps.adapters.get(channel.providerType ?? deps.req.resource.providerType);
    if (adapter.streamChat === undefined) {
      lastError = { code: 'internal_error', message: `adapter ${adapter.providerType} cannot streamChat`, retryable: false };
      if (!isLast) continue;
      throw new EngineError(lastError);
    }
    const ctx = await buildContext(deps, channel);
    try {
      const iterator = adapter.streamChat(ir, ctx)[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done === true) { recordCommitSafe(channel.id); return { iterator, first: undefined, servedChannel: channel }; }
      if (first.value.type === 'error') {
        const e = first.value.error;
        if (e.retryable && !isLast) { await recordFailureSafe(channel.id); lastError = e; continue; }
        throw new EngineError(e); // non-retryable or last → drive fallback / HTTP error
      }
      recordCommitSafe(channel.id);
      return { iterator, first: first.value, servedChannel: channel };
    } catch (err) {
      if (err instanceof EngineError && !err.unified.retryable) throw err; // already a decided failure
      if (isFailoverRetryable(err) && !isLast) { await recordFailureSafe(channel.id); lastError = toUnified(err); continue; }
      throw err instanceof EngineError ? err : new EngineError(toUnified(err));
    }
  }
  throw new EngineError(lastError ?? { code: 'upstream_error', message: 'all channels failed', retryable: false });
}
```

(Adapt names to the real file. Keep `recordFailureSafe`/`recordCommitSafe`/`availableChannels`/`orderForFailover`/`buildContext` exactly as today. Note: the EngineError thrown for a retryable-exhausted chain must carry a retryable DEGRADE code — preserve `lastError`'s original `code`/`retryable` so the relay's `shouldDegradeToNextModel` sees `upstream_error`/`upstream_timeout`/`rate_limited` and degrades; a non-retryable first error must keep `retryable:false` so it does NOT degrade.)

- [ ] **Step 4: Make `createChatSettlingStream` drain-only.** Change its signature to accept the committed stream and run only Phase 2 + finalize:

```ts
export async function* createChatSettlingStream(
  deps: SettlingStreamDeps,
  committed: CommittedChatStream,
): AsyncGenerator<ChatStreamEvent> {
  // keep: latestUsage, failure, settled, streamedChars, measuredUsage, finalize (servedChannel comes from `committed.servedChannel`)
  const servedChannel = committed.servedChannel;
  try {
    const drain = async function* () {
      if (committed.first !== undefined) yield committed.first;
      for (;;) {
        const next = await committed.iterator.next();
        if (next.done === true) break;
        yield next.value;
      }
    };
    for await (const ev of drain()) {
      /* SAME Phase-2 body: usage tally, content/tool char tally, in-band error → set failure + yield + return, else yield */
    }
  } catch (err) {
    const unified = failure ?? toUnified(err);
    failure = unified;
    await finalize();
    yield { type: 'error', error: unified };
  } finally {
    await finalize();
  }
}
```

(`finalize`/`measuredUsage` bodies unchanged; `servedChannel` is now sourced from `committed`, not a mutable let.)

- [ ] **Step 5: `runChatStream` awaits the commit.** In `execution-service.ts`, after `validateAndHold` produces `{inputs, holdAmount}` + `jobId`, build the `SettlingStreamDeps` (same object as today), then:

```ts
const deps = {
  /* same deps createChatSettlingStream used to be built with */
};
let committed: CommittedChatStream;
try {
  committed = await openChatStreamCommit(deps);
} catch (err) {
  // Release the hold the same way the generator's finalize would on failure.
  await failStream(deps, err instanceof EngineError ? err.unified : toUnified(err));
  throw err instanceof EngineError ? err : toEngineError(err);
}
return { jobId, servedModel: req.usageLogModel, events: createChatSettlingStream(deps, committed) };
```

Add `servedModel?: string` to the `ChatStreamOutcome` type. (If `failStream`/`toEngineError`/`toUnified` aren't already imported in execution-service, import from where stream.ts gets them, or expose a tiny helper. Confirm `SettlingStreamDeps` is exported from stream.ts.)

- [ ] **Step 6: Run engine tests + build.** `pnpm --filter @actionow/engine exec vitest run` (PASS); `pnpm --filter @actionow/engine build`; `pnpm --filter @actionow/engine typecheck`.

- [ ] **Step 7: Commit.**

```bash
DEVELOPER_DIR=/Library/Developer/CommandLineTools git add packages/engine/
DEVELOPER_DIR=/Library/Developer/CommandLineTools git commit -m "feat(engine): split stream commit from drain; throw on pre-commit failure (streaming fallback)"
```

---

## Phase 2 — Relay + controller: loop the model chain

### Task 2: `chatStream()` model-chain loop + served-model labeling + copy

**Files:**

- Modify: `apps/api/src/chat/chat-relay.service.ts` (`chatStream` + doc-comments), the streaming controller(s) (`apps/api/src/chat/openai.controller.ts`; check for an Anthropic `messages` controller + a Gemini controller with a streaming branch), `apps/api/src/i18n`? (no — i18n is web). i18n in `apps/web/src/i18n/locales/{zh-CN,en}/console.json`.
- Test: `apps/api/test/*stream*.e2e.test.ts` (extend or add; fake adapter switchable fail-on-first-event vs stream-ok)

- [ ] **Step 1: Read** `chat-relay.service.ts` (`chat()` is the blocking model-chain precedent at ~line 136; `chatStream()` at ~108) and the streaming controller branch(es). Find how api e2e fakes adapters / forces a channel to fail on the first stream event.

- [ ] **Step 2: Failing relay e2e** (fake adapter): a streaming `/v1/chat/completions {stream:true}` where the requested model's only upstream returns a RETRYABLE error on the first event, and that model has `fallbackModels=[good-model]` with a healthy upstream → the SSE stream commits to `good-model`, the client receives content frames, and the `usage_log` row records the served (fallback) model. Run, expect FAIL.

- [ ] **Step 3: Implement the chain loop** in `chatStream()` (mirror `chat()` exactly):

```ts
async chatStream(modelName, ir, ctx, idempotencyKey?, routeTag?): Promise<ChatStreamOutcome> {
  const chain = [modelName, ...(await getModelFallbacks(this.db, modelName))];
  let lastError: unknown;
  for (const [i, model] of chain.entries()) {
    const isLast = i === chain.length - 1;
    const idem = idempotencyKey === undefined || i === 0 ? idempotencyKey : `${idempotencyKey}:fb${String(i)}`;
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

(`getModelFallbacks` + `shouldDegradeToNextModel` + `DEGRADE_CODES` are already imported/defined in this file for `chat()`. Reuse them.) Update the `chatStream`/`chat` doc-comments to drop "(Streaming has no model fallback …)".

- [ ] **Step 4: Served-model labeling in the controller(s).** Where the controller does `const { events } = await this.relay.chatStream(...)`, also read `servedModel` and pass `servedModel ?? ir.model` to the dialect renderer (`renderOpenAIChatStream(events, servedModel ?? ir.model)`, and the Anthropic/Gemini equivalents if they have a streaming branch). If a controller doesn't destructure `servedModel`, add it.

- [ ] **Step 5: i18n copy.** In `apps/web/src/i18n/locales/zh-CN/console.json` + `/en/console.json`, reword `models.tip.fallbackModels` to drop "仅作用于非流式 / Non-streaming only" → "阻塞式与流式均生效" / "applies to both blocking and streaming".

- [ ] **Step 6: Run** the new relay e2e (PASS) + `pnpm --filter @actionow/api typecheck` + `pnpm --filter @actionow/web typecheck`. Add e2e cases: non-retryable first error → NO fallback + HTTP error; ALL models fail pre-commit → real HTTP error (not 200+frame); post-commit mid-stream error → still in-band.

- [ ] **Step 7: Commit.**

```bash
DEVELOPER_DIR=/Library/Developer/CommandLineTools git add apps/api/ apps/web/src/i18n/
DEVELOPER_DIR=/Library/Developer/CommandLineTools git commit -m "feat(api): streaming model-fallback via fallbackModels chain (streaming fallback)"
```

---

## Phase 3 — Gate (controller's, not the workflow's)

### Task 3: full gate, live-verify, memory, PR

- [ ] **Step 1: Full suites** (testcontainer suites separately to dodge parallel-load flake): engine, contracts, db, `apps/api` e2e, web — all green; api + web typecheck + eslint clean.
- [ ] **Step 2: Live-verify** (rebuild + restart API): a streaming relay where the primary model's upstream fails retryably and `fallbackModels` points to a healthy model → SSE streams from the fallback; an all-fail case → a real HTTP error (not 200+frame).
- [ ] **Step 3:** Memory (`memory/streaming-model-fallback.md` + index; update [[route-tagging]]/[[billing-routing-governance]]: ⑤ fully closed). PR → `main` → squash-merge (footers).

---

## Self-review notes (addressed)

- **Spec coverage:** §② → T1 (commit/drain split + throw + servedModel); §③④ → T2 (chain loop + served-model label); §⑦ copy → T2 step 5; §⑥ testing across T1/T2; §⑨ phasing = these phases.
- **Invariant — single committing channel unchanged:** drain-only generator over a committed stream is byte-for-byte the old Phase-2; a one-channel chain = one commit then drain.
- **Invariant — no double-charge:** each model attempt is a self-contained `runChatStream` (hold released on pre-commit throw); only the committed model settles; distinct idempotency keys.
- **Degrade gating:** the EngineError thrown by `openChatStreamCommit` must preserve the underlying `code`/`retryable` so `shouldDegradeToNextModel` degrades only on DEGRADE_CODES (retryable upstream failures), never on client-side codes — called out in T1 step 3.
- **Naming:** `openChatStreamCommit`/`CommittedChatStream`/`ChatStreamOutcome.servedModel` consistent across tasks.
