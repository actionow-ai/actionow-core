# App-on-core engineering guidance — Phase 1 Implementation Plan (TS starter scaffold)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A clonable, compiling TypeScript starter (`examples/app-starter/`) that implements scenario 2 (capability base, Model-B) end to end — a framework-agnostic `core-kit` + a thin Express reference backend — so a team can `cp -r` it and launch.

**Architecture:** `src/core-kit/` holds framework-agnostic helpers over `@actionow/sdk` (two-client factory + raw fetch for untyped routes, console session/refresh, µcredit BigInt, retryable-based retry, webhook verify, job poll). `src/routes/` are thin Express handlers that compose core-kit. `src/store/` is an in-memory stand-in for the team's own user DB (stores only core IDs — `subject_id` + `ak_`). The scaffold typechecks standalone by mapping `@actionow/sdk` to source, exactly like `examples/quickstart`.

**Tech Stack:** TypeScript (ESM, `tsx`), Express 4, `@actionow/sdk` (workspace), `vitest` for core-kit unit tests. Framework-agnostic core; Express only in `routes/` + `server.ts`.

> **Encodes the audit-corrected facts:** relay dialect (`/v1/chat/completions`, …) + `/console/{subjects,redeem,limit-plans}*` are UNTYPED → use `core-kit` raw fetch, never `client.POST`; `expiresIn` is a duration STRING; payments-intent → `{intent_id, redirect_url?, qr?}`; retry only on `error.retryable`; `end_user = external_id`; console creds must be tenant-admin.

> **Commit note:** commits are gated on the user's go-ahead; if given, branch off `main` first. Commit steps below are for completeness.

> **Verify convention:** every code task ends with `pnpm -C examples/app-starter typecheck` (and, for `core-kit`, `vitest run`). The scaffold must stay green after each task.

---

## File structure

| File                                    | Responsibility                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `examples/app-starter/package.json`     | ESM pkg; deps `@actionow/sdk`, `express`; scripts typecheck/start/test/lint           |
| `examples/app-starter/tsconfig.json`    | extends `../../tsconfig.base.json`; maps `@actionow/sdk` → source (mirror quickstart) |
| `examples/app-starter/.env.example`     | env contract                                                                          |
| `examples/app-starter/eslint.config.js` | flat config, strict                                                                   |
| `examples/app-starter/Dockerfile`       | container build                                                                       |
| `examples/app-starter/README.md`        | run + scenario switch + upgrade path                                                  |
| `src/config.ts`                         | typed env loader                                                                      |
| `src/core-kit/client.ts`                | `consoleClient` / `dataClient` (typed SDK) + `rawPost`/`rawGet` (untyped routes)      |
| `src/core-kit/auth.ts`                  | `loginConsole`, `refresh`, `ConsoleSession` (lazy refresh via JWT `exp`)              |
| `src/core-kit/money.ts`                 | µcredit BigInt utils                                                                  |
| `src/core-kit/retry.ts`                 | `callWithRetry` — branch on `error.retryable`                                         |
| `src/core-kit/webhook.ts`               | re-export `verifyWebhookSignature` + header const                                     |
| `src/core-kit/jobs.ts`                  | re-export `submitAndWait`/`consumeJobStream`                                          |
| `src/core-kit/index.ts`                 | barrel                                                                                |
| `src/store/users.ts`                    | in-memory user table: yourUserId → { subjectId, apiKey }                              |
| `src/routes/onboard.ts`                 | `POST /api/users` — Model-B onboard (subject + key)                                   |
| `src/routes/chat.ts`                    | `POST /api/chat` — proxy `/v1/chat/completions` (blocking + stream)                   |
| `src/routes/topup.ts`                   | `POST /api/topup` — `/console/payments/intents` or `/console/redeem`                  |
| `src/routes/media.ts`                   | `POST /api/media` — `/v1/run` submit + poll                                           |
| `src/routes/webhook.ts`                 | `POST /webhooks/actionow` — verify → fetch job                                        |
| `src/routes/files.ts`                   | `POST /api/files` — presign passthrough                                               |
| `src/server.ts`                         | Express app wiring                                                                    |
| `test/core-kit.test.ts`                 | money + retry unit tests + mock-fetch onboard test                                    |

