# Real-Provider Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes. TDD.

**Goal:** Make the Actionow platform call REAL upstreams end-to-end: OpenAI-compatible chat (DeepSeek / Xiaomi MiMo / HuiMeng-fronted GPT+Gemini), async image/video via the HuiMeng task relay (submit→poll + signed webhook), with **per-channel HTTP proxy** support (so direct openai/anthropic/gemini hosts become reachable from a blocked network), and **R2 persistence** of media outputs (the 24h upstream URL is copied into the `actionow` R2 bucket and the result rewritten to a stable `https://asset.actionow.ai/...` URL + a `file_object` row). The default test suite stays network-free; a single opt-in live e2e really hits the providers.

**Architecture:**

- New pure `huimeng` `ProviderAdapter` in `packages/adapters` (async media: image=`seedream-4.5`, video=`seedance-2.0`), registered in `createDefaultRegistry`. Modeled on `async-media-mock.ts` (state machine shape) + `dify-workflow.ts` (real-HTTP shape via `ctx.http`).
- Per-channel proxy: `proxyUrl?: string` added to `AdapterContext`; `FetchHttpClient` honors it via an `undici` `ProxyAgent` set as the fetch `dispatcher`. New `upstream_channel` columns `endpoint`, `model`, `proxy_ref` (migration `0005`). The channel→`RunChannel`→`AdapterContext` mapping is threaded through `RunService`, the worker `loaders.ts`, and the api `CallbacksService`.
- R2 media persistence: a pure `engine` hook (`persistMediaOutput`) that takes a `StorageProvider` + an HTTP fetch fn, copies media URLs into R2, and rewrites the output. Called from `JobRunner.settle` via an optional injected dependency. The `StorageProvider` is threaded into the worker runtime (and the api `CallbacksService`). Adapters NEVER import storage (eslint boundary `adapters↛db`, and adapters stay storage-free by convention).
- OpenAI-compatible channels reuse the existing `openai` adapter with a per-channel `endpoint`. Direct openai/anthropic/gemini channels reuse existing adapters + a `proxy_ref`.
- Seed extension registers image/video/chat resources + channels + pricebooks. One opt-in live e2e (`LIVE_PROVIDER_TEST=1`) hits DeepSeek (blocking), HuiMeng image (async submit→poll→complete), and an R2 round-trip; skipped by default.

**Tech Stack:** pnpm monorepo; TypeScript (strict, ESLint no-`any`, `consistent-type-imports`, boundaries via `eslint-plugin-boundaries` + `no-restricted-imports`); Node 24 global `fetch`; `undici` `ProxyAgent`; drizzle-kit (latest migration `0004` → new ones start at `0005`); `@aws-sdk/client-s3` (R2 S3-compatible); Vitest; Testcontainers (`postgres:16-alpine`, `minio/minio:latest`); BullMQ worker; NestJS api. Money is `bigint` µcredits.

## Decisions (locked at plan review — these OVERRIDE the "Open questions" section at the bottom)

1. **Proxy** — option (a): per-channel `proxy_ref` (a `text` env-key locator resolved via `SecretResolver`) + a global `UPSTREAM_PROXY_URL` env fallback. This is the requirement "系统代理 + 不同模型走不同代理".
2. **Persistence** — best-effort in the worker + `CallbacksService` settle path only (no blocking-path persistence); if the R2 upload fails the job still settles, falling back to the temp upstream URL.
3. **Pricing** — PLACEHOLDER rates now (refine later in admin/pricebook): media uses the `tasks` dimension — image = flat `250_000` µcredits/image, video = flat `1_500_000` µcredits/video (placeholder; refine to per-second later); chat = per-token via the existing token pricing method at a placeholder rate. Recording upstream `cost` for audit is optional/skip-if-nontrivial.
4. **Direct-host channels** (openai/anthropic/gemini) — seed `status: 'active'` WITH a `proxy_ref` (usable once a proxy is configured); GPT/Gemini are also reachable via the async-media / OpenAI-compat relay channels.
5. **NO vendor identity in code or commits (locked correction).** The relay adapter is the GENERIC `async-media` adapter (`providerType: 'async-media'`, done in `b1a50ea`); submit/poll/signed-callback is a vendor-neutral protocol. EVERY vendor specific — base URL, model ids, the task submit/poll URL paths, and the webhook signature/timestamp header names — is per-channel **config DATA seeded in the DB**, never hardcoded and never named in code/commit/PR messages. This OVERRIDES any vendor-named identifiers/paths/headers shown in the original Task 1/5/6/7/12 text below:
   - **Task 5** ALSO adds a `config` jsonb column to `upstream_channel` (alongside `endpoint`/`model`/`proxy_ref`) to hold the relay protocol config (`{ submitPath, pollPath, signatureHeader, timestampHeader }`).
   - **Tasks 6 & 7** ALSO thread `channel.config` → `AdapterContext.config` (next to endpoint/model/proxyUrl).
   - **Task 12** seeds the relay as DATA: a `async-media` channel with `endpoint`, `model`, `credential_ref`, and `config` = the relay's task paths + signature header names. The concrete relay values (its base URL, its `/api/v1/tasks` paths, its `X-…-Signature` header, its image/video model ids) live ONLY in this seed row — they are the one place a vendor name may appear, as seed data.

---

## Conventions

- **Repo root:** `/Users/alienworm/actionow-core` (a pnpm monorepo: `packages/*`, `apps/*`). Run all `pnpm` commands from the root. Per-package tests can be scoped with `pnpm --filter @actionow/<pkg> test` / `pnpm --filter @actionow/api test`.
- **Branch:** `feat/real-providers` off `main`. Create it first: `git switch -c feat/real-providers`.
- **TDD:** every task is red→green. Write the failing test FIRST, run it and SEE it fail for the expected reason, then write the minimal implementation, run it and SEE it pass. Never write implementation before a failing test.
- **Commit per task:** one commit at the end of each task. Lowercase conventional-commit subject (e.g. `feat(adapters): huimeng async media adapter`). **Every commit body line MUST be < 100 chars** (commitlint `body-max-line-length`). End every commit body with the trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
  Do NOT `git commit` until a task's tests are green. Do NOT push unless asked.
- **Strict types:** no `any`. Parse `unknown` upstream JSON with the existing helpers in `packages/adapters/src/internal/json.ts` (`asRecord`, `asString`, `asNumber`, `asArray`). Interfaces are `PascalCase`, no `I`-prefix.
- **Money:** `bigint` µcredits everywhere. The HuiMeng `cost` field is NOT money in our system — see Task 1's `extractUsage` (maps to `{ tasks: 1 }`; OUR pricebook prices the job). See **Open Questions**.
- **Secrets:** API keys, proxy URLs (may contain credentials), and HMAC secrets are NEVER logged or returned to clients. Resolved values flow only into `AdapterContext`.
- **Boundaries (§14.5):** adapters may import `contracts`/`domain`/`infra` (NOT `db`/`engine`). Adapters MUST NOT import the storage provider — persistence runs in `engine`/worker where a `StorageProvider` is injected. `infra` may import only `contracts`. Verify with `pnpm lint`.
- **Migrations:** generated by drizzle-kit from `packages/db/src/schema/*`. The latest committed migration is `0004_smart_talon.sql`; the next is `0005`. Generate with `pnpm --filter @actionow/db db:generate` (the package script is `db:generate` → `drizzle-kit generate`; writes `packages/db/drizzle/0005_*.sql` + updates `drizzle/meta`). Integration tests apply migrations from scratch via `migrate(db, { migrationsFolder: ... })`.
- **Live secrets at runtime:** `SecretResolver`/`resolveSecretFromEnv` read `SECRET_<REF>` (then `<REF>`) from `process.env`, where `<REF>` is uppercased with non-alphanumerics → `_`. The live e2e loads `.env` via `node --env-file=.env` (or vitest `env`).

---

## Task 1 — `huimeng` async-media adapter (image + video)

A pure `ProviderAdapter` (`providerType: 'huimeng'`) over `ctx.http`: `submit` POSTs `/api/v1/tasks`, `poll` GETs `/api/v1/tasks/{id}`, `parseCallback` verifies the HMAC webhook, `extractUsage` maps to `{ tasks: 1 }`, `mapError` to a `UnifiedError`. Model the state mapping on `async-media-mock.ts` and the real-HTTP shape on `dify-workflow.ts`. Confirmed facts: base `https://api.huimengi.com`; image `seedream-4.5` (`params.prompt`[, `size`]), video `seedance-2.0` (`params: { prompt, duration, ratio }`); result URLs expire in 24h; webhook headers `X-HuiMeng-Signature` = HMAC-SHA256(secret, `"{timestamp}.{rawBody}"`) hex, `X-HuiMeng-Timestamp` (unix s), `X-HuiMeng-Event`.

**Files:**

- create `packages/adapters/src/huimeng.ts`
- create `packages/adapters/test/huimeng.test.ts`
- modify `packages/adapters/src/index.ts` (barrel export)

Steps:

- [ ] Write the failing test `packages/adapters/test/huimeng.test.ts`. Use the `fakeHttp` capture pattern from `dify-workflow.test.ts` and the modality shape from `async-media-mock.test.ts`:

```ts
import type { HttpClient, HttpRequest, SubmitInput } from '@actionow/contracts';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { huimengAdapter } from '../src/huimeng.js';
import { AdapterError } from '../src/errors.js';

const fakeHttp = (
  resp: { status: number; body: unknown },
  capture?: (req: HttpRequest) => void,
): HttpClient => ({
  request: (req: HttpRequest) => {
    capture?.(req);
    return Promise.resolve({
      status: resp.status,
      ok: resp.status < 400,
      body: resp.body,
      text: JSON.stringify(resp.body),
    });
  },
});

const input = (
  http: HttpClient,
  modality: string,
  inputs: Record<string, unknown>,
  model: string,
): SubmitInput => ({
  resourceId: `model:huimeng/${modality}`,
  modality,
  inputs,
  execMode: 'async-poll',
  ctx: {
    providerType: 'huimeng',
    model,
    endpoint: 'https://api.huimengi.com',
    apiKey: 'hm-test',
    http,
  },
});

describe('huimeng adapter', () => {
  it('exposes the huimeng provider type', () => {
    expect(huimengAdapter.providerType).toBe('huimeng');
  });

  it('submits an image task: POST /api/v1/tasks with model + params.prompt', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp(
      { status: 200, body: { task_id: 'task-uuid-1', status: 'pending' } },
      (r) => {
        seen = r;
      },
    );
    const r = await huimengAdapter.submit(
      input(http, 'image', { prompt: 'a cat', size: '1024x1024' }, 'seedream-4.5'),
    );
    expect(seen?.method).toBe('POST');
    expect(seen?.url).toBe('https://api.huimengi.com/api/v1/tasks');
    expect(seen?.headers?.Authorization).toBe('Bearer hm-test');
    expect(seen?.body).toEqual({
      model: 'seedream-4.5',
      params: { prompt: 'a cat', size: '1024x1024' },
    });
    expect(r.kind).toBe('async');
    if (r.kind === 'async') {
      expect(r.provider).toBe('huimeng');
      expect(r.upstreamJobId).toBe('task-uuid-1');
    }
  });

  it('submits a video task: params carries prompt, duration, ratio', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: { task_id: 'task-v', status: 'pending' } }, (r) => {
      seen = r;
    });
    await huimengAdapter.submit(
      input(http, 'video', { prompt: 'a dog runs', duration: 5, ratio: '16:9' }, 'seedance-2.0'),
    );
    expect(seen?.body).toEqual({
      model: 'seedance-2.0',
      params: { prompt: 'a dog runs', duration: 5, ratio: '16:9' },
    });
  });

  it('forwards webhook_url + idempotency_key when present on inputs', async () => {
    let seen: HttpRequest | undefined;
    const http = fakeHttp({ status: 200, body: { task_id: 't2', status: 'pending' } }, (r) => {
      seen = r;
    });
    await huimengAdapter.submit({
      ...input(http, 'image', { prompt: 'x' }, 'seedream-4.5'),
      inputs: { prompt: 'x', webhook_url: 'https://cb.test/hm', idempotency_key: 'idem-1' },
    });
    const body = seen?.body as Record<string, unknown>;
    expect(body.webhook_url).toBe('https://cb.test/hm');
    expect(body.idempotency_key).toBe('idem-1');
    expect(body.params).toEqual({ prompt: 'x' });
  });

  it('throws invalid_input when no prompt is supplied', async () => {
    const http = fakeHttp({ status: 200, body: {} });
    await expect(
      huimengAdapter.submit(input(http, 'image', {}, 'seedream-4.5')),
    ).rejects.toMatchObject({ unified: { code: 'invalid_input', retryable: false } });
  });

  it('maps a 401 submit to unauthorized', async () => {
    const http = fakeHttp({ status: 401, body: { error_message: 'bad key' } });
    await expect(
      huimengAdapter.submit(input(http, 'image', { prompt: 'x' }, 'seedream-4.5')),
    ).rejects.toMatchObject({
      unified: { code: 'unauthorized', retryable: false, upstream: { provider: 'huimeng' } },
    });
  });

  it('polls pending/processing as running, no output', async () => {
    const ctx = input(
      fakeHttp({ status: 200, body: { id: 't', model: 'seedream-4.5', status: 'processing' } }),
      'image',
      { prompt: 'x' },
      'seedream-4.5',
    ).ctx;
    const r = await huimengAdapter.poll?.('t', ctx);
    expect(r?.status).toBe('running');
    expect(r?.output).toBeUndefined();
  });

  it('polls completed image as succeeded with image_url(s) output + tasks:1 usage', async () => {
    const ctx = input(
      fakeHttp({
        status: 200,
        body: {
          id: 't',
          model: 'seedream-4.5',
          status: 'completed',
          result: {
            image_url: 'https://cdn.huimengi.com/a.png',
            image_urls: ['https://cdn.huimengi.com/a.png'],
            image_count: 1,
            size: '1024x1024',
          },
          cost: 0.25,
        },
      }),
      'image',
      { prompt: 'x' },
      'seedream-4.5',
    ).ctx;
    const r = await huimengAdapter.poll?.('t', ctx);
    expect(r?.status).toBe('succeeded');
    expect(r?.output).toMatchObject({
      image_url: 'https://cdn.huimengi.com/a.png',
      image_urls: ['https://cdn.huimengi.com/a.png'],
    });
    expect(r?.usage).toEqual({ tasks: 1 });
  });

  it('polls completed video as succeeded with video_url output', async () => {
    const ctx = input(
      fakeHttp({
        status: 200,
        body: {
          id: 't',
          model: 'seedance-2.0',
          status: 'completed',
          result: {
            video_url: 'https://cdn.huimengi.com/v.mp4',
            duration: 5,
            resolution: '720p',
            ratio: '16:9',
          },
          cost: 1,
        },
      }),
      'video',
      { prompt: 'x' },
      'seedance-2.0',
    ).ctx;
    const r = await huimengAdapter.poll?.('t', ctx);
    expect(r?.status).toBe('succeeded');
    expect(r?.output).toMatchObject({ video_url: 'https://cdn.huimengi.com/v.mp4' });
  });

  it('polls failed as failed with a job_failed error carrying error_message', async () => {
    const ctx = input(
      fakeHttp({
        status: 200,
        body: { id: 't', model: 'seedream-4.5', status: 'failed', error_message: 'nsfw blocked' },
      }),
      'image',
      { prompt: 'x' },
      'seedream-4.5',
    ).ctx;
    const r = await huimengAdapter.poll?.('t', ctx);
    expect(r?.status).toBe('failed');
    expect(r?.error?.code).toBe('job_failed');
    expect(r?.error?.message).toContain('nsfw blocked');
  });

  it('parseCallback verifies a valid HMAC signature and returns the mapped result', () => {
    const secret = 'hm-webhook-secret';
    const ts = '1750000000';
    const rawBody = JSON.stringify({
      event: 'task.completed',
      task_id: 'task-uuid-1',
      data: {
        status: 'completed',
        result: { image_url: 'https://cdn.huimengi.com/a.png' },
        cost: 0.25,
        created_at: '2026-06-16T00:00:00Z',
        completed_at: '2026-06-16T00:01:00Z',
      },
    });
    const sig = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
    const cb = huimengAdapter.parseCallback?.({
      rawBody,
      headers: {
        'x-huimeng-signature': sig,
        'x-huimeng-timestamp': ts,
        'x-huimeng-event': 'task.completed',
      },
      secret,
      nowMs: Number(ts) * 1000,
    });
    expect(cb).toMatchObject({ upstreamJobId: 'task-uuid-1', status: 'succeeded' });
    expect(cb?.output).toMatchObject({ image_url: 'https://cdn.huimengi.com/a.png' });
    expect(cb?.usage).toEqual({ tasks: 1 });
  });

  it('parseCallback returns an empty upstreamJobId for a bad signature', () => {
    const cb = huimengAdapter.parseCallback?.({
      rawBody: '{"task_id":"x"}',
      headers: { 'x-huimeng-signature': 'deadbeef', 'x-huimeng-timestamp': '1750000000' },
      secret: 'hm-webhook-secret',
      nowMs: 1750000000 * 1000,
    });
    expect(cb?.upstreamJobId).toBe('');
  });

  it('parseCallback rejects a stale timestamp outside the replay window', () => {
    const secret = 'hm-webhook-secret';
    const ts = '1000000000';
    const rawBody = '{"event":"task.completed","task_id":"x","data":{"status":"completed"}}';
    const sig = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
    const cb = huimengAdapter.parseCallback?.({
      rawBody,
      headers: { 'x-huimeng-signature': sig, 'x-huimeng-timestamp': ts },
      secret,
      nowMs: 1750000000 * 1000, // ~24 years later → outside the 5-min window
    });
    expect(cb?.upstreamJobId).toBe('');
  });

  it('extractUsage maps a completed task to a single-task vector', () => {
    expect(huimengAdapter.extractUsage({ status: 'completed', cost: 0.25 })).toEqual({ tasks: 1 });
  });
});
```

- [ ] Run it, expect FAIL: `pnpm --filter @actionow/adapters test huimeng` → fails with `Cannot find module '../src/huimeng.js'` / `huimengAdapter is not exported`.

- [ ] Implement `packages/adapters/src/huimeng.ts` (minimal, pure, no `db`/`engine`/storage imports):

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

import type {
  CallbackResult,
  PollResult,
  SubmitInput,
  SubmitResult,
  UnifiedError,
  UsageVector,
} from '@actionow/contracts';

import { AdapterError, httpStatusToUnified } from './errors.js';
import { asNumber, asRecord, asString } from './internal/json.js';
import type { ProviderAdapter } from './types.js';

const PROVIDER = 'huimeng';
const DEFAULT_ENDPOINT = 'https://api.huimengi.com';
/** Replay window for webhook timestamps (ms). */
const TIMESTAMP_WINDOW_MS = 5 * 60_000;

/** The verified-callback envelope the engine hands to {@link parseCallback}. */
export interface HuimengCallbackEnvelope {
  /** The exact raw request bytes the HMAC was computed over. */
  rawBody: string;
  headers: Record<string, string | undefined>;
  /** The channel signing secret (resolved by the engine; never logged). */
  secret: string;
  /** Injected clock (unix ms) for the replay-window check. */
  nowMs: number;
}

/** Build `params` for the task from the unified inputs, per modality/model. */
function buildParams(modality: string, inputs: Record<string, unknown>): Record<string, unknown> {
  const prompt = asString(inputs.prompt) ?? asString(inputs.input);
  if (prompt === undefined) {
    throw new AdapterError({
      code: 'invalid_input',
      message: 'huimeng inputs require a "prompt" string',
      upstream: { provider: PROVIDER },
      retryable: false,
    });
  }
  const params: Record<string, unknown> = { prompt };
  if (modality === 'video') {
    const duration = asNumber(inputs.duration);
    if (duration !== undefined) params.duration = duration;
    const ratio = asString(inputs.ratio);
    if (ratio !== undefined) params.ratio = ratio;
  } else {
    const size = asString(inputs.size);
    if (size !== undefined) params.size = size;
  }
  return params;
}

/** Map a completed `result` block to the unified output (media URLs preserved). */
function resultOutput(result: Record<string, unknown> | undefined): Record<string, unknown> {
  if (result === undefined) return {};
  const out: Record<string, unknown> = {};
  for (const key of [
    'image_url',
    'image_urls',
    'image_count',
    'size',
    'video_url',
    'duration',
    'resolution',
    'ratio',
  ]) {
    if (result[key] !== undefined) out[key] = result[key];
  }
  return out;
}

/** Read a header case-insensitively (lower-cased lookup). */
function header(headers: Record<string, string | undefined>, key: string): string | undefined {
  return headers[key] ?? headers[key.toLowerCase()];
}

