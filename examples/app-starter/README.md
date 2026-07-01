# app-starter — capability-base (Model-B) starter

A clonable, compiling TypeScript backend that builds an AIGC app **on** an Actionow / actionow-core gateway using **scenario 2 (capability base)**: you own your users, mirror each into core as a `subject` (`external_id` = your user id), and reuse core's credits / top-up / models / files.

Pairs with the [`building-on-actionow`](../../skills/building-on-actionow/SKILL.md) skill (architecture) and [`actionow-integration`](../../skills/actionow-integration/SKILL.md) (call mechanics). This is a fuller starting point than [`../quickstart`](../quickstart) (which is a minimal API demo).

## File tree

```
app-starter/
  src/
    core-kit/        framework-agnostic helpers over @actionow/sdk
      client.ts        two-client factory (typed) + rawPost/rawGet (untyped routes)
      auth.ts          loginConsole / refresh / ConsoleSession (refreshes via JWT exp)
      money.ts         µcredit BigInt utils
      retry.ts         callWithRetry — branch on error.retryable
      webhook.ts       verifyWebhookSignature (re-export)
      jobs.ts          submitAndWait / consumeJobStream (re-export)
    store/users.ts   in-memory stand-in for YOUR user DB (stores only subject_id + ak_)
    routes/          thin Express handlers
      onboard.ts  chat.ts  topup.ts  media.ts  files.ts  webhook.ts
    config.ts  server.ts
  test/core-kit.test.ts
  package.json  tsconfig.json  eslint.config.js  Dockerfile  .env.example
```

## Setup

```sh
cp .env.example .env      # fill it in
pnpm install
pnpm start                # → app-starter on :8787
```

Two credentials, both server-side:
- `ACTIONOW_CONSOLE_EMAIL/PASSWORD` — a **tenant admin** (create-subject / mint-key / redeem need `tenant_role=admin`, else 403).
- `ACTIONOW_PROXY_API_KEY` — a **tenant-level** `ak_` (no `subjectId`) so per-call `end_user=<your user id>` attributes spend; a subject-scoped key can only serve its one bound user.

## API surface (what your frontend calls)

| Route | Does | Credential used |
| --- | --- | --- |
| `POST /api/users {userId}` | onboard: create subject + mint `ak_`, store both | console JWT (`/console/subjects` raw + `/console/api-keys` typed) |
| `POST /api/chat {userId,messages,stream?}` | proxy `/v1/chat/completions` (blocking + SSE) | that user's `ak_` (raw fetch — relay is untyped) |
| `POST /api/topup {code}` or `{provider,amount_minor,currency}` | redeem 卡密 / payment intent | console JWT |
| `POST /api/media {userId,resourceId,inputs}` | submit `/v1/run` + poll | that user's `ak_` (typed) |
| `POST /api/files {userId,filename,content_type,size}` | presign upload | that user's `ak_` (typed) |
| `POST /webhooks/actionow` | verify raw signature → fetch job | proxy `ak_` |

## Attribution, errors & webhooks

- **Attribution** is via each user's **subject-scoped `ak_`** (minted in `onboard`). That's why `chat`/`media`/`files` don't send `end_user` — the key already fixes the subject. (`end_user` is only honored on `/v1/run`, and only matters with a *tenant-level* key; the chat relay ignores it entirely.) The **tenant-level** `ACTIONOW_PROXY_API_KEY` is used only by the webhook route to read *any* user's job.
- **Errors:** every route is wrapped in `asyncHandler`, and `errorMiddleware` renders a thrown gateway error (`402`/`404`/`429`/timeout) as a clean `{ error }` with the right status — Express 4 would otherwise hang the request and crash the process. `callWithRetry` retries only on `error.retryable` (never `402`/`400`).
- **Webhooks (optional):** by default `media` **polls**. For push, set `PUBLIC_BASE_URL` (an https origin core can reach — a tunnel in dev) and call `POST /api/media { …, webhook: true }`; the run is submitted `async-callback` and core POSTs a signed `{ job_id }` ping to `/webhooks/actionow`, which verifies it and fetches the job. The `ACTIONOW_WEBHOOK_SECRET` must match the secret configured for your callback URL on the core side.
- **onboard is idempotent** on `userId` (a repeat returns the existing subject, never mints a duplicate). If `onboard`/`topup` returns `403`, your console account isn't a **tenant admin**.

## Typed vs untyped (why some calls use the SDK and some use raw fetch)

`@actionow/sdk` only types the OpenAPI surface. **Typed** (`client.POST/GET`): `/console/api-keys*`, `/console/payments/intents*`, `/v1/run`, `/v1/jobs*`, `/v1/resources*`, `/v1/files*`. **Untyped → raw fetch** (`core-kit` `rawPost/rawGet`): the whole relay dialect (`/v1/chat/completions`, `/v1/embeddings`, …), `/auth/login`, `/console/{subjects,redeem,limit-plans}*`. See [actionow-integration/reference/07-sdk-reference.md](../../skills/actionow-integration/reference/07-sdk-reference.md).

## Swapping the framework

`core-kit/` is framework-agnostic — only `routes/` and `server.ts` touch Express. To use Hono/Nest/Next, keep `core-kit/` and `store/`, and re-wire the handlers. To use a real DB, replace `store/users.ts` (it already stores only core IDs, so it's a thin swap).

## Scenario 1 (managed, Model-A) variant

If you don't want to own users, let core authenticate them (Model-A) and keep just the `chat`/`topup` proxy routes (drop `onboard`), validating a member JWT from the frontend instead of your own session. See [building-on-actionow/reference/02-scenario-managed.md](../../skills/building-on-actionow/reference/02-scenario-managed.md).

## Dev commands

```sh
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest (money + retry)
pnpm lint        # eslint
```
