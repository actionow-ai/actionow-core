# actionow-integration skill

A self-contained **agent skill** that teaches a third-party developer's coding agent (Claude Code, Codex, Cursor, etc.) how to correctly integrate with an **Actionow / actionow-core** AI gateway — auth, OpenAI-compatible `/v1` calls, async jobs, files, billing/errors, and webhooks.

Core can be used two ways — as a **pure full-modality model gateway** (one tenant-level `ak_` key on `/v1`, no subjects, no federation) or as an **app base** (federate your own end-users as subjects) — and this skill covers the `/v1` call mechanics for both.

It is the contract a third party works from **without** access to actionow-core's source. Everything is verified against the gateway's real contracts (`packages/contracts`, the `/v1` + `/console` controllers).

## What's inside

```
actionow-integration/
  SKILL.md                     ← entry point: mental model, golden path, gotchas, index
  reference/
    01-authentication.md         credentials, Model-A/B, onboarding subjects, keys
    02-chat-and-relay.md         chat (OpenAI/Anthropic/Gemini), embeddings, rerank, moderation
    03-media-jobs-and-files.md   /v1/run, exec modes, jobs, images/audio, file upload/download
    04-billing-and-limits.md     µcredit money, wallets, hold→settle, governance limits
    05-errors-and-idempotency.md error envelope, 11 codes, retry policy, Idempotency-Key
    06-webhooks.md               async-callback + HMAC signature verification
    07-sdk-reference.md          @actionow/sdk client + helpers
    endpoint-catalog.md          every public endpoint, by plane
  scripts/                      runnable, zero-dependency (bash+curl / Node 18+ global fetch)
    smoke-test.sh  chat.mjs  run-and-poll.mjs  onboard-subject.mjs  verify-webhook.mjs
```

## Install it into your agent

**Claude Code / Copilot CLI** — copy the folder into your skills dir; the harness reads `SKILL.md`'s frontmatter and surfaces it by description:

```sh
cp -r actionow-integration ~/.claude/skills/          # personal
# or, per-project:  cp -r actionow-integration .claude/skills/
```

**Codex** — copy into `~/.agents/skills/` (or your configured skills path).

**Cursor / other agents without a skills loader** — point your agent at `SKILL.md` (e.g. reference it from `.cursorrules` / `AGENTS.md`), or just tell the agent to read `actionow-integration/SKILL.md` first.

## Use it

1. Set env vars (see the "Setup" section in `SKILL.md`).
2. Run `scripts/smoke-test.sh` to prove connectivity + auth against your gateway.
3. Let the agent read `SKILL.md`, then follow the golden path and the relevant `reference/*.md` for the task.

## Keeping it accurate

The gateway serves live docs at `GET /docs` (Swagger UI over its OpenAPI spec). If a shape in this skill ever disagrees with a specific gateway's `/docs`, **trust the live gateway** — versions can differ. The canonical source for this skill lives in the actionow-core repo under `skills/actionow-integration/`.