export const huimengAdapter: ProviderAdapter = {
  providerType: PROVIDER,

  async submit(input: SubmitInput): Promise<SubmitResult> {
    const { ctx, inputs, modality } = input;
    const endpoint = ctx.endpoint ?? DEFAULT_ENDPOINT;
    const params = buildParams(modality, inputs);

    const body: Record<string, unknown> = { model: ctx.model, params };
    const webhookUrl = asString(inputs.webhook_url);
    if (webhookUrl !== undefined) body.webhook_url = webhookUrl;
    const idemKey = asString(inputs.idempotency_key);
    if (idemKey !== undefined) body.idempotency_key = idemKey;

    const res = await ctx.http.request({
      method: 'POST',
      url: `${endpoint}/api/v1/tasks`,
      headers: { Authorization: `Bearer ${ctx.apiKey ?? ''}` },
      body,
    });
    if (!res.ok) {
      throw new AdapterError(httpStatusToUnified(PROVIDER, res.status));
    }
    const taskId = asString(asRecord(res.body)?.task_id);
    if (taskId === undefined) {
      throw new AdapterError({
        code: 'upstream_error',
        message: 'huimeng submit did not return a task_id',
        upstream: { provider: PROVIDER },
        retryable: false,
      });
    }
    return { kind: 'async', provider: PROVIDER, upstreamJobId: taskId, meta: { modality } };
  },

  async poll(upstreamJobId, ctx): Promise<PollResult> {
    const endpoint = ctx.endpoint ?? DEFAULT_ENDPOINT;
    const res = await ctx.http.request({
      method: 'GET',
      url: `${endpoint}/api/v1/tasks/${upstreamJobId}`,
      headers: { Authorization: `Bearer ${ctx.apiKey ?? ''}` },
    });
    if (!res.ok) {
      return { status: 'failed', error: httpStatusToUnified(PROVIDER, res.status) };
    }
    const data = asRecord(res.body);
    const status = asString(data?.status);
    if (status === 'completed') {
      return {
        status: 'succeeded',
        output: resultOutput(asRecord(data?.result)),
        usage: { tasks: 1 },
      };
    }
    if (status === 'failed') {
      return {
        status: 'failed',
        error: {
          code: 'job_failed',
          message: asString(data?.error_message) ?? 'huimeng task failed',
          upstream: { provider: PROVIDER },
          retryable: false,
        },
      };
    }
    // pending | processing | unknown → still running.
    return { status: 'running' };
  },

  parseCallback(payload: unknown): CallbackResult {
    const env = payload as Partial<HuimengCallbackEnvelope>;
    const empty: CallbackResult = { upstreamJobId: '', status: 'failed' };
    if (
      typeof env.rawBody !== 'string' ||
      env.headers === undefined ||
      typeof env.secret !== 'string'
    ) {
      return empty;
    }
    const ts = header(env.headers, 'x-huimeng-timestamp');
    const sig = header(env.headers, 'x-huimeng-signature');
    if (ts === undefined || sig === undefined) return empty;
    const tsMs = Number(ts) * 1000;
    if (!Number.isFinite(tsMs) || Math.abs((env.nowMs ?? 0) - tsMs) > TIMESTAMP_WINDOW_MS) {
      return empty;
    }
    const expected = createHmac('sha256', env.secret).update(`${ts}.${env.rawBody}`).digest('hex');
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return empty;

    const parsed = asRecord(JSON.parse(env.rawBody));
    const taskId = asString(parsed?.task_id);
    const data = asRecord(parsed?.data);
    if (taskId === undefined || data === undefined) return empty;
    const status = asString(data.status);
    if (status === 'completed') {
      return {
        upstreamJobId: taskId,
        status: 'succeeded',
        output: resultOutput(asRecord(data.result)),
        usage: { tasks: 1 },
      };
    }
    return {
      upstreamJobId: taskId,
      status: 'failed',
      error: {
        code: 'job_failed',
        message: asString(data.error_message) ?? 'huimeng task failed',
        upstream: { provider: PROVIDER },
        retryable: false,
      },
    };
  },

  extractUsage(raw: unknown): UsageVector {
    const status = asString(asRecord(raw)?.status);
    return status === 'completed' ? { tasks: 1 } : {};
  },

  mapError(raw: unknown): UnifiedError {
    return {
      code: 'job_failed',
      message: asString(asRecord(raw)?.error_message) ?? 'huimeng task failed',
      upstream: { provider: PROVIDER },
      retryable: false,
    };
  },
};
```

- [ ] Add the barrel export — edit `packages/adapters/src/index.ts`, inserting (kept alphabetical with simple-import-sort): `export * from './huimeng.js';` after the `gemini` line.

- [ ] Run it, expect PASS: `pnpm --filter @actionow/adapters test huimeng`. Then `pnpm --filter @actionow/adapters lint` (no `any`, sorted imports).

- [ ] Commit: `feat(adapters): huimeng async media adapter (image+video)`

---

## Task 2 — register `huimeng` in `createDefaultRegistry`

**Files:**

- modify `packages/adapters/src/default-registry.ts`
- modify `packages/adapters/test/default-registry.test.ts`

Steps:

- [ ] Edit the failing test `packages/adapters/test/default-registry.test.ts` — add `'huimeng'` to the `ALL_PROVIDER_TYPES` tuple:

```ts
const ALL_PROVIDER_TYPES = [
  'openai',
  'anthropic',
  'gemini',
  'huimeng',
  'async-media-mock',
  'dify-workflow',
  'mock-stream',
] as const;
```

Also change the first test's title assertion to count seven:

```ts
  it('resolves all seven built-in provider_types', () => {
```

- [ ] Run it, expect FAIL: `pnpm --filter @actionow/adapters test default-registry` → `registry.has('huimeng')` is `false` / `registry.get('huimeng')` throws "no adapter for provider_type huimeng".

- [ ] Implement: edit `packages/adapters/src/default-registry.ts`. Add the import `import { huimengAdapter } from './huimeng.js';` (alphabetical, after the `geminiAdapter` import) and `registry.register(huimengAdapter);` after `registry.register(geminiAdapter);`. Update the JSDoc list of built-ins to include `huimeng`.

- [ ] Run it, expect PASS: `pnpm --filter @actionow/adapters test default-registry`.

- [ ] Commit: `feat(adapters): register huimeng in default registry`

---

## Task 3 — `proxyUrl` on `AdapterContext` + `FetchHttpClient` ProxyAgent

Add `proxyUrl?: string` to `AdapterContext`. `FetchHttpClient` constructs an `undici` `ProxyAgent` when `req.proxyUrl` is set and passes it as the fetch `dispatcher`. `undici` is added as an explicit dependency of `@actionow/infra` (currently only transitively present; not resolvable as a bare import). The `HttpRequest` contract gains an optional `proxyUrl`.

**Files:**

- modify `packages/contracts/src/adapter.ts` (add `proxyUrl` to `AdapterContext`)
- modify `packages/contracts/src/http.ts` (add `proxyUrl` to `HttpRequest`)
- modify `packages/infra/package.json` (add `undici` dependency)
- modify `packages/infra/src/http.ts` (ProxyAgent dispatcher)
- modify `packages/infra/test/http.test.ts` (proxy test)

Steps:

- [ ] Add `undici` as a direct dependency of infra so the bare `import { ProxyAgent } from 'undici'` resolves. Run from repo root: `pnpm --filter @actionow/infra add undici`. (Confirms a `"undici": "^x"` line in `packages/infra/package.json` `dependencies` and updates the lockfile. `undici@7.x` is already in the store.)

- [ ] Write the failing test additions in `packages/infra/test/http.test.ts`. Add a new describe block that stubs `fetch` and asserts a `dispatcher` is passed when `proxyUrl` is set, and NOT passed otherwise:

```ts
describe('FetchHttpClient proxy support', () => {
  it('passes an undici dispatcher to fetch when proxyUrl is set', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        stubResponse({ status: 200, contentType: 'application/json', text: '{"ok":true}' }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new FetchHttpClient();
    await client.request({
      method: 'GET',
      url: 'https://x.test/y',
      proxyUrl: 'http://proxy.local:8080',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { dispatcher?: unknown }];
    expect(init.dispatcher).toBeDefined();
  });

  it('does not pass a dispatcher when proxyUrl is absent', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        stubResponse({ status: 200, contentType: 'application/json', text: '{"ok":true}' }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new FetchHttpClient();
    await client.request({ method: 'GET', url: 'https://x.test/y' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { dispatcher?: unknown }];
    expect(init.dispatcher).toBeUndefined();
  });

  it('reuses one ProxyAgent per proxyUrl across requests', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        stubResponse({ status: 200, contentType: 'application/json', text: '{}' }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new FetchHttpClient();
    await client.request({ method: 'GET', url: 'https://x.test/a', proxyUrl: 'http://p:8080' });
    await client.request({ method: 'GET', url: 'https://x.test/b', proxyUrl: 'http://p:8080' });

    const d1 = (fetchMock.mock.calls[0]?.[1] as { dispatcher?: unknown }).dispatcher;
    const d2 = (fetchMock.mock.calls[1]?.[1] as { dispatcher?: unknown }).dispatcher;
    expect(d1).toBe(d2);
  });
});
```

- [ ] Run it, expect FAIL: `pnpm --filter @actionow/infra test http` → `init.dispatcher` is `undefined` in the first proxy test (FetchHttpClient does not yet read `proxyUrl`).

- [ ] Implement the contract changes:
  - In `packages/contracts/src/http.ts`, add to `HttpRequest`: `/** Optional per-request HTTP(S) proxy URL; the FetchHttpClient routes via an undici ProxyAgent. */ proxyUrl?: string;`
  - In `packages/contracts/src/adapter.ts`, add to `AdapterContext` (after `apiKey`): `/** Optional per-channel egress proxy URL (resolved from the channel proxy_ref); never logged. */ proxyUrl?: string;`

- [ ] Implement `packages/infra/src/http.ts`:
  - Add `import { ProxyAgent } from 'undici';` at the top.
  - Add a private agent cache and a `dispatcher` injection in both `request` and `stream`:

```ts
export class FetchHttpClient implements HttpClient {
  /** One ProxyAgent per proxy URL, reused across requests. */
  private readonly proxyAgents = new Map<string, ProxyAgent>();

  /** Resolve (caching) the ProxyAgent for a proxy URL. */
  private agentFor(proxyUrl: string): ProxyAgent {
    let agent = this.proxyAgents.get(proxyUrl);
    if (agent === undefined) {
      agent = new ProxyAgent(proxyUrl);
      this.proxyAgents.set(proxyUrl, agent);
    }
    return agent;
  }
  // ...
}
```

- Change `buildInit` to accept the request and attach the dispatcher. Because `dispatcher` is an undici extension not in the DOM `RequestInit`, type the init as `RequestInit & { dispatcher?: ProxyAgent }`:

```ts
function buildInit(
  req: HttpRequest,
  agent: ProxyAgent | undefined,
  signal?: AbortSignal,
): RequestInit & { dispatcher?: ProxyAgent } {
  const headers: Record<string, string> = { ...req.headers };
  let body: string | undefined;
  if (req.body !== undefined) {
    body = JSON.stringify(req.body);
    if (!('content-type' in headers) && !('Content-Type' in headers)) {
      headers['content-type'] = 'application/json';
    }
  }
  const init: RequestInit & { dispatcher?: ProxyAgent } = { method: req.method, headers };
  if (signal !== undefined) init.signal = signal;
  if (body !== undefined) init.body = body;
  if (agent !== undefined) init.dispatcher = agent;
  return init;
}
```

- In `request`, compute the agent before fetch: `const agent = req.proxyUrl === undefined ? undefined : this.agentFor(req.proxyUrl);` and pass it: `await fetch(req.url, buildInit(req, agent, controller.signal));`
- In `stream`, the same: `const agent = req.proxyUrl === undefined ? undefined : this.agentFor(req.proxyUrl);` then `await fetch(req.url, buildInit(req, agent));`

- [ ] Run it, expect PASS: `pnpm --filter @actionow/infra test http`. Then `pnpm --filter @actionow/infra lint && pnpm --filter @actionow/contracts lint`.

- [ ] Commit: `feat(infra): per-request proxy via undici ProxyAgent dispatcher`

---

## Task 4 — thread `proxyUrl` through adapters' request builders

The `openai`, `anthropic`, `gemini`, `dify-workflow`, and `huimeng` adapters must forward `ctx.proxyUrl` onto every `ctx.http.request`/`ctx.http.stream` call, so a channel proxy actually takes effect. This is the load-bearing wiring: without it `AdapterContext.proxyUrl` is inert.

**Files:**

- modify `packages/adapters/src/openai.ts`
- modify `packages/adapters/src/huimeng.ts`
- modify `packages/adapters/src/anthropic.ts`
- modify `packages/adapters/src/gemini.ts`
- modify `packages/adapters/src/dify-workflow.ts`
- modify `packages/adapters/test/openai.test.ts`
- modify `packages/adapters/test/huimeng.test.ts`

Steps:

- [ ] Write the failing test in `packages/adapters/test/openai.test.ts` — add a test that asserts `proxyUrl` is forwarded. Use the existing test's `fakeHttp` capture pattern (mirror `dify-workflow.test.ts`); add a context with `proxyUrl`:

```ts
it('forwards ctx.proxyUrl onto the http request', async () => {
  let seen: HttpRequest | undefined;
  const http = fakeHttp(
    { status: 200, body: { choices: [{ message: { content: 'hi' } }], usage: {} } },
    (req) => {
      seen = req;
    },
  );
  await openaiAdapter.submit({
    resourceId: 'r',
    modality: 'text',
    inputs: { prompt: 'hi' },
    execMode: 'blocking',
    ctx: {
      providerType: 'openai',
      model: 'gpt',
      endpoint: 'https://api.deepseek.com/v1',
      apiKey: 'k',
      proxyUrl: 'http://proxy.local:8080',
      http,
    },
  });
  expect(seen?.proxyUrl).toBe('http://proxy.local:8080');
});
```

(Confirm `openai.test.ts` already defines a `fakeHttp` capturing helper; if its existing helper does not capture, copy the `fakeHttp` from `dify-workflow.test.ts`.)

- [ ] Write the matching failing test in `packages/adapters/test/huimeng.test.ts`:

```ts
it('forwards ctx.proxyUrl onto the submit request', async () => {
  let seen: HttpRequest | undefined;
  const http = fakeHttp({ status: 200, body: { task_id: 't', status: 'pending' } }, (r) => {
    seen = r;
  });
  await huimengAdapter.submit({
    ...input(http, 'image', { prompt: 'x' }, 'seedream-4.5'),
    ctx: {
      ...input(http, 'image', { prompt: 'x' }, 'seedream-4.5').ctx,
      proxyUrl: 'http://p:8080',
    },
  });
  expect(seen?.proxyUrl).toBe('http://p:8080');
});
```

- [ ] Run both, expect FAIL: `pnpm --filter @actionow/adapters test "openai|huimeng"` → `seen?.proxyUrl` is `undefined`.

- [ ] Implement: in each adapter, where the `ctx.http.request({...})` / `openStream(ctx, ...)` / `ctx.http.stream({...})` object is built, add `...(ctx.proxyUrl !== undefined ? { proxyUrl: ctx.proxyUrl } : {})` to the request object. Concretely:
  - `openai.ts` `submit`: add to the `ctx.http.request({ method, url, headers, body })` object. In `stream`, the request flows through `openStream(ctx, PROVIDER, { method, url, headers, body })` — add `proxyUrl` to that request object too (`openStream` forwards the `HttpRequest` to `ctx.http.stream`; verify by reading `packages/adapters/src/internal/stream.ts` and add `proxyUrl` to the object it passes, or include it in the request literal already passed through).
  - `huimeng.ts` `submit` + `poll`: add `proxyUrl` to both request objects.
  - `anthropic.ts`, `gemini.ts`, `dify-workflow.ts`: add `proxyUrl` to each `ctx.http.request(...)`/stream call object.

  Use a small local helper at the top of each adapter to avoid repetition and keep it `any`-free:

```ts
/** Spread `proxyUrl` into a request when the channel set one. */
function withProxy(ctx: AdapterContext): { proxyUrl?: string } {
  return ctx.proxyUrl === undefined ? {} : { proxyUrl: ctx.proxyUrl };
}
```

Then e.g. `await ctx.http.request({ method: 'POST', url, headers, body, ...withProxy(ctx) });`.

- [ ] Run, expect PASS: `pnpm --filter @actionow/adapters test`. Then `pnpm --filter @actionow/adapters lint`.

- [ ] Commit: `feat(adapters): forward ctx.proxyUrl onto upstream http calls`

---

## Task 5 — `upstream_channel` schema: `endpoint`, `model`, `proxy_ref` (migration 0005)

`RunChannel` and the engine already support `endpoint`/`model`/`proxyUrl`; the DB table does not carry them, and the channel→RunChannel mappers drop them. Add three nullable columns and generate migration `0005`.

**Files:**

- modify `packages/db/src/schema/catalog.ts`
- modify `packages/db/src/repositories/catalog.ts` (`CreateUpstreamChannelInput` + insert)
- create `packages/db/drizzle/0005_*.sql` (generated)
- create `packages/db/test/catalog-channel.int.test.ts`

Steps:

- [ ] Write the failing integration test `packages/db/test/catalog-channel.int.test.ts` (Testcontainers `postgres:16-alpine`, mirror the `beforeAll`/`migrate`/`afterEach` setup of `apps/worker/test/processors.int.test.ts`). It seeds a tenant + resource, creates a channel with `endpoint`/`model`/`proxyRef`, and asserts `listChannels` returns those columns:

```ts
import { createResource, createUpstreamChannel, listChannels, schema } from '@actionow/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const { tenant } = schema;
let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
}, 120_000);
afterAll(async () => {
  await client.end();
  await container.stop();
});
afterEach(async () => {
  await client`TRUNCATE TABLE upstream_channel, resource_version, resource, tenant RESTART IDENTITY CASCADE`;
});

describe('upstream_channel endpoint/model/proxy_ref columns', () => {
  it('persists and reads back endpoint, model, and proxy_ref', async () => {
    const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
    if (!t) throw new Error('no tenant');
    await createResource(db, {
      id: 'deepseek-chat',
      tenantId: t.id,
      kind: 'model',
      modality: 'text',
      providerType: 'openai',
      execModes: ['blocking'],
      ioSchema: { inputs: [], outputs: [] },
      version: 1,
    });
    await createUpstreamChannel(db, {
      resourceId: 'deepseek-chat',
      providerType: 'openai',
      endpoint: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      proxyRef: 'upstream_proxy',
      weight: 1,
      status: 'active',
    });
    const [row] = await listChannels(db, 'deepseek-chat');
    expect(row?.endpoint).toBe('https://api.deepseek.com/v1');
    expect(row?.model).toBe('deepseek-chat');
    expect(row?.proxyRef).toBe('upstream_proxy');
  });
});
```

- [ ] Run it, expect FAIL: `pnpm --filter @actionow/db test catalog-channel` → drizzle/typescript error: `endpoint`/`model`/`proxyRef` are not on `CreateUpstreamChannelInput`, and the columns do not exist.

- [ ] Implement the schema columns in `packages/db/src/schema/catalog.ts` — extend the `upstreamChannel` table:

```ts
export const upstreamChannel = pgTable(
  'upstream_channel',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    resourceId: text('resource_id')
      .notNull()
      .references(() => resource.id),
    providerType: text('provider_type').notNull(),
    credentialRef: uuid('credential_ref'),
    /** Per-channel upstream base URL (e.g. https://api.deepseek.com/v1); null → adapter default. */
    endpoint: text('endpoint'),
    /** Per-channel model id (e.g. deepseek-chat, seedream-4.5); null → resource default. */
    model: text('model'),
    /** Locator (a secret_ref-style env key) for this channel's egress proxy URL; null → none. */
    proxyRef: text('proxy_ref'),
    weight: integer('weight').notNull().default(1),
    status: text('status').notNull().default('active'),
  },
  (t) => [index('upstream_resource_idx').on(t.resourceId)],
);
```

Note: `proxy_ref` is a `text` locator (resolved like `credential_ref` via the SecretResolver to a URL) per the recommended Open Question (a). `credential_ref` stays `uuid` (it points at a `secret_ref` row); `proxy_ref` is a plain env-key string to keep proxy URLs out of the DB. See **Open Questions**.

- [ ] Extend `CreateUpstreamChannelInput` + the insert in `packages/db/src/repositories/catalog.ts`:

```ts
export interface CreateUpstreamChannelInput {
  readonly resourceId: string;
  readonly providerType: string;
  readonly credentialRef?: string | null | undefined;
  readonly endpoint?: string | null | undefined;
  readonly model?: string | null | undefined;
  readonly proxyRef?: string | null | undefined;
  readonly weight?: number | undefined;
  readonly status?: string | undefined;
}
```

and in `createUpstreamChannel`'s `.values({...})` add:

```ts
      endpoint: input.endpoint ?? null,
      model: input.model ?? null,
      proxyRef: input.proxyRef ?? null,
```

- [ ] Generate migration `0005`: `pnpm --filter @actionow/db db:generate`. Confirm it writes `packages/db/drizzle/0005_*.sql` containing three `ALTER TABLE "upstream_channel" ADD COLUMN ...` statements and updates `drizzle/meta/_journal.json` + a new snapshot. Inspect the SQL to confirm only the three additive columns are present (no destructive changes).

- [ ] Run it, expect PASS: `pnpm --filter @actionow/db test catalog-channel` (the migration is applied from scratch and the columns round-trip).

- [ ] Commit: `feat(db): upstream_channel endpoint/model/proxy_ref + migration 0005`

---

## Task 6 — resolve `proxy_ref` → `proxyUrl` and thread channel endpoint/model into `AdapterContext` (engine)

The engine's `ExecutionService.buildContext` and `JobRunner.buildContext` already set `ctx.endpoint`/`ctx.model` from `RunChannel`; now add `proxyUrl` resolution. `RunChannel` gains `proxyRef`. A global `UPSTREAM_PROXY_URL` env fallback applies when a channel has no `proxyRef`. The engine resolves `proxyRef` to a URL via the SAME `resolveSecret` function used for credentials (so the env key holds the proxy URL).

**Files:**

- modify `packages/engine/src/execution-service.ts` (`RunChannel` + `buildContext` + a proxy resolver dep)
- modify `packages/engine/src/job-runner.ts` (`buildContext` + proxy resolver dep)
- modify `packages/engine/test/execution-service.int.test.ts` (proxy threading assertion)

Steps:

- [ ] Write the failing test addition in `packages/engine/test/execution-service.int.test.ts`. Add a test that a channel with a `proxyRef` produces an `AdapterContext.proxyUrl` reaching the adapter. Use a tiny capturing fake adapter registered in an `AdapterRegistry`, and a `resolveSecret` that maps the proxy ref to a URL:

```ts
it('threads channel proxyRef → resolved proxyUrl into the adapter context', async () => {
  const seenCtx: { proxyUrl?: string }[] = [];
  const adapters = new AdapterRegistry();
  adapters.register({
    providerType: 'capture',
    submit: (i) => {
      seenCtx.push({ proxyUrl: i.ctx.proxyUrl });
      return Promise.resolve({ kind: 'sync', output: { text: 'ok' }, usage: { tokens: 1 } });
    },
    extractUsage: () => ({}),
    mapError: () => ({ code: 'upstream_error', message: 'x', retryable: false }),
  });
  // resolveSecret maps the proxy ref to a URL and any other ref to a fake key.
  const resolveSecret = (ref: string): Promise<string | undefined> =>
    Promise.resolve(ref === 'upstream_proxy' ? 'http://proxy.local:8080' : 'fake-key');

  const svc = new ExecutionService({
    db,
    adapters,
    resolveSecret,
    http: noHttp,
    now: () => new Date(),
    enqueue: () => Promise.resolve(),
  });
  // ...seed a 'capture' resource + pricebook (reuse the file's existing seed helper,
  // overriding providerType to 'capture'), then run a blocking request with a channel
  // carrying { proxyRef: 'upstream_proxy' }...
  await svc.run(buildRunRequestWithChannel({ proxyRef: 'upstream_proxy' }));
  expect(seenCtx[0]?.proxyUrl).toBe('http://proxy.local:8080');
});
```

(Adapt `buildRunRequestWithChannel` to the file's existing `RunRequest` builder; the load-bearing assertion is `seenCtx[0]?.proxyUrl === 'http://proxy.local:8080'`.)

- [ ] Run it, expect FAIL: `pnpm --filter @actionow/engine test execution-service` → `seenCtx[0]?.proxyUrl` is `undefined` (engine does not resolve `proxyRef` yet, and `RunChannel` has no `proxyRef`).

- [ ] Implement in `packages/engine/src/execution-service.ts`:
  - Add `proxyRef?: string | undefined;` to `RunChannel`.
  - Add an optional dep `proxyUrlEnv?: string | undefined;` to `ExecutionServiceDeps` (the `UPSTREAM_PROXY_URL` global fallback). Document it as "global egress proxy fallback when a channel has no proxyRef".
  - In `buildContext`, after setting `apiKey`, resolve the proxy:

```ts
const proxyUrl = await this.resolveProxy(channel);
if (proxyUrl !== undefined) ctx.proxyUrl = proxyUrl;
```

and add the helper:

```ts
  /** Resolve a channel's egress proxy URL: its proxyRef (via resolveSecret), else the global env fallback. */
  private async resolveProxy(channel: RunChannel): Promise<string | undefined> {
    if (channel.proxyRef !== undefined) {
      const url = await this.deps.resolveSecret(channel.proxyRef);
      if (url !== undefined) return url;
    }
    return this.deps.proxyUrlEnv;
  }
```

- [ ] Implement the same in `packages/engine/src/job-runner.ts`:
  - Add `proxyUrlEnv?: string | undefined;` to `JobRunnerDeps`.
  - In `buildContext`, after the credential block, resolve `channel.proxyRef` (and fall back to `this.deps.proxyUrlEnv`) and set `ctx.proxyUrl` when defined. (Guard the `channel === undefined` early-return as today; the proxy resolution only runs when a channel exists, plus the env fallback applies even with no channel — set `ctx.proxyUrl = this.deps.proxyUrlEnv` when defined before the early return.)

- [ ] Run it, expect PASS: `pnpm --filter @actionow/engine test execution-service`. Then `pnpm --filter @actionow/engine lint`.

- [ ] Commit: `feat(engine): resolve channel proxy_ref into AdapterContext.proxyUrl`

---

## Task 7 — thread channel `endpoint`/`model`/`proxyRef` from rows into `RunChannel` (api + worker + callbacks)

The three channel→`RunChannel` mappers (`apps/api/src/execution/run.service.ts::toRunChannel`, `apps/worker/src/loaders.ts`, `apps/api/src/callbacks/callbacks.service.ts::loadContext`) currently only copy `id`/`weight`/`credentialRef`. Copy the new columns so the engine actually sees per-channel endpoint/model/proxy. Also pass the `UPSTREAM_PROXY_URL` env fallback into the engine constructions.

**Files:**

- modify `packages/infra/src/config.ts` (add `UPSTREAM_PROXY_URL` to the env schema)
- modify `apps/api/src/execution/run.service.ts`
- modify `apps/worker/src/loaders.ts`
- modify `apps/api/src/callbacks/callbacks.service.ts`
- modify `apps/worker/test/processors.int.test.ts` (assert endpoint/model reach the adapter on the async path)

Steps:

- [ ] Add `UPSTREAM_PROXY_URL` to the env schema in `packages/infra/src/config.ts` (optional, documented "global egress proxy URL fallback for upstream channels with no proxy_ref; never logged"):

```ts
    UPSTREAM_PROXY_URL: z.string().url().optional(),
```

- [ ] Write the failing test in `apps/worker/test/processors.int.test.ts`. Extend the existing `seed()` to set a channel `endpoint`/`model`, register a capturing adapter as the resource's provider, and assert the worker's `loadJobContext` produced channels carrying them. Simplest: a focused new test in this file that inserts an `upstream_channel` row with `endpoint`/`model` set and a capturing adapter, then asserts the captured `AdapterContext.endpoint`/`.model`:

```ts
it('passes channel endpoint + model into the adapter context on the async path', async () => {
  const s = await seed(1_000_000n); // seed() already inserts the resource + a channel
  // overwrite the channel with endpoint + model:
  await client`UPDATE upstream_channel SET endpoint='https://api.deepseek.com/v1', model='deepseek-chat', provider_type='capture' WHERE resource_id=${s.resourceId}`;
  await client`UPDATE resource SET provider_type='capture' WHERE id=${s.resourceId}`;
  const seen: { endpoint?: string; model?: string }[] = [];
  const adapters = new AdapterRegistry();
  adapters.register({
    providerType: 'capture',
    submit: (i) => {
      seen.push({ endpoint: i.ctx.endpoint, model: i.ctx.model });
      return Promise.resolve({ kind: 'async', provider: 'capture', upstreamJobId: 'u1' });
    },
    poll: () =>
      Promise.resolve({ status: 'succeeded', output: { text: 'ok' }, usage: { images: 1 } }),
    extractUsage: () => ({}),
    mapError: () => ({ code: 'upstream_error', message: 'x', retryable: false }),
  });
  const job = await makeQueuedJob(s, 1_000n);
  const process = createJobExecProcessor(runtimeWith(adapters));
  await process({ jobId: job.id });
  expect(seen[0]).toEqual({ endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat' });
});
```

- [ ] Run it, expect FAIL: `pnpm --filter @actionow/worker test processors` → `seen[0]` is `{ endpoint: undefined, model: undefined }` (loaders drop the columns).

- [ ] Implement the mappers. In all three files, change the `channels: channelRows.map((c) => ({ ... }))` / `toRunChannel` to copy the columns:

```ts
    channels: channelRows.map((c) => ({
      id: c.id,
      weight: c.weight,
      credentialRef: c.credentialRef ?? undefined,
      endpoint: c.endpoint ?? undefined,
      model: c.model ?? undefined,
      proxyRef: c.proxyRef ?? undefined,
    })),
```

- `apps/api/src/execution/run.service.ts`: update the standalone `toRunChannel(row)` helper identically (it returns a `RunChannel`).

- [ ] Pass the `UPSTREAM_PROXY_URL` fallback into the engine:
  - `apps/api/src/execution/run.service.ts::buildService` — `ExecutionService` is constructed here. Inject `ENV` (`@Inject(ENV) private readonly env: AppEnv`) and add `proxyUrlEnv: this.env.UPSTREAM_PROXY_URL` to the `new ExecutionService({...})` deps. (Confirm `ENV` is provided in the execution module; if not, add it to the providers — check `apps/api/src/execution/execution.module.ts`.)
  - `apps/worker/src/processors/job-exec.processor.ts` — `JobRunner` is constructed here over `runtime`. Add `proxyUrlEnv: runtime.env.UPSTREAM_PROXY_URL` to the `new JobRunner({...})` deps.
  - `apps/api/src/callbacks/callbacks.service.ts::buildRunner` — add `proxyUrlEnv: this.env.UPSTREAM_PROXY_URL` (inject `ENV` into `CallbacksService` similarly; confirm the callbacks module provides `ENV`).

- [ ] Run it, expect PASS: `pnpm --filter @actionow/worker test processors`. Then `pnpm --filter @actionow/api lint && pnpm --filter @actionow/worker lint && pnpm --filter @actionow/infra lint`.

- [ ] Commit: `feat(api,worker): thread channel endpoint/model/proxy into engine context`

---

## Task 8 — R2 media-output persistence hook (engine, pure)

A pure engine function `persistMediaOutput` that, given a `StorageProvider`, an HTTP "fetch bytes" function, a tenant id, a job id, and a media output, downloads the upstream media URL(s), uploads them to R2 under `{tenantId}/{jobId}.{ext}`, and returns a rewritten output where the temp URL is replaced by the public `publicBaseUrl` URL — plus the object keys it wrote (so the caller can create `file_object` rows). Best-effort: on a fetch/upload failure it returns the ORIGINAL output unchanged and a `persisted: false` flag (the job still settles with the temp URL). Adapters are NOT touched (boundary-safe): this lives in `packages/engine` which may import `contracts` (the `StorageProvider` interface) but NOT `infra`'s S3 impl — the concrete provider is injected.

**Files:**

- create `packages/engine/src/media-persistence.ts`
- create `packages/engine/test/media-persistence.test.ts`
- modify `packages/engine/src/index.ts` (export) — confirm the barrel path first

Steps:

- [ ] Write the failing unit test `packages/engine/test/media-persistence.test.ts` (no network, no real S3 — a fake `StorageProvider` + a fake byte-fetcher):

```ts
import type { StorageProvider } from '@actionow/contracts';
import { describe, expect, it, vi } from 'vitest';

import { persistMediaOutput } from '../src/media-persistence.js';

const PUBLIC_BASE = 'https://asset.actionow.ai';

function fakeStorage(): StorageProvider & { puts: { key: string; contentType?: string }[] } {
  const puts: { key: string; contentType?: string }[] = [];
  return {
    kind: 'r2',
    puts,
    presignPut: (key, opts) => {
      puts.push({ key, contentType: opts?.contentType });
      return Promise.resolve({ url: `https://r2.local/put/${key}`, key, expiresIn: 900 });
    },
    presignGet: (key) => Promise.resolve({ url: `https://r2.local/get/${key}`, expiresIn: 3600 }),
    head: () => Promise.resolve({ exists: true, size: 3, contentType: 'image/png', etag: 'e' }),
    delete: () => Promise.resolve(),
  };
}

describe('persistMediaOutput', () => {
  it('copies an image_url into R2 and rewrites it to the public URL', async () => {
    const storage = fakeStorage();
    // putBytes uploads bytes to a presigned URL; here it just succeeds.
    const putBytes = vi.fn().mockResolvedValue(undefined);
    const fetchBytes = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
    });

    const r = await persistMediaOutput({
      storage,
      publicBaseUrl: PUBLIC_BASE,
      fetchBytes,
      putBytes,
      tenantId: 'tenant-1',
      jobId: 'job-1',
      output: {
        image_url: 'https://cdn.huimengi.com/a.png',
        image_urls: ['https://cdn.huimengi.com/a.png'],
      },
    });

    expect(r.persisted).toBe(true);
    expect(r.output.image_url).toBe('https://asset.actionow.ai/tenant-1/job-1.png');
    expect(r.output.image_urls).toEqual(['https://asset.actionow.ai/tenant-1/job-1.png']);
    expect(r.objects).toHaveLength(1);
    expect(r.objects[0]).toMatchObject({ key: 'tenant-1/job-1.png', contentType: 'image/png' });
    expect(putBytes).toHaveBeenCalledTimes(1);
  });

  it('derives the extension from a video_url and rewrites it', async () => {
    const storage = fakeStorage();
    const r = await persistMediaOutput({
      storage,
      publicBaseUrl: PUBLIC_BASE,
      fetchBytes: () => Promise.resolve({ bytes: new Uint8Array([0]), contentType: 'video/mp4' }),
      putBytes: () => Promise.resolve(),
      tenantId: 't',
      jobId: 'j',
      output: { video_url: 'https://cdn.huimengi.com/v.mp4?token=abc' },
    });
    expect(r.output.video_url).toBe('https://asset.actionow.ai/t/j.mp4');
  });

  it('is a best-effort no-op when fetching the bytes fails (job still settles)', async () => {
    const storage = fakeStorage();
    const r = await persistMediaOutput({
      storage,
      publicBaseUrl: PUBLIC_BASE,
      fetchBytes: () => Promise.reject(new Error('cdn 404')),
      putBytes: () => Promise.resolve(),
      tenantId: 't',
      jobId: 'j',
      output: { image_url: 'https://cdn.huimengi.com/a.png' },
    });
    expect(r.persisted).toBe(false);
    expect(r.output.image_url).toBe('https://cdn.huimengi.com/a.png');
    expect(r.objects).toEqual([]);
  });

  it('passes through an output with no media URLs unchanged', async () => {
    const storage = fakeStorage();
    const r = await persistMediaOutput({
      storage,
      publicBaseUrl: PUBLIC_BASE,
      fetchBytes: () => Promise.reject(new Error('should not be called')),
      putBytes: () => Promise.resolve(),
      tenantId: 't',
      jobId: 'j',
      output: { text: 'hello' },
    });
    expect(r.persisted).toBe(false);
    expect(r.output).toEqual({ text: 'hello' });
    expect(r.objects).toEqual([]);
  });
});
```

- [ ] Run it, expect FAIL: `pnpm --filter @actionow/engine test media-persistence` → `Cannot find module '../src/media-persistence.js'`.

- [ ] Implement `packages/engine/src/media-persistence.ts`:

```ts
import type { StorageProvider } from '@actionow/contracts';

/** The bytes + content type fetched from an upstream media URL. */
export interface FetchedBytes {
  bytes: Uint8Array;
  contentType?: string;
}

/** Upload bytes to a presigned PUT URL (injected so the engine stays infra-free). */
export type PutBytes = (url: string, bytes: Uint8Array, contentType?: string) => Promise<void>;
/** Download an upstream media URL's bytes (injected). */
export type FetchBytes = (url: string) => Promise<FetchedBytes>;

/** A persisted R2 object the caller turns into a `file_object` row. */
export interface PersistedObject {
  key: string;
  contentType?: string;
  size?: number;
}

export interface PersistMediaInput {
  storage: StorageProvider;
  /** The R2 public custom-domain base (e.g. https://asset.actionow.ai). */
  publicBaseUrl: string;
  fetchBytes: FetchBytes;
  putBytes: PutBytes;
  tenantId: string;
  jobId: string;
  output: Record<string, unknown>;
}

export interface PersistMediaResult {
  /** True iff at least one media URL was copied into R2 and rewritten. */
  persisted: boolean;
  /** The (possibly rewritten) output; identical to input.output when not persisted. */
  output: Record<string, unknown>;
  objects: PersistedObject[];
}

/** The output keys that may carry an upstream media URL (single value). */
const SINGLE_URL_KEYS = ['image_url', 'video_url'] as const;
/** The output keys that carry an array of media URLs. */
const ARRAY_URL_KEYS = ['image_urls'] as const;

/** Default extension per content-type when a URL has no usable suffix. */
const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
};

