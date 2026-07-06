# 07 · The `@actionow/sdk` TypeScript client

Optional but recommended for TS/JS apps. Every path, param, body, and response is typed straight from the OpenAPI contract (generated from the same zod schemas the backend validates against), so your types cannot drift from the server. Built on `openapi-fetch` (~6 kB). ESM-only; any runtime with a global `fetch` (Node 18+, Bun, Deno, browsers, edge).

```sh
pnpm add @actionow/sdk    # or npm i / yarn add
```

## The client

```ts
import { createActionowClient } from '@actionow/sdk';

const api = createActionowClient({
  baseUrl: 'https://core.actionow.ai',
  token: process.env.ACTIONOW_TOKEN, // sent as Authorization: Bearer <token>
  // headers?, fetch?  ← optional (custom default headers / fetch override)
});
```

Hold **two** clients — one per plane, because they carry different credentials:

```ts
const consoleClient = createActionowClient({ baseUrl, token: userJwt }); // control plane
const dataClient = createActionowClient({ baseUrl, token: akKey }); // data plane
```

## Results, never throws

Every call returns `{ data, error, response }` — non-2xx does NOT throw:

```ts
const { data, error } = await api.GET('/admin/models');
if (error) throw error; // error is the typed ErrorView envelope
// error.error.code / error.error.message / error.error.retryable / error.error.retry_after_ms
console.log(data.data.length); // data is the typed success body
```

## Writes & path params

```ts
await consoleClient.POST('/console/api-keys', { body: { subjectId } });
await dataClient.POST('/v1/files/{id}/confirm', { params: { path: { id: fileId } } });
```

## Data-plane helpers (re-exported from the package root)

| Helper                                                 | Use                                                                                                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------ |
| `submitAndWait(client, resourceId, runBody, opts?)`    | Submit `/v1/run` in `async-poll` mode and poll `/v1/jobs/:id` to terminal. `opts`: `{ pollMs=1000, timeoutMs=120000, signal? }`. Throws `ActionowApiError` / `JobTimeoutError`. |
| `consumeSse(response)`                                 | Async-iterate raw SSE frames of a streaming `fetch` Response. `SSE_DONE === '[DONE]'` is exported for the chat sentinel.                                                        |
| `consumeJobStream({ baseUrl, jobId, token, signal? })` | Async-iterate `GET /v1/jobs/:id/stream` frames (`snapshot`/`progress`/`done`/`error`).                                                                                          |
| `isTerminalJobStatus(status)`                          | Type guard for `'succeeded'                                                                                                                                                     | 'failed' | 'canceled'`. |

```ts
import { createActionowClient, submitAndWait, consumeSse, SSE_DONE } from '@actionow/sdk';

// async media
const job = await submitAndWait(
  dataClient,
  'image-relay',
  { inputs: { prompt: 'a red bicycle' }, end_user: externalUserId }, // your user handle, not the subject UUID
  { pollMs: 1500, timeoutMs: 180_000 },
);
if (job.status === 'succeeded') {
  /* resolve job.output file_ids via /v1/files */
}

// streaming chat (SDK doesn't wrap the OpenAI dialect — use fetch + consumeSse)
const res = await fetch(`${baseUrl}/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${akKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-4o', messages, stream: true }),
});
for await (const frame of consumeSse(res)) {
  if (frame.data === SSE_DONE) break;
  const chunk = JSON.parse(frame.data);
  if (chunk.error) throw new Error(`stream failed: ${chunk.error.code}: ${chunk.error.message}`);
  process.stdout.write(chunk.choices?.[0]?.delta?.content ?? '');
}
```

Since v0.0.9 a mid-stream failure emits a `data: {"error":{...}}` frame (handled above). A stream that ends **without** `data: [DONE]` is a failed stream — treat it as an error, not a complete response.

## Webhook subpath

```ts
import { verifyWebhookSignature } from '@actionow/sdk/webhook'; // + WEBHOOK_SIGNATURE_HEADER
```

`WEBHOOK_SIGNATURE_HEADER === 'X-Actionow-Signature'` (Node lowercases it to `x-actionow-signature`). See [06-webhooks.md](06-webhooks.md) — remember the delivery body is a minimal `{ job_id }` ping; fetch the job for the result. The `/webhook` subpath uses `node:crypto` — import it only in server code, never a browser bundle.

## Conventions the SDK does NOT hide

- **Money:** response money fields are µcredit decimal **strings** — `sum + BigInt(m.input_price)`, never `Number`. Request money is a human number.
- **Pagination:** list endpoints return `{ data, next_cursor, has_more }`; loop feeding `next_cursor` back as the `cursor` query param.
- **Coverage gap — the typed surface is narrower than it looks.** Only these are in the generated OpenAPI (callable via `client.GET/POST`):
  - `/v1/*`: **only** `/v1/run/{resourceId}`, `/v1/jobs`, `/v1/jobs/{id}`, `/v1/jobs/{id}/cancel`, `/v1/resources`, `/v1/resources/{id}`, the `/v1/files` presign-upload/confirm/list/`{id}`/url routes, and `/v1/audio/transcriptions`. Note `GET /v1/files/usage`, `DELETE /v1/files/{id}`, and `GET /v1/jobs/{id}/stream` exist but are **UNTYPED** — raw `fetch` (use `consumeJobStream` for the stream). The **entire relay dialect is UNTYPED** — `/v1/chat/completions`, `/v1/messages`, `/v1/embeddings`, `/v1/rerank`, `/v1/moderations`, `/v1/images/generations`, `/v1/audio/speech`, `/v1/models`, `/v1beta/models/*` — call all of them (blocking AND streaming) with raw `fetch`, never `client.POST`.
  - `/console/*`: typed = `/console/api-keys*`, `/console/payments/intents*` (and `GET /console/payments`), `/console/settings`, `/console/conversations*`, `/console/files*`, and the GET reads (`/console/{me,balance,models,usage,usage-log,analytics/usage}`). **Untyped → raw `fetch`:** `/console/subjects*` (incl. all `/sub-account/*`, `/limit-plan`, `/limit-status`), `/console/redeem`, `/console/limit-plans*`, `/console/users*`, `GET /console/limits`.
  - `/auth/login` is untyped (`/auth/refresh`, `/auth/logout` are typed).

  When unsure, let `tsc` tell you: an untyped path fails to type-check on `client.POST`, so fall back to `fetch`.

## Types

```ts
import type {
  RunResponse,
  RunJobView,
  ResourceSummary,
  ResourceDetail,
  PresignUploadResult,
  FileView,
  FileUrlResult,
  ErrorView,
  ConsoleApiKeyView /* …plus every admin/console view & request body */,
  paths,
  components,
} from '@actionow/sdk';
```