---

### Task 1: Package scaffolding (compiles empty)

**Files:** Create `examples/app-starter/{package.json,tsconfig.json,.env.example,eslint.config.js,Dockerfile}` and `src/config.ts`.

- [ ] **Step 1: package.json**

```json
{
  "name": "@actionow/example-app-starter",
  "version": "0.0.0",
  "private": true,
  "description": "Clonable capability-base (Model-B) starter: core-kit + thin Express backend on Actionow core.",
  "license": "MIT",
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "start": "tsx src/server.ts",
    "test": "vitest run",
    "lint": "eslint ."
  },
  "dependencies": {
    "@actionow/sdk": "workspace:*",
    "express": "^4.21.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: tsconfig.json** (mirror quickstart's source-mapping trick)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "lib": ["ES2023", "DOM"],
    "types": ["node"],
    "baseUrl": ".",
    "paths": {
      "@actionow/sdk": ["../../packages/sdk/src/index.ts"],
      "@actionow/sdk/webhook": ["../../packages/sdk/src/webhook.ts"]
    }
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: .env.example**

```sh
ACTIONOW_BASE_URL=https://gateway.example.com
# Console creds MUST be a TENANT ADMIN (create-subject / mint-key / redeem require tenant_role=admin, else 403).
ACTIONOW_CONSOLE_EMAIL=admin@yourapp.example
ACTIONOW_CONSOLE_PASSWORD=
# The proxy's data-plane key: a TENANT-LEVEL ak_ (no subjectId) so end_user attribution works per call.
ACTIONOW_PROXY_API_KEY=ak_...
ACTIONOW_WEBHOOK_SECRET=
ACTIONOW_MODEL=gpt-4o
PORT=8787
```

- [ ] **Step 4: eslint.config.js** (minimal flat config)

```js
import js from '@eslint/js';
export default [
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: { 'no-unused-vars': 'warn' },
  },
];
```

(Add `@eslint/js` to devDependencies in package.json.)

- [ ] **Step 5: Dockerfile**

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile || npm i
EXPOSE 8787
CMD ["npx","tsx","src/server.ts"]
```

- [ ] **Step 6: src/config.ts**

```ts
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
export const config = {
  baseUrl: () => req('ACTIONOW_BASE_URL').replace(/\/$/, ''),
  consoleEmail: () => req('ACTIONOW_CONSOLE_EMAIL'),
  consolePassword: () => req('ACTIONOW_CONSOLE_PASSWORD'),
  proxyApiKey: () => req('ACTIONOW_PROXY_API_KEY'),
  webhookSecret: () => req('ACTIONOW_WEBHOOK_SECRET'),
  model: () => process.env.ACTIONOW_MODEL ?? 'gpt-4o',
  port: () => Number(process.env.PORT ?? 8787),
};
```

- [ ] **Step 7: Verify** — `pnpm -C examples/app-starter install && pnpm -C examples/app-starter typecheck` → passes (no src yet beyond config; expect 0 errors).
- [ ] **Step 8: Commit** (gated, branch-first): `git add examples/app-starter && git commit -m "chore(example): app-starter scaffolding"`

---

### Task 2: core-kit/client.ts (typed clients + raw fetch for untyped routes)

**Files:** Create `src/core-kit/client.ts`.

- [ ] **Step 1: Write client.ts**