/** Best-effort: derive a file extension from a URL path, then content-type, else 'bin'. */
function extOf(url: string, contentType?: string): string {
  try {
    const path = new URL(url).pathname;
    const dot = path.lastIndexOf('.');
    if (dot > 0 && dot < path.length - 1) {
      const ext = path.slice(dot + 1).toLowerCase();
      if (/^[a-z0-9]{1,5}$/.test(ext)) return ext;
    }
  } catch {
    // fall through to content-type
  }
  if (contentType !== undefined && EXT_BY_CONTENT_TYPE[contentType] !== undefined) {
    return EXT_BY_CONTENT_TYPE[contentType];
  }
  return 'bin';
}

/**
 * Copy any media URL(s) in `output` into R2 under `{tenantId}/{jobId}.{ext}` and
 * rewrite them to the stable `{publicBaseUrl}/{key}` URL. ALL media URLs that share
 * one modality point at the SAME object (image_url == image_urls[0]), so a single
 * download+upload is reused. Best-effort: any error leaves `output` untouched and
 * reports `persisted: false` so the job still settles with the temp URL.
 */
export async function persistMediaOutput(input: PersistMediaInput): Promise<PersistMediaResult> {
  const { output } = input;
  // Find the first present media URL (single keys take priority, else array[0]).
  const sourceUrl = firstMediaUrl(output);
  if (sourceUrl === undefined) {
    return { persisted: false, output, objects: [] };
  }

  try {
    const fetched = await input.fetchBytes(sourceUrl);
    const ext = extOf(sourceUrl, fetched.contentType);
    const key = `${input.tenantId}/${input.jobId}.${ext}`;
    const presign = await input.storage.presignPut(key, { contentType: fetched.contentType });
    await input.putBytes(presign.url, fetched.bytes, fetched.contentType);

    const publicUrl = `${input.publicBaseUrl}/${key}`;
    const rewritten: Record<string, unknown> = { ...output };
    for (const k of SINGLE_URL_KEYS) {
      if (typeof rewritten[k] === 'string') rewritten[k] = publicUrl;
    }
    for (const k of ARRAY_URL_KEYS) {
      if (Array.isArray(rewritten[k]))
        rewritten[k] = (rewritten[k] as unknown[]).map(() => publicUrl);
    }
    return {
      persisted: true,
      output: rewritten,
      objects: [{ key, contentType: fetched.contentType, size: fetched.bytes.byteLength }],
    };
  } catch {
    // Best-effort: settle with the temp URL rather than failing the job.
    return { persisted: false, output, objects: [] };
  }
}

