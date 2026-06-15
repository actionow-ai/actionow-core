# Actionow Phase 2 — Provider Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. Follow superpowers:test-driven-development.

**Goal:** Implement the `ProviderAdapter` abstraction (§6) and the five adapters (`openai`, `anthropic`, `gemini`, `async-media-mock`, `dify-workflow`), the adapter registry, and weighted-random + failover routing — all unit-tested against an injectable `HttpClient` fake (no real API keys, no network in tests).

**Architecture:** `packages/contracts` gains adapter-facing types + the `HttpClient` interface (pure). `packages/infra` gains a `fetch`-based `HttpClient` impl. `packages/adapters` holds the `ProviderAdapter` interface, the 5 impls, the registry, and routing — importing only `contracts`, `domain`, `infra` (boundaries-enforced). Adapters receive an `AdapterContext` carrying the resolved credential + endpoint + an `HttpClient`; tests inject a fake client. The execution layer (Phase 3) calls `validateInputs` (domain) before `submit`, resolves secrets, and drives routing.

**Tech Stack:** TypeScript strict, Vitest. Node 24 global `fetch` for the real client. No new runtime deps (use built-in `fetch`/`crypto.randomUUID`).

**Source spec:** `docs/superpowers/specs/2026-06-16-actionow-backend-scaffold-design.md` — §4.7 (unified errors), §6 (adapter interface + routing), §7 (Dify runtime).

---

## Conventions

- Repo root `/Users/alienworm/actionow-core`, branch `feat/phase-2-adapters`. TDD; commit per task (lowercase conventional subject). Don't push.
- Strict ESLint (no `any`, explicit return types, `consistent-type-imports`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Add `test` to each touched package's tsconfig `include` (already done for contracts/domain; do it for `adapters` and `infra` mirroring the db package's `tsconfig.json` + `tsconfig.build.json` split).
- Tests must use a **fake `HttpClient`** — never real network. Use `crypto.randomUUID()` for ids.
- `adapters` may import `@actionow/contracts`, `@actionow/domain`, `@actionow/infra` only.

---

## Task 1: Adapter contract types + `HttpClient` (`@actionow/contracts`) + fetch impl (`@actionow/infra`)

**Files:** Create `packages/contracts/src/adapter.ts`, `packages/contracts/src/http.ts`; modify `packages/contracts/src/index.ts`; create `packages/infra/src/http.ts`, modify `packages/infra/src/index.ts`; tests `packages/contracts/test/adapter.test.ts`, `packages/infra/test/http.test.ts`.

- [ ] **Step 1:** Implement `contracts/src/http.ts`:

```ts
export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}
export interface HttpResponse {
  status: number;
  ok: boolean;
  body: unknown; // parsed JSON when possible, else undefined
  text: string;
}
export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}
```

- [ ] **Step 2:** Implement `contracts/src/adapter.ts`:

```ts
import type { HttpClient } from './http.js';

export const EXEC_MODES = ['blocking', 'stream', 'async-poll', 'async-callback'] as const;
export type ExecMode = (typeof EXEC_MODES)[number];

export type UsageVector = Record<string, number>;

export const UNIFIED_ERROR_CODES = [
  'invalid_input',
  'insufficient_credits',
  'resource_not_found',
  'rate_limited',
  'upstream_error',
  'upstream_timeout',
  'content_filtered',
  'job_failed',
  'unauthorized',
  'internal_error',
] as const;
export type UnifiedErrorCode = (typeof UNIFIED_ERROR_CODES)[number];

export interface UnifiedError {
  code: UnifiedErrorCode;
  message: string;
  upstream?: { provider: string; rawCode?: string };
  retryable: boolean;
  retryAfterMs?: number;
}

export interface AdapterContext {
  providerType: string;
  model?: string;
  endpoint?: string;
  apiKey?: string; // resolved from vault by caller; never logged
  http: HttpClient;
}

export interface SubmitInput {
  resourceId: string;
  modality: string;
  inputs: Record<string, unknown>;
  execMode: ExecMode;
  ctx: AdapterContext;
}

export interface SyncResult {
  kind: 'sync';
  output: Record<string, unknown>;
  usage: UsageVector;
}
export interface UpstreamJobHandle {
  kind: 'async';
  provider: string;
  upstreamJobId: string;
  meta?: Record<string, unknown>;
}
export type SubmitResult = SyncResult | UpstreamJobHandle;

export type UpstreamStatus = 'running' | 'succeeded' | 'failed';
export interface PollResult {
  status: UpstreamStatus;
  output?: Record<string, unknown>;
  usage?: UsageVector;
  error?: UnifiedError;
}
export interface CallbackResult extends PollResult {
  upstreamJobId: string;
}
```

