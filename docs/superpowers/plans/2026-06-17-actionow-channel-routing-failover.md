# P0a + P0b — Multi-channel routing/failover on the chat path + channel admin API

> Source: the relay-landscape comparison sweep flagged that Actionow has weighted-routing
> primitives (`packages/adapters/src/routing.ts`) but the IR chat paths hardcode `channels[0]`
> (`stream.ts:87,221`, `execution-service.ts:310`), so multi-channel configs silently never
> rotate or fail over on `/v1/chat`, `/v1/messages`, Gemini. P0b: the channel admin DTO drops
> `endpoint/model/proxyRef/config` the engine already honors.

## Decisions (user-approved)

- **Cooldown is persisted in Postgres** (not in-memory): a `channel_health` table; backoff decays
  by time-since-last-failure (write only on failure, read on selection) → multi-replica-consistent
  via the shared DB, no in-memory singleton to thread through `buildService`.
- **P0b is full**: extend create with the 4 columns + `PATCH` update + `GET` list.
- Session-affinity (pin a conversation to a channel) is **deferred** (no reliable conversation key
  in the IR; revisit with CLI-OAuth pooling).
- Honoring upstream `Retry-After` is **deferred** (adapters don't surface it yet); the
  `recordChannelFailure(retryAfterMs?)` hook exists for it. Exponential backoff only for now.

## Architecture

- Reuse `selectWeighted` / `routeWithFailover` / `isRetryableAdapterError` (adapters/routing.ts);
  **export `orderForFailover`** for the streaming path (it can't use `routeWithFailover`, which
  returns a value — streaming must commit mid-attempt).
- Engine reads/writes `channel_health` via `deps.db` (same pattern as `settleJob`/`failJob`).
- **Blocking** (`runChat`, and unify `runBlocking`): filter cooled-down channels → `routeWithFailover`
  over the available set; the attempt records failure on a retryable throw.
- **Streaming** (`createChatSettlingStream`): **pre-first-event failover** — iterate
  `orderForFailover(available, rng)`; for each channel get `adapter.streamChat` and pull the FIRST
  event; if it throws (retryable) or the first event is `{type:'error'}` (retryable), record failure
  - try the next channel; once `message_start`/content is forwarded, **commit** (no further
    failover; mid-stream errors stay in-band). All channels exhausted → terminal error frame + release.
- If ALL channels are cooled down, fall back to the full set (try anyway, never hard-503).

## Backoff

`cooldown_until = now + min(BASE·2^(failures-1), CAP)`; `failures` resets to 1 when
`now - last_failure_at > RESET_WINDOW`. BASE=1s, CAP=5min, RESET_WINDOW=5min (constants).

## Tasks (TDD, one commit each)

1. **db schema + migration 0009**: `channel_health(channel_id pk FK upstream_channel, consecutive_failures int, cooldown_until timestamptz null, last_failure_at timestamptz)`. Generate 0009. int test asserts presence.
2. **db repos**: `recordChannelFailure(db, channelId, now, retryAfterMs?)`, `listCooledDownChannelIds(db, channelIds, now)` (P0a); `updateUpstreamChannel(db, id, patch)`, `listChannelsForResource(db, resourceId)` incl. disabled (P0b). int tests.
3. **adapters**: export `orderForFailover`. unit test.
4. **engine routing helper + wire blocking** (`runChat` + `runBlocking` cooldown-aware failover). unit tests (failover order, retryable→next, non-retryable→throw, all-cooled fallback, records failure).
5. **engine streaming failover** (`createChatSettlingStream` pre-first-event failover; thread `db`/`rng` already present). unit tests (fail over before first frame; commit after message_start; all-exhausted→error frame; records failure; settle/hold semantics unchanged).
6. **api P0b**: extend `createChannelSchema` + `admin.service.createChannel` (4 fields); add `PATCH resources/:id/channels/:cid` + `GET resources/:id/channels`; e2e.
7. **Verification gate** + (chat-relay e2e: add a 2-channel failover assertion if feasible with mock-chat).

## Out of scope / non-goals

- No change to media/dify/run text-stream behavior beyond the shared cooldown store (additive).
- No Redis. No session-affinity. No Retry-After parsing.