/** The first present media URL in an output, or undefined. */
function firstMediaUrl(output: Record<string, unknown>): string | undefined {
  for (const k of SINGLE_URL_KEYS) {
    const v = output[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  for (const k of ARRAY_URL_KEYS) {
    const arr = output[k];
    if (Array.isArray(arr) && typeof arr[0] === 'string') return arr[0];
  }
  return undefined;
}
```

- [ ] Export it: confirm the engine barrel path with `cat packages/engine/src/index.ts`, then add `export * from './media-persistence.js';` (sorted).

- [ ] Run it, expect PASS: `pnpm --filter @actionow/engine test media-persistence`. Then `pnpm --filter @actionow/engine lint`.

- [ ] Commit: `feat(engine): R2 media-output persistence hook (pure, injected storage)`

---

## Task 9 — wire persistence into `JobRunner.settle` (optional dependency)

`JobRunner` gains an optional `persistMedia?: (input) => Promise<PersistMediaResult>` style dependency (a closure the api/worker builds over the injected `StorageProvider` + http). When present and the settle output carries media URLs, `settle` calls it BEFORE `settleJob`, settling with the rewritten output. Absent (default, all existing tests + non-media providers) → unchanged behavior.

**Files:**

- modify `packages/engine/src/job-runner.ts`
- modify `packages/engine/test/job-runner.int.test.ts` (assert rewritten output is persisted)

Steps:

- [ ] Write the failing test addition in `packages/engine/test/job-runner.int.test.ts`. Build a runner whose `persistMedia` closure rewrites `image_url` to a public URL and assert the settled job's `output.image_url` is the rewritten URL:

```ts
it('rewrites media output via persistMedia before settling', async () => {
  const s = await seed(1_000_000n);
  const job = await makeQueuedJob(s, 1_000n);
  const adapters = new AdapterRegistry();
  adapters.register(createAsyncMediaMock({ readyAfterPolls: 0 }));
  const runner = new JobRunner({
    db,
    adapters,
    loadContext: () => Promise.resolve(contextFor(s)),
    resolveSecret: () => Promise.resolve(undefined),
    http: { request: () => Promise.reject(new Error('no http')) },
    maxPolls: 5,
    pollIntervalMs: 0,
    sleep: () => Promise.resolve(),
    persistMedia: ({ output, tenantId, jobId }) =>
      Promise.resolve({
        persisted: true,
        output: { ...output, image_url: `https://asset.actionow.ai/${tenantId}/${jobId}.png` },
        objects: [{ key: `${tenantId}/${jobId}.png`, contentType: 'image/png', size: 3 }],
      }),
  });

  await runner.process(job.id);

  const settled = await getJob(db, job.id);
  expect(settled?.status).toBe('succeeded');
  expect((settled?.output as Record<string, unknown>).image_url).toBe(
    `https://asset.actionow.ai/${s.tenantId}/${job.id}.png`,
  );
});
```

- [ ] Run it, expect FAIL: `pnpm --filter @actionow/engine test job-runner` → typescript error `persistMedia` is not a `JobRunnerDeps` field, and (once typed) the settled `image_url` is still `https://mock.local/...`.

- [ ] Implement in `packages/engine/src/job-runner.ts`:
  - Import the persistence types: `import type { PersistMediaResult } from './media-persistence.js';`
  - Define the injected dependency type and add it to `JobRunnerDeps`:

```ts
/** Persist media outputs to durable storage, returning a rewritten output. Optional; absent → no rewrite. */
export type PersistMediaFn = (input: {
  tenantId: string;
  jobId: string;
  output: Record<string, unknown>;
}) => Promise<PersistMediaResult>;
```

add to `JobRunnerDeps`: `persistMedia?: PersistMediaFn | undefined;`

- In `settle`, before computing cost / calling `settleJob`, rewrite the output:

```ts
let output = result.output ?? {};
if (this.deps.persistMedia !== undefined) {
  const persisted = await this.deps.persistMedia({
    tenantId: job.tenantId,
    jobId: job.id,
    output,
  });
  output = persisted.output;
}
```

and use `output` in place of the previous `const output = result.output ?? {};` for both `computeFinalCost`'s input record (NO — cost uses `job.inputs`, not output; leave `computeFinalCost` as-is) and the `settleJob({ ..., output })` call. Note: cost is computed from `usage` + `job.inputs`, so rewriting `output` does not change pricing — confirm by reading the existing `settle`.

- [ ] Run it, expect PASS: `pnpm --filter @actionow/engine test job-runner`. Then `pnpm --filter @actionow/engine lint`.

- [ ] Commit: `feat(engine): call persistMedia before settling async media jobs`

---

## Task 10 — thread a real `StorageProvider` + `persistMedia` into the worker (and callbacks)

The worker runtime carries no storage today. Add an optional `StorageProvider | null` + an `AppEnv`-derived `publicBaseUrl` to `WorkerRuntime`, build the provider from `STORAGE_*` env (reusing the api's `storageConfigFromEnv` logic — extract it to `@actionow/infra` so both apps share it), and build the `persistMedia` closure in `createJobExecProcessor` over `FetchHttpClient`. Do the same in `apps/api/src/callbacks/callbacks.service.ts` (it already injects `STORAGE` via the FilesModule export).

**Files:**

- modify `packages/infra/src/config.ts` (export a shared `storageConfigFromEnv(env): StorageProviderConfig | null` + `STORAGE_PUBLIC_BASE_URL` env)
- modify `packages/infra/src/index.ts` (export the helper)
- modify `apps/api/src/files/files.module.ts` (use the shared helper)
- modify `apps/worker/src/runtime.ts` (add `storage` + `publicBaseUrl`)
- modify `apps/worker/src/processors/job-exec.processor.ts` (build `persistMedia`)
- modify `apps/worker/test/processors.int.test.ts` (assert media persistence on the async path with a fake storage runtime)
- modify `apps/api/src/callbacks/callbacks.service.ts` (build `persistMedia` from injected `STORAGE`)

Steps:

- [ ] Add `STORAGE_PUBLIC_BASE_URL` to `packages/infra/src/config.ts` env schema (optional URL; documented "public custom-domain base for persisted media, e.g. https://asset.actionow.ai"):

```ts
    STORAGE_PUBLIC_BASE_URL: z.string().url().optional(),
```

- [ ] Extract `storageConfigFromEnv` to `@actionow/infra`. Move the body of `apps/api/src/files/files.module.ts::storageConfigFromEnv` into `packages/infra/src/config.ts` as an exported `export function storageConfigFromEnv(env: AppEnv): StorageProviderConfig | null { ... }` (it only reads `STORAGE_*` env fields — boundary-safe, infra→contracts only). Export it from `packages/infra/src/index.ts`. Update `files.module.ts` to import and use it (delete the local copy).

- [ ] Write the failing test in `apps/worker/test/processors.int.test.ts`. Add a fake `StorageProvider` to `runtimeWith` (extend its signature with an optional `storage`/`publicBaseUrl`), register an async media adapter returning an `image_url`, and assert the settled job's `image_url` is the rewritten public URL:

```ts
it('persists async media output to storage and rewrites the public URL', async () => {
  const s = await seed(1_000_000n);
  await client`UPDATE resource SET modality='image', provider_type='async-media-mock' WHERE id=${s.resourceId}`;
  await client`UPDATE upstream_channel SET provider_type='async-media-mock' WHERE resource_id=${s.resourceId}`;
  const job = await makeQueuedJob(s, 1_000n);
  const adapters = new AdapterRegistry();
  adapters.register(createAsyncMediaMock({ readyAfterPolls: 0 }));

  const puts: string[] = [];
  const storage: StorageProvider = {
    kind: 'r2',
    presignPut: (key) => {
      puts.push(key);
      return Promise.resolve({ url: `https://r2.local/${key}`, key, expiresIn: 900 });
    },
    presignGet: (key) => Promise.resolve({ url: `https://r2.local/${key}`, expiresIn: 3600 }),
    head: () => Promise.resolve({ exists: true }),
    delete: () => Promise.resolve(),
  };
  // fetchBytes/putBytes are stubbed via an http client that returns bytes; for the
  // worker we inject through the runtime — runtimeWith gains storage + publicBaseUrl,
  // and the processor builds persistMedia over a stub http that returns 3 bytes.
  const http: HttpClient = {
    request: () => Promise.resolve({ status: 200, ok: true, body: undefined, text: 'abc' }),
  };
  const rt = runtimeWith(adapters, http);
  rt.storage = storage;
  rt.publicBaseUrl = 'https://asset.actionow.ai';
  const process = createJobExecProcessor(rt);

  await process({ jobId: job.id });

  const settled = await getJob(db, job.id);
  expect(settled?.status).toBe('succeeded');
  expect((settled?.output as Record<string, unknown>).image_url).toContain(
    'https://asset.actionow.ai/',
  );
  expect(puts).toHaveLength(1);
});
```

(Extend the `WorkerRuntime` type used by `runtimeWith` to allow `storage`/`publicBaseUrl`; set them on the returned object. The processor's `persistMedia` builds `fetchBytes`/`putBytes` over the runtime `http` — see implementation.)

- [ ] Run it, expect FAIL: `pnpm --filter @actionow/worker test processors` → typescript error (`storage`/`publicBaseUrl` not on `WorkerRuntime`) and/or `image_url` still `https://mock.local/...`.

