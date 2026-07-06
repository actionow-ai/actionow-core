# Build an app on Actionow core

How an internal team builds a **new app** on top of Actionow core, fast.

Core is a multi-tenant AI-relay middle-platform. It gives you AI relay (chat /
image / video / audio), a credit ledger, payments, object storage, and a
billing-attribution identity for every end-user. **Your app keeps its own
database, users, and business logic** and runs a thin server that holds a core
credential and calls core. You reference core only by the stable IDs it returns
(`subject_id` / `file_id` / `job_id`).

A runnable, typed reference backend lives in
[`examples/quickstart`](../examples/quickstart). This doc is the map; that
example is the territory.

---

## 1. Responsibility split — core vs. your app

| Concern           | **Core owns**                                                           | **Your app owns**                                         |
| ----------------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| End-user identity | The `subject` (stable billing/attribution id, governance dim)           | The real user: profile, password, sessions, business data |
| AI relay          | Provider keys, routing, fallback, circuit-breaking, dialect translation | Prompt construction, product UX                           |
| Money             | Credit ledger, holds, settlement, payments, 卡密                        | When/whether to charge YOUR user (your pricing)           |
| Budgets           | Tenant pool + per-subject sub-wallets + governance limit plans          | Deciding each user's budget                               |
| Storage           | The S3 bucket, presigned URLs, file lifecycle                           | Which files matter, and your own metadata about them      |
| Jobs              | Async queue, polling, webhooks, settlement                              | Correlating a `job_id` back to a user request             |

Rule of thumb: if it touches a **provider key, a credit, or a stored byte**, it's
core's. Everything that makes your product YOUR product is yours.

---

## 2. The federation principle — your DB stores core's IDs

You do **not** mirror core's data into your app, and core does **not** know your
business data. You federate by storing core's stable IDs on your own rows:

```
your_app.users
  id            (your PK)            ← your user
  actionow_subject_id   text         ← core subject id (the join key)
  actionow_api_key      text (enc)   ← that subject's ak_… data-plane key (optional)
```

- `subject.external_id` is **Model-B**: you set it to your own user id, and it is
  **immutable**, so it's a perfect reverse join key.
- A generated media asset comes back as a directly-fetchable **url** in the job
  output (`output.assets[].url`), not a `file_id`; store the `job_id` and re-fetch —
  never mirror the bytes. (`file_id`s are for files **you** upload — see Step 5.)
- An async generation returns a `job_id`; store that against the request row so a
  webhook (or a poll) can resolve it back to the user.

Onboard a user once, persist the IDs, and every later call is keyed off them.

---

## 3. The auth / credential cheat-sheet

Core has four credential types, one per plane. **Your thin backend mainly holds
two**: a tenant-admin USER JWT (control plane) and per-user `ak_…` keys (data
plane).

| Credential                    | Looks like                                             | Plane / routes                                               | Verified by                                 | Who holds it                                        |
| ----------------------------- | ------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------- | --------------------------------------------------- |
| **Data-plane API key**        | `ak_…` (Bearer or `x-api-key`)                         | `/v1/*` (chat, run, jobs, files, resources)                  | `ApiKeyGuard`                               | One per end-user; your server (or a trusted client) |
| **Console USER JWT**          | a JWT from `POST /auth/login`                          | `/console/*` (subjects, api-keys, wallets, limits, payments) | `ConsoleGuard` (+ `@TenantAdmin` on writes) | Your server only — high trust                       |
| **Admin service token (M2M)** | `at_…` (Bearer)                                        | `/admin/*` (platform operator)                               | `AdminGuard`                                | Platform operators / cross-tenant tooling           |
| **Member JWT**                | a JWT from `POST /auth/login-member` (`typ:'subject'`) | `/member/*` (read-only self-service)                         | `MemberGuard`                               | An end-user logged into your app via core Model-A   |

Notes:

- The **console JWT is tenant-admin** — it can mint keys and move credits for any
  subject in your tenant. Keep it server-side; never ship it to a browser.
- The **member JWT** is the read-only end-user token (`GET /member/me`,
  `/member/usage`, `/member/balance`, `/member/api-keys`, `/member/limits`). Use
  it only if you let core authenticate your end-users (Model-A email login); with
  Model-B (`external_id`) you typically don't.
- The `at_` admin token is for the **platform `/admin` plane**, not for an app
  backend. An app manages its own end-users through `/console/*`, not `/admin/*`.

Send any of them as `Authorization: Bearer <credential>`.

---

## 4. The ordered integration flow

Each step lists the route, the plane, and both a `curl` and an `@actionow/sdk`
snippet. Money in **request** bodies is human numbers; money in **responses** is
a **µcredit decimal string** (`1 credit = 1e6 µcredit`; parse with `BigInt`).

### Step 0 — log in (control plane)

```sh
curl -sX POST "$CORE/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"admin@yourapp.example","password":"…"}'
# → { "token": "<USER JWT>" }
```

