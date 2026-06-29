# Playground — Shell + Chat (sub-project 1)

**Date:** 2026-06-29
**Status:** approved direction (brainstormed Q1–Q6), implementing

A ZenMux-style interactive playground for the **tenant operator** plane (`/app`).
A user picks a model and runs prompts, seeing results + live metrics. Built as a
multi-tool **shell** so image / video / audio drop in as later sub-projects. This
spec covers **sub-project 1 only: the shell + the chat (text) tool.**

## Decisions (from brainstorming)

| #                   | Decision                                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audience / home     | Tenant operator, route `/app/playground` (JWT-authed). Bills the tenant account.                                                                                |
| Execution / auth    | Browser calls the existing data-plane `POST /v1/chat/completions` (SSE) with a tenant **API key**. No new execution endpoints.                                  |
| Scope               | Shell + Chat first. Image / video / audio are separate later sub-projects (own spec→plan→build).                                                                |
| History persistence | **Backend** — new `conversation` / `message` tables + `/console/conversations` CRUD (cross-device).                                                             |
| API-key UX          | Auto find-or-mint a dedicated tenant key named `playground`; cache `{id, plaintext}` in `localStorage`; recover via rotate when plaintext lost; re-mint on 401. |
| Layout              | **A — dedicated full-height chrome**: left tool-rail + conversation panel + chat canvas + top model selector. Auto-collapses the `/app` sidebar.                |

## Clean split

- **Generation** reuses the data plane (API key → `/v1/chat/completions`). The
  relay's `pipeSse` is a transparent passthrough, so `reasoning_content` deltas
  and a final `usage` chunk flow straight to the client. The playground sends
  `stream:true, stream_options:{include_usage:true}`.
- **Transcript** is tenant-scoped JWT data like any other `/console` resource —
  persisted via new `/console/conversations` endpoints, NOT via the API key.

## Architecture