- [ ] Implement `apps/worker/src/runtime.ts`:
  - Add to `WorkerRuntime`: `storage: StorageProvider | null;` and `publicBaseUrl: string | undefined;` (import `StorageProvider` from `@actionow/contracts`).
  - In `createWorkerRuntime`, build them: `const cfg = storageConfigFromEnv(env); const storage = cfg === null ? null : createS3StorageProvider(cfg);` and `publicBaseUrl: env.STORAGE_PUBLIC_BASE_URL` (import `storageConfigFromEnv`, `createS3StorageProvider` from `@actionow/infra`).

- [ ] Implement `apps/worker/src/processors/job-exec.processor.ts` — build `persistMedia` when storage + publicBaseUrl are configured, and pass it into `JobRunner`:

```ts
import { JobRunner, persistMediaOutput } from '@actionow/engine';
// ...
export function createJobExecProcessor(
  runtime: WorkerRuntime,
): (data: JobExecData) => Promise<void> {
  const { storage, publicBaseUrl, http } = runtime;
  const persistMedia =
    storage === null || publicBaseUrl === undefined
      ? undefined
      : ({
          tenantId,
          jobId,
          output,
        }: {
          tenantId: string;
          jobId: string;
          output: Record<string, unknown>;
        }) =>
          persistMediaOutput({
            storage,
            publicBaseUrl,
            tenantId,
            jobId,
            output,
            // Download upstream bytes over the same HttpClient (no proxy needed for CDN reads).
            fetchBytes: async (url) => {
              const res = await fetch(url);
              const buf = new Uint8Array(await res.arrayBuffer());
              const ct = res.headers.get('content-type') ?? undefined;
              return { bytes: buf, contentType: ct };
            },
            // Upload to the presigned PUT URL.
            putBytes: async (url, bytes, contentType) => {
              await fetch(url, {
                method: 'PUT',
                headers: contentType === undefined ? {} : { 'content-type': contentType },
                body: bytes,
              });
            },
          });

  const runner = new JobRunner({
    db: runtime.db,
    adapters: runtime.adapters,
    loadContext: (job) => loadJobContext(runtime.db, job),
    resolveSecret: runtime.resolveSecret,
    http,
    proxyUrlEnv: runtime.env.UPSTREAM_PROXY_URL,
    ...(persistMedia !== undefined ? { persistMedia } : {}),
  });
  return (data: JobExecData): Promise<void> => runner.process(data.jobId);
}
```

(Use global `fetch` directly for the byte transfer rather than the `HttpClient` JSON wrapper, since media is binary; the `HttpClient` abstraction is JSON-oriented. The test's stub returns `text:'abc'`; in the test the processor's `fetchBytes` calls global `fetch` which the test stubs via `vi.stubGlobal('fetch', ...)` — adjust the test to stub global `fetch` to return a `Response` with `arrayBuffer()` yielding 3 bytes, OR have the test inject a runtime-level `fetchBytes`. SIMPLER: add an optional `fetchBytes`/`putBytes` override to `WorkerRuntime` for testability and default to the global-`fetch` impls; the test sets `rt.fetchBytes = () => Promise.resolve({ bytes: new Uint8Array([1,2,3]), contentType: 'image/png' })` and `rt.putBytes = () => Promise.resolve()`. Wire the processor to prefer `runtime.fetchBytes ?? defaultFetchBytes`. Update the failing test above accordingly.)