- [ ] **Step 3:** Implement `infra/src/http.ts` — `FetchHttpClient implements HttpClient` using global `fetch`, with `AbortController` timeout; parse body as JSON when `content-type` includes `json` (guard parse errors → `body: undefined`), always capture `text`. Export a singleton `fetchHttpClient`. Add a unit test that stubs global `fetch` (vitest `vi.stubGlobal('fetch', …)`) verifying JSON parse, non-JSON text passthrough, and timeout → throws.

- [ ] **Step 4:** Barrels: `contracts/src/index.ts` add `export * from './http.js'; export * from './adapter.js';`. `infra/src/index.ts` add `export * from './http.js';`.

- [ ] **Step 5:** Tests for the contract types are light (type-level); the meaningful test is `infra/test/http.test.ts`. Add `adapters`/`infra` tsconfig `test` include + `tsconfig.build.json` as needed. Verify `pnpm --filter @actionow/contracts --filter @actionow/infra test`, typecheck, eslint green. Commit `feat(contracts,infra): adapter contract types + HttpClient (fetch impl)`.

---

## Task 2: `ProviderAdapter` interface, error helpers, registry skeleton (`@actionow/adapters`)

**Files:** Create `packages/adapters/src/types.ts`, `packages/adapters/src/errors.ts`, `packages/adapters/src/registry.ts`; modify barrel; test `packages/adapters/test/registry.test.ts`.

- [ ] **Step 1:** `types.ts` — the interface:

```ts
import type {
  AdapterContext,
  CallbackResult,
  PollResult,
  SubmitInput,
  SubmitResult,
  UnifiedError,
  UsageVector,
} from '@actionow/contracts';

export interface ProviderAdapter {
  readonly providerType: string;
  submit(input: SubmitInput): Promise<SubmitResult>;
  poll?(upstreamJobId: string, ctx: AdapterContext): Promise<PollResult>;
  parseCallback?(payload: unknown): CallbackResult;
  extractUsage(raw: unknown): UsageVector;
  mapError(raw: unknown): UnifiedError;
}
```

- [ ] **Step 2:** `errors.ts` — `httpStatusToUnified(provider: string, status: number, rawCode?: string): UnifiedError` mapping: 400→`invalid_input`(retryable false), 401/403→`unauthorized`(false), 404→`resource_not_found`(false), 408→`upstream_timeout`(true), 429→`rate_limited`(true), 5xx→`upstream_error`(true), else→`upstream_error`(false). Also `AdapterError extends Error` carrying a `UnifiedError` (so `submit` can `throw new AdapterError(unified)` and routing can read `.unified.retryable`). Test the mapping table.

- [ ] **Step 3:** `registry.ts`:

```ts
import type { ProviderAdapter } from './types.js';

export class AdapterRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();
  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.providerType, adapter);
  }
  has(providerType: string): boolean {
    return this.adapters.has(providerType);
  }
  get(providerType: string): ProviderAdapter {
    const a = this.adapters.get(providerType);
    if (!a) throw new Error(`no adapter for provider_type "${providerType}"`);
    return a;
  }
}
```

- [ ] **Step 4:** Test the registry (register/get/has/throw). Barrel exports. Verify green. Commit `feat(adapters): ProviderAdapter interface, error mapping, registry`.

---

## Task 3: OpenAI adapter (full template) (`@actionow/adapters`)

**Files:** Create `packages/adapters/src/openai.ts`; test `packages/adapters/test/openai.test.ts`.

Mapping: `POST {endpoint||'https://api.openai.com/v1'}/chat/completions`, header `Authorization: Bearer {apiKey}`, body `{ model, messages, max_tokens? }`. Inputs accept `messages` (array of `{role,content}`) OR `prompt`/`input` (string → `[{role:'user',content}]`). Response: `choices[0].message.content` → `output.text`; `usage.prompt_tokens`/`completion_tokens` → `{ input_tokens, output_tokens }`. Non-2xx → `throw new AdapterError(mapError(body)/httpStatusToUnified)`.

- [ ] **Step 1:** Failing test `openai.test.ts` using a fake `HttpClient`:

```ts
import { describe, expect, it } from 'vitest';
import type { HttpClient, HttpRequest, SubmitInput } from '@actionow/contracts';

import { openaiAdapter } from '../src/openai.js';

const fakeHttp = (resp: { status: number; body: unknown }): HttpClient => ({
  request: (_req: HttpRequest) =>
    Promise.resolve({
      status: resp.status,
      ok: resp.status < 400,
      body: resp.body,
      text: JSON.stringify(resp.body),
    }),
});
const baseInput = (http: HttpClient, inputs: Record<string, unknown>): SubmitInput => ({
  resourceId: 'model:openai/gpt-4o-mini',
  modality: 'text',
  inputs,
  execMode: 'blocking',
  ctx: { providerType: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-x', http },
});

describe('openai adapter', () => {
  it('submits a prompt and returns text + usage', async () => {
    const http = fakeHttp({
      status: 200,
      body: {
        choices: [{ message: { content: 'hello' } }],
        usage: { prompt_tokens: 12, completion_tokens: 5 },
      },
    });
    const r = await openaiAdapter.submit(baseInput(http, { prompt: 'hi' }));
    expect(r.kind).toBe('sync');
    if (r.kind === 'sync') {
      expect(r.output.text).toBe('hello');
      expect(r.usage).toEqual({ input_tokens: 12, output_tokens: 5 });
    }
  });
  it('maps a 429 to rate_limited (retryable)', async () => {
    const http = fakeHttp({ status: 429, body: { error: { message: 'slow down' } } });
    await expect(openaiAdapter.submit(baseInput(http, { prompt: 'hi' }))).rejects.toMatchObject({
      unified: { code: 'rate_limited', retryable: true },
    });
  });
});
```

- [ ] **Step 2:** Run red. **Step 3:** Implement `openai.ts` (full, no placeholders): build messages, call `ctx.http.request`, on non-2xx throw `AdapterError`, else map output+usage. Implement `extractUsage` and `mapError`. **Step 4:** Run green; add cases (messages passthrough, missing content guard, 401→unauthorized, 500→upstream_error retryable). **Step 5:** Commit `feat(adapters): openai adapter`.

---

## Task 4: Anthropic + Gemini adapters

**Files:** Create `packages/adapters/src/anthropic.ts`, `gemini.ts`; tests for each.

- **anthropic.ts:** `POST {endpoint||'https://api.anthropic.com'}/v1/messages`, headers `x-api-key: {apiKey}`, `anthropic-version: 2023-06-01`. Body `{ model, max_tokens: inputs.max_tokens ?? 1024, messages, system? }`. Response `content[0].text` → `output.text`; `usage.input_tokens`/`output_tokens` → usage. (Anthropic already names them input/output_tokens.)
- **gemini.ts (independent mapping — NOT an openai alias):** `POST {endpoint||'https://generativelanguage.googleapis.com'}/v1beta/models/{model}:generateContent?key={apiKey}`. Body `{ contents: [{ role: 'user', parts: [{ text }] }] }` (from `prompt`/`input`, or map `messages` → contents). Response `candidates[0].content.parts[0].text` → `output.text`; `usageMetadata.promptTokenCount`/`candidatesTokenCount` → `{ input_tokens, output_tokens }`.

- [ ] For each: TDD with fake `HttpClient` (happy path text+usage; one error-status mapping). Implement `submit`/`extractUsage`/`mapError`. Commit `feat(adapters): anthropic adapter` and `feat(adapters): gemini adapter` (separate commits).

---

## Task 5: async-media-mock adapter (exercises the async state machine)

**Files:** Create `packages/adapters/src/async-media-mock.ts`; test.

Behavior: `submit` returns an `UpstreamJobHandle` (`upstreamJobId = crypto.randomUUID()`), recording the handle in an in-process `Map` with a poll counter and the requested modality. `poll(upstreamJobId)`: increments the counter; while `count < readyAfterPolls` (default 1) → `{ status: 'running' }`; once reached → `{ status: 'succeeded', output: { <video_url|image_url>: 'https://mock.local/{id}' }, usage: { duration_seconds | images: 1 } }`. Unknown id → `{ status: 'failed', error: upstream_error }`. Expose a factory `createAsyncMediaMock(opts?: { readyAfterPolls?: number })` so tests can set `0` (immediate) or `2`. `parseCallback(payload)` parses `{ upstreamJobId, status }`-shaped objects.

- [ ] TDD: submit → handle; poll returns running then succeeded (with readyAfterPolls=1); readyAfterPolls=0 → immediate succeeded; unknown id → failed; image modality → `image_url`+`images:1`, video → `video_url`+`duration_seconds`. Commit `feat(adapters): async-media-mock adapter with poll state machine`.

