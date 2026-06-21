# Development Plan — multi-modal AIGC + relay (2026-06-20)

Unifies three threads: the SDK-foundation track (provision endpoint, typed errors),
the AIGC-e-commerce-product scenario (①), and the multi-modal relay-station scenario
(②). All effort is S (<1d) / M (a few days) / L (1–2wk+), grounded in verified code.

> **Status update (2026-06-20): Phase 2 (image relay MVP) is IMPLEMENTED.** Real-key
> validation showed the huimengi relay (`seedream-4.5`/`seedance-2.0`) already matches
> the `async-media` protocol byte-for-byte, so 2a (a new adapter) was unnecessary.
> Shipped: per-image/per-second metering (`{images:N}`/`{duration_seconds:S}`),
> per-unit pricebook, batch-N-images persistence (N objects, not 1), and img2img
> input wiring (`resolveFileInputs` → RunService + reference-image passthrough).
> Verified live: actionow's adapter generated a real product image via huimengi,
> persisted it to R2, served from `asset.actionow.ai`, metering `{images:1}`. The
> open item is the exact huimengi img2img param name (needs their docs to finalize).

## Unifying insight

Both scenarios share ONE backbone and ONE set of gaps. What's done vs not:

- **DONE (the hard part):** multi-tenant + credits + hold→settle ledger + `ak_` keys
  (allowlist/rate-limit/group-bind) + channel routing (priority failover) + official
  prices & margin + relay-trace audit + payments (stripe/alipay/wechat/crypto) +
  redemption codes + admin/console frontend + contract-first `@actionow/sdk` (control
  plane) + M2M admin service tokens. **LLM relay (OpenAI/Anthropic/Gemini dialects,
  streaming) and Dify-workflow relay are production-grade.** The async job spine
  (durable BullMQ+Redis queue, hold→settle, HMAC callbacks, reaper) is production-grade.
- **NOT done (the app-defining 30% of the data plane):** no REAL media adapter (only a
  generic `async-media` stub + mock); image-INPUT (`resolveFileInputs`) unwired into
  `RunService`; usage is flat `{tasks:1}` so no per-image/per-second billing; ~30s poll
  ceiling times out video; audio is enum-only; `@actionow/sdk` has ZERO data-plane
  (`/v1/*`) paths; media has no OpenAI-compatible dialect endpoints.

So: **LLM + Dify can launch today; the multi-modal work is finishing, not greenfield.**

## Phase 0 — Launch LLM + Dify relay (no build; ops only)

Already production-grade. To actually run it as a relay: register upstream channels
(provider creds via `/admin/secrets` + channel bindings), set route groups/prices, mint
tenant `ak_` keys. Downstream users point their OpenAI/Anthropic/Gemini SDK at the
gateway `base_url`. **Milestone: a billing, multi-tenant LLM+Dify 中转站 is live.**

## Phase 1 — Finish the SDK foundation (serves BOTH scenarios)