- [ ] Implement `apps/api/src/callbacks/callbacks.service.ts` — inject `STORAGE` (`@Inject(STORAGE) private readonly storage: StorageProvider | null`) and `ENV`, and build the same `persistMedia` closure in `buildRunner`, passing it into the `JobRunner` (so a webhook-driven settle also persists). The callbacks module already imports `STORAGE` via FilesModule's export — confirm `apps/api/src/callbacks/callbacks.module.ts` imports `FilesModule` or provides `STORAGE`; if not, add `STORAGE` to its providers (reuse the FilesModule storage provider factory or import FilesModule).

- [ ] Run it, expect PASS: `pnpm --filter @actionow/worker test processors`. Then `pnpm --filter @actionow/worker lint && pnpm --filter @actionow/api lint && pnpm --filter @actionow/infra lint`.

- [ ] Commit: `feat(worker,api): persist async media outputs to R2 on settle`

---

## Task 11 — `file_object` rows for persisted media (worker + callbacks)

`persistMediaOutput` returns `objects[]` (key + contentType + size). When media is persisted, create a `ready` `file_object` row per object so the tenant's media catalog reflects it. The engine stays db-free (boundary `engine→db` IS allowed — engine may import db — but to keep `persistMedia` pure the row creation happens in the app's `persistMedia` closure, which already runs in app context). Implement by wrapping `persistMediaOutput` in the processor/callbacks closure: after it returns, `for (const obj of result.objects) await createFileObject(db, { tenantId, provider: storage.kind, bucket, key: obj.key }); await markFileReady(db, file.id, { size, contentType });`.

**Files:**

- modify `apps/worker/src/processors/job-exec.processor.ts`
- modify `apps/api/src/callbacks/callbacks.service.ts`
- modify `apps/worker/test/processors.int.test.ts` (assert a `file_object` row exists after media settle)

Steps:

- [ ] Write the failing test addition in `apps/worker/test/processors.int.test.ts` — after the media-persist test settles, assert a `ready` `file_object` row exists for the tenant with the expected key:

```ts
it('records a ready file_object for each persisted media object', async () => {
  // ...same setup as the media-persist test (image resource + fake storage + 3-byte fetchBytes)...
  await process({ jobId: job.id });

  const files = await db
    .select()
    .from(schema.fileObject)
    .where(eq(schema.fileObject.tenantId, s.tenantId));
  expect(files).toHaveLength(1);
  expect(files[0]?.status).toBe('ready');
  expect(files[0]?.key).toBe(`${s.tenantId}/${job.id}.png`);
  expect(files[0]?.size).toBe(3);
});
```

(Add `fileObject` to the destructured `schema` at the top of the test if not already, and to the `TRUNCATE` list.)

- [ ] Run it, expect FAIL: `pnpm --filter @actionow/worker test processors` → `files` has length 0 (no row created).

- [ ] Implement: in both the worker processor and the callbacks `persistMedia` closure, change the closure to call `persistMediaOutput`, then for each returned object create + ready a `file_object` row, using `STORAGE_BUCKET` from env for `bucket`. Keep it best-effort (a row-creation failure must not fail the settle — wrap in try/catch and continue, since the URL is already rewritten):

```ts
const persistMedia =
  storage === null || publicBaseUrl === undefined
    ? undefined
    : async ({ tenantId, jobId, output }) => {
        const result = await persistMediaOutput({
          storage,
          publicBaseUrl,
          tenantId,
          jobId,
          output,
          fetchBytes,
          putBytes,
        });
        for (const obj of result.objects) {
          try {
            const file = await createFileObject(runtime.db, {
              tenantId,
              provider: storage.kind,
              bucket: runtime.env.STORAGE_BUCKET ?? '',
              key: obj.key,
            });
            await markFileReady(runtime.db, file.id, {
              ...(obj.size !== undefined ? { size: obj.size } : {}),
              ...(obj.contentType !== undefined ? { contentType: obj.contentType } : {}),
            });
          } catch {
            // best-effort: the output URL is already rewritten; a catalog row miss is non-fatal.
          }
        }
        return result;
      };
```

Import `createFileObject`, `markFileReady` from `@actionow/db` (apps may import db).

- [ ] Run it, expect PASS: `pnpm --filter @actionow/worker test processors`. Then `pnpm --filter @actionow/worker lint && pnpm --filter @actionow/api lint`.

- [ ] Commit: `feat(worker,api): create ready file_object rows for persisted media`

---

## Task 12 — seed real-provider resources, channels, pricebooks (network-free)

Extend the seed with a new opt-in seed module that registers image (`seedream-4.5`/`huimeng`), video (`seedance-2.0`/`huimeng`), and chat resources (DeepSeek `deepseek-chat`/`openai`, a MiMo model `mimo-v2.5`/`openai`, HuiMeng `gpt-5.5`/`openai`) with channels carrying `endpoint`/`model`/`credentialRef` (and optional `proxyRef`) + pricebooks. The seed itself does NO network (it only writes catalog rows). This is unit/int-tested against a Testcontainers pg.

**Files:**

- create `apps/api/src/seed/seed-providers.ts`
- create `apps/api/test/seed-providers.int.test.ts`

Steps:

- [ ] Write the failing integration test `apps/api/test/seed-providers.int.test.ts` (Testcontainers pg, mirror the seed test pattern). Seed a tenant + account first (reuse `seedAll` from `seed.ts`), then call `seedProviders(db, { tenantId })` and assert the resources + channels exist with the right endpoint/model:

```ts
it('seeds image/video/chat resources with channels carrying endpoint+model', async () => {
  const { tenantId } = await seedAll(db); // existing base seed
  await seedProviders(db, { tenantId });

  const image = await getResource(db, 'huimeng-seedream');
  expect(image?.providerType).toBe('huimeng');
  expect(image?.modality).toBe('image');
  const [imageChannel] = await listChannels(db, 'huimeng-seedream');
  expect(imageChannel?.endpoint).toBe('https://api.huimengi.com');
  expect(imageChannel?.model).toBe('seedream-4.5');

  const deepseek = await getResource(db, 'deepseek-chat');
  expect(deepseek?.providerType).toBe('openai');
  const [dsChannel] = await listChannels(db, 'deepseek-chat');
  expect(dsChannel?.endpoint).toBe('https://api.deepseek.com/v1');
  expect(dsChannel?.model).toBe('deepseek-chat');

  // pricebook present + active for each
  expect(await getActivePricebookEntry(db, 'deepseek-chat', 1)).toBeDefined();
  expect(await getActivePricebookEntry(db, 'huimeng-seedream', 1)).toBeDefined();
});

it('is idempotent: a second run creates nothing new', async () => {
  const { tenantId } = await seedAll(db);
  await seedProviders(db, { tenantId });
  const before = (await listResources(db)).length;
  await seedProviders(db, { tenantId });
  expect((await listResources(db)).length).toBe(before);
});
```

- [ ] Run it, expect FAIL: `pnpm --filter @actionow/api test seed-providers` → `Cannot find module '../src/seed/seed-providers.js'`.

- [ ] Implement `apps/api/src/seed/seed-providers.ts`. Follow `seed.ts`'s idempotent find-then-create pattern. Define a table of resources and loop:

```ts
import {
  createPricebookEntry,
  createResource,
  createSecretRef,
  createUpstreamChannel,
  type Database,
  getResource,
} from '@actionow/db';

interface ProviderSeed {
  id: string;
  kind: string;
  modality: string;
  providerType: string;
  endpoint: string;
  model: string;
  /** env secret ref locator for the channel credential. */
  credentialLocator: string;
  execModes: string[];
  ioSchema: unknown;
  /** unit/post pricebook spec (µcredits per usage dimension). */
  pricebookSpec: unknown;
}

const TEXT_IO = {
  inputs: [{ key: 'prompt', type: 'string', required: true }],
  outputs: [{ key: 'text', type: 'string' }],
};
const IMAGE_IO = {
  inputs: [
    { key: 'prompt', type: 'string', required: true },
    { key: 'size', type: 'string', required: false },
  ],
  outputs: [{ key: 'image_url', type: 'string' }],
};
const VIDEO_IO = {
  inputs: [
    { key: 'prompt', type: 'string', required: true },
    { key: 'duration', type: 'number', required: false },
    { key: 'ratio', type: 'string', required: false },
  ],
  outputs: [{ key: 'video_url', type: 'string' }],
};

/** unit/post over tokens (1 µcredit/token) for chat. */
const TOKENS_PRICEBOOK = { method: 'unit', dimensions: { tokens: { rate: 1 } } };
/** unit/post over tasks (e.g. 250_000 µcredits per image task). */
const TASKS_PRICEBOOK = { method: 'unit', dimensions: { tasks: { rate: 250_000 } } };

const PROVIDER_SEEDS: ProviderSeed[] = [
  {
    id: 'deepseek-chat',
    kind: 'model',
    modality: 'text',
    providerType: 'openai',
    endpoint: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    credentialLocator: 'deepseek_api_key',
    execModes: ['blocking', 'stream'],
    ioSchema: TEXT_IO,
    pricebookSpec: TOKENS_PRICEBOOK,
  },
  {
    id: 'xiaomi-mimo',
    kind: 'model',
    modality: 'text',
    providerType: 'openai',
    endpoint: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5',
    credentialLocator: 'xiaomi_api_key',
    execModes: ['blocking', 'stream'],
    ioSchema: TEXT_IO,
    pricebookSpec: TOKENS_PRICEBOOK,
  },
  {
    id: 'huimeng-gpt',
    kind: 'model',
    modality: 'text',
    providerType: 'openai',
    endpoint: 'https://api.huimengi.com/v1',
    model: 'gpt-5.5',
    credentialLocator: 'huimeng_api_key',
    execModes: ['blocking', 'stream'],
    ioSchema: TEXT_IO,
    pricebookSpec: TOKENS_PRICEBOOK,
  },
  {
    id: 'huimeng-seedream',
    kind: 'model',
    modality: 'image',
    providerType: 'huimeng',
    endpoint: 'https://api.huimengi.com',
    model: 'seedream-4.5',
    credentialLocator: 'huimeng_api_key',
    execModes: ['async-poll', 'async-callback'],
    ioSchema: IMAGE_IO,
    pricebookSpec: TASKS_PRICEBOOK,
  },
  {
    id: 'huimeng-seedance',
    kind: 'model',
    modality: 'video',
    providerType: 'huimeng',
    endpoint: 'https://api.huimengi.com',
    model: 'seedance-2.0',
    credentialLocator: 'huimeng_api_key',
    execModes: ['async-poll', 'async-callback'],
    ioSchema: VIDEO_IO,
    pricebookSpec: TASKS_PRICEBOOK,
  },
];

export interface SeedProvidersOptions {
  readonly tenantId: string;
  /** Optional global proxy ref applied to every channel (e.g. for direct hosts). */
  readonly proxyRef?: string;
}

/** Idempotently register the real-provider catalog (resources + channels + pricebooks). */
export async function seedProviders(db: Database, opts: SeedProvidersOptions): Promise<void> {
  for (const s of PROVIDER_SEEDS) {
    if ((await getResource(db, s.id)) !== undefined) continue;
    await createResource(db, {
      id: s.id,
      tenantId: opts.tenantId,
      kind: s.kind,
      modality: s.modality,
      providerType: s.providerType,
      execModes: s.execModes,
      ioSchema: s.ioSchema,
      version: 1,
    });
    await createPricebookEntry(db, {
      resourceId: s.id,
      resourceVersion: 1,
      version: 1,
      method: 'unit',
      timing: 'post',
      spec: s.pricebookSpec,
      active: true,
    });
    const secret = await createSecretRef(db, { provider: 'env', locator: s.credentialLocator });
    await createUpstreamChannel(db, {
      resourceId: s.id,
      providerType: s.providerType,
      credentialRef: secret.id,
      endpoint: s.endpoint,
      model: s.model,
      ...(opts.proxyRef !== undefined ? { proxyRef: opts.proxyRef } : {}),
      weight: 1,
      status: 'active',
    });
  }
}
```