```ts
import { createActionowClient } from '@actionow/sdk';

export type Client = ReturnType<typeof createActionowClient>;

/** Control-plane client (tenant-admin USER JWT) — server-side ONLY. */
export function consoleClient(baseUrl: string, jwt: string): Client {
  return createActionowClient({ baseUrl, token: jwt });
}
/** Data-plane client (ak_). */
export function dataClient(baseUrl: string, ak: string): Client {
  return createActionowClient({ baseUrl, token: ak });
}

/**
 * Raw fetch for endpoints OUTSIDE the generated OpenAPI (so @actionow/sdk can't
 * type them): the whole relay dialect (/v1/chat/completions, /v1/embeddings, …),
 * /auth/login, and /console/{subjects,redeem,limit-plans}*. Throws on non-2xx
 * with the unified error attached.
 */
export async function rawPost<T = unknown>(
  baseUrl: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok)
    throw Object.assign(new Error(`${path} → HTTP ${res.status}`), {
      status: res.status,
      error: json.error,
    });
  return json as T;
}
export async function rawGet<T = unknown>(
  baseUrl: string,
  path: string,
  token?: string,
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok)
    throw Object.assign(new Error(`${path} → HTTP ${res.status}`), {
      status: res.status,
      error: json.error,
    });
  return json as T;
}
```

- [ ] **Step 2: Verify** — `pnpm -C examples/app-starter typecheck` → passes.
- [ ] **Step 3: Commit** (gated): `git add … && git commit -m "feat(app-starter): core-kit client + raw fetch"`

---

### Task 3: core-kit/money.ts + retry.ts (+ unit tests — TDD)

**Files:** Create `src/core-kit/money.ts`, `src/core-kit/retry.ts`, `test/core-kit.test.ts`.

- [ ] **Step 1: Write the failing tests** (`test/core-kit.test.ts`)