> **Status (2026-06-20): DONE.** 1a — atomic `POST /admin/provision` ({tenant, account,
> key} in one tx). 1b — `ErrorView` envelope typed on every path (the SDK `error` branch
> now narrows; was `never`). 1c — the data plane is in the SDK (`/v1/run`, `/v1/jobs`,
> `/v1/resources`, `/v1/files`; run/presign bodies sourced from contracts so SDK types
> can't drift from validation). 72 schemas / 59 paths. **Milestone reached.**

The control-plane SDK is done; these close it out and extend it to the data plane.

- **1a. One-step provision endpoint** `POST /admin/provision` → `{tenant, account, key}`
  atomically (M, core). Collapses the 3-round-trip signup into one typed SDK call;
  callable programmatically with the new M2M token. _Unlocks: embed-as-backend (①) and
  per-customer onboarding for a relay (②)._
- **1b. Typed error / ProblemDetails schema** on common codes (400/401/403/404/409)
  (M, core). The contract currently declares zero non-2xx bodies (surfaced when writing
  the SDK README). One `ErrorView` in the zod source, attached across all paths → the
  failure surface becomes typed for every SDK consumer. _backlog #4._
- **1c. Data-plane in the SDK** — register `/v1/run`, `/v1/jobs`, `/v1/files`,
  `/v1/resources` (+ models) into the OpenAPI/contract pipeline (M, core). Today the SDK
  is control-plane-only; the product hot path is hand-rolled. _This is the bridge between
  the SDK track and the data plane — both scenarios need it._

**Milestone: a developer can `provision a customer → submit a job → poll → download`
entirely through a typed, drift-proof `@actionow/sdk`.**

## Phase 2 — Image generation/relay MVP (the highest-leverage modality)

- **2a. One REAL image adapter** against a chosen provider (fal / Replicate / OpenAI-
  images style): `submit/poll/parseCallback/extractUsage/mapError`, modeled on
  `async-media.ts`; register it (M, core). _Unblocks real image generation OOTB._
- **2b. Granular usage + unit pricing** — make `extractUsage` emit `{images:N}` (and
  `{duration_seconds:S}` for video) from the provider payload; author a per-resource unit
  pricebook (M, core). _Without this, media bills flat-per-job and a per-image pricebook
  silently undercharges missing dims to 0._
- **2c. Turn on storage** — set `STORAGE_*` + `STORAGE_PUBLIC_BASE_URL` so output media
  is copied to R2/S3 + a `file_object` row is written (S, ops). Already wired on the
  async/callback paths; OOTB it returns the ephemeral upstream URL.
- **2d. Wire image INPUT** — call `resolveFileInputs` in `RunService.buildRequest`
  (file*id→presigned GET) + add an `init_image`/reference passthrough in the adapter's
  `buildParams` (M, core). \_Enables the defining e-commerce flow: upload product photo →
  img2img variant.*

**Milestone: image generation/relay works end-to-end — submit (with optional input
image) → poll → download, billed per image. E-commerce "product photo → variants"
closes.** (Image PoC = Phase 1c + 2a–2d.)

## Phase 3 — Video

> **Status (2026-06-20): DONE (poll-budget approach).** 3a shipped via a per-channel
> poll budget: the job-runner reads `maxPolls`/`pollIntervalMs` off the channel config
> (falling back to the deps/30s default), and the seeded video channel carries
> `maxPolls:120, pollIntervalMs:5000` (≈10 min). 3b was already covered — seedance-2.0
> shares the `async-media` path, `{duration_seconds}` metering shipped in P2, and
> persistence covers `video_url`. So multi-minute video no longer times out.

- **3a. Long-horizon execution** — ✅ per-channel poll budget (`maxPolls`/`pollIntervalMs`
  from channel config). A detached async-callback mode (submit → record handle → release
  the worker slot → HMAC webhook settles) is the better long-run fix for worker-slot
  utilization and is the recommended next step (huimengi sends signed callbacks, so it's
  viable) — _follow-up._
- **3b. Video adapter + metering** — ✅ done (shared async-media path + `{duration_seconds}`
  - `video_url` persistence).

**Milestone reached: multi-minute video generation/relay without `upstream_timeout`.**

## Phase 4 — Audio + (optional) OpenAI media dialects

> **Status (2026-06-22): 4a (audio modality) is DONE.** Reused the async-media relay
> path end-to-end: the adapter forwards audio params (voice/language/format/speed),
> preserves `audio_url`, and meters `{characters}` (TTS, per input char) else
> `{audio_seconds}` (generative, per second) with a `{tasks:1}` fallback;
> media-persistence copies `audio_url` to R2 (mpeg/mp3/wav/ogg/aac/flac → ext); a seeded
> `audio-relay` resource (io_schema → `audio_url`) + per-unit pricebook
> (characters/audio_seconds/tasks); and the gallery is extended to a `kind=audio` filter
>
> - an inline `<audio>` player. `audio` was already a valid modality (contracts enum + db
>   schema). Shipped on PR #2 (CI green); the diff cleared an adversarial review (0 findings).

- ✅ **4a. Audio modality** — DONE (adapter audio branch + `audio_url` + audio
  media-persistence + audio resource seed + gallery audio).
- ✅ **4b. OpenAI-compatible media dialects** — DONE (2026-06-22). `POST /v1/images/generations`
  (JSON `{created,data:[{url}]}`) + `POST /v1/audio/speech` (binary audio bytes) map onto a
  SYNCHRONOUS run of `image-relay`/`audio-relay`. Since OpenAI media is sync but actionow media
  is async, `MediaDialectService` drives the job to terminal IN-PROCESS with **zero engine
  changes** — a no-op-`enqueue` ExecutionService creates the queued job, then `JobRunner.process`
  runs the exact submit→poll→persist→settle inline; `estimated_usage` sizes the hold (images:n;
  audio holds characters + seconds so a duration-metering relay can't under-hold). Guarded by
  ApiKeyGuard+RateLimitGuard, tenant-scoped, billed per image / per character. e2e green; cleared
  an adversarial billing-path review (the one confirmed finding — a pre-existing engine
  hold/settle dim-mismatch with no cap — is mitigated here + spun off as an engine follow-up).

**Milestone reached: ALL of Phase 4 done — four modalities (LLM/image/video/audio) + Dify relay,
PLUS drop-in OpenAI base_url compat for chat, images, and audio.**

## Phase 5 — Operator/product finishing (per scenario)

> **Status (2026-06-22): Phase 5 (the core-owned Relay-station ② surface) is COMPLETE.**
> All five operator/product-finishing items shipped, contract-first, on PR #2 (CI green;
> reproducible regen now **81 schemas / 65 paths**):
>
> 1. **Redemption codes (卡密)** — `redemptionCodeView`/`redeemCodesResult`, `GET/POST
/admin/redemption-codes`, `RedemptionCodesPage`.
> 2. **Tenant asset gallery** — `GET /console/files` (JWT, ready-only, image|video kind
>    filter) over the `listFilesByTenant` keyset repo fn; `consoleFileViewSchema` (url =
>    storage public base + key); the `/app/media` `AppMedia` gallery — closes the relay loop.
> 3. **`GET /v1/files` data-plane list** — keyset + status filter over the same repo fn;
>    `FileView` gained `created_at`; rounds out the SDK files resource for the dev's app.
> 4. **White-label / deployment-mode switch** — `config.brandName` (VITE_BRAND_NAME) +
>    `config.deploymentMode` (VITE_DEPLOYMENT_MODE marketing|app); `RootRoute` switches `/`
>    between Landing and a home redirect; Logo/Footer/title read the brand from config.
> 5. **Upstream OAuth/Codex credential-management page** — the 5 `/admin/oauth-sessions`
>    endpoints migrated into the contract/SDK; `OAuthSessionsPage` (list, revoke, turnkey
>    codex login start→authorize→complete, BYO paste-auth) at `/console/oauth-sessions`.
>
> Each diff cleared a multi-dimension adversarial review (gallery: 3 a11y nits fixed;
> the /v1-files + white-label + oauth diff: 0 findings). The remaining AIGC-product (①)
> items below are the third-party DEV's app layer — core ships none.

**Relay-station (②), core-owned, mostly FE — ✅ ALL DONE:**

- ✅ White-label / deployment-mode switch (M). ✅ Redemption-codes (卡密) admin UI (M).
  ✅ Tenant asset gallery (`GET /console/files` + `/app/media`). ✅ Upstream OAuth/Codex
  credential-management page (`/console/oauth-sessions`). ✅ `GET /v1/files` data-plane list.

**AIGC-product (①), the DEV's app layer (core ships none — out of scope for core):**

- End-customer sub-accounts/credit sub-ledgers, batch fan-out (N SKUs → N renders),
  product catalog, prompt templates, the customer-facing generation UI. Core provides
  only tenant→account billing + `POST /v1/run` + `GET /v1/files` (shipped) so the dev's
  gallery doesn't need direct DB access.

## Cross-cutting / quality (fold in opportunistically)

- Batch-N-images persistence collapses to one object — fix to N objects (S).
- Async runs ignore route-group tier/priority-fallback (carry `route_group_id` on the
  job) (M).
- `admin.ts listUsage` sends `tenantId` but `GET /admin/usage` ignores it — correctness
  illusion; drop the param or add it server-side (S).
- DS token sweep (theme.css `--fw-display`/`--fs-feature`; ~22 raw fontWeight) (S,
  cosmetic — the one formally-open design-review task).

## Critical path & scenario mapping

```
Phase 0 (LLM+Dify) ──now──▶ live relay (LLM/Dify only)
         │
Phase 1  ├─ 1a provision ─┐
         ├─ 1b typed errors│  (SDK foundation; both scenarios)
         └─ 1c data-plane SDK ─┐
                                ▼
Phase 2  2a real img adapter → 2b usage/price → 2c storage → 2d input-image
                                ▼  IMAGE relay + e-commerce img2img DONE
Phase 3  3a poll/detached → 3b video                ▼ VIDEO
Phase 4  4a audio  (4b OpenAI media dialects)        ▼ AUDIO / drop-in compat
Phase 5  white-label /卡密 UI / OAuth UI / gallery   ▼ operator polish
```

- **Relay-station ② needs:** Phase 0 (now) → +2 (image) → +3 (video) → +4a (audio),
  with 4b if base_url-drop-in is required; 5 for operator polish. 1c helps but the relay
  itself is HTTP-compatible so the SDK is optional for ②.
- **AIGC-product ① needs:** Phase 1 (provision + data-plane SDK) → Phase 2 (image, incl.
  input-image) at minimum; 3/4 for more modalities; the customer UI + batch is the dev's.

## Rough distance

- Control plane: ~95% (done; +Phase 1 closes provision/errors/data-plane SDK).
- Data plane: ~70% — async spine production-grade; the gating 30% is Phase 2–4.
- Frontend: control-plane console done; end-customer AIGC UI is the dev's (①) or a
  thin operator surface (②, Phase 5).
- **Fastest revenue:** ship Phase 0 now (LLM+Dify relay), do Phase 2 for image (≈ one
  real adapter + metering + input wiring), defer video/audio.