Playground is a **top-level nav group** in the `/app` icon rail (no separate
tool-rail column — that was redundant with the rail). The **2nd-column sub-nav**
(`ConsoleLayout`'s standard `SubNav`) is the modality switcher: 对话 / 图片 / 视频 /
音频. Each modality is a routed sibling under `/app/playground/*`; only Chat is live.

```
/app icon rail  →  [home] [✦ playground] [account]        (column 1)
   playground active → SubNav: 对话 / 图片 / 视频 / 音频    (column 2)
      /app/playground/chat   → ChatTool                    (the Outlet)
      │  ├─ ConversationPanel   "新对话" + saved list, rename/delete   (column 3)
      │  └─ ChatCanvas
      │     ├─ TopBar          PlaygroundModelPicker (text models)
      │     ├─ ChatTranscript  ChatMessage[] (reasoning + content + metrics)
      │     └─ ChatComposer    textarea + send/stop
      /app/playground/{image,video,audio} → PlaygroundComingSoon
```

`/app/playground` redirects to `/app/playground/chat`. Frontend feature dir:
`apps/web/src/features/app/playground/`. Later phases swap each `PlaygroundComingSoon`
route for the real `ImageTool`/`VideoTool`/`AudioTool` — the nav group + sub-nav are
already in place, so no shell changes.

## Backend — conversation persistence

**Schema (new migration):**

- `conversation`: `id` uuid pk, `tenant_id` fk, `subject_id` fk nullable (attribution),
  `title` text, `model` text (last-used model name), `created_at`, `updated_at`,
  `deleted_at` (soft-delete). Index `(tenant_id, deleted_at, updated_at desc)`.
- `message`: `id` uuid pk, `conversation_id` fk (cascade), `seq` int (per-conversation
  order), `role` text CHECK in `('user','assistant','system')`, `content` text,
  `reasoning` text nullable, `usage` jsonb nullable (`{input,output}`),
  `latency_ms` int nullable, `model` text nullable, `created_at`. Index
  `(conversation_id, seq)`. Append-only in spirit (no business UPDATE).

**Endpoints (`/console/conversations`, ConsoleGuard, tenant-scoped via JWT):**

- `GET /console/conversations` → keyset list `{id,title,model,updated_at}` newest-first.
- `POST /console/conversations` `{title?, model?}` → conversation.
- `GET /console/conversations/:id` → conversation + ordered messages (404 cross-tenant).
- `PATCH /console/conversations/:id` `{title?, model?}` → updated.
- `DELETE /console/conversations/:id` → 204 (soft-delete).
- `POST /console/conversations/:id/messages` `{role, content, reasoning?, usage?, latency_ms?, model?}`
  → appended message (server assigns `seq`, bumps conversation `updated_at`).

**Contracts:** zod `conversationView`, `conversationDetailView`, `messageView`,
`createConversationBody`, `updateConversationBody`, `appendMessageBody`; register
the 6 paths in `openapi.ts`; regen `openapi.json` + SDK (reproducible).

## Frontend

- **`consoleApi`**: list/create/get/rename/delete conversations + appendMessage.
  `qk.conversations()` + `qk.conversation(id)`. Re-export types in `types.ts`.
- **`usePlaygroundKey`**: find-or-mint the `playground` key (see API-key UX).
  Returns `{ key, ready, error }`. Disables the composer until `ready`.
- **`useChatStream`**: `fetch` + `ReadableStream` POST to `/v1/chat/completions`
  with `Authorization: Bearer <playground key>`, body
  `{model, messages, stream:true, stream_options:{include_usage:true}, ...params}`.
  Parses OpenAI SSE frames: accumulates `delta.content` and `delta.reasoning_content`
  separately; captures the final `usage`; closes on `[DONE]`. Measures **TTFT**
  (延迟) and **total** (总计) client-side. `AbortController` for stop. Returns the
  in-progress `{content, reasoning, usage, ttftMs, totalMs, status, error}`.
- **Run loop** (optimistic + persist-on-completion): user sends → append a user
  `message` (optimistic UI + `POST …/messages`) → stream the assistant reply via
  `useChatStream` → on completion, append the assistant `message` (content +
  reasoning + usage + latency). A new conversation is `POST`ed lazily on first send
  (title derived from the first user message; renameable).
- **Markdown**: no renderer in the repo; v1 renders assistant text with preserved
  whitespace + fenced-code-block detection (a small local helper). Full markdown
  (react-markdown) is a deferred enhancement.
- **Model picker**: `/console/models` filtered to text/chat modality; a searchable
  dropdown (reuse `ComboboxField`/`Select` patterns + the model-facet rendering
  from `AppModels`) showing display name, maker icon, context, pricing.

## Error handling

- Key mint failure → toast + disabled composer with a retry.
- `/v1` stream error (network / 4xx / 5xx) → error bubble + toast; allow regenerate.
- `402` (insufficient balance) → explicit message + link to `/app/billing`.
- Persistence `POST` failure → **best-effort**, non-blocking toast; the streamed
  transcript stays in the UI (never lose generated content).
- No text models visible → empty state with guidance.

## Testing

- **Frontend (vitest + RTL):** `useChatStream` SSE parsing (content/reasoning split,
  usage, `[DONE]`, abort, error frame); `usePlaygroundKey` (cache hit / mint /
  rotate-recover / 401 re-mint); `ChatMessage` reasoning toggle + metrics render;
  `ConversationPanel` list/empty.
- **Backend (e2e):** conversations CRUD lifecycle, message append + `seq` ordering,
  tenant-scoping (cross-tenant 404), soft-delete delisting.

## Out of scope (v1)

Image / video / audio tools; multi-turn parameter editing beyond a minimal
temperature/system-prompt panel; backend-side streaming relay over JWT; sharing /
export; full markdown rendering; cross-conversation search.

## Billing / attribution

`/v1` calls bill the tenant account through the existing governance hold/settle on
the API key. The dedicated `playground` key isolates playground usage for
attribution. No new billing logic.
