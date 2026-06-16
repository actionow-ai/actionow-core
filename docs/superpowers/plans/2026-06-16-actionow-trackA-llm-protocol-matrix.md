# Track A — LLM Protocol Translation Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes. TDD.
> **Goal:** Add an OpenAI/Anthropic/Gemini-compatible relay surface (`/v1/chat/completions`, `/v1/messages`, `/v1beta/models/{model}:generateContent[:streamGenerateContent]`) that translates each wire dialect through one neutral IR, drives the existing engine `runStream`/`run` (hold→stream→settle-once), and renders the IR back to each dialect (including streaming SSE framing).
> **Architecture:** Hub-and-spoke: a pure `@actionow/llm-protocol` package with 3 inbound parsers (wire→`ChatRequest`) + 3 outbound renderers (`ChatResponse`/`ChatStreamEvent`→wire, with per-dialect SSE), plus a normalization layer. The `ProviderAdapter` contract gains IR-level `chat`/`streamChat`; openai/anthropic/gemini adapters implement them over the existing `HttpClient` port (old `submit`/`stream` stay for non-chat modalities). The API funnels each dialect endpoint into the engine: resolve the `model` name → a chat resource (Track C `resolveModelForTenant`) → build a `RunRequest` carrying the IR in `inputs.__ir` → `runStream`/`run` → render IR events back to the caller's dialect.

## **Tech Stack:** TypeScript (NodeNext ESM), zod, NestJS 11, vitest + Testcontainers (postgres:16-alpine), official SDKs (`openai`, `@anthropic-ai/sdk`, `@google/genai`) as **type sources only** (no runtime use).

## Conventions

- **Repo root:** `/Users/alienworm/actionow-core` (pnpm monorepo; turbo). All commands run from the repo root unless a `pnpm --filter` scopes them.
- **Branch:** create and work on `feat/trackA` (`git checkout -b feat/trackA`). Do NOT push.
- **TDD, always:** write the failing test first, run it and SEE it fail, write the minimal code, run it and SEE it pass, then commit. One task = one commit.
- **Commits:** lowercase conventional subjects, e.g. `feat(contracts): add chat IR types`. **Commit body lines must be < 100 chars** (commitlint `body-max-line-length=100`). End every commit body with:

  ```

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

- **Lint is strict:** `tseslint.configs.strictTypeChecked` + `no-explicit-any: error`. Never use `any`; narrow `unknown` with the existing `asRecord`/`asArray`/`asString`/`asNumber`/`parseJsonRecord` helpers in `packages/adapters/src/internal/json.ts` (re-create equivalents inside `llm-protocol` since boundaries forbid it from importing adapters). `@typescript-eslint/consistent-type-imports` and `simple-import-sort` are enforced — use `import type` for types and let sorting be alphabetical.
- **Money is bigint µcredits.** Never coerce through a float. Track A does NOT touch pricing math; it relies on the engine's existing settle path. The `'model_token'` pricing method + `model`/`usage_log` tables are **Track C's**; this plan consumes Track C's pinned `resolveModelForTenant` signature only.
- **`exactOptionalPropertyTypes` is on.** Build optional object properties conditionally (`if (x !== undefined) obj.x = x;`) rather than assigning `undefined`. Mirror the existing adapter pattern.
- **boundaries:** `@actionow/llm-protocol` may import ONLY `@actionow/contracts`; `apps/api` may import it. Wire both the `boundaries/element-types` block AND the per-package `no-restricted-imports` block in `eslint.config.mjs` (Task A2 does this).
- **SDKs as types only.** `import type { ... } from 'openai/resources/...'` etc. is allowed for field-shape fidelity, but no SDK runtime symbol may appear in emitted JS. Prefer hand-written zod schemas + the `as*` narrowing helpers for runtime parsing; reach for an SDK type only when it sharpens a field's static type.

---

## Cross-track dependency note

Track A's model routing consumes **Track C**'s repo (pinned signature, do NOT rename):

```ts
resolveModelForTenant(
  db: DbOrTx,
  modelName: string,
  tenantId: string,
): Promise<{ modelId: string; resourceId: string; inputPrice: bigint; outputPrice: bigint;
            capabilities: Record<string, unknown> } | undefined>