```ts
import { createActionowClient } from '@actionow/sdk';

const res = await fetch(`${baseUrl}/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const { token } = (await res.json()) as { token: string };
const consoleClient = createActionowClient({ baseUrl, token }); // typed control-plane client
```

### Step 1 — register the end-user as a subject (control plane)

`POST /console/subjects` — Model-B: `externalId` = your own user id (immutable).

```sh
curl -sX POST "$CORE/console/subjects" \
  -H "authorization: Bearer $JWT" -H 'content-type: application/json' \
  -d '{"externalId":"user_42","displayName":"Ada Lovelace"}'
# → { "id":"sub_…", "external_id":"user_42", "status":"active", … }
```

```ts
const res = await fetch(`${baseUrl}/console/subjects`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ externalId: 'user_42', displayName: 'Ada Lovelace' }),
});
const subject = await res.json(); // { id, external_id, … } — persist subject.id
```

> `/console/subjects` is not yet in the generated OpenAPI surface, so the SDK
> client doesn't type it; call it with `fetch`. (`/console/api-keys` below IS
> typed.)

### Step 2 — mint a subject-scoped API key (control plane)

`POST /console/api-keys` with `{ subjectId }` — the `ak_…` is returned **once**.

```sh
curl -sX POST "$CORE/console/api-keys" \
  -H "authorization: Bearer $JWT" -H 'content-type: application/json' \
  -d '{"subjectId":"sub_…"}'
# → { "id":"key_…", "plaintext":"ak_…" }   ← store ak_… now; unrecoverable
```

```ts
const { data, error } = await consoleClient.POST('/console/api-keys', {
  body: { subjectId: subject.id },
});
if (error) throw error;
const apiKey = data.plaintext; // ak_…  → persist (or rotate later)
```

### Step 3 — chat (data plane, the user's key)

`POST /v1/chat/completions` — OpenAI-wire. Set `stream:true` for SSE.

```sh
curl -sX POST "$CORE/v1/chat/completions" \
  -H "authorization: Bearer $AK" -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'
```

```ts
import { consumeSse, SSE_DONE } from '@actionow/sdk';

