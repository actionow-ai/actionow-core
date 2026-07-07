# Agent Trajectory Capture & Export — Design Spec

> **Status:** Brainstorming output (grounded by a 4-agent research+audit pass). Independent line from the catalog/icon work. Builds on the existing `relay_trace` / `usage_log` best-effort mirror posture.

**Goal:** Produce **one training-data record per agent SESSION** (not per API request) capturing the full chain **User → Assistant → Tool Call → Tool Result → … → Assistant Final**, with 100% tool_call↔tool_result pairing, real failures/retries preserved, full tool definitions, closed-loop only, deduped to the final complete version, filtered to real agent tasks (coding/search/data-analysis).

**Grounding facts (from the audit):**

- **Nothing reads a session/conversation id today** (repo-wide grep = 0). `relay_trace` is per-upstream-HTTP-call, byte-truncated, off-by-default (`RELAY_TRACE=full`), no session correlation (only `job_id`).
- OpenAI Chat Completions + Anthropic Messages are **stateless** — the client **replays the full+growing message history each turn**. So a session's _longest_ request body ≈ its whole trajectory.
- **Codex CLI** sends a stable `session-id` header (UUIDv7, whole run); **Claude Code** has no wire session id but a session-stable `metadata.user_id` + `user-agent: claude-cli`. OpenAI **Responses API** has `previous_response_id`/`conversation` (not a relayed dialect here yet).
- **Streaming currently discards** assistant text + tool-call args — the drain loop (`stream.ts:367-376`) only counts char length for billing. Capturing streamed turns needs net-new accumulation.
- One chat call = one `job` (jobId is the natural per-turn id). `usage_log` has **no jobId column** → streaming usage can't join cleanly.

---

## 1. Session correlation — layered key resolver

Resolve a stable `sessionKey` per request at the chat controller, strict priority, persist `keySource` so explicit groupings are trusted and heuristic ones are provisional/re-runnable. **`sessionKey` is always scoped within `tenantId` — never group across tenants.**

**DECIDED — provider-native id first; the custom header is an optional override.** Use the client's own session id when present (Tier 1); a tenant _may_ additionally set a custom `x-actionow-session-id` to force grouping (Tier 0, takes precedence when used); heuristic is the backfill. We do NOT require clients to send our header.

- **Tier 0 — optional custom override:** if `x-actionow-session-id` is set, use it (`sha256("hdr:"+v)`, `keySource='client_header'`). Same read pattern as `idempotencyKeyHeader(req)` at `openai.controller.ts:40`. Not required — for clients that want explicit control.
- **Tier 1 — provider-native ids (the default path):** Codex `session-id` header (accept `session_id` spelling too); Claude Code `metadata.user_id` (+ user-agent detect); OpenAI Responses `previous_response_id`/`conversation` DAG (forward-compat). "如果有则用他们的".
- **Tier 2 — heuristic prefix-growth (workhorse for stateless replay):** within `(anchorHash, apiKeyId/tenantId, model-family, idle-window 30m)`, `anchorHash = sha256(system + first user msg)`; a shorter turn's full message list being a **prefix** of a longer one ⇒ same session; the longest superset = latest state. Collisions tiebroken by api_key + first-divergence hash. `keySource='prefix_heuristic'`.
- **Tier 3 — coarse last resort:** `sha256(tenant+apiKey+model+window-bucket)`.

Per-turn id = existing `jobId`. Persist `parentTurnKey` (Tier-1 chain parent, else preceding same-session turn).

## 2. Data model (`@actionow/db`, migration 0035 — additive, best-effort, no FKs)

Do **not** overload `relay_trace` (wrong granularity / raw provider bytes). Two new tables:

**`trajectory_turn`** — one row per turn (one job), written best-effort post-settle:
`id, created_at, tenant_id, api_key_id, job_id, sessionKey (idx), keySource, parentTurnKey, clientSurface, dialect, model, providerType, channelId, seq, requestIr jsonb (FULL neutral IR: messages[]+tools[]+params, untruncated), responseMessage jsonb (assembled assistant IR msg incl. toolCalls with arguments as OBJECTS), stopReason, usage jsonb, anchorHash, prefixHash, messageCount, isStream, truncated, status, errorCode, latencyMs`. Indexes: `(sessionKey, created_at)`, `(anchorHash, api_key_id, created_at)`, `(job_id)`.

**`trajectory_session`** — materialized by the assembler (not hot path):
`id, sessionKey (unique), tenant_id, api_key_id, clientSurface, firstTurnAt, lastTurnAt, turnCount, toolCallCount, status (open|closed|incomplete|abandoned), closedLoop, taskType, rejected, rejectReason, exportVersion, contentHash, exportedTrajectory jsonb OR exportRef (R2 key when large)`.

Also: extend `TenantContext` (`auth.service.ts:8-19`) with `sessionId?` + resolved `keySource/clientSurface`; thread `trajectorySessionKey?/keySource?/clientSurface?` into `RunRequest` exactly like `usageLogModel`; **add `job_id` to `usage_log`** (small migration) for clean usage joins. Never store secrets — `requestIr`/`responseMessage` carry messages/tools only; reuse relay-trace header redaction.

## 3. Capture (post-settle best-effort — money/orchestration hot path untouched)