```

When Track C is not yet built, Task A8 ships a **local interface + injectable port** matching this exact signature so Track A's controller compiles and tests use a fake; the production binding is swapped to `@actionow/db`'s `resolveModelForTenant` once Track C lands (a one-line change, noted inline). No renaming.

---

## Task A1 — IR types in `@actionow/contracts`

The neutral intermediate representation every dialect maps to/from. Full tier: text + tools + multimodal.

**Files:**

- Create `packages/contracts/src/chat.ts`
- Modify `packages/contracts/src/index.ts` (add `export * from './chat.js';`)
- Create `packages/contracts/test/chat.test.ts`

Steps:

- [ ] Write the failing test `packages/contracts/test/chat.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';

  import {
    type ChatRequest,
    type ChatResponse,
    type ChatStreamEvent,
    chatRequestSchema,
    type ContentPart,
    type Message,
    type ToolCall,
    type ToolDef,
  } from '../src/chat.js';

  describe('chat IR schemas', () => {
    it('parses a minimal text request', () => {
      const req: ChatRequest = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
      };
      expect(chatRequestSchema.parse(req)).toMatchObject({ model: 'gpt-4o' });
    });

    it('accepts tools, tool calls, and an image content part', () => {
      const tool: ToolDef = {
        name: 'get_weather',
        description: 'weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      };
      const call: ToolCall = { id: 'call_1', name: 'get_weather', arguments: { city: 'SF' } };
      const image: ContentPart = {
        kind: 'image',
        source: 'base64',
        data: 'aGVsbG8=',
        mime: 'image/png',
      };
      const messages: Message[] = [
        { role: 'system', content: [{ kind: 'text', text: 'be brief' }] },
        { role: 'user', content: [{ kind: 'text', text: 'weather?' }, image] },
        { role: 'assistant', content: [], toolCalls: [call] },
        { role: 'tool', content: [{ kind: 'text', text: '72F' }], toolCallId: 'call_1' },
      ];
      const req: ChatRequest = {
        model: 'gpt-4o',
        messages,
        tools: [tool],
        toolChoice: 'auto',
        params: { temperature: 0.2, maxOutputTokens: 256, responseFormat: 'json_object' },
      };
      expect(chatRequestSchema.parse(req).tools).toHaveLength(1);
    });

    it('rejects an unknown role', () => {
      const bad = { model: 'x', messages: [{ role: 'robot', content: [] }] };
      expect(chatRequestSchema.safeParse(bad).success).toBe(false);
    });

    it('types a response + stream events', () => {
      const res: ChatResponse = {
        message: { role: 'assistant', content: [{ kind: 'text', text: 'ok' }] },
        stopReason: 'stop',
        usage: { inputTokens: 3, outputTokens: 1 },
      };
      const events: ChatStreamEvent[] = [
        { type: 'message_start' },
        { type: 'content_delta', text: 'o' },
        { type: 'tool_call_delta', index: 0, id: 'c1', name: 'f', argumentsDelta: '{' },
        { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } },
        { type: 'stop', stopReason: 'stop' },
        { type: 'done' },
        { type: 'error', error: { code: 'upstream_error', message: 'x', retryable: false } },
      ];
      expect(res.stopReason).toBe('stop');
      expect(events).toHaveLength(7);
    });
  });
  ```

- [ ] Run it, expect FAIL (module missing): `pnpm --filter @actionow/contracts exec vitest run test/chat.test.ts` → fails to resolve `../src/chat.js`.
- [ ] Create `packages/contracts/src/chat.ts` with zod schemas + inferred types. Mirror the §A.1 shape; use string-literal unions for roles/kinds:

  ```ts
  import { z } from 'zod';

  import type { UnifiedError } from './adapter.js';

  export const CHAT_ROLES = ['system', 'user', 'assistant', 'tool'] as const;
  export type ChatRole = (typeof CHAT_ROLES)[number];

  /** A JSON Schema object (tool parameters / structured-output schema). */
  export type JsonSchema = Record<string, unknown>;
  const jsonSchema: z.ZodType<JsonSchema> = z.record(z.string(), z.unknown());

  export const textPartSchema = z.object({ kind: z.literal('text'), text: z.string() });
  export const imagePartSchema = z.object({
    kind: z.literal('image'),
    source: z.enum(['url', 'base64', 'file_id']),
    /** The URL, base64 payload, or provider file id, per `source`. */
    data: z.string(),
    mime: z.string().optional(),
  });
  export const audioPartSchema = z.object({
    kind: z.literal('audio'),
    source: z.enum(['url', 'base64', 'file_id']),
    data: z.string(),
    mime: z.string().optional(),
  });
  export const filePartSchema = z.object({
    kind: z.literal('file'),
    source: z.enum(['url', 'base64', 'file_id']),
    data: z.string(),
    mime: z.string().optional(),
  });
  export const contentPartSchema = z.discriminatedUnion('kind', [
    textPartSchema,
    imagePartSchema,
    audioPartSchema,
    filePartSchema,
  ]);
  export type ContentPart = z.infer<typeof contentPartSchema>;

  export const toolCallSchema = z.object({
    id: z.string(),
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  });
  export type ToolCall = z.infer<typeof toolCallSchema>;

  export const toolDefSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: jsonSchema,
  });
  export type ToolDef = z.infer<typeof toolDefSchema>;

  export const messageSchema = z.object({
    role: z.enum(CHAT_ROLES),
    content: z.array(contentPartSchema),
    toolCalls: z.array(toolCallSchema).optional(),
    toolCallId: z.string().optional(),
    name: z.string().optional(),
  });
  export type Message = z.infer<typeof messageSchema>;

  export const RESPONSE_FORMATS = ['text', 'json_object', 'json_schema'] as const;
  export const chatParamsSchema = z.object({
    temperature: z.number().optional(),
    topP: z.number().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    stop: z.array(z.string()).optional(),
    seed: z.number().int().optional(),
    responseFormat: z.enum(RESPONSE_FORMATS).optional(),
    jsonSchema: jsonSchema.optional(),
  });
  export type ChatParams = z.infer<typeof chatParamsSchema>;

  export const TOOL_CHOICES = ['auto', 'none', 'required'] as const;
  export const chatRequestSchema = z.object({
    model: z.string(),
    messages: z.array(messageSchema),
    tools: z.array(toolDefSchema).optional(),
    toolChoice: z.union([z.enum(TOOL_CHOICES), z.object({ name: z.string() })]).optional(),
    params: chatParamsSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });
  export type ChatRequest = z.infer<typeof chatRequestSchema>;

  export const STOP_REASONS = ['stop', 'length', 'tool_calls', 'content_filter', 'error'] as const;
  export type StopReason = (typeof STOP_REASONS)[number];

  /** Token usage in the IR's canonical camelCase shape. */
  export interface ChatUsage {
    inputTokens: number;
    outputTokens: number;
  }

  export interface ChatResponse {
    message: Message;
    stopReason: StopReason;
    usage: ChatUsage;
  }

  /**
   * IR-level streaming event. `tool_call_delta` carries an incremental tool-call
   * (index + optional id/name on the first chunk, then `argumentsDelta` slices).
   */
  export type ChatStreamEvent =
    | { type: 'message_start' }
    | { type: 'content_delta'; text: string }
    | {
        type: 'tool_call_delta';
        index: number;
        id?: string;
        name?: string;
        argumentsDelta?: string;
      }
    | { type: 'usage'; usage: ChatUsage }
    | { type: 'stop'; stopReason: StopReason }
    | { type: 'done' }
    | { type: 'error'; error: UnifiedError };
  ```

- [ ] Add `export * from './chat.js';` to `packages/contracts/src/index.ts` (keep the list alphabetically sorted — insert after `./adapter.js`).
- [ ] Run it, expect PASS: `pnpm --filter @actionow/contracts exec vitest run test/chat.test.ts`.
- [ ] Typecheck + lint the package: `pnpm --filter @actionow/contracts typecheck && pnpm --filter @actionow/contracts lint`.
- [ ] Commit: `git commit -am "feat(contracts): add chat IR types and schemas"`.

---

## Task A2 — Scaffold `@actionow/llm-protocol` package + eslint boundaries

A pure package depending only on `@actionow/contracts`, with its own JSON-narrowing helpers (it may NOT import `@actionow/adapters`).

**Files:**

- Create `packages/llm-protocol/package.json`
- Create `packages/llm-protocol/tsconfig.json`
- Create `packages/llm-protocol/tsconfig.build.json`
- Create `packages/llm-protocol/vitest.config.ts`
- Create `packages/llm-protocol/src/index.ts`
- Create `packages/llm-protocol/src/internal/json.ts`
- Create `packages/llm-protocol/test/json.test.ts`
- Modify `eslint.config.mjs` (add `llm-protocol` to `boundaries/element-types` and a `no-restricted-imports` block)

Steps:

- [ ] Create `packages/llm-protocol/package.json` (mirror `packages/contracts/package.json`; contracts-only dep):
  ```json
  {
    "name": "@actionow/llm-protocol",
    "version": "0.0.0",
    "private": true,
    "type": "module",
    "main": "src/index.ts",
    "exports": { ".": "./src/index.ts" },
    "scripts": {
      "build": "tsc -p tsconfig.build.json",
      "typecheck": "tsc -p tsconfig.json --noEmit",
      "lint": "eslint src",
      "test": "vitest run --passWithNoTests"
    },
    "dependencies": {
      "@actionow/contracts": "workspace:*",
      "zod": "^3.23.0"
    },
    "devDependencies": {
      "@anthropic-ai/sdk": "^0.32.1",
      "@google/genai": "^0.3.0",
      "openai": "^4.73.0",
      "typescript": "^5.6.0",
      "vitest": "^2.1.0"
    }
  }
  ```
- [ ] Create `packages/llm-protocol/tsconfig.json`:
  ```json
  {
    "extends": "../../tsconfig.base.json",
    "compilerOptions": { "outDir": "dist", "rootDir": "." },
    "include": ["src", "test", "vitest.config.ts"]
  }
  ```
- [ ] Create `packages/llm-protocol/tsconfig.build.json`:
  ```json
  {
    "extends": "../../tsconfig.base.json",
    "compilerOptions": { "outDir": "dist", "rootDir": "src" },
    "include": ["src"]
  }
  ```
- [ ] Create `packages/llm-protocol/vitest.config.ts` (no Testcontainers here — pure unit):

  ```ts
  import { defineConfig } from 'vitest/config';

  export default defineConfig({
    test: { include: ['test/**/*.test.ts'] },
  });
  ```

- [ ] Write the failing test `packages/llm-protocol/test/json.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';

  import { asArray, asNumber, asRecord, asString, parseJsonRecord } from '../src/internal/json.js';

  describe('json narrowing helpers', () => {
    it('narrows records, arrays, strings, numbers', () => {
      expect(asRecord({ a: 1 })).toEqual({ a: 1 });
      expect(asRecord([1])).toBeUndefined();
      expect(asArray([1])).toEqual([1]);
      expect(asString('x')).toBe('x');
      expect(asNumber(3)).toBe(3);
      expect(asNumber(Number.NaN)).toBeUndefined();
    });
    it('parses JSON records, tolerating garbage', () => {
      expect(parseJsonRecord('{"a":1}')).toEqual({ a: 1 });
      expect(parseJsonRecord('not json')).toBeUndefined();
      expect(parseJsonRecord('[1]')).toBeUndefined();
    });
  });
  ```

- [ ] Run it, expect FAIL (module missing): `pnpm --filter @actionow/llm-protocol exec vitest run test/json.test.ts`.
- [ ] Create `packages/llm-protocol/src/internal/json.ts` (copy the proven helpers from `packages/adapters/src/internal/json.ts` verbatim — re-created here because boundaries forbid importing adapters): the `asRecord`, `asArray`, `asString`, `asNumber`, `recordAt`, `parseJsonRecord` functions exactly as in that file.
- [ ] Create `packages/llm-protocol/src/index.ts` with `export * from './internal/json.js';` (later tasks append more exports).
- [ ] Run it, expect PASS.
- [ ] Edit `eslint.config.mjs` `boundaries/element-types` rules: add a block after the `contracts` block:
  ```js
  // llm-protocol: pure — contracts only.
  {
    from: [['pkg', { package: 'llm-protocol' }]],
    allow: [
      ['pkg', { package: 'llm-protocol' }],
      ['pkg', { package: 'contracts' }],
    ],
  },
  ```
- [ ] Edit `eslint.config.mjs` add a `no-restricted-imports` flat block (after the `contracts` block, same shape) forbidding every non-contracts `@actionow/*` package:
  ```js
  {
    files: ['packages/llm-protocol/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            '@actionow/domain', '@actionow/domain/*',
            '@actionow/db', '@actionow/db/*',
            '@actionow/adapters', '@actionow/adapters/*',
            '@actionow/dify', '@actionow/dify/*',
            '@actionow/infra', '@actionow/infra/*',
            '@actionow/engine', '@actionow/engine/*',
            '@actionow/payments', '@actionow/payments/*',
          ],
        },
      ],
    },
  },
  ```
  (Keep each pattern array entry on its own line per the existing file style; the inline form above is for brevity.)
- [ ] Install the new workspace package + SDK devDeps: `pnpm install`.
- [ ] Lint the whole repo to confirm boundaries accept the new package: `pnpm --filter @actionow/llm-protocol lint && pnpm lint`.
- [ ] Commit: `git commit -am "feat(llm-protocol): scaffold pure package + eslint boundaries"`.

---

## Task A3 — Normalization layer (capability gating)

A pure function that downgrades or 400s an IR against a model's declared capabilities, returning a typed `ProtocolError` the API maps to the right dialect error body.

**Files:**

- Create `packages/llm-protocol/src/errors.ts`
- Create `packages/llm-protocol/src/capabilities.ts`
- Create `packages/llm-protocol/src/normalize.ts`
- Modify `packages/llm-protocol/src/index.ts`
- Create `packages/llm-protocol/test/normalize.test.ts`

Steps:

- [ ] Write the failing test `packages/llm-protocol/test/normalize.test.ts`:

  ```ts
  import type { ChatRequest } from '@actionow/contracts';
  import { describe, expect, it } from 'vitest';

  import { ProtocolError } from '../src/errors.js';
  import { normalizeRequest } from '../src/normalize.js';

  const base: ChatRequest = {
    model: 'm',
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
  };

  describe('normalizeRequest', () => {
    it('passes a text request through when the model supports text', () => {
      const out = normalizeRequest(base, {
        tools: false,
        vision: false,
        audio: false,
        json: false,
      });
      expect(out.messages).toHaveLength(1);
    });

    it('400s when tools are sent to a model without tool capability', () => {
      const withTools: ChatRequest = {
        ...base,
        tools: [{ name: 'f', parameters: { type: 'object' } }],
      };
      expect(() =>
        normalizeRequest(withTools, { tools: false, vision: false, audio: false, json: false }),
      ).toThrow(ProtocolError);
    });

    it('400s when an image part is sent to a non-vision model', () => {
      const withImg: ChatRequest = {
        ...base,
        messages: [
          { role: 'user', content: [{ kind: 'image', source: 'url', data: 'http://x/y.png' }] },
        ],
      };
      expect(() =>
        normalizeRequest(withImg, { tools: false, vision: false, audio: false, json: false }),
      ).toThrow(ProtocolError);
    });

    it('400s on json_object responseFormat for a non-json model', () => {
      const withJson: ChatRequest = { ...base, params: { responseFormat: 'json_object' } };
      expect(() =>
        normalizeRequest(withJson, { tools: false, vision: false, audio: false, json: false }),
      ).toThrow(ProtocolError);
    });

    it('allows everything when the model declares full capability', () => {
      const full: ChatRequest = {
        ...base,
        tools: [{ name: 'f', parameters: { type: 'object' } }],
        params: { responseFormat: 'json_object' },
        messages: [
          { role: 'user', content: [{ kind: 'image', source: 'url', data: 'http://x/y.png' }] },
        ],
      };
      const out = normalizeRequest(full, { tools: true, vision: true, audio: true, json: true });
      expect(out.tools).toHaveLength(1);
    });
  });
  ```

- [ ] Run it, expect FAIL.
- [ ] Create `packages/llm-protocol/src/errors.ts` — a `ProtocolError` carrying `{ code, message }` where `code` is the contracts `UnifiedErrorCode` (the API maps it to the right HTTP status + dialect body):

  ```ts
  import type { UnifiedErrorCode } from '@actionow/contracts';

  /** A request-translation/normalization failure, surfaced to the API layer. */
  export class ProtocolError extends Error {
    readonly code: UnifiedErrorCode;
    constructor(code: UnifiedErrorCode, message: string) {
      super(message);
      this.name = 'ProtocolError';
      this.code = code;
    }
  }
  ```

- [ ] Create `packages/llm-protocol/src/capabilities.ts`:

  ```ts
  /** What a resolved model can do; drives the normalization gate. */
  export interface ModelCapabilities {
    tools: boolean;
    vision: boolean;
    audio: boolean;
    json: boolean;
  }

  /** Read a capabilities bag from a model's `capabilities` jsonb (booleans only). */
  export function readCapabilities(raw: Record<string, unknown>): ModelCapabilities {
    const flag = (k: string): boolean => raw[k] === true;
    return {
      tools: flag('tools'),
      vision: flag('vision'),
      audio: flag('audio'),
      json: flag('json'),
    };
  }
  ```

- [ ] Create `packages/llm-protocol/src/normalize.ts`:

  ```ts
  import type { ChatRequest } from '@actionow/contracts';

  import type { ModelCapabilities } from './capabilities.js';
  import { ProtocolError } from './errors.js';

  /**
   * Gate an IR `ChatRequest` against a model's capabilities. Unsupported feature
   * → `ProtocolError('invalid_input', ...)` (the API renders a 400 per dialect).
   * Returns the request unchanged on success (a place to add downgrades later).
   */
  export function normalizeRequest(req: ChatRequest, caps: ModelCapabilities): ChatRequest {
    if (req.tools !== undefined && req.tools.length > 0 && !caps.tools) {
      throw new ProtocolError('invalid_input', 'model does not support tools');
    }
    const wantsJson =
      req.params?.responseFormat === 'json_object' || req.params?.responseFormat === 'json_schema';
    if (wantsJson && !caps.json) {
      throw new ProtocolError('invalid_input', 'model does not support structured output');
    }
    for (const m of req.messages) {
      for (const part of m.content) {
        if (part.kind === 'image' && !caps.vision) {
          throw new ProtocolError('invalid_input', 'model does not support image input');
        }
        if (part.kind === 'audio' && !caps.audio) {
          throw new ProtocolError('invalid_input', 'model does not support audio input');
        }
      }
    }
    return req;
  }
  ```

- [ ] Add exports to `packages/llm-protocol/src/index.ts`: `export * from './capabilities.js';`, `export * from './errors.js';`, `export * from './normalize.js';` (keep sorted).
- [ ] Run it, expect PASS.
- [ ] Typecheck + lint: `pnpm --filter @actionow/llm-protocol typecheck && pnpm --filter @actionow/llm-protocol lint`.
- [ ] Commit: `git commit -am "feat(llm-protocol): capability normalization gate"`.

---

## Task A4 — OpenAI inbound parser + outbound renderer (non-streaming)

`parseOpenAIChat(wire) → ChatRequest` and `renderOpenAIChat(ChatResponse) → wire`.

**Files:**

- Create `packages/llm-protocol/src/openai/parse.ts`
- Create `packages/llm-protocol/src/openai/render.ts`
- Create `packages/llm-protocol/src/openai/index.ts`
- Modify `packages/llm-protocol/src/index.ts`
- Create `packages/llm-protocol/test/openai.test.ts`

Steps:

- [ ] Write the failing test `packages/llm-protocol/test/openai.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';

  import { parseOpenAIChat, renderOpenAIChat } from '../src/openai/index.js';

  describe('parseOpenAIChat', () => {
    it('maps system/user roles, string content, and params', () => {
      const ir = parseOpenAIChat({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hi' },
        ],
        temperature: 0.5,
        max_tokens: 100,
        response_format: { type: 'json_object' },
      });
      expect(ir.model).toBe('gpt-4o');
      expect(ir.messages[0]).toEqual({
        role: 'system',
        content: [{ kind: 'text', text: 'be brief' }],
      });
      expect(ir.params?.temperature).toBe(0.5);
      expect(ir.params?.maxOutputTokens).toBe(100);
      expect(ir.params?.responseFormat).toBe('json_object');
    });

    it('maps tools[].function and assistant tool_calls', () => {
      const ir = parseOpenAIChat({
        model: 'gpt-4o',
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'c1', content: '42' },
        ],
        tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
      });
      expect(ir.tools?.[0]).toEqual({
        name: 'f',
        description: undefined,
        parameters: { type: 'object' },
      });
      expect(ir.messages[0]?.toolCalls?.[0]).toEqual({ id: 'c1', name: 'f', arguments: { a: 1 } });
      expect(ir.messages[1]).toMatchObject({ role: 'tool', toolCallId: 'c1' });
    });

    it('maps an image_url content part', () => {
      const ir = parseOpenAIChat({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this' },
              { type: 'image_url', image_url: { url: 'http://x/y.png' } },
            ],
          },
        ],
      });
      expect(ir.messages[0]?.content).toEqual([
        { kind: 'text', text: 'what is this' },
        { kind: 'image', source: 'url', data: 'http://x/y.png' },
      ]);
    });
  });

  describe('renderOpenAIChat', () => {
    it('renders a chat.completion with content + usage', () => {
      const wire = renderOpenAIChat(
        {
          message: { role: 'assistant', content: [{ kind: 'text', text: 'hello' }] },
          stopReason: 'stop',
          usage: { inputTokens: 3, outputTokens: 2 },
        },
        'gpt-4o',
      );
      expect(wire).toMatchObject({
        object: 'chat.completion',
        model: 'gpt-4o',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
    });

    it('renders assistant tool_calls with finish_reason tool_calls', () => {
      const wire = renderOpenAIChat(
        {
          message: {
            role: 'assistant',
            content: [],
            toolCalls: [{ id: 'c1', name: 'f', arguments: { a: 1 } }],
          },
          stopReason: 'tool_calls',
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        'gpt-4o',
      );
      const choice = (
        wire as { choices: { message: { tool_calls: unknown }; finish_reason: string }[] }
      ).choices[0];
      expect(choice?.finish_reason).toBe('tool_calls');
      expect(choice?.message.tool_calls).toEqual([
        { id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
      ]);
    });
  });
  ```

- [ ] Run it, expect FAIL.
- [ ] Create `packages/llm-protocol/src/openai/parse.ts` implementing `parseOpenAIChat(wire: unknown): ChatRequest`. Use the `as*` helpers from `../internal/json.js`. Field mapping (from spec §A.3): `messages[].role` (`system|user|assistant|tool`) → IR role; string `content` → `[{kind:'text', text}]`; array `content` parts (`text`→text part, `image_url`→`{kind:'image', source:'url', data: image_url.url}`, supporting a `data:` base64 url by detecting the `data:` prefix and setting `source:'base64'` + extracting mime); `tool_calls[]` (`function.name`, `function.arguments` JSON-parsed via `parseJsonRecord`, falling back to `{}`) → `toolCalls`; `tool_call_id` → `toolCallId`; `name` → `name`; `tools[].function` (`name`/`description`/`parameters`) → `ToolDef`; `tool_choice` (`'auto'|'none'|'required'` or `{type:'function', function:{name}}` → `{name}`); params (`temperature`/`top_p`→`topP`/`max_tokens`→`maxOutputTokens`/`stop`/`seed`/`response_format.type`→`responseFormat`). Throw `ProtocolError('invalid_input', ...)` when `messages` is absent/not an array or a role is unknown (validate by `chatRequestSchema.safeParse` of the assembled IR and throw on failure).
- [ ] Create `packages/llm-protocol/src/openai/render.ts` implementing `renderOpenAIChat(res: ChatResponse, model: string): Record<string, unknown>`. Build `{ id: 'chatcmpl-'+randomUUID, object:'chat.completion', created: <unix s>, model, choices:[{index:0, message:{role:'assistant', content:<joined text or null>, tool_calls?:[...] }, finish_reason: mapStop(res.stopReason)}], usage:{prompt_tokens, completion_tokens, total_tokens} }`. `content`: join all `text` parts; emit `null` when empty AND tool calls present. `tool_calls`: map IR `ToolCall` → `{id, type:'function', function:{name, arguments: JSON.stringify(arguments)}}`. `mapStop`: `stop→'stop'`, `length→'length'`, `tool_calls→'tool_calls'`, `content_filter→'content_filter'`, `error→'stop'`. Import `randomUUID` from `node:crypto`.
- [ ] Create `packages/llm-protocol/src/openai/index.ts`: `export * from './parse.js';` + `export * from './render.js';`.
- [ ] Add `export * from './openai/index.js';` to `packages/llm-protocol/src/index.ts`.
- [ ] Run it, expect PASS.
- [ ] Typecheck + lint the package.
- [ ] Commit: `git commit -am "feat(llm-protocol): openai inbound parser and outbound renderer"`.

---

## Task A5 — Anthropic inbound parser + outbound renderer (non-streaming)

`parseAnthropicMessages(wire) → ChatRequest` and `renderAnthropicMessages(ChatResponse) → wire`.

**Files:**

- Create `packages/llm-protocol/src/anthropic/parse.ts`
- Create `packages/llm-protocol/src/anthropic/render.ts`
- Create `packages/llm-protocol/src/anthropic/index.ts`
- Modify `packages/llm-protocol/src/index.ts`
- Create `packages/llm-protocol/test/anthropic.test.ts`

Steps:

- [ ] Write the failing test `packages/llm-protocol/test/anthropic.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';

  import { parseAnthropicMessages, renderAnthropicMessages } from '../src/anthropic/index.js';

  describe('parseAnthropicMessages', () => {
    it('hoists the top-level system param into a system message', () => {
      const ir = parseAnthropicMessages({
        model: 'claude-3-5-sonnet',
        max_tokens: 256,
        system: 'be brief',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(ir.messages[0]).toEqual({
        role: 'system',
        content: [{ kind: 'text', text: 'be brief' }],
      });
      expect(ir.messages[1]).toEqual({ role: 'user', content: [{ kind: 'text', text: 'hi' }] });
      expect(ir.params?.maxOutputTokens).toBe(256);
    });

    it('maps tool_use and tool_result content blocks', () => {
      const ir = parseAnthropicMessages({
        model: 'claude-3-5-sonnet',
        max_tokens: 256,
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu1', name: 'f', input: { a: 1 } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '42' }],
          },
        ],
        tools: [{ name: 'f', input_schema: { type: 'object' } }],
      });
      expect(ir.tools?.[0]).toEqual({
        name: 'f',
        description: undefined,
        parameters: { type: 'object' },
      });
      expect(ir.messages[0]?.toolCalls?.[0]).toEqual({ id: 'tu1', name: 'f', arguments: { a: 1 } });
      expect(ir.messages[1]).toMatchObject({ role: 'tool', toolCallId: 'tu1' });
    });

    it('maps an image source.base64 block', () => {
      const ir = parseAnthropicMessages({
        model: 'claude-3-5-sonnet',
        max_tokens: 16,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'aGk=' },
              },
            ],
          },
        ],
      });
      expect(ir.messages[0]?.content[0]).toEqual({
        kind: 'image',
        source: 'base64',
        data: 'aGk=',
        mime: 'image/png',
      });
    });
  });

  describe('renderAnthropicMessages', () => {
    it('renders a message with text + tool_use blocks and usage', () => {
      const wire = renderAnthropicMessages(
        {
          message: {
            role: 'assistant',
            content: [{ kind: 'text', text: 'sure' }],
            toolCalls: [{ id: 'tu1', name: 'f', arguments: { a: 1 } }],
          },
          stopReason: 'tool_calls',
          usage: { inputTokens: 3, outputTokens: 2 },
        },
        'claude-3-5-sonnet',
      );
      expect(wire).toMatchObject({
        type: 'message',
        role: 'assistant',
        model: 'claude-3-5-sonnet',
        stop_reason: 'tool_use',
        usage: { input_tokens: 3, output_tokens: 2 },
      });
      const content = (wire as { content: { type: string }[] }).content;
      expect(content).toEqual([
        { type: 'text', text: 'sure' },
        { type: 'tool_use', id: 'tu1', name: 'f', input: { a: 1 } },
      ]);
    });
  });
  ```

- [ ] Run it, expect FAIL.
- [ ] Create `packages/llm-protocol/src/anthropic/parse.ts` implementing `parseAnthropicMessages(wire: unknown): ChatRequest`. Mapping (§A.3): top-level `system` (string OR an array of `{type:'text',text}` blocks — join text) → a leading `{role:'system', content:[{kind:'text', text}]}` message; `messages[]` where `content` is a string → one text part; where `content` is a block array map each block: `text`→text part, `image` (`source.type:'base64'`→`{kind:'image', source:'base64', data:source.data, mime:source.media_type}`; `source.type:'url'`→`{source:'url', data:source.url}`), `tool_use` (`id`/`name`/`input`)→ collected into the message's `toolCalls`, `tool_result` (`tool_use_id`, `content` string or block array)→ a `{role:'tool', toolCallId, content:[text part(s)]}` message. `tools[]` use `input_schema`→`parameters`. `tool_choice` (`{type:'auto'|'any'|'tool', name?}`)→ `'auto'`/`'required'`/`{name}`. `max_tokens`→`maxOutputTokens`; `temperature`/`top_p`/`stop_sequences`→`stop`. Validate via `chatRequestSchema.safeParse`, throw `ProtocolError` on failure.
- [ ] Create `packages/llm-protocol/src/anthropic/render.ts` implementing `renderAnthropicMessages(res: ChatResponse, model: string): Record<string, unknown>`. Build `{ id:'msg_'+randomUUID, type:'message', role:'assistant', model, content:[...text blocks then tool_use blocks], stop_reason: mapStop(res.stopReason), stop_sequence:null, usage:{input_tokens, output_tokens} }`. `mapStop`: `stop→'end_turn'`, `length→'max_tokens'`, `tool_calls→'tool_use'`, `content_filter→'end_turn'`, `error→'end_turn'`. `content` blocks: each IR text part → `{type:'text', text}`; each `ToolCall` → `{type:'tool_use', id, name, input: arguments}`.
- [ ] Create `packages/llm-protocol/src/anthropic/index.ts`: re-export parse + render.
- [ ] Add `export * from './anthropic/index.js';` to `src/index.ts`.
- [ ] Run it, expect PASS.
- [ ] Typecheck + lint.
- [ ] Commit: `git commit -am "feat(llm-protocol): anthropic inbound parser and outbound renderer"`.

---

## Task A6 — Gemini inbound parser + outbound renderer (non-streaming)

`parseGeminiGenerateContent(wire) → ChatRequest` and `renderGeminiGenerateContent(ChatResponse) → wire`.

**Files:**

- Create `packages/llm-protocol/src/gemini/parse.ts`
- Create `packages/llm-protocol/src/gemini/render.ts`
- Create `packages/llm-protocol/src/gemini/index.ts`
- Modify `packages/llm-protocol/src/index.ts`
- Create `packages/llm-protocol/test/gemini.test.ts`

Steps:

- [ ] Write the failing test `packages/llm-protocol/test/gemini.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';

  import { parseGeminiGenerateContent, renderGeminiGenerateContent } from '../src/gemini/index.js';

  describe('parseGeminiGenerateContent', () => {
    it('maps systemInstruction + contents roles (model→assistant)', () => {
      const ir = parseGeminiGenerateContent(
        {
          systemInstruction: { parts: [{ text: 'be brief' }] },
          contents: [
            { role: 'user', parts: [{ text: 'hi' }] },
            { role: 'model', parts: [{ text: 'hello' }] },
          ],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 64,
            responseMimeType: 'application/json',
          },
        },
        'gemini-1.5-pro',
      );
      expect(ir.model).toBe('gemini-1.5-pro');
      expect(ir.messages[0]).toEqual({
        role: 'system',
        content: [{ kind: 'text', text: 'be brief' }],
      });
      expect(ir.messages[2]).toEqual({
        role: 'assistant',
        content: [{ kind: 'text', text: 'hello' }],
      });
      expect(ir.params?.maxOutputTokens).toBe(64);
      expect(ir.params?.responseFormat).toBe('json_object');
    });

    it('maps functionCall / functionResponse / functionDeclarations', () => {
      const ir = parseGeminiGenerateContent(
        {
          contents: [
            { role: 'model', parts: [{ functionCall: { name: 'f', args: { a: 1 } } }] },
            { role: 'user', parts: [{ functionResponse: { name: 'f', response: { v: 42 } } }] },
          ],
          tools: [{ functionDeclarations: [{ name: 'f', parameters: { type: 'object' } }] }],
        },
        'gemini-1.5-pro',
      );
      expect(ir.tools?.[0]).toEqual({
        name: 'f',
        description: undefined,
        parameters: { type: 'object' },
      });
      expect(ir.messages[0]?.toolCalls?.[0]?.name).toBe('f');
      expect(ir.messages[1]).toMatchObject({ role: 'tool', name: 'f' });
    });

    it('maps inlineData (base64 image)', () => {
      const ir = parseGeminiGenerateContent(
        {
          contents: [
            { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'aGk=' } }] },
          ],
        },
        'gemini-1.5-pro',
      );
      expect(ir.messages[0]?.content[0]).toEqual({
        kind: 'image',
        source: 'base64',
        data: 'aGk=',
        mime: 'image/png',
      });
    });
  });

  describe('renderGeminiGenerateContent', () => {
    it('renders a candidate with text + functionCall and usageMetadata', () => {
      const wire = renderGeminiGenerateContent({
        message: {
          role: 'assistant',
          content: [{ kind: 'text', text: 'sure' }],
          toolCalls: [{ id: 'x', name: 'f', arguments: { a: 1 } }],
        },
        stopReason: 'tool_calls',
        usage: { inputTokens: 3, outputTokens: 2 },
      });
      expect(wire).toMatchObject({
        candidates: [{ content: { role: 'model' }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
      });
      const parts = (wire as { candidates: { content: { parts: unknown[] } }[] }).candidates[0]
        ?.content.parts;
      expect(parts).toEqual([{ text: 'sure' }, { functionCall: { name: 'f', args: { a: 1 } } }]);
    });
  });
  ```

- [ ] Run it, expect FAIL.
- [ ] Create `packages/llm-protocol/src/gemini/parse.ts` implementing `parseGeminiGenerateContent(wire: unknown, model: string): ChatRequest` (the model comes from the URL path, not the body). Mapping (§A.3): `systemInstruction.parts[].text` → leading system message; `contents[]` (`role:'user'|'model'`, `model`→`assistant`) where each `parts[]` element: `{text}`→text part, `{inlineData:{mimeType,data}}`→`{kind:'image', source:'base64', data, mime:mimeType}`, `{fileData:{fileUri,mimeType}}`→`{kind:'file', source:'url', data:fileUri, mime}`, `{functionCall:{name,args}}`→ collected to `toolCalls` (synthesize an `id` as `name` since Gemini has none — use the function name), `{functionResponse:{name,response}}`→ a `{role:'tool', name, content:[{kind:'text', text: JSON.stringify(response)}]}` message. `tools[].functionDeclarations[]` (`name`/`description`/`parameters`)→ `ToolDef[]`. `generationConfig`: `temperature`/`topP`/`maxOutputTokens`/`stopSequences`→`stop`/`responseMimeType==='application/json'`→`responseFormat:'json_object'`. `toolConfig.functionCallingConfig.mode` (`AUTO|ANY|NONE`)→`'auto'|'required'|'none'`. Validate via `chatRequestSchema.safeParse`, throw `ProtocolError` on failure.
- [ ] Create `packages/llm-protocol/src/gemini/render.ts` implementing `renderGeminiGenerateContent(res: ChatResponse): Record<string, unknown>`. Build `{ candidates:[{ content:{ role:'model', parts:[...text parts then {functionCall:{name,args:arguments}} parts] }, finishReason: mapStop(res.stopReason), index:0, safetyRatings:[] }], usageMetadata:{ promptTokenCount, candidatesTokenCount, totalTokenCount } }`. `mapStop`: `stop→'STOP'`, `length→'MAX_TOKENS'`, `tool_calls→'STOP'`, `content_filter→'SAFETY'`, `error→'OTHER'`.
- [ ] Create `packages/llm-protocol/src/gemini/index.ts`: re-export.
- [ ] Add `export * from './gemini/index.js';` to `src/index.ts`.
- [ ] Run it, expect PASS.
- [ ] Typecheck + lint.
- [ ] Commit: `git commit -am "feat(llm-protocol): gemini inbound parser and outbound renderer"`.

---

## Task A7 — Streaming SSE renderers (golden frames per dialect)

Three pure functions that consume an `AsyncIterable<ChatStreamEvent>` and yield each dialect's SSE byte frames as strings. The API writes these verbatim to the socket.

**Files:**

- Create `packages/llm-protocol/src/sse.ts` (shared `sseFrame` helper)
- Create `packages/llm-protocol/src/openai/stream.ts`
- Create `packages/llm-protocol/src/anthropic/stream.ts`
- Create `packages/llm-protocol/src/gemini/stream.ts`
- Modify `packages/llm-protocol/src/openai/index.ts`, `anthropic/index.ts`, `gemini/index.ts`
- Create `packages/llm-protocol/test/stream-sse.test.ts`

Steps:

- [ ] Write the failing test `packages/llm-protocol/test/stream-sse.test.ts`:

  ```ts
  import type { ChatStreamEvent } from '@actionow/contracts';
  import { describe, expect, it } from 'vitest';

  import { renderAnthropicMessagesStream } from '../src/anthropic/index.js';
  import { renderGeminiGenerateContentStream } from '../src/gemini/index.js';
  import { renderOpenAIChatStream } from '../src/openai/index.js';

  // eslint-disable-next-line @typescript-eslint/require-await
  async function* events(evs: ChatStreamEvent[]): AsyncIterable<ChatStreamEvent> {
    for (const e of evs) yield e;
  }
  async function collect(it: AsyncIterable<string>): Promise<string> {
    let out = '';
    for await (const s of it) out += s;
    return out;
  }

  const happyPath: ChatStreamEvent[] = [
    { type: 'message_start' },
    { type: 'content_delta', text: 'hel' },
    { type: 'content_delta', text: 'lo' },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
    { type: 'stop', stopReason: 'stop' },
    { type: 'done' },
  ];

  describe('renderOpenAIChatStream', () => {
    it('emits chat.completion.chunk frames + [DONE]', async () => {
      const out = await collect(renderOpenAIChatStream(events(happyPath), 'gpt-4o'));
      const frames = out.split('\n\n').filter((f) => f.startsWith('data: '));
      expect(frames.at(-1)).toBe('data: [DONE]');
      expect(out).toContain('"object":"chat.completion.chunk"');
      expect(out).toContain('"delta":{"content":"hel"}');
      expect(out).toContain('"finish_reason":"stop"');
    });
  });

  describe('renderAnthropicMessagesStream', () => {
    it('emits typed events: message_start..content_block_delta..message_stop', async () => {
      const out = await collect(
        renderAnthropicMessagesStream(events(happyPath), 'claude-3-5-sonnet'),
      );
      expect(out).toContain('event: message_start');
      expect(out).toContain('event: content_block_start');
      expect(out).toContain('event: content_block_delta');
      expect(out).toContain('"text_delta"');
      expect(out).toContain('event: message_delta');
      expect(out).toContain('event: message_stop');
    });
  });

  describe('renderGeminiGenerateContentStream', () => {
    it('emits one SSE data frame per candidate chunk', async () => {
      const out = await collect(renderGeminiGenerateContentStream(events(happyPath)));
      const frames = out.split('\n\n').filter((f) => f.startsWith('data: '));
      expect(frames.length).toBeGreaterThanOrEqual(2);
      expect(out).toContain('"text":"hel"');
      expect(out).toContain('"finishReason":"STOP"');
      expect(out).toContain('usageMetadata');
    });
  });
  ```

- [ ] Run it, expect FAIL.
- [ ] Create `packages/llm-protocol/src/sse.ts`:

  ```ts
  /** Build a default (no `event:`) SSE data frame for a JSON-serializable value. */
  export function sseData(payload: unknown): string {
    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  /** Build a typed SSE frame (`event:` + `data:`), as Anthropic streaming uses. */
  export function sseEvent(event: string, payload: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  }
  ```

- [ ] Create `packages/llm-protocol/src/openai/stream.ts` — `renderOpenAIChatStream(events, model): AsyncIterable<string>`. For each `content_delta`, yield `sseData({ id, object:'chat.completion.chunk', created, model, choices:[{index:0, delta:{content:text}, finish_reason:null}] })`. For each `tool_call_delta`, yield a chunk with `delta:{tool_calls:[{index, id?, type:'function', function:{name?, arguments: argumentsDelta ?? ''}}]}`. On `stop`, yield a final chunk with `delta:{}` + `finish_reason: mapStop(stopReason)`. On `done`, yield `'data: [DONE]\n\n'`. On `error`, yield a chunk with `finish_reason:'stop'` then `[DONE]` (OpenAI streams have no error frame; the engine's pre-stream hold guarantees errors before bytes — mid-stream upstream errors degrade to a clean stop). Use a single `id` + `created` generated once at the start.
- [ ] Create `packages/llm-protocol/src/anthropic/stream.ts` — `renderAnthropicMessagesStream(events, model): AsyncIterable<string>`. On `message_start`, yield `sseEvent('message_start', { type:'message_start', message:{ id, type:'message', role:'assistant', model, content:[], stop_reason:null, usage:{input_tokens:0, output_tokens:0} } })` then `sseEvent('content_block_start', { type:'content_block_start', index:0, content_block:{type:'text', text:''} })`. For each `content_delta`, yield `sseEvent('content_block_delta', { type:'content_block_delta', index:0, delta:{type:'text_delta', text} })`. On the first `tool_call_delta`, open a new content block (`content_block_start` with `{type:'tool_use', id, name, input:{}}` at an incremented index) then stream `input_json_delta` partials. On `usage`, remember output tokens. On `stop`, yield `sseEvent('content_block_stop', { type:'content_block_stop', index:0 })`, then `sseEvent('message_delta', { type:'message_delta', delta:{stop_reason: mapStop(stopReason), stop_sequence:null}, usage:{output_tokens} })`, then `sseEvent('message_stop', { type:'message_stop' })`. Track block indices in locals.
- [ ] Create `packages/llm-protocol/src/gemini/stream.ts` — `renderGeminiGenerateContentStream(events): AsyncIterable<string>` (alt=sse: each frame is a `GenerateContentResponse` chunk). For each `content_delta`, yield `sseData({ candidates:[{ content:{ role:'model', parts:[{text}] }, index:0 }] })`. For each `tool_call_delta`, yield a candidate chunk with `parts:[{functionCall:{name, args:{}}}]` (Gemini streams whole functionCalls; accumulate `argumentsDelta` and emit a single functionCall part when `name` is present — emit on the delta carrying the name). On the terminal `stop`/`usage`, yield a final candidate chunk with `finishReason: mapStop(stopReason)` + `usageMetadata:{promptTokenCount, candidatesTokenCount, totalTokenCount}`. No `[DONE]` sentinel (Gemini's SSE ends at stream close).
- [ ] Re-export each `*Stream` from its dialect `index.ts`.
- [ ] Run it, expect PASS.
- [ ] Typecheck + lint.
- [ ] Commit: `git commit -am "feat(llm-protocol): per-dialect streaming sse renderers"`.

---

## Task A8 — Cross-dialect round-trip + translation tests

Prove parse→render round-trips and a full cross-dialect translation (OpenAI in → IR → Anthropic out → IR → OpenAI out) preserve tools + image.

**Files:**

- Create `packages/llm-protocol/test/cross-dialect.test.ts`

Steps:

- [ ] Write the failing test `packages/llm-protocol/test/cross-dialect.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';

  import { parseAnthropicMessages, renderAnthropicMessages } from '../src/anthropic/index.js';
  import { parseGeminiGenerateContent, renderGeminiGenerateContent } from '../src/gemini/index.js';
  import { parseOpenAIChat, renderOpenAIChat } from '../src/openai/index.js';

  describe('cross-dialect translation (tools + image)', () => {
    it('OpenAI request → IR → Anthropic upstream → IR → OpenAI response', () => {
      // 1. Inbound OpenAI request with an image + a tool definition.
      const ir = parseOpenAIChat({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is in this image and the weather?' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } },
            ],
          },
        ],
        tools: [
          { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } },
        ],
      });
      expect(ir.messages[0]?.content[1]).toEqual({
        kind: 'image',
        source: 'base64',
        data: 'aGk=',
        mime: 'image/png',
      });

      // 2. Render IR to an Anthropic upstream request shape, then re-parse it back
      //    to IR to confirm the tool + image survive the dialect hop.
      //    (renderAnthropicRequest is the inbound-shaped request renderer added below.)
      // For the assistant *response* path:
      const anthropicResp = renderAnthropicMessages(
        {
          message: {
            role: 'assistant',
            content: [{ kind: 'text', text: 'a cat; sunny' }],
            toolCalls: [{ id: 'tu1', name: 'get_weather', arguments: { city: 'SF' } }],
          },
          stopReason: 'tool_calls',
          usage: { inputTokens: 10, outputTokens: 4 },
        },
        'claude-3-5-sonnet',
      );

      // 3. Re-parse the Anthropic response message back to IR via the request
      //    parser shape (assistant turn with tool_use), then render OpenAI out.
      const backToIr = parseAnthropicMessages({
        model: 'claude-3-5-sonnet',
        max_tokens: 16,
        messages: [{ role: 'assistant', content: (anthropicResp as { content: unknown }).content }],
      });
      const openaiOut = renderOpenAIChat(
        {
          message: backToIr.messages[0]!,
          stopReason: 'tool_calls',
          usage: { inputTokens: 10, outputTokens: 4 },
        },
        'gpt-4o',
      );
      const choice = (
        openaiOut as {
          choices: { message: { tool_calls: { function: { name: string } }[] } }[];
        }
      ).choices[0];
      expect(choice?.message.tool_calls?.[0]?.function.name).toBe('get_weather');
    });

    it('round-trips a gemini request through IR (image + function)', () => {
      const ir = parseGeminiGenerateContent(
        {
          contents: [
            {
              role: 'user',
              parts: [
                { text: 'caption this' },
                { inlineData: { mimeType: 'image/png', data: 'aGk=' } },
              ],
            },
          ],
          tools: [{ functionDeclarations: [{ name: 'cap', parameters: { type: 'object' } }] }],
        },
        'gemini-1.5-pro',
      );
      const out = renderGeminiGenerateContent({
        message: {
          role: 'assistant',
          content: [{ kind: 'text', text: 'a cat' }],
          toolCalls: [{ id: 'cap', name: 'cap', arguments: {} }],
        },
        stopReason: 'tool_calls',
        usage: { inputTokens: 5, outputTokens: 1 },
      });
      expect(ir.tools?.[0]?.name).toBe('cap');
      expect((out as { candidates: unknown[] }).candidates).toHaveLength(1);
    });
  });
  ```

- [ ] Run it, expect FAIL (it should fail only if a mapping is wrong — if the parsers/renderers from A4–A6 are correct it may pass; treat any failure as a real mapping bug to fix in the dialect modules, NOT here).
- [ ] If failing, fix the offending mapping in the relevant `parse.ts`/`render.ts` (e.g. the `data:` base64 URL extraction in openai parse, or tool_use re-parse in anthropic parse). Re-run until PASS.
- [ ] Typecheck + lint.
- [ ] Commit: `git commit -am "test(llm-protocol): cross-dialect translation round-trips"`.

---

## Task A9 — Adapter contract: `chat`/`streamChat` + IR upstream-request renderers

Add IR-level methods to `ProviderAdapter` and the inbound-request renderers each adapter needs to call its upstream. Keep `submit`/`stream` for non-chat modalities.

**Files:**

- Modify `packages/adapters/src/types.ts` (add `chat?`/`streamChat?` + `capabilities`)
- Create `packages/llm-protocol/src/openai/render-request.ts`, `anthropic/render-request.ts`, `gemini/render-request.ts` (IR→upstream wire request body)
- Modify the three dialect `index.ts` to re-export the request renderers
- Create `packages/llm-protocol/test/render-request.test.ts`

Steps:

- [ ] Write the failing test `packages/llm-protocol/test/render-request.test.ts`:

  ```ts
  import type { ChatRequest } from '@actionow/contracts';
  import { describe, expect, it } from 'vitest';

  import { renderAnthropicRequest } from '../src/anthropic/index.js';
  import { renderGeminiRequest } from '../src/gemini/index.js';
  import { renderOpenAIRequest } from '../src/openai/index.js';

  const ir: ChatRequest = {
    model: 'm',
    messages: [
      { role: 'system', content: [{ kind: 'text', text: 'be brief' }] },
      { role: 'user', content: [{ kind: 'text', text: 'hi' }] },
    ],
    tools: [{ name: 'f', parameters: { type: 'object' } }],
    params: { temperature: 0.2, maxOutputTokens: 64 },
  };

  describe('renderOpenAIRequest', () => {
    it('keeps system as a message and maps tools[].function', () => {
      const body = renderOpenAIRequest(ir, 'gpt-4o');
      expect(body).toMatchObject({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'hi' },
        ],
        temperature: 0.2,
        max_tokens: 64,
        tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
      });
    });
  });

  describe('renderAnthropicRequest', () => {
    it('hoists system to a top-level param and uses input_schema', () => {
      const body = renderAnthropicRequest(ir, 'claude-3-5-sonnet');
      expect(body).toMatchObject({
        model: 'claude-3-5-sonnet',
        system: 'be brief',
        max_tokens: 64,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [{ name: 'f', input_schema: { type: 'object' } }],
      });
      expect((body as { messages: unknown[] }).messages).toHaveLength(1);
    });
  });

  describe('renderGeminiRequest', () => {
    it('hoists system to systemInstruction and uses functionDeclarations', () => {
      const body = renderGeminiRequest(ir);
      expect(body).toMatchObject({
        systemInstruction: { parts: [{ text: 'be brief' }] },
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        tools: [{ functionDeclarations: [{ name: 'f', parameters: { type: 'object' } }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 64 },
      });
    });
  });
  ```

- [ ] Run it, expect FAIL.
- [ ] Create `packages/llm-protocol/src/openai/render-request.ts` — `renderOpenAIRequest(ir, model): Record<string, unknown>` mapping IR→OpenAI ChatCompletions request body (inverse of `parseOpenAIChat`): system stays a message; each `Message.content` text parts join to a string (or an array of `{type:'text'|'image_url'}` when non-text parts exist); `toolCalls`→`tool_calls`; `toolCallId`→`tool_call_id`; `tools`→`[{type:'function', function:{name, description?, parameters}}]`; params→`temperature`/`top_p`/`max_tokens`/`stop`/`seed`/`response_format`.
- [ ] Create `packages/llm-protocol/src/anthropic/render-request.ts` — `renderAnthropicRequest(ir, model): Record<string, unknown>`: pull the leading `system` message into a top-level `system` string; non-system messages → `{role, content: block array}` (text→`{type:'text'}`, image→`{type:'image', source:{...}}`, tool role → a `user` message with a `tool_result` block, assistant toolCalls → `tool_use` blocks); `tools`→`[{name, description?, input_schema:parameters}]`; `max_tokens` (default 1024 like the existing anthropic adapter), `temperature`/`top_p`/`stop_sequences`.
- [ ] Create `packages/llm-protocol/src/gemini/render-request.ts` — `renderGeminiRequest(ir): Record<string, unknown>`: leading system → `systemInstruction:{parts:[{text}]}`; messages → `contents:[{role: assistant→model, parts:[...]}]` (text→`{text}`, image base64→`{inlineData}`, toolCalls→`{functionCall}`, tool role→`{functionResponse}`); `tools`→`[{functionDeclarations:[...]}]`; `generationConfig` from params.
- [ ] Re-export the three request renderers from each dialect `index.ts`.
- [ ] Run the test, expect PASS.
- [ ] Now modify `packages/adapters/src/types.ts` to extend the contract (add the IR methods + a capabilities declaration). Append to the `ProviderAdapter` interface:

  ```ts
  import type {
    AdapterContext,
    CallbackResult,
    ChatRequest,
    ChatResponse,
    ChatStreamEvent,
    PollResult,
    StreamEvent,
    SubmitInput,
    SubmitResult,
    UnifiedError,
    UsageVector,
  } from '@actionow/contracts';

  /** A provider's declared chat capabilities, surfaced to the normalization gate. */
  export interface AdapterCapabilities {
    tools: boolean;
    vision: boolean;
    audio: boolean;
    json: boolean;
    stream: boolean;
  }

  export interface ProviderAdapter {
    readonly providerType: string;
    /** Declared chat capabilities; absent → no chat support (submit-only adapter). */
    readonly capabilities?: AdapterCapabilities;
    submit(input: SubmitInput): Promise<SubmitResult>;
    poll?(upstreamJobId: string, ctx: AdapterContext): Promise<PollResult>;
    stream?(input: SubmitInput, ctx: AdapterContext): AsyncIterable<StreamEvent>;
    /** IR-level blocking chat: preserves tools/multimodal/stopReason/usage. */
    chat?(ir: ChatRequest, ctx: AdapterContext): Promise<ChatResponse>;
    /** IR-level streaming chat: yields {@link ChatStreamEvent}s. */
    streamChat?(ir: ChatRequest, ctx: AdapterContext): AsyncIterable<ChatStreamEvent>;
    parseCallback?(payload: unknown): CallbackResult;
    extractUsage(raw: unknown): UsageVector;
    mapError(raw: unknown): UnifiedError;
  }
  ```

  Note: `@actionow/adapters` may NOT import `@actionow/llm-protocol` (boundaries forbid it — adapters predates llm-protocol in the dependency order). The adapters therefore implement `chat`/`streamChat` by hand-rolling IR→upstream request bodies inline (Task A10), NOT by importing the `render*Request` helpers. The `render*Request` helpers in `llm-protocol` exist for the API layer's translation tests + future reuse, and are exercised by Task A8/A9 tests.

- [ ] Run the adapters typecheck to confirm the contract extension compiles (existing adapters have no `chat`/`capabilities` yet — those fields are optional, so this passes): `pnpm --filter @actionow/adapters typecheck`.
- [ ] Typecheck + lint the llm-protocol package.
- [ ] Commit: `git commit -am "feat(adapters): add chat/streamChat IR contract + capabilities"`.

---

## Task A10 — Upgrade openai/anthropic/gemini adapters with `chat`/`streamChat`

Implement the IR methods on each adapter over the existing `HttpClient` port, declaring capabilities. Keep `submit`/`stream` intact.

**Files:**

- Modify `packages/adapters/src/openai.ts`
- Modify `packages/adapters/src/anthropic.ts`
- Modify `packages/adapters/src/gemini.ts`
- Create `packages/adapters/test/openai-chat.test.ts`
- Create `packages/adapters/test/anthropic-chat.test.ts`
- Create `packages/adapters/test/gemini-chat.test.ts`

Steps:

- [ ] Write the failing test `packages/adapters/test/openai-chat.test.ts` (mirror the `fakeHttp`/`fakeStreamHttp`/`drain` harness from `packages/adapters/test/openai.test.ts`):

  ```ts
  import type { ChatRequest, ChatStreamEvent, HttpClient, HttpRequest } from '@actionow/contracts';
  import { describe, expect, it } from 'vitest';

  import { openaiAdapter } from '../src/openai.js';

  const fakeHttp = (
    resp: { status: number; body: unknown },
    cap?: (r: HttpRequest) => void,
  ): HttpClient => ({
    request: (r: HttpRequest) => {
      cap?.(r);
      return Promise.resolve({
        status: resp.status,
        ok: resp.status < 400,
        body: resp.body,
        text: '',
      });
    },
  });

  const ir: ChatRequest = {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
    tools: [{ name: 'f', parameters: { type: 'object' } }],
  };

  describe('openaiAdapter.chat', () => {
    it('declares chat capabilities', () => {
      expect(openaiAdapter.capabilities).toMatchObject({ tools: true, vision: true, stream: true });
    });

    it('posts an IR-derived body and parses tool_calls into the IR response', async () => {
      let seen: HttpRequest | undefined;
      const http = fakeHttp(
        {
          status: 200,
          body: {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    { id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 7, completion_tokens: 3 },
          },
        },
        (r) => {
          seen = r;
        },
      );
      const res = await openaiAdapter.chat!(ir, {
        providerType: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk',
        http,
      });
      expect(seen?.url).toBe('https://api.openai.com/v1/chat/completions');
      expect(seen?.body).toMatchObject({ tools: [{ type: 'function', function: { name: 'f' } }] });
      expect(res.message.toolCalls).toEqual([{ id: 'c1', name: 'f', arguments: { a: 1 } }]);
      expect(res.stopReason).toBe('tool_calls');
      expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    });
  });

  async function drainChat(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
    const out: ChatStreamEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
  }

  describe('openaiAdapter.streamChat', () => {
    it('yields message_start, content_delta, usage, stop, done', async () => {
      // eslint-disable-next-line @typescript-eslint/require-await
      const lines = (async function* g(): AsyncIterable<string> {
        yield 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n';
        yield 'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n';
        yield 'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n';
        yield 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n';
        yield 'data: [DONE]\n\n';
      })();
      const http: HttpClient = {
        request: () => Promise.reject(new Error('unused')),
        stream: () => Promise.resolve({ status: 200, ok: true, lines }),
      };
      const events = await drainChat(
        openaiAdapter.streamChat!(ir, {
          providerType: 'openai',
          model: 'gpt-4o',
          apiKey: 'sk',
          http,
        }),
      );
      expect(events.map((e) => e.type)).toEqual([
        'message_start',
        'content_delta',
        'content_delta',
        'stop',
        'usage',
        'done',
      ]);
    });
  });
  ```

- [ ] Run it, expect FAIL: `pnpm --filter @actionow/adapters exec vitest run test/openai-chat.test.ts`.
- [ ] Modify `packages/adapters/src/openai.ts`: add `capabilities: { tools: true, vision: true, audio: false, json: true, stream: true }` and `async chat(ir, ctx)` + `async *streamChat(ir, ctx)`. Build the request body inline from the IR (system stays a message; content text parts joined; image parts → `{type:'image_url', image_url:{url}}`; `tools`→`[{type:'function', function:{...}}]`; `tool_calls`/`tool_call_id`; params→`temperature`/`max_tokens`/etc.). `chat` parses `choices[0].message` into an IR `Message` (content→text part, `tool_calls`→`toolCalls`), maps `finish_reason`→`stopReason`, `usage`→`{inputTokens, outputTokens}`. `streamChat` uses `openStream` + `parseSse` (already imported), emitting `message_start` on the first frame, `content_delta` per `delta.content`, `tool_call_delta` per `delta.tool_calls[]`, `stop` on a frame with `finish_reason`, `usage` on the trailing usage frame, and `done` at `[DONE]`. Reuse the existing `asRecord`/`asArray`/`asString`/`asNumber`/`parseJsonRecord` imports.
- [ ] Run it, expect PASS.
- [ ] Repeat the analogous failing test + implementation for `anthropic.ts` (`anthropic-chat.test.ts`): capabilities `{ tools:true, vision:true, audio:false, json:false, stream:true }`; request body hoists system to a top-level param, blocks for content, `input_schema` for tools, `max_tokens` default 1024; `chat` parses `content[]` blocks (`text`→text parts, `tool_use`→toolCalls) + `stop_reason`→IR + `usage`; `streamChat` consumes Anthropic typed SSE (`message_start`→`message_start`+capture input_tokens, `content_block_delta` with `text_delta`→`content_delta`, `content_block_start`/`delta` with `input_json_delta`→`tool_call_delta`, `message_delta`→accumulate output_tokens, `message_stop`→`stop`+`usage`+`done`).
- [ ] Repeat for `gemini.ts` (`gemini-chat.test.ts`): capabilities `{ tools:true, vision:true, audio:true, json:true, stream:true }`; request body uses `systemInstruction`/`contents`/`functionDeclarations`/`generationConfig`; `chat` parses `candidates[0].content.parts` (`text`→text, `functionCall`→toolCall) + `finishReason`→IR + `usageMetadata`; `streamChat` uses `:streamGenerateContent?alt=sse`, each frame a candidate chunk → `content_delta`/`tool_call_delta`, final frame's `usageMetadata`→`usage`, then `stop`+`done`.
- [ ] Run all three new tests, expect PASS: `pnpm --filter @actionow/adapters exec vitest run test/openai-chat.test.ts test/anthropic-chat.test.ts test/gemini-chat.test.ts`.
- [ ] Confirm the EXISTING adapter tests still pass (submit/stream untouched): `pnpm --filter @actionow/adapters test`.
- [ ] Typecheck + lint adapters.
- [ ] Commit: `git commit -am "feat(adapters): implement chat/streamChat on openai anthropic gemini"`.

---

## Task A11 — Engine IR streaming: forward `ChatStreamEvent` through the settling stream

The engine's `createSettlingStream` currently only knows text `StreamEvent`. Add a parallel IR streaming path so chat runs use `streamChat` and surface IR events to the API while still settling exactly once with token usage.

**Files:**

- Modify `packages/engine/src/stream.ts` (add `createChatSettlingStream`)
- Modify `packages/engine/src/execution-service.ts` (add `runChatStream`/`runChat`)
- Modify `packages/engine/src/index.ts` (export new symbols if not via `*`)
- Create `packages/engine/test/chat-stream.test.ts`

Steps:

- [ ] Write the failing test `packages/engine/test/chat-stream.test.ts` (unit, injected fakes — mirror the existing engine stream test style; no DB container). Use a fake `db` with `settleJob`/`failJob` recorded, a fake adapter registry whose adapter exposes `streamChat`, and assert: IR events `message_start`/`content_delta`/`usage`/`stop`/`done` are forwarded, the terminal engine `done` carries `{jobId, cost}`, and `settleJob` is called exactly once with the token usage `{input_tokens, output_tokens}` derived from the IR `usage` event. (Model the test on `packages/engine/test/*stream*.test.ts` — read that file first for the exact fake-db shape; if none exists, build fakes for the `settleJob`/`failJob`/`DbOrTx` surface used in `stream.ts`.)
      Key assertion bodies:
  ```ts
  // after draining createChatSettlingStream(...):
  expect(events.map((e) => e.type)).toEqual([
    'message_start',
    'content_delta',
    'usage',
    'stop',
    'done',
  ]);
  expect(settleCalls).toHaveLength(1);
  expect(settleCalls[0].usage).toEqual({ input_tokens: 3, output_tokens: 2 });
  // terminal done carries jobId + cost (decimal-string µcredits)
  const done = events.at(-1) as { type: 'done'; jobId?: string; cost?: { credits: string } };
  expect(done.jobId).toBeDefined();
  ```
- [ ] Run it, expect FAIL: `pnpm --filter @actionow/engine exec vitest run test/chat-stream.test.ts`.
- [ ] In `packages/engine/src/stream.ts`, add `createChatSettlingStream(deps): AsyncGenerator<ChatStreamEvent>` modeled on `createSettlingStream`: it resolves the adapter, requires `adapter.streamChat`, reads the IR from `deps.inputs.__ir` (a `ChatRequest` placed there by the API), iterates `adapter.streamChat(ir, ctx)`, forwards each event, captures the latest `usage` IR event (mapping `{inputTokens,outputTokens}`→the engine's `UsageVector {input_tokens, output_tokens}` used by `computeFinalCost`/the `model_token` pricing), settles exactly once on completion/disconnect (reuse the same `settleStream`/`failStream` helpers, passing the mapped usage), and emits a terminal engine IR `done` carrying `{ type:'done', jobId, cost:{credits} }` — extend the `ChatStreamEvent` `done` variant locally is NOT needed: emit the contracts `done` as `{ type: 'done' }` to the consumer and surface the settled `{jobId, cost}` on a final synthetic event. To keep the IR contract clean, emit the engine terminal as a separate `{ type:'done' }` and have the API read the settled job id from the `StreamOutcome.jobId` returned by `runChatStream` (the API already knows the jobId before streaming). So: forward IR events verbatim, settle in `finally`, and do NOT mutate the IR `done` shape.
      Concretely, mirror `createSettlingStream`'s structure: `latestUsage`, `failure`, `settled`, a `finalize()` that calls `settleStream`/`failStream`. On an IR `usage` event, set `latestUsage = { input_tokens: ev.usage.inputTokens, output_tokens: ev.usage.outputTokens }`. On an IR `error` event, set `failure` and throw. Forward every IR event to the consumer (including `done`). In `finally`, `await finalize()`.
- [ ] In `packages/engine/src/execution-service.ts`, add `runChatStream(req): Promise<{ jobId: string; events: AsyncIterable<ChatStreamEvent> }>` and `runChat(req): Promise<{ jobId: string; response: ChatResponse; cost: RunCost }>`. `runChatStream` reuses `validateAndHold` (the IR lives in `req.inputs.__ir`; the io_schema validation passes because the chat resource's schema accepts an opaque `__ir` object — see Task A12's resource seeding) then builds the chat settling stream. `runChat` runs the blocking branch: resolve adapter, call `adapter.chat(ir, ctx)`, map IR `usage`→`UsageVector`, settle via the existing `settleSync` path (passing `{ kind:'sync', output: <rendered>, usage }`). Keep these additive; do not change `run`/`runStream`.
- [ ] Ensure `ChatStreamEvent`/`ChatResponse` are imported from `@actionow/contracts` in both engine files.
- [ ] Run the engine test, expect PASS.
- [ ] Confirm existing engine tests still pass: `pnpm --filter @actionow/engine test`.
- [ ] Typecheck + lint engine.
- [ ] Commit: `git commit -am "feat(engine): IR chat settling stream + blocking chat run"`.

---

## Task A12 — API: model resolution port + chat endpoints (OpenAI/Anthropic/Gemini)

Add the three dialect controllers, a `ModelResolverService` consuming Track C's pinned `resolveModelForTenant`, and a `ChatRelayService` that builds a `RunRequest` from a resolved model and drives the engine, rendering IR back to the caller's dialect.

**Files:**

- Create `apps/api/src/chat/model-resolver.service.ts`
- Create `apps/api/src/chat/chat-relay.service.ts`
- Create `apps/api/src/chat/openai.controller.ts`
- Create `apps/api/src/chat/anthropic.controller.ts`
- Create `apps/api/src/chat/gemini.controller.ts`
- Create `apps/api/src/chat/chat.module.ts`
- Modify `apps/api/src/app.module.ts` (import `ChatModule`)
- Modify `apps/api/package.json` (add `@actionow/llm-protocol` dep)
- Create `apps/api/test/chat-relay.e2e.test.ts`

Steps:

- [ ] Add `"@actionow/llm-protocol": "workspace:*"` to `apps/api/package.json` dependencies; run `pnpm install`.
- [ ] Create `apps/api/src/chat/model-resolver.service.ts` with an injectable port matching Track C's pinned signature. Until Track C lands, bind it to a thrown `resource_not_found` and override it in tests; the production binding becomes `resolveModelForTenant` from `@actionow/db`:

  ```ts
  import type { Database } from '@actionow/db';
  import { Inject, Injectable } from '@nestjs/common';

  import { engineNotFound } from '../common/errors.js';
  import { DB } from '../common/tokens.js';

  /** Track C's pinned model-resolution shape (do NOT rename). */
  export interface ResolvedModel {
    modelId: string;
    resourceId: string;
    inputPrice: bigint;
    outputPrice: bigint;
    capabilities: Record<string, unknown>;
  }

  /** DI token for the (Track-C-backed) model resolver. */
  export const MODEL_RESOLVER = Symbol('MODEL_RESOLVER');

  export interface ModelResolverPort {
    resolveModelForTenant(
      db: Database,
      modelName: string,
      tenantId: string,
    ): Promise<ResolvedModel | undefined>;
  }

  @Injectable()
  export class ModelResolverService {
    constructor(
      @Inject(DB) private readonly db: Database,
      @Inject(MODEL_RESOLVER) private readonly port: ModelResolverPort,
    ) {}

    async resolve(modelName: string, tenantId: string): Promise<ResolvedModel> {
      const m = await this.port.resolveModelForTenant(this.db, modelName, tenantId);
      if (m === undefined) throw engineNotFound(`model "${modelName}" not found`);
      return m;
    }
  }
  ```

  In `chat.module.ts`, provide `MODEL_RESOLVER` with a default that calls `@actionow/db`'s `resolveModelForTenant` if it exists, else throws — add a TODO comment: `// Track C provides resolveModelForTenant; bind here once landed.` Tests override `MODEL_RESOLVER` with a fake.

- [ ] Create `apps/api/src/chat/chat-relay.service.ts`. It: (1) resolves the model → `resourceId` + capabilities; (2) `normalizeRequest(ir, readCapabilities(capabilities))` (from `@actionow/llm-protocol`); (3) builds a `RunRequest` for that `resourceId` reusing the same db loads as `RunService.buildRequest` (`getResource`/`getResourceVersion`/`getActivePricebookEntry`/`listChannels`/`listApplicableModifiers`) — extract a shared `buildChatRunRequest(resourceId, ir, ctx, execMode)` that places the IR at `inputs: { __ir: ir }` and forces `execMode` to `'stream'` or `'blocking'`; (4) calls `service.runChatStream(req)` or `service.runChat(req)`. Expose `chatStream(modelName, ir, ctx): Promise<{ jobId; events: AsyncIterable<ChatStreamEvent> }>` and `chat(modelName, ir, ctx): Promise<{ response: ChatResponse }>`. Construct the `ExecutionService` exactly as `RunService.buildService()` does (same deps: DB, ADAPTERS, JOB_QUEUE, SecretResolver, FetchHttpClient). The channels' `model` field carries the upstream model name; the chat resource's `providerType` selects the adapter (`openai`/`anthropic`/`gemini`).
- [ ] Create `apps/api/src/chat/openai.controller.ts`:

  ```ts
  import type { ChatStreamEvent } from '@actionow/contracts';
  import {
    parseOpenAIChat,
    renderOpenAIChat,
    renderOpenAIChatStream,
  } from '@actionow/llm-protocol';
  import { Body, Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
  import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
  import type { Request, Response } from 'express';

  import { ApiKeyGuard } from '../auth/api-key.guard.js';
  import { AuthService } from '../auth/auth.service.js';
  import { RateLimitGuard } from '../auth/rate-limit.guard.js';
  import { ChatRelayService } from './chat-relay.service.js';

  @ApiTags('v1')
  @ApiBearerAuth('api-key')
  @UseGuards(ApiKeyGuard, RateLimitGuard)
  @Controller('v1/chat')
  export class OpenAIChatController {
    constructor(
      private readonly relay: ChatRelayService,
      private readonly auth: AuthService,
    ) {}

    @Post('completions')
    async completions(
      @Body() body: Record<string, unknown>,
      @Req() req: Request,
      @Res({ passthrough: true }) res: Response,
    ): Promise<Record<string, unknown> | undefined> {
      const ctx = this.auth.resolve(req);
      const ir = parseOpenAIChat(body);
      if (body.stream === true) {
        const { events } = await this.relay.chatStream(ir.model, ir, ctx);
        await pipeSse(res, renderOpenAIChatStream(events, ir.model));
        return undefined;
      }
      const { response } = await this.relay.chat(ir.model, ir, ctx);
      return renderOpenAIChat(response, ir.model);
    }
  }
  ```

  Add a shared `pipeSse(res, frames: AsyncIterable<string>): Promise<void>` helper (in `apps/api/src/chat/sse.ts`) that sets the same SSE headers as `run.controller.ts` (`Content-Type: text/event-stream`, `Cache-Control`, `X-Accel-Buffering: no`, `flushHeaders()`), wires `res.on('close')` → `iterator.return?.()` for disconnect-settle, writes each string frame verbatim, and `res.end()`s in `finally`. Critically: `relay.chatStream` performs the hold (in `runChatStream`→`validateAndHold`) BEFORE any byte is written, so an `insufficient_credits`/`invalid_input` throw surfaces as a real HTTP error via the `UnifiedErrorFilter` — exactly the property `stream-callbacks.e2e.test.ts` verifies for `/v1/run`.

- [ ] Create `apps/api/src/chat/anthropic.controller.ts` — `@Controller('v1')`, `@Post('messages')`, using `parseAnthropicMessages`/`renderAnthropicMessages`/`renderAnthropicMessagesStream`. Same guard stack + `pipeSse`.
- [ ] Create `apps/api/src/chat/gemini.controller.ts` — `@Controller('v1beta/models')`, two routes: `@Post(':model\\:generateContent')` (blocking) and `@Post(':model\\:streamGenerateContent')` (SSE). Extract the model from the `:model` param (NestJS route: use a param + manual split on `':'`, or two explicit routes — model name precedes the action). Use `parseGeminiGenerateContent(body, model)`/`renderGeminiGenerateContent`/`renderGeminiGenerateContentStream`. (Note: Gemini passes its API key as a `?key=` query param upstream, but the relay authenticates the CLIENT via `ApiKeyGuard` on the `Authorization`/`x-api-key`/`x-goog-api-key` header; the upstream key comes from the channel credential. If clients send `?key=`, the guard's `x-api-key` path already covers `x-api-key`; add `x-goog-api-key` extraction to `extractKey` in `api-key.guard.ts` ONLY if a gemini e2e shows it's needed — otherwise require `Authorization: Bearer`.)
- [ ] Create `apps/api/src/chat/chat.module.ts` registering the three controllers + `ChatRelayService` + `ModelResolverService` + `AuthService` + `ApiKeyGuard` + `RateLimitGuard`, and the `MODEL_RESOLVER` provider (default binding with the Track C TODO).
- [ ] Add `ChatModule` to `apps/api/src/app.module.ts` imports.
- [ ] Write the failing e2e `apps/api/test/chat-relay.e2e.test.ts` (Testcontainers postgres:16-alpine, `fileParallelism:false` is repo default). Model it on `stream-callbacks.e2e.test.ts`: boot a real server (`app.listen(0)`), seed a tenant + funded account + api key, seed a **chat resource** (`providerType:'mock-chat'`, `execModes:['stream','blocking']`, an io_schema whose single input is `{key:'__ir', type:'string', required:false}` so engine validation is a no-op on the IR bag — confirm `validateInputs` tolerates an object value for a non-required field; if it rejects objects, instead seed the io_schema with NO required inputs so the `__ir` passthrough is unvalidated), a post/unit pricebook keyed on `output_tokens` (so settle prices tokens), and an upstream channel. Register a **`mock-chat` adapter** (created in this test file or added to the default registry — see below) that implements `chat`/`streamChat` returning deterministic IR. Override `MODEL_RESOLVER` with a fake mapping `'mock-model' → { resourceId: <seeded id>, inputPrice:0n, outputPrice:0n, capabilities:{ tools:true, vision:true, audio:true, json:true } }`. Assertions:
  - `POST /v1/chat/completions` (non-stream) returns `200` with `object:'chat.completion'`, `choices[0].message.content`, and `usage.completion_tokens`; the ledger has exactly one settle row.
  - `POST /v1/chat/completions` with `stream:true` + `Accept: text/event-stream` returns `chat.completion.chunk` frames ending in `data: [DONE]`; settle-once holds (one settle ledger row).
  - `POST /v1/messages` returns Anthropic `type:'message'` JSON; streaming yields `event: message_start`…`event: message_stop`.
  - `POST /v1beta/models/mock-model:generateContent` returns `candidates[0].content.parts`; `:streamGenerateContent` yields `data:` candidate frames.
  - A model the resolver doesn't know → `404 resource_not_found`.
  - Disconnecting mid-stream settles exactly once (mirror the abort-fetch assertion in `stream-callbacks.e2e.test.ts`).
- [ ] Create the `mock-chat` adapter for the e2e. Prefer adding it to `packages/adapters/src/mock-chat.ts` + registering it in `createDefaultRegistry` (mirrors `mock-stream`). It declares `capabilities` and implements `chat` (returns `{ message:{role:'assistant', content:[{kind:'text', text:'hello'}]}, stopReason:'stop', usage:{inputTokens:10, outputTokens:5} }`) and `streamChat` (yields `message_start`, two `content_delta` `'hel'`/`'lo'`, `usage {inputTokens:10, outputTokens:5}`, `stop`, `done`). If added to adapters, write its unit test `packages/adapters/test/mock-chat.test.ts` first (TDD) and commit it within this task. The engine's chat settling stream maps `outputTokens:5` → `output_tokens:5` → 5µ via the seeded `unit` pricebook (`output_tokens` rate 1).
- [ ] Run the e2e, expect FAIL first (controllers/module not wired), then implement until PASS: `pnpm --filter @actionow/api exec vitest run test/chat-relay.e2e.test.ts` (Docker must be up).
- [ ] Confirm existing API e2e suites still pass: `pnpm --filter @actionow/api test`.
- [ ] Typecheck + lint the api app + adapters.
- [ ] Commit: `git commit -am "feat(api): openai/anthropic/gemini chat relay endpoints"`.

---

## Task A13 — Optional `GET /v1/models` discovery

List the models visible to the caller (Track C's `listVisibleModels`). Behind `ApiKeyGuard`.

**Files:**

- Create `apps/api/src/chat/models.controller.ts`
- Modify `apps/api/src/chat/chat.module.ts` (register the controller)
- Modify `apps/api/src/chat/model-resolver.service.ts` (add a `listVisible` passthrough)
- Modify `apps/api/test/chat-relay.e2e.test.ts` (add a `GET /v1/models` case)

Steps:

- [ ] Add to the e2e a failing case: `GET /v1/models` returns `{ object:'list', data:[{ id:'mock-model', object:'model' }] }` (OpenAI-shaped discovery). Override the `MODEL_RESOLVER` fake to also implement `listVisibleModels(db, tenantId) → [{ name:'mock-model', display:'Mock', modality:'chat', capabilities:{...} }]` (Track C's pinned `ModelView[]`).
- [ ] Run it, expect FAIL.
- [ ] Extend `ModelResolverPort` with `listVisibleModels(db, tenantId): Promise<ModelView[]>` (define a local `ModelView` interface matching Track C's pinned shape: `{ name: string; display: string; modality: string; capabilities: Record<string, unknown> }`). Add `ModelResolverService.listVisible(tenantId)`.
- [ ] Create `apps/api/src/chat/models.controller.ts`: `@Controller('v1/models')`, `@UseGuards(ApiKeyGuard)`, `@Get()` → resolve tenant via `AuthService`, call `listVisible`, render `{ object:'list', data: models.map((m) => ({ id: m.name, object:'model', owned_by:'actionow' })) }`.
- [ ] Register it in `chat.module.ts`.
- [ ] Run the e2e case, expect PASS.
- [ ] Typecheck + lint.
- [ ] Commit: `git commit -am "feat(api): GET /v1/models discovery endpoint"`.

---

## Task A14 — Golden SSE fixtures per dialect (regression lock)

Lock the exact streaming byte shapes so a future refactor can't silently change a dialect's framing.

**Files:**

- Create `packages/llm-protocol/test/golden-sse.test.ts`

Steps:

- [ ] Write `packages/llm-protocol/test/golden-sse.test.ts` that runs the SAME deterministic `ChatStreamEvent[]` (one `message_start`, two `content_delta` `'A'`/`'B'`, one `usage {inputTokens:5, outputTokens:2}`, one `stop {stopReason:'stop'}`, one `done`) through each `render*Stream`, normalizes only the volatile fields (replace any `"id":"chatcmpl-..."`/`"msg_..."` and `"created":<n>` with a fixed token via regex), and `expect(normalized).toMatchInlineSnapshot(...)`. Three inline snapshots — one per dialect. The OpenAI snapshot must end with `data: [DONE]\n\n`; the Anthropic one must contain the `event: message_start` → `content_block_start` → `content_block_delta`×2 → `content_block_stop` → `message_delta` → `message_stop` sequence; the Gemini one must be `data:`-only candidate frames with the final frame carrying `finishReason:"STOP"` + `usageMetadata`.
- [ ] Run it once to populate the inline snapshots, INSPECT each snapshot against the real dialect SSE specs (OpenAI `chat.completion.chunk`; Anthropic streaming events; Gemini `alt=sse`), then run again to confirm PASS.
- [ ] Lint + typecheck.
- [ ] Commit: `git commit -am "test(llm-protocol): golden sse snapshots per dialect"`.

---

## Verification gate

**Files:** none (verification only).

- [ ] Ensure Docker is up for Testcontainers: `docker info` succeeds.
- [ ] `pnpm install` (clean lockfile after the new package + deps).
- [ ] `pnpm typecheck` — green across all packages/apps.
- [ ] `pnpm lint` — green; confirm NO `@actionow/llm-protocol` import appears in any non-`apps/**`, non-`contracts` package (boundaries enforced), and the new `no-restricted-imports` block for `llm-protocol` rejects forbidden edges. Grep to confirm no `any`: `! grep -rn ": any\b\| as any\b" packages/llm-protocol/src apps/api/src/chat` (must find nothing).
- [ ] `pnpm build` — every package emits to `dist/` (turbo `^build` order).
- [ ] `pnpm test` — all unit + integration suites green, including the new `packages/llm-protocol/test/*`, `packages/adapters/test/*-chat.test.ts`, `packages/engine/test/chat-stream.test.ts`, and `apps/api/test/chat-relay.e2e.test.ts`.
- [ ] Boundaries intact: `@actionow/llm-protocol` imports only `@actionow/contracts` (+ `zod`); `@actionow/adapters` does NOT import `@actionow/llm-protocol`; `apps/api` imports `@actionow/llm-protocol` only in `apps/api/src/chat/*`.
- [ ] No secret logging: confirm the chat controllers/services never log `ctx.apiKey`, the upstream channel credential, or request bodies; the SSE `pipeSse` writes only rendered dialect frames; the `UnifiedErrorFilter` sanitizes all errors (unchanged).
- [ ] SDKs are types-only: `grep -rn "from 'openai'\|from '@anthropic-ai/sdk'\|from '@google/genai'" packages/llm-protocol/src` returns only `import type` lines (or nothing). No SDK runtime symbol in emitted `dist/`.

---

## Definition of Done

Mirrors spec §支柱A:

- **IR (§A.1):** `ChatRequest`/`ChatResponse`/`ChatStreamEvent`/`Message`/`ContentPart`/`ToolDef`/`ToolCall` live in `@actionow/contracts/src/chat.ts`, covering text + tools + multimodal (image/audio/file parts), with the streaming event union (`message_start`/`content_delta`/`tool_call_delta`/`usage`/`stop`/`done`/`error`).
- **`@actionow/llm-protocol` (§A.2):** a pure, contracts-only package with `parseOpenAIChat`/`parseAnthropicMessages`/`parseGeminiGenerateContent` (wire→IR), `renderOpenAIChat`/`renderAnthropicMessages`/`renderGeminiGenerateContent` (IR→wire), each dialect's streaming SSE renderer (`renderOpenAIChatStream` chat.completion.chunk + `[DONE]`; `renderAnthropicMessagesStream` typed events; `renderGeminiGenerateContentStream` alt=sse array chunks), inbound-request renderers, and a `normalizeRequest` capability gate that 400s unsupported features (§A.3 dialect map covered: system, tools/calls/results, images, usage).
- **Adapter contract (§A.4):** `ProviderAdapter` gains optional `chat`/`streamChat` (IR-level, preserving tools/multimodal/stopReason/usage) + a `capabilities` declaration; openai/anthropic/gemini adapters implement both over the existing `HttpClient` port; `submit`/`stream` remain for non-chat modalities.
- **Endpoints (§A.5):** `POST /v1/chat/completions`, `POST /v1/messages`, `POST /v1beta/models/{model}:generateContent` + `:streamGenerateContent`, and optional `GET /v1/models`, all behind `ApiKeyGuard` (+ `RateLimitGuard` on the chat POSTs), funneling into the engine's `runChatStream`/`runChat` (hold→stream→settle-once) with model resolution via Track C's `resolveModelForTenant` (pinned port; bound to `@actionow/db` once Track C lands) and token usage flowing to settle. Errors render per dialect with correct HTTP codes via the `UnifiedErrorFilter`.
- **SDK strategy (§A.6):** official SDKs used as type sources only; all runtime parse/render/SSE/HTTP stays hand-written on `HttpClient`.
- **Tests:** cross-dialect translation (OpenAI in → Anthropic upstream → OpenAI out, with tools + image), golden SSE snapshots per dialect, adapter chat/streamChat unit tests with injected fake HTTP, engine IR settling-stream unit test (settle-once + token usage), and an e2e with a `mock-chat` adapter proving hold/settle + token usage + disconnect-settles-once across all three dialects.
- **Quality gate:** `pnpm typecheck && pnpm lint && pnpm build && pnpm test` all green; boundaries intact; no `any`; no secret logging.