Also add direct openai/anthropic/gemini entries with `credentialLocator: 'openai_api_key' | 'anthropic_api_key' | 'gemini_api_key'`, `providerType: 'openai'|'anthropic'|'gemini'`, their default endpoints, and `proxyRef` left to the caller — mark them "untested from this network; reachable via proxy or via the HuiMeng relay (huimeng-gpt / a gemini-fronted huimeng channel)". Keep them in `PROVIDER_SEEDS` so the catalog is complete.

- [ ] Run it, expect PASS: `pnpm --filter @actionow/api test seed-providers`. Then `pnpm --filter @actionow/api lint`.

- [ ] Commit: `feat(api): seed real-provider resources/channels/pricebooks`

---

## Task 13 — opt-in LIVE provider e2e (skipped by default)

A single Vitest suite that REALLY hits DeepSeek (blocking chat), HuiMeng image (submit→poll→completed), and an R2 persistence round-trip. Gated behind `LIVE_PROVIDER_TEST=1` AND the presence of the required `SECRET_*` keys; otherwise `describe.skip`. The DEFAULT suite never runs it (no network). Uses `node --env-file=.env`-style env (vitest reads `process.env`).

**Files:**

- create `apps/api/test/live-providers.e2e.test.ts`
- modify root `README` or `.env.example` if one exists (document the live env vars) — only if such a file exists; do not create new docs.

Steps:

- [ ] Write the test `apps/api/test/live-providers.e2e.test.ts`. It is `describe.skip` unless `process.env.LIVE_PROVIDER_TEST === '1'` and the needed secrets exist. It calls the adapters DIRECTLY (no full NestJS boot needed) with a real `FetchHttpClient`, honoring `UPSTREAM_PROXY_URL` if set:

```ts
import { huimengAdapter, openaiAdapter } from '@actionow/adapters';
import { createS3StorageProvider } from '@actionow/infra';
import { FetchHttpClient } from '@actionow/infra';
import { describe, expect, it } from 'vitest';

const LIVE = process.env.LIVE_PROVIDER_TEST === '1';
const hasDeepseek = typeof process.env.SECRET_DEEPSEEK_API_KEY === 'string';
const hasHuimeng = typeof process.env.SECRET_HUIMENG_API_KEY === 'string';
const hasR2 =
  typeof process.env.STORAGE_ACCESS_KEY_ID === 'string' &&
  typeof process.env.STORAGE_SECRET_ACCESS_KEY === 'string' &&
  typeof process.env.STORAGE_ENDPOINT === 'string';

const proxyUrl = process.env.UPSTREAM_PROXY_URL;
const http = new FetchHttpClient();

(LIVE && hasDeepseek ? describe : describe.skip)('LIVE: DeepSeek blocking chat', () => {
  it('returns text from a real deepseek-chat completion', async () => {
    const r = await openaiAdapter.submit({
      resourceId: 'deepseek-chat',
      modality: 'text',
      inputs: { prompt: 'Reply with the single word: pong', max_tokens: 16 },
      execMode: 'blocking',
      ctx: {
        providerType: 'openai',
        model: 'deepseek-chat',
        endpoint: 'https://api.deepseek.com/v1',
        apiKey: process.env.SECRET_DEEPSEEK_API_KEY,
        ...(proxyUrl !== undefined ? { proxyUrl } : {}),
        http,
      },
    });
    expect(r.kind).toBe('sync');
    if (r.kind === 'sync') expect(typeof r.output.text).toBe('string');
  }, 60_000);
});

(LIVE && hasHuimeng ? describe : describe.skip)('LIVE: HuiMeng image submit→poll', () => {
  it('submits seedream-4.5 and polls to completed with an image_url', async () => {
    const ctx = {
      providerType: 'huimeng',
      model: 'seedream-4.5',
      endpoint: 'https://api.huimengi.com',
      apiKey: process.env.SECRET_HUIMENG_API_KEY,
      ...(proxyUrl !== undefined ? { proxyUrl } : {}),
      http,
    } as const;
    const submitted = await huimengAdapter.submit({
      resourceId: 'huimeng-seedream',
      modality: 'image',
      inputs: { prompt: 'a single red apple on a white background' },
      execMode: 'async-poll',
      ctx,
    });
    expect(submitted.kind).toBe('async');
    if (submitted.kind !== 'async') throw new Error('expected async handle');

    // Poll up to ~2 min.
    let last;
    for (let i = 0; i < 60; i += 1) {
      last = await huimengAdapter.poll?.(submitted.upstreamJobId, ctx);
      if (last?.status === 'succeeded' || last?.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(last?.status).toBe('succeeded');
    expect(typeof last?.output?.image_url).toBe('string');
  }, 180_000);
});

(LIVE && hasR2 ? describe : describe.skip)('LIVE: R2 persistence round-trip', () => {
  it('uploads and downloads bytes via the real R2 bucket', async () => {
    const storage = createS3StorageProvider({
      kind: 'r2',
      bucket: process.env.STORAGE_BUCKET ?? 'actionow',
      region: 'auto',
      endpoint: process.env.STORAGE_ENDPOINT,
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? '',
      forcePathStyle: true,
    });
    const key = `live-test/${Date.now()}.txt`;
    const put = await storage.presignPut(key, { contentType: 'text/plain' });
    const body = new TextEncoder().encode('actionow live r2');
    const putRes = await fetch(put.url, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body,
    });
    expect(putRes.status).toBe(200);
    expect((await storage.head(key)).exists).toBe(true);
    const get = await storage.presignGet(key);
    const got = await (await fetch(get.url)).text();
    expect(got).toBe('actionow live r2');
    await storage.delete(key);
  }, 60_000);
});
```

- [ ] Run it WITHOUT the flag, expect SKIP: `pnpm --filter @actionow/api test live-providers` → all suites skipped (0 failures, suites reported skipped). This is the default-CI behavior; the live calls never fire.

- [ ] (Manual, NOT part of CI) Document the run recipe in the test's top-of-file comment: `LIVE_PROVIDER_TEST=1 node --env-file=.env … ` with `SECRET_DEEPSEEK_API_KEY`, `SECRET_HUIMENG_API_KEY`, `STORAGE_*` set. Do NOT run the live path in the verification gate.

- [ ] Commit: `test(api): opt-in live-provider e2e (skipped by default)`

---

## Verification gate

- [ ] Ensure Docker is running (Testcontainers needs it). With the live flag UNSET, run the full gate from the repo root:
  - [ ] `pnpm typecheck` — green (no `any`; `dispatcher` typed via `RequestInit & { dispatcher?: ProxyAgent }`; all new types resolve).
  - [ ] `pnpm lint` — green. Confirm boundaries intact: `packages/adapters/**` does NOT import `@actionow/db`/`@actionow/engine`/storage; `packages/infra/**` imports only `@actionow/contracts` (+ `undici`, `@aws-sdk/*`); `packages/engine/src/media-persistence.ts` imports only `@actionow/contracts`.
  - [ ] `pnpm build` — green (all packages compile, barrels export the new symbols).
  - [ ] `pnpm test` — green: the new `huimeng` adapter unit tests, the infra proxy tests, the engine `media-persistence` + `job-runner` persist test, the db `catalog-channel` int test, the worker `processors` media+file_object int tests, the api `seed-providers` int test all pass; `live-providers.e2e.test.ts` is SKIPPED.
- [ ] Confirm migration `0005` applies from scratch: a fresh Testcontainers pg in any int test runs `migrate(...)` from `0000`→`0005` with no error (the worker/db int tests already exercise this). Optionally `pnpm --filter @actionow/db db:generate` again and confirm it reports "No schema changes" (the committed `0005` matches the schema).
- [ ] Confirm NO secret logging: grep the diff for `console.log`/`logger` lines touching `apiKey`/`proxyUrl`/`secret`/`Authorization`/`X-HuiMeng-Signature` — there must be none. Proxy URLs and HMAC secrets never appear in logs.
- [ ] `git log --oneline` shows one focused commit per task, each body wrapping < 100 chars and ending with the `Co-Authored-By` trailer.

## Definition of Done

- A pure `huimeng` `ProviderAdapter` (image `seedream-4.5`, video `seedance-2.0`) is registered in `createDefaultRegistry`; it submits `/api/v1/tasks`, polls `/api/v1/tasks/{id}`, and HMAC-verifies the `X-HuiMeng-Signature` webhook over `"{timestamp}.{rawBody}"` with a replay window.
- `AdapterContext.proxyUrl` + `HttpRequest.proxyUrl` exist; `FetchHttpClient` routes through an `undici` `ProxyAgent` dispatcher (cached per proxy URL); `undici` is a direct `@actionow/infra` dependency; all real-HTTP adapters forward `ctx.proxyUrl`.
- `upstream_channel` carries `endpoint`/`model`/`proxy_ref` (migration `0005`); these thread through the api `RunService`, worker `loaders`, and api `CallbacksService` into `RunChannel` → `AdapterContext`; `proxy_ref` resolves via `resolveSecret` with a global `UPSTREAM_PROXY_URL` fallback.
- A pure engine `persistMediaOutput` copies completed media URLs into R2 under `{tenantId}/{jobId}.{ext}`, rewrites the output to `STORAGE_PUBLIC_BASE_URL` URLs, and reports objects; it is best-effort (a copy failure settles with the temp URL). `JobRunner.settle` calls it via an injected `persistMedia`; the worker + callbacks build that closure over the real `StorageProvider`, and create `ready` `file_object` rows per persisted object.
- OpenAI-compatible channels (DeepSeek, Xiaomi MiMo, HuiMeng-fronted GPT) reuse the existing `openai` adapter with per-channel `endpoint`/`model`; direct openai/anthropic/gemini channels are seeded with `credential_ref` + an optional `proxy_ref` and flagged untested-from-this-network.
- The seed registers image/video/chat resources + channels + pricebooks (network-free, idempotent).
- A single opt-in `live-providers.e2e.test.ts` really hits DeepSeek + HuiMeng image + R2; it is `describe.skip` by default and absent from the gate. The default `pnpm test` is fully network-free.
- The verification gate (`pnpm typecheck && pnpm lint && pnpm build && pnpm test` with Docker up) is green; boundaries intact; no secret logging; migration `0005` applies from scratch.

## Open questions for the human — RESOLVED (see the "Decisions" block at the top, which overrides this section)

1. **Proxy config shape** (Architecture §2). The plan implements **(a)**: a `proxy_ref` text column on `upstream_channel`, resolved to a URL via the same `SecretResolver` used for credentials (env key holds the proxy URL), plus a global `UPSTREAM_PROXY_URL` env fallback. Alternatives were **(b)** a plain `proxy_url` column (simpler, but puts proxy URLs — which may embed credentials — in the DB) and **(c)** an env map of provider→proxy (no per-channel granularity). Confirm (a), or switch. Note `credential_ref` is `uuid` (→ a `secret_ref` row) while `proxy_ref` is a plain env-key `text`; if you want symmetry, make `proxy_ref` a `secret_ref` uuid too.
2. **Persistence location** (Architecture §3). The plan persists in the worker `job-exec` completion path AND the api `CallbacksService` (both build a `persistMedia` closure over the injected `StorageProvider`), running inside `JobRunner.settle` so poll- and webhook-driven settles both persist. The blocking path (`ExecutionService.runBlocking`) does NOT persist today (media providers are async-only). Confirm we do NOT also need persistence on the blocking path, and confirm "best-effort" (settle with the temp URL on R2 failure) is the desired failure mode vs. failing the job.
3. **Usage/cost mapping** (Architecture §1). HuiMeng returns a provider `cost` (e.g. image 0.25) that is NOT our money and NOT tokens. The plan maps `extractUsage` → `{ tasks: 1 }` and prices via OUR `unit`/`post` pricebook over the `tasks` dimension (seed rate `250_000` µcredits/task as a placeholder). Confirm the dimension name (`tasks`) and the per-modality rates (image vs. video should likely differ — the plan seeds the same rate for both), and whether the upstream `cost` should be recorded anywhere (e.g. a usage sub-field for reconciliation/audit) even though it does not drive billing.
4. **Direct-host channels.** openai/anthropic/gemini direct hosts are unreachable/403 from this network. The plan seeds them anyway (with `credential_ref` + optional `proxy_ref`) and relies on GPT/Gemini also being reachable via the HuiMeng relay. Confirm whether to seed the direct channels as `status: 'active'` (and depend on a configured proxy) or `status: 'disabled'` until a proxy is provisioned.