1. Config flag `TRAJECTORY_CAPTURE=off|on` (alongside `RELAY_TRACE`); for raw-wire harvesting raise `RELAY_TRACE_MAX_BYTES` (default 1MB clips long turns).
2. Controllers (openai/anthropic/gemini): read `x-actionow-session-id` + sniff `originator`/user-agent/`x-app`/`anthropic-beta`/`metadata.user_id` → `clientSurface` + key.
3. **Blocking hook:** write `trajectory_turn` at `executeChat` (`execution-service.ts:483-500`, beside the `settleSync` usage_log mirror — `ir`/`response`/`jobId`/served/ctx in scope).
4. **Streaming hook + reassembly:** at `finalize()`/`mirrorChatUsageLog` (`stream.ts:226-246`, runs once in `finally` even on disconnect). MUST add net-new accumulation in the drain loop (`stream.ts:367-376`): concat `content_delta.text` + per-tool-index accumulate `id/name + argumentsDelta` → `JSON.parse` → assembled assistant IR message.
5. **Raw-wire fallback:** assembler can read `relay_trace` (full mode) request/response bodies + parse assembled SSE per dialect when the service-seam capture is absent; truncated rows = incomplete.

## 4. Assembler (offline/async, idempotent, re-runnable)

1. **Group** by sessionKey (trust explicit; re-cluster heuristic by prefix-containment, assign `seq`; split Claude Code sub-agent branches by prefix divergence).
2. **Dedup snapshots:** take the **longest-superset turn's `messages[]` as the canonical spine** (do NOT concatenate per-turn histories — that's the replay-snapshot trap); collapse identical prefixes by content hash.
3. **Pair tool_call↔tool_result (100%):** walk the spine; every assistant `toolCalls[].id` must match a later `role:'tool'` `toolCallId`; arguments normalized to IR objects; parallel calls pair independently.
4. **Streaming reassembly** (if only raw SSE exists): per-dialect parser (OpenAI/Anthropic accumulate arg deltas by index then parse; Gemini whole args/frame).
5. **Closed-loop check:** every call paired AND no dangling tool_calls AND final turn is assistant text with `stopReason != 'tool_calls'`. **Preserve real failures** — a failed tool result + assistant recovery is KEPT (valid signal); reject only UNPAIRED calls or NO final answer → `incomplete`/`abandoned`, excluded from export.
6. **Full tool definitions:** attach session `tools[]` from `requestIr`, deduped to the most complete set (usually last turn).
7. **Version & dedup:** `contentHash` the assembled trajectory; bump `exportVersion` only on change; the final complete version supersedes partials.

## 5. Classification / task filter (on the assembled session)

- **Stage A structural gate:** accept only sessions that **used tools** (`toolCallCount > 0`) AND are closed-loop. This alone drops plain chat / translation / roleplay (tool-free) and media/`/v1/run` (excluded earlier by url/modality). Embeddings/rerank are structurally absent (no endpoints).
- **Stage B label:** `coding` (file/exec/git/test tools or codex/claude-code surface), `search` (web/browse/retrieval tools), `data-analysis` (sql/dataframe/chart/compute tools); reject trivial-tool/roleplay/translate-intent. Ambiguous residue → optional LLM-judge (cost TBD).
- Persist `taskType/rejected/rejectReason`; only accepted, closed-loop, tool-using sessions export.

## 6. Export format (JSONL, one object per session)

`{ session_id, source{client_surface,dialect,key_source,tenant_id,model}, task_type, closed_loop, export_version, tool_definitions[{name,description,parameters}], messages[ system / user / assistant(+tool_calls with arguments as PARSED OBJECTS) / tool(tool_call_id,name,content,is_error) / … assistant final(tool_calls:null) ], tool_pairs[{tool_call_id,called_in_turn,resolved_in_turn,is_error}], turns[{seq,job_id,usage,stop_reason,status}], stats{turn_count,tool_call_count,tokens,duration_ms} }`. Single **deduped canonical spine** (not replayed snapshots); arguments always parsed objects; `is_error` preserved; large records offloaded to R2 (`exportRef`).

## 7. Phases

1. **Capture primitives:** session-header + clientSurface resolve at controllers → TenantContext → RunRequest; `trajectory_turn` table + blocking hook; `usage_log.job_id`.
2. **Streaming reassembly:** drain-loop net-new accumulation → assembled responseMessage on the streaming hook.
3. **Assembler + `trajectory_session`:** group/dedup/pair/closed-loop/tools/version (worker job).
4. **Classification + export:** task filter + JSONL export endpoint/CLI (+ R2 offload).

## 8. Decisions

**DECIDED:**

- **Correlation:** provider-native id first (Tier 1); optional custom `x-actionow-session-id` override (Tier 0); heuristic backfill (Tier 2). Clients are NOT required to send our header.
- **Privacy:** **capture ON by default, per-tenant opt-out** (a `trajectory_opt_out` flag on the tenant; capture is skipped for opted-out tenants). Still: redact credentials, keep a TTL on raw turns, and a tenant setting to purge. (Per the 记录系统 moat — capture broadly, honor opt-out + red lines.)

**STILL OPEN (defaults proposed):**

- **Assembler trigger:** queue-on-idle (30m window) — default; vs scheduled batch / on-demand.
- **Storage:** Postgres jsonb inline; offload to R2 above ~256KB.
- **usage_log.job_id**: add now (small migration) for clean streaming-usage joins — proposed yes.
- **Claude Code sub-agent split:** prefix-divergence heuristic now (don't wait for upstream parent/child ids).
- `/v1/responses` relayed dialect: forward-compat only (not today).
- **Task-type LLM-judge** for ambiguous residue: model/cost TBD (optional).