---

## Task 6: Dify workflow (BYO) adapter

**Files:** Create `packages/adapters/src/dify-workflow.ts`; test.

Runtime (§7): `POST {ctx.endpoint}/v1/workflows/run`, header `Authorization: Bearer {ctx.apiKey}`, body `{ inputs, response_mode: 'blocking', user: 'actionow' }`. Response shape `{ data: { status, outputs, total_tokens?, error? } }`. On `data.status === 'succeeded'` → `SyncResult` with `output = data.outputs ?? {}`, `usage = { total_tokens: data.total_tokens ?? 0 }`. On `data.status === 'failed'` → throw `AdapterError(job_failed)`. Non-2xx → `httpStatusToUnified`. (DSL parsing/registration is Phase 4 — this adapter only _runs_ an already-bound BYO app.)

- [ ] TDD with fake `HttpClient`: blocking success → outputs+usage; `data.status:'failed'` → AdapterError(job_failed); 401 → unauthorized. Commit `feat(adapters): dify-workflow BYO runtime adapter`.

---

## Task 7: Weighted routing + failover (`@actionow/adapters`)

**Files:** Create `packages/adapters/src/routing.ts`; test.

```ts
export interface WeightedChannel<T> {
  id: string;
  weight: number;
  value: T;
}
// Deterministic given rng() in [0,1): pick by cumulative weight.
export function selectWeighted<T>(
  channels: WeightedChannel<T>[],
  rng: () => number,
): WeightedChannel<T>;
// Order = weighted pick first, then the rest by descending weight. Try each; if attempt throws and isRetryable(err) → next; non-retryable → rethrow now; all exhausted → throw last error.
export function routeWithFailover<T, R>(
  channels: WeightedChannel<T>[],
  rng: () => number,
  attempt: (value: T, channel: WeightedChannel<T>) => Promise<R>,
  isRetryable: (err: unknown) => boolean,
): Promise<R>;
```

- [ ] TDD (full code in impl; no placeholders):
  - `selectWeighted` deterministic: weights `[1,3]`, `rng=()=>0.0` → first; `rng=()=>0.99` → second; empty → throw.
  - `routeWithFailover`: first channel throws retryable, second succeeds → returns second's result, attempted both. First throws non-retryable → rethrows immediately, second NOT attempted. All retryable-fail → throws last error.
  - `isRetryable` helper reads `AdapterError.unified.retryable` (default false for unknown errors).
- Commit `feat(adapters): weighted-random routing with failover`.

> Note: the pre-submit vs post-submit idempotency guard (review #3 — don't blind-retry non-idempotent submits) is applied at the **execution layer (Phase 3)**, which decides whether to pass a "retryable" verdict into `routeWithFailover`. Routing here only honors the verdict.

---

## Task 8: Default registry wiring + verification gate

**Files:** Create `packages/adapters/src/default-registry.ts`; modify barrel.

- [ ] `createDefaultRegistry(opts?): AdapterRegistry` registering `openaiAdapter`, `anthropicAdapter`, `geminiAdapter`, `createAsyncMediaMock(...)`, `difyWorkflowAdapter`. Test that all 5 `provider_type`s resolve.
- [ ] Barrel `packages/adapters/src/index.ts` exports interface, registry, routing, all adapters, `createDefaultRegistry`.
- [ ] Gate: `pnpm --filter @actionow/adapters test` green; `pnpm typecheck && pnpm lint && pnpm build` green; `pnpm exec eslint packages/adapters` clean; confirm adapters import only contracts/domain/infra (boundaries). Commit `feat(adapters): default registry + phase-2 gate`.

---

## Phase 2 Definition of Done

- `@actionow/adapters` exports `ProviderAdapter`, `AdapterRegistry`/`createDefaultRegistry`, `selectWeighted`/`routeWithFailover`, and 5 adapters, each unit-tested with a fake `HttpClient` (no network).
- The 5 `provider_type`s resolve from the default registry; async-media-mock drives a `running→succeeded` poll sequence; dify-workflow runs a blocking BYO call.
- `pnpm typecheck && pnpm lint && pnpm build && pnpm test` green; adapters import only contracts/domain/infra.

> **Next:** Phase 3 — Execution (the `/run` pipeline, jobs, ledger hold/settle IO, routing wiring, webhooks/outbox, reaper).