const res = await fetch(`${baseUrl}/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-4o', messages, stream: true }),
});
for await (const frame of consumeSse(res)) {
  if (frame.data === SSE_DONE) break;
  const chunk = JSON.parse(frame.data); // chat.completion.chunk
  if (chunk.error) throw new Error(`stream failed: ${chunk.error.code}: ${chunk.error.message}`);
  process.stdout.write(chunk.choices?.[0]?.delta?.content ?? '');
}
```

The pre-flight credit hold runs **before** the first SSE byte, so an
insufficient-credits / invalid-input failure is a real non-2xx HTTP error, not an
in-band frame. A **post-commit** upstream failure (after streaming has begun)
instead arrives as a terminal `data: {"error":{…}}` frame and the stream ends
**without** `[DONE]` — handle it (as above) and treat a missing `[DONE]` as an
abnormal end.

When one model name is served by several channels, core routes automatically. To
**pin** a call to a specific channel (e.g. an official key vs a reseller), send the
`X-Actionow-Route-Tag` header, or bind the key to a route group — see the
`actionow-integration` skill's _Pinning a channel_ section.

### Step 4 — async media (data plane, submit + poll)

`POST /v1/run/:resourceId` → poll `GET /v1/jobs/:id` to a terminal status
(`succeeded` / `failed` / `canceled`). Discover resource ids via `GET /v1/resources`.

```sh
JOB=$(curl -sX POST "$CORE/v1/run/image-relay" \
  -H "authorization: Bearer $AK" -H 'content-type: application/json' \
  -d '{"inputs":{"prompt":"a red bicycle"},"exec_mode":"async-poll"}' | jq -r .job_id)
curl -s "$CORE/v1/jobs/$JOB" -H "authorization: Bearer $AK"   # repeat until terminal
```

```ts
import { submitAndWait } from '@actionow/sdk';

const data = createActionowClient({ baseUrl, token: apiKey });
const job = await submitAndWait(
  data,
  'image-relay',
  { inputs: { prompt: 'a red bicycle' } }, // the ak_ is subject-scoped → spend attributes automatically
  { pollMs: 1500, timeoutMs: 180_000 },
);
// output for a media relay = { kind:"media", assets:[{ url, mime, … }] }; urls are directly fetchable
if (job.status === 'succeeded') console.log(job.output);
```

The **push alternative** to polling: submit with `exec_mode:"async-callback"` +
`callback_url` and core POSTs a **signed** webhook when the job is terminal — see
§5.

### Step 5 — object storage (data plane)

Presign → PUT to storage → confirm. All three control calls are typed; the PUT is
direct-to-storage (no API request / no credits).

```sh
# 1. presign
curl -sX POST "$CORE/v1/files/presign-upload" \
  -H "authorization: Bearer $AK" -H 'content-type: application/json' \
  -d '{"filename":"a.png","content_type":"image/png","size":12345}'
# → { file_id, upload_url, key, expires_in, public_url }   # public_url: stable non-expiring link (null if unconfigured)
# 2. PUT bytes to upload_url (the storage host)
curl -sX PUT "$UPLOAD_URL" -H 'content-type: image/png' --data-binary @a.png
# 3. confirm
curl -sX POST "$CORE/v1/files/$FILE_ID/confirm" -H "authorization: Bearer $AK"
# download grant
curl -s "$CORE/v1/files/$FILE_ID/url" -H "authorization: Bearer $AK"   # → { url, expires_in, public_url }
```

```ts
const presign = await data.POST('/v1/files/presign-upload', {
  body: { filename: 'a.png', content_type: 'image/png', size: bytes.byteLength },
});
await fetch(presign.data!.upload_url, {
  method: 'PUT',
  headers: { 'content-type': 'image/png' },
  body: bytes,
});
await data.POST('/v1/files/{id}/confirm', { params: { path: { id: presign.data!.file_id } } });
const dl = await data.GET('/v1/files/{id}/url', {
  params: { path: { id: presign.data!.file_id } },
});
```

---

## 5. Webhooks — the job-done callback

When you submit a run with a `callback_url`, core POSTs the terminal job to it and
**signs the delivery**: `HMAC-SHA256(secret, rawBody)` as lowercase hex in the
`X-Actionow-Signature` header (see `packages/engine/src/webhook.ts`). Verify it
over the **raw bytes** — do not parse-then-restringify before verifying.

```ts
import express from 'express';
import { verifyWebhookSignature } from '@actionow/sdk/webhook';

app.post('/webhooks/actionow', express.raw({ type: 'application/json' }), (req, res) => {
  const result = verifyWebhookSignature(
    req.body, // Buffer — the raw bytes
    req.header('X-Actionow-Signature'),
    process.env.ACTIONOW_WEBHOOK_SECRET!,
  );
  if (!result.valid) return res.status(401).json({ error: result.reason });
  const job = JSON.parse(req.body.toString('utf8')); // { job_id, status, output, … }
  // … resolve job_id → your request row, mark done, notify the user
  res.sendStatus(200); // 2xx → core marks the delivery `sent` (else it retries, then dead-letters)
});
```

The shared signing secret is resolved per webhook URL on the core side; configure
the matching secret in your app. If core can't resolve a secret for the URL it
sends the delivery **unsigned** (no header), which `verifyWebhookSignature`
reports distinctly as `missing-signature` so you can fail closed.

---

## 6. Funding and metering end-users

Money is two-level: a **tenant pool** (your master balance) and optional
**per-subject sub-wallets** (HARD mode) allocated from it.

```
                redeem 卡密 / payment
                        │
              ┌─────────▼─────────┐
              │   TENANT POOL     │   /console/balance, /console/payments/intents, /console/redeem
              └─────────┬─────────┘
            allocate (conserving — never minted)
        ┌───────────────┼───────────────┐
   ┌────▼────┐     ┌────▼────┐      ┌────▼────┐
   │subject A│     │subject B│      │ (no wallet → spends the shared pool)
   │sub-wallet     │sub-wallet
```

| Goal                               | Route (control plane)                             | Body                                    |
| ---------------------------------- | ------------------------------------------------- | --------------------------------------- |
| Top up the tenant pool with a 卡密 | `POST /console/redeem`                            | `{ code }`                              |
| Top up the tenant pool via payment | `POST /console/payments/intents`                  | `{ provider, amount_minor, currency }`  |
| Open a subject sub-wallet          | `POST /console/subjects/:id/sub-account/open`     | `{ credits? }` (opening balance, human) |
| Allocate credits to a subject      | `POST /console/subjects/:id/sub-account/topup`    | `{ credits }` (human)                   |
| Move credits pool ↔ subject        | `POST /console/subjects/:id/sub-account/transfer` | `{ credits, direction }`                |
| See a subject's balance            | `GET /console/subjects/:id/sub-account`           | —                                       |

Sub-wallet topup/transfer are **conserving**: they move credits out of the tenant
pool, never mint them, and fail atomically if the pool is short. A subject with no
sub-wallet spends directly against the tenant pool.

**Governance limits** (rate / spend / tokens caps) are a separate dim: define a
reusable plan with `POST /console/limit-plans`, then bind it to a subject with
`POST /console/subjects/:id/limit-plan` (`{ planId }`); read live usage at
`GET /console/subjects/:id/limit-status`. A subject's `ak_…` key is then rate- and
budget-limited automatically (429 / 402 on breach).

---

## 7. Two tenancy models for end-users

- **Model-B (recommended for app-on-core):** your app authenticates its own users;
  you mirror each one as a subject with `external_id` = your user id and mint them
  an `ak_…` key. Core never sees a password. This doc's flow.
- **Model-A:** core authenticates the end-user (email + password under your
  tenant) via `POST /auth/register-member` / `POST /auth/login-member`, which
  issues a member JWT for the read-only `/member/*` self-service plane.

Both attribute spend, limits, and ownership down to the individual subject.

---

## 8. Where to go next

- [`examples/quickstart`](../examples/quickstart) — the typed reference backend
  (every step above as compiling code).
- [`packages/sdk/README.md`](../packages/sdk/README.md) — the typed client:
  money/pagination/error conventions, plus the `submitAndWait`, `consumeSse`, and
  `verifyWebhookSignature` data-plane helpers.
- [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) — running core itself and wiring
  provider keys.