```ts
import { describe, it, expect, vi } from 'vitest';
import { formatCredits, creditsToMicro, MICRO_PER_CREDIT } from '../src/core-kit/money.js';
import { callWithRetry } from '../src/core-kit/retry.js';

describe('money', () => {
  it('formats µcredit string to credits', () => {
    expect(formatCredits('1500000')).toBe('1.5');
    expect(formatCredits(1234567n, 2)).toBe('1.23');
  });
  it('converts human credits to µcredit bigint', () => {
    expect(creditsToMicro(2)).toBe(2n * MICRO_PER_CREDIT);
  });
});

describe('callWithRetry', () => {
  it('does NOT retry a non-retryable 402', async () => {
    const fn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: 'insufficient_credits', retryable: false } }),
          { status: 402 },
        ),
    );
    await expect(callWithRetry(fn, { max: 3, baseMs: 1 })).rejects.toMatchObject({
      code: 'insufficient_credits',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('retries a retryable 429 then succeeds', async () => {
    let n = 0;
    const fn = vi.fn(async () =>
      ++n < 2
        ? new Response(
            JSON.stringify({ error: { code: 'rate_limited', retryable: true, retry_after_ms: 1 } }),
            { status: 429 },
          )
        : new Response('{}', { status: 200 }),
    );
    const res = await callWithRetry(fn, { max: 3, baseMs: 1 });
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** — `pnpm -C examples/app-starter test` → fails (modules missing).

- [ ] **Step 3: Write money.ts**

```ts
export const MICRO_PER_CREDIT = 1_000_000n;
/** µcredit (string|bigint) → human credits string with `dp` decimals. */
export function formatCredits(micro: string | bigint, dp = 4): string {
  const v = BigInt(micro);
  const whole = v / MICRO_PER_CREDIT;
  const frac = (v % MICRO_PER_CREDIT).toString().padStart(6, '0').slice(0, dp).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
/** human credits → µcredit bigint. */
export function creditsToMicro(credits: number): bigint {
  return BigInt(Math.round(credits * 1_000_000));
}
```

- [ ] **Step 4: Write retry.ts**

```ts
export interface RetryOpts {
  max?: number;
  baseMs?: number;
}
/**
 * Call an HTTP thunk, retrying ONLY when the unified error envelope says
 * `retryable:true` (never 402/400). Honors `retry_after_ms`. Throws the unified
 * error (with `code`/`status`) when exhausted or non-retryable.
 */
export async function callWithRetry(
  fn: () => Promise<Response>,
  opts: RetryOpts = {},
): Promise<Response> {
  const max = opts.max ?? 3;
  const baseMs = opts.baseMs ?? 500;
  for (let attempt = 0; ; attempt++) {
    const res = await fn();
    if (res.ok) return res;
    const body = (await res
      .clone()
      .json()
      .catch(() => ({}))) as {
      error?: { code?: string; retryable?: boolean; retry_after_ms?: number };
    };
    const err = body.error ?? {};
    if (!err.retryable || attempt >= max)
      throw Object.assign(new Error(err.code ?? res.statusText), {
        code: err.code,
        status: res.status,
      });
    await new Promise((r) => setTimeout(r, err.retry_after_ms ?? 2 ** attempt * baseMs));
  }
}
```

- [ ] **Step 5: Run — expect PASS** — `pnpm -C examples/app-starter test` → all pass.
- [ ] **Step 6: Commit** (gated): `git commit -m "feat(app-starter): µcredit + retryable-based retry (tested)"`

---

### Task 4: core-kit/auth.ts (login + lazy-refresh session)

**Files:** Create `src/core-kit/auth.ts`.

- [ ] **Step 1: Write auth.ts** — note `expiresIn` is a duration string, so DON'T use it; track expiry via the JWT `exp` claim.

```ts
import { rawPost } from './client.js';

export interface TokenPair {
  token: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

export function loginConsole(baseUrl: string, email: string, password: string): Promise<TokenPair> {
  return rawPost<TokenPair>(baseUrl, '/auth/login', { email, password });
}
export function refreshTokens(baseUrl: string, refreshToken: string): Promise<TokenPair> {
  return rawPost<TokenPair>(baseUrl, '/auth/refresh', { refreshToken });
}

function jwtExpMs(jwt: string): number {
  try {
    const [, payload] = jwt.split('.');
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: number;
    };
    return exp ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** Lazy tenant-admin session: logs in once, refreshes ~60s before the JWT exp. */
export class ConsoleSession {
  private pair?: TokenPair;
  private expMs = 0;
  constructor(
    private baseUrl: string,
    private email: string,
    private password: string,
  ) {}
  async token(): Promise<string> {
    const now = Date.now();
    if (!this.pair) this.pair = await loginConsole(this.baseUrl, this.email, this.password);
    else if (now > this.expMs - 60_000)
      this.pair = await refreshTokens(this.baseUrl, this.pair.refreshToken).catch(() =>
        loginConsole(this.baseUrl, this.email, this.password),
      );
    this.expMs = jwtExpMs(this.pair.accessToken);
    return this.pair.token;
  }
}
```

- [ ] **Step 2: Verify** — `typecheck` passes.
- [ ] **Step 3: Commit** (gated): `git commit -m "feat(app-starter): console session (JWT-exp refresh, expiresIn is a string)"`

---

### Task 5: core-kit/webhook.ts + jobs.ts + index.ts (barrel)

**Files:** Create `src/core-kit/{webhook.ts,jobs.ts,index.ts}`.

- [ ] **Step 1: webhook.ts**

```ts
export { verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } from '@actionow/sdk/webhook';
```

- [ ] **Step 2: jobs.ts**

```ts
export { submitAndWait, consumeJobStream, isTerminalJobStatus } from '@actionow/sdk';
```

- [ ] **Step 3: index.ts** (barrel)

```ts
export * from './client.js';
export * from './auth.js';
export * from './money.js';
export * from './retry.js';
export * from './webhook.js';
export * from './jobs.js';
```

- [ ] **Step 4: Verify** — `typecheck` passes.
- [ ] **Step 5: Commit** (gated): `git commit -m "feat(app-starter): core-kit webhook/jobs re-exports + barrel"`

---

### Task 6: store/users.ts (federation stand-in)

**Files:** Create `src/store/users.ts`.

- [ ] **Step 1: Write users.ts** — your own user table; stores ONLY core IDs (federation).

```ts
export interface UserRow {
  userId: string;
  subjectId: string;
  apiKey: string;
} // apiKey encrypted in real apps
const users = new Map<string, UserRow>();
export const userStore = {
  put(row: UserRow) {
    users.set(row.userId, row);
  },
  get(userId: string): UserRow | undefined {
    return users.get(userId);
  },
};
```

- [ ] **Step 2: Verify** — `typecheck` passes.
- [ ] **Step 3: Commit** (gated): `git commit -m "feat(app-starter): in-memory federation store (stores core IDs only)"`

---

### Task 7: routes/onboard.ts + chat.ts

**Files:** Create `src/routes/onboard.ts`, `src/routes/chat.ts`.

- [ ] **Step 1: onboard.ts** — Model-B: create subject (untyped → rawPost) + mint key (typed console client).

```ts
import type { Request, Response } from 'express';
import { consoleClient, rawPost, type ConsoleSession } from '../core-kit/index.js';
import { userStore } from '../store/users.js';
import { config } from '../config.js';

/** POST /api/users { userId } — onboard your user as a core subject + mint their ak_. */
export function onboardRoute(session: ConsoleSession) {
  return async (req: Request, res: Response) => {
    const userId = String(req.body?.userId ?? '');
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const base = config.baseUrl();
    const jwt = await session.token();
    // /console/subjects is UNTYPED → rawPost. externalId = your user id.
    const subject = await rawPost<{ id: string }>(
      base,
      '/console/subjects',
      { externalId: userId, displayName: userId },
      jwt,
    );
    // /console/api-keys IS typed → SDK client.
    const { data, error } = await consoleClient(base, jwt).POST('/console/api-keys', {
      body: { subjectId: subject.id },
    });
    if (error) return res.status(502).json({ error });
    userStore.put({ userId, subjectId: subject.id, apiKey: data!.plaintext });
    res.json({ userId, subject_id: subject.id }); // never return the ak_ to the caller
  };
}
```

- [ ] **Step 2: chat.ts** — proxy the UNTYPED relay dialect with raw fetch (blocking + stream), attributing `end_user`.

```ts
import type { Request, Response } from 'express';
import { callWithRetry, type ConsoleSession } from '../core-kit/index.js';
import { userStore } from '../store/users.js';
import { config } from '../config.js';

/** POST /api/chat { userId, messages, stream? } — proxy /v1/chat/completions with the user's ak_. */
export function chatRoute() {
  return async (req: Request, res: Response) => {
    const { userId, messages, stream } = req.body ?? {};
    const row = userStore.get(String(userId));
    if (!row) return res.status(404).json({ error: 'unknown user — onboard first' });
    const base = config.baseUrl();
    const body = JSON.stringify({
      model: config.model(),
      messages,
      stream: Boolean(stream),
      end_user: row.userId,
    });
    // relay dialect is UNTYPED → raw fetch. Pre-commit errors are real non-2xx (retry only on retryable).
    const upstream = await callWithRetry(() =>
      fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${row.apiKey}`, 'content-type': 'application/json' },
        body,
      }),
    );
    if (!stream) return res.json(await upstream.json());
    res.setHeader('content-type', 'text/event-stream');
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>)
      res.write(chunk);
    res.end();
  };
}
```

- [ ] **Step 3: Verify** — `typecheck` passes.
- [ ] **Step 4: Commit** (gated): `git commit -m "feat(app-starter): onboard + chat proxy routes"`

---

### Task 8: routes/topup.ts + media.ts + files.ts + webhook.ts

**Files:** Create `src/routes/{topup,media,files,webhook}.ts`.

- [ ] **Step 1: topup.ts** — `/console/payments/intents` (typed) → `{ intent_id, redirect_url?, qr? }`, or `/console/redeem` (untyped).

```ts
import type { Request, Response } from 'express';
import { consoleClient, rawPost, type ConsoleSession } from '../core-kit/index.js';
import { config } from '../config.js';

/** POST /api/topup { code? , provider?, amount_minor?, currency? } */
export function topupRoute(session: ConsoleSession) {
  return async (req: Request, res: Response) => {
    const base = config.baseUrl();
    const jwt = await session.token();
    if (req.body?.code)
      return res.json(await rawPost(base, '/console/redeem', { code: req.body.code }, jwt)); // → { credited, balance }
    const { provider, amount_minor, currency } = req.body ?? {};
    const { data, error } = await consoleClient(base, jwt).POST('/console/payments/intents', {
      body: { provider, amount_minor, currency },
    });
    if (error) return res.status(502).json({ error });
    res.json(data); // { intent_id, redirect_url?, qr? }
  };
}
```

- [ ] **Step 2: media.ts** — submit `/v1/run` + poll via `submitAndWait`.

```ts
import type { Request, Response } from 'express';
import { dataClient, submitAndWait } from '../core-kit/index.js';
import { userStore } from '../store/users.js';
import { config } from '../config.js';

/** POST /api/media { userId, resourceId, inputs } */
export function mediaRoute() {
  return async (req: Request, res: Response) => {
    const { userId, resourceId, inputs } = req.body ?? {};
    const row = userStore.get(String(userId));
    if (!row) return res.status(404).json({ error: 'unknown user' });
    const client = dataClient(config.baseUrl(), row.apiKey);
    const job = await submitAndWait(
      client,
      resourceId,
      { inputs, end_user: row.userId },
      { pollMs: 1500, timeoutMs: 180_000 },
    );
    res.json(job); // resolve any output file_id via /v1/files/:id/url
  };
}
```

- [ ] **Step 3: files.ts** — presign passthrough (typed `/v1/files`).

```ts
import type { Request, Response } from 'express';
import { dataClient } from '../core-kit/index.js';
import { userStore } from '../store/users.js';
import { config } from '../config.js';

/** POST /api/files { userId, filename, content_type, size } → presign for a client-side PUT. */
export function filesRoute() {
  return async (req: Request, res: Response) => {
    const { userId, filename, content_type, size } = req.body ?? {};
    const row = userStore.get(String(userId));
    if (!row) return res.status(404).json({ error: 'unknown user' });
    const { data, error } = await dataClient(config.baseUrl(), row.apiKey).POST(
      '/v1/files/presign-upload',
      { body: { filename, content_type, size } },
    );
    if (error) return res.status(502).json({ error });
    res.json(data); // { file_id, upload_url, key, expires_in }
  };
}
```

- [ ] **Step 4: webhook.ts** — verify RAW bytes → fetch the job (body is a minimal `{ job_id }` ping).

```ts
import type { Request, Response } from 'express';
import { verifyWebhookSignature, dataClient } from '../core-kit/index.js';
import { config } from '../config.js';

/** POST /webhooks/actionow — mount with express.raw({ type: 'application/json' }). */
export function webhookRoute() {
  return async (req: Request, res: Response) => {
    const result = verifyWebhookSignature(
      req.body as Buffer,
      req.header('X-Actionow-Signature'),
      config.webhookSecret(),
    );
    if (!result.valid) return res.status(401).json({ error: result.reason });
    res.sendStatus(200); // ack fast
    const ping = JSON.parse((req.body as Buffer).toString('utf8')) as {
      job_id: string;
      error?: unknown;
    };
    if (ping.error) return; // failed — record it
    // body is minimal; fetch the real result with the proxy ak_
    const { data } = await dataClient(config.baseUrl(), config.proxyApiKey()).GET('/v1/jobs/{id}', {
      params: { path: { id: ping.job_id } },
    });
    void data; // resolve output file_ids, notify user, etc.
  };
}
```

- [ ] **Step 5: Verify** — `typecheck` passes.
- [ ] **Step 6: Commit** (gated): `git commit -m "feat(app-starter): topup/media/files/webhook routes"`

---

### Task 9: server.ts (wire Express)

**Files:** Create `src/server.ts`.

- [ ] **Step 1: server.ts**

```ts
import express from 'express';
import { ConsoleSession } from './core-kit/index.js';
import { config } from './config.js';
import { onboardRoute } from './routes/onboard.js';
import { chatRoute } from './routes/chat.js';
import { topupRoute } from './routes/topup.js';
import { mediaRoute } from './routes/media.js';
import { filesRoute } from './routes/files.js';
import { webhookRoute } from './routes/webhook.js';

const session = new ConsoleSession(
  config.baseUrl(),
  config.consoleEmail(),
  config.consolePassword(),
);
const app = express();
// webhook needs RAW bytes for signature verification — mount BEFORE express.json()
app.post('/webhooks/actionow', express.raw({ type: 'application/json' }), webhookRoute());
app.use(express.json());
app.post('/api/users', onboardRoute(session));
app.post('/api/chat', chatRoute());
app.post('/api/topup', topupRoute(session));
app.post('/api/media', mediaRoute());
app.post('/api/files', filesRoute());
app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(config.port(), () => console.log(`app-starter on :${config.port()}`));
```

- [ ] **Step 2: Verify** — `typecheck` passes; `test` passes.
- [ ] **Step 3: Commit** (gated): `git commit -m "feat(app-starter): express server wiring"`

---

### Task 10: README.md

**Files:** Create `examples/app-starter/README.md`.

- [ ] **Step 1: Write README** covering: what it is (scenario-2 capability-base starter); the file tree; env setup (note tenant-admin + tenant-level proxy key); run (`pnpm i && pnpm start`); the API surface (`/api/{users,chat,topup,media,files}` + `/webhooks/actionow`); the credential map per route; how to swap Express for Hono/Nest (core-kit is framework-agnostic); scenario-1 (managed) variant note; and links to the `building-on-actionow` skill + `actionow-integration` for mechanics.

- [ ] **Step 2: Verify** — links resolve.
- [ ] **Step 3: Commit** (gated): `git commit -m "docs(app-starter): README"`

---

### Task 11: Fact-audit + typecheck/lint/test gate

- [ ] **Step 1:** Run the full local gate: `pnpm -C examples/app-starter install && pnpm -C examples/app-starter typecheck && pnpm -C examples/app-starter test && pnpm -C examples/app-starter lint`. Expected: all green. Fix any type/lint/test failures inline.
- [ ] **Step 2:** Dispatch a fact-audit subagent (source access) to verify every endpoint/credential/field the scaffold uses against real contracts — especially: `/console/subjects` untyped (rawPost right), `/console/api-keys`+`/console/payments/intents`+`/v1/files/presign-upload` typed (client.POST right), payments → `{intent_id,redirect_url?,qr?}`, chat proxy uses raw fetch (relay untyped), webhook body minimal `{job_id}` → GET job, `end_user`=userId(external_id), tenant-admin + tenant-level-key assumptions. Fix criticals/majors inline; re-run the gate.
- [ ] **Step 3: Commit** (gated): `git add examples/app-starter && git commit -m "fix(app-starter): apply Phase-1 audit findings"`

---

### Task 12: Wrap + memory

- [ ] **Step 1:** Update the project memory (building-on-actionow note): Phase 1 scaffold landed at `examples/app-starter/`, Phase 2 remains.
- [ ] **Step 2:** Report the file tree, gate results, and offer Phase 2 (scenario-3 + migration + `docs/ENGINEERING-GUIDE.md`).

---

## Self-Review

**Spec coverage (Phase 1 = spec §4.3 scaffold):** core-kit (client/auth/money/retry/webhook/jobs) → Tasks 2–5 ✓; Express example routes (onboard/chat/topup/media/webhook/files) → Tasks 7–8 ✓; server → Task 9 ✓; store (federation) → Task 6 ✓; boilerplate (pkg/tsconfig/eslint/Dockerfile/.env) → Task 1 ✓; README + framework-swap note → Task 10 ✓; tests → Task 3 ✓; audit gate → Task 11 ✓. (Deferred, explicitly: `scenario-managed/` variant → note in README, full build Phase 2.)

**Placeholder scan:** No TBD/TODO. Every code file has complete content. README (Task 10) enumerates exact sections.

**Type/name consistency:** `config.*()` accessor style consistent across config.ts + all routes; `ConsoleSession.token()`, `userStore.{put,get}`, `UserRow{userId,subjectId,apiKey}`, `rawPost/rawGet`, `callWithRetry`, `formatCredits/creditsToMicro/MICRO_PER_CREDIT` used identically where referenced. SDK calls use only TYPED paths (`/console/api-keys`, `/console/payments/intents`, `/v1/files/presign-upload`, `/v1/jobs/{id}`) via `client.POST/GET`; UNTYPED paths (`/auth/login`, `/console/subjects`, `/console/redeem`, `/v1/chat/completions`) via `rawPost`/`fetch` — matching the corrected 07-sdk-reference coverage map.
