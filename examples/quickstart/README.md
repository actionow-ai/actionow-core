# Actionow quickstart — a thin app backend

A runnable, **fully typed** example of the smallest correct "app on core" backend.
It demonstrates the whole integration flow end to end as readable code:

| Step                                                                 | File                      | Plane / credential |
| -------------------------------------------------------------------- | ------------------------- | ------------------ |
| (a) hold a tenant-admin control-plane credential                     | `src/client.ts`           | console — USER JWT |
| (b) register an end-user as a core `subject` (Model-B `external_id`) | `src/onboard-user.ts`     | console            |
| (c) mint a subject-scoped `ak_…` API key                             | `src/onboard-user.ts`     | console            |
| fund + meter the end-user (sub-wallet, 卡密)                         | `src/fund-user.ts`        | console            |
| (d) chat — blocking + streaming (SSE)                                | `src/chat.ts`             | data plane — `ak_` |
| (e) async media job — submit + poll to completion                    | `src/media.ts`            | data plane         |
| (f) object storage — presigned upload + download                     | `src/files.ts`            | data plane         |
| (g) job-done webhook receiver (HMAC-verified)                        | `src/webhook-receiver.ts` | inbound from core  |
| the narrative tying it together                                      | `src/main.ts`             | both               |

## The idea in one sentence

**Core** provides AI relay + credits + payments + object storage +
billing-attribution identity. **Your app** owns its own DB, users, and business
logic, and runs a thin server that holds a core credential and calls core,
referencing core's stable IDs (`subject_id` / `file_id` / `job_id`).

The full guide — responsibility split, federation principle, auth cheat-sheet —
is in [`../../docs/INTEGRATION.md`](../../docs/INTEGRATION.md).

## Run it

The example is wired to the workspace `@actionow/sdk` and typechecks standalone
(it does not need a live core to compile):

```sh
# typecheck (the validation gate)
pnpm -C examples/quickstart typecheck

# run against a real core (set the env first)
ACTIONOW_BASE_URL=https://gateway.example.com \
ACTIONOW_CONSOLE_EMAIL=admin@yourapp.example \
ACTIONOW_CONSOLE_PASSWORD=... \
pnpm -C examples/quickstart start
```

## What to copy into your app

- The **two-client split** (`src/client.ts`) — never mix the high-trust console
  credential with the per-user data-plane key.
- The **onboard-once, store-the-IDs** pattern (`src/onboard-user.ts`) — your app
  DB keeps `subjectId`; everything later is keyed off it.
- The SDK helpers `submitAndWait`, `consumeSse`, and `verifyWebhookSignature`
  (from `@actionow/sdk`) — they cover the async-poll loop, SSE parsing, and
  webhook authentication so you don't hand-roll them.
