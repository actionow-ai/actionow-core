# @actionow/sdk

Fully-typed TypeScript client for the **Actionow** control-plane API.

Every path, method, query param, request body, and response is typed straight
from the OpenAPI contract — which is itself generated from the same zod schemas
the backend validates against. So the types you call against are not
hand-written and cannot drift from the server: if the API changes, the contract
regenerates and your build tells you.

Built on [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/) — a tiny
(~6 kB) typed wrapper over the platform `fetch`.

## Install

```sh
pnpm add @actionow/sdk
# or: npm i @actionow/sdk  /  yarn add @actionow/sdk
```

ESM-only. Runs on any runtime with a global `fetch` (Node 18+, Bun, Deno,
browsers, edge); on older runtimes pass a `fetch` implementation explicitly
(see [Options](#options)).

## Quickstart

```ts
import { createActionowClient } from '@actionow/sdk';

const api = createActionowClient({
  baseUrl: 'https://gateway.example.com',
  token: process.env.ACTIONOW_TOKEN, // sent as `Authorization: Bearer <token>`
});

// GET with a typed, paginated response
const { data, error } = await api.GET('/admin/models');
if (error) throw error;

for (const model of data.data) {
  // `input_price` is a µcredit decimal STRING — see "Money" below
  console.log(model.name, model.input_price);
}
```

`data`, `error`, and the raw `response` come back as a discriminated result —
there are no thrown exceptions for non-2xx responses (see
[Errors](#errors-and-results)).

## Auth

Pass `token` and the client sends `Authorization: Bearer <token>` on every
request. Today that is the admin/console login JWT; a long-lived service token
for machine-to-machine use is on the roadmap. To rotate the token, create a new
client (or pass a custom `fetch`/`headers` that injects it per request).

## Writes

`POST`/`PATCH`/`PUT` take a typed `body`; path params go in `params.path`:

```ts
// Create a tenant — body is `CreateTenantBody`
const { data: tenant, error } = await api.POST('/admin/tenants', {
  body: { name: 'Acme', isolationMode: 'schema' }, // 'field' | 'schema' | 'db'
});

// Path params are typed too
await api.DELETE('/admin/api-keys/{id}', { params: { path: { id: keyId } } });
```

## Tasks (async generation)

The task-paradigm endpoints (`POST /v1/videos/generations`,
`POST /v1/audio/music`, and the generic `POST /v1/tasks` with a `type`) answer
in **two server-decided shapes**: a fast model returns the result inline as
**200**, a slow/task model returns **202 + Task** (the server auto-upgrades
slow operations — there is no client opt-in). `submitTaskAndWait` digests
both:

```ts
import { submitTaskAndWait } from '@actionow/sdk';

const result = await submitTaskAndWait(
  api,
  '/v1/videos/generations',
  {
    model: 'seedance-pro',
    prompt: 'a red bicycle riding itself',
    resolution: '1080p',
  },
  {
    idempotencyKey: crypto.randomUUID(), // §5: same key+body replays, different body ⇒ 409
  },
);

if (result.kind === 'sync') {
  console.log(result.response.output); // 200 — done inline
} else if (result.task.status === 'succeeded') {
  console.log(result.task.output, result.task.served_by); // 202 → polled to terminal
} else {
  console.error(result.task.error); // failed/canceled/expired resolve, never throw
}
```

- `waitForTask(api, taskId, opts)` polls an existing task to a terminal
  status; `GET /v1/tasks/{id}/stream` is the SSE alternative.
- To pre-judge which shape you'll get (e.g. to show a progress UI up front),
  read the discovery face's slow marker: `GET /v1/gateway/models` →
  `operations[].slow` (`operationIsSlow(model, 'images.generation')`).
- Pass `routeTag` to pin supply via `X-Actionow-Route-Tag` (narrow-only).
- Task webhooks (`callback_url` on the create body) are signed with a
  **timestamped** HMAC — verify with `verifyTaskWebhookSignature` from
  `@actionow/sdk/webhook`:

```ts
import { verifyTaskWebhookSignature } from '@actionow/sdk/webhook';

app.post('/webhooks/actionow-tasks', express.raw({ type: 'application/json' }), (req, res) => {
  const v = verifyTaskWebhookSignature(
    req.body, // the RAW bytes — never a re-serialized object
    req.header('X-Actionow-Signature'), // t=<unix>,v1=<hex>
    process.env.ACTIONOW_WEBHOOK_SECRET!, // tenant-level secret configured in core
  );
  if (!v.valid) return res.status(401).json({ error: v.reason });
  const event = JSON.parse(req.body.toString('utf8'));
  // dedupe on event.evt_id (retries reuse it), then act on event.task
  res.sendStatus(200);
});
```

(The legacy `/v1/run` job flow keeps `submitAndWait` + the body-only
`verifyWebhookSignature`; both generations coexist until the old endpoints are
removed.)

## Conventions

### Money

Actionow money is a fixed-point µ-unit (1 credit = 1,000,000 µcredit), carried
as a **string** so no precision is ever lost to a JS `number`. The direction
matters:

- **Responses** — every money/credit field is a µ-unit decimal **string**
  (e.g. `model.input_price === "1500"`). Parse with `BigInt` for math, never
  `Number`.
- **Requests** — amounts are **human numbers** in the body's documented unit
  (e.g. a top-up's `amount_minor` is an integer count of the currency's minor
  unit — cents/fen).

```ts
const { data } = await api.GET('/admin/models');
const totalIn = data!.data.reduce((sum, m) => sum + BigInt(m.input_price), 0n);
```

### Pagination

List endpoints are keyset-paginated and return a uniform envelope:

```ts
{ data: T[], next_cursor: string | null, has_more: boolean }
```

Walk every page by feeding `next_cursor` back as the `cursor` query param:

```ts
let cursor: string | undefined;
const all = [];
do {
  const { data, error } = await api.GET('/admin/jobs', {
    params: { query: { cursor, limit: 100 } },
  });
  if (error) throw error;
  all.push(...data.data);
  cursor = data.next_cursor ?? undefined;
} while (cursor);
```

### Errors and results

Every call returns `{ data, error, response }` and never throws on an HTTP
error. The simplest pattern throws `error` and narrows `data` to the typed
success body for you:

```ts
const { data, error } = await api.GET('/admin/tenants');
if (error) throw error; // non-2xx → `error` is the typed ErrorView envelope
console.log(data.data.length, 'tenants'); // `data` is the typed success body
```

To handle a failure without throwing, branch on `error` — it is the uniform
**`ErrorView`** envelope (`{ error: { code, message, retryable, retry_after_ms? } }`,
typed on every path), and the else branch narrows `data` to defined:

```ts
const result = await api.GET('/admin/tenants');
if (result.error) {
  // result.error.error.code: 'invalid_input' | 'unauthorized' | 'rate_limited' | …
  console.error(result.error.error.code, result.error.error.message, result.response.status);
} else {
  console.log(result.data.data.length, 'tenants');
}
```

## Options

```ts
createActionowClient({
  baseUrl, // API origin, e.g. 'https://gateway.example.com'
  token, // optional bearer token
  headers, // optional extra default headers
  fetch, // optional fetch override (tests, custom agents, older runtimes)
});
```

The return value is the underlying `openapi-fetch` `Client<paths>`, so all of
its features (middleware via `.use()`, per-call `fetch`, `querySerializer`,
etc.) are available.

## Types

Every contract view and request body is re-exported as a named type — the same
shapes the backend produces and validates:

```ts
import type {
  ModelView,
  TenantView,
  CreateTenantBody,
  ConsoleCreateIntentBody,
  paths, // the full OpenAPI path map
  components, // all component schemas
} from '@actionow/sdk';
```

## How the types stay correct

`packages/contracts` holds the zod schemas as the single source of truth. The
backend `.parse()`s responses against them; this package's types are generated
from them (`zod → openapi.json → openapi-typescript`). A CI job regenerates the
spec and the client on every push and fails on any diff, so a published release
can never be stale relative to the contract.

## License

[MIT](./LICENSE) © Actionow
