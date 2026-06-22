# Media/Provider Plugins — P2 Implementation Plan (Plugin Engine + Signer Registry + Clone Templates)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]`. Builds on P1 (the `MediaResult`/`PluginResult` contract + `media-result` engine module + `JobRunner.settle` persist/meter are DONE).

**Goal:** Add a data-driven provider-plugin engine: a `provider_plugin` (manifest + sandboxed JS handler) executed by a generic adapter, with a platform-side **named signer registry** (keys never enter the sandbox) so heterogeneous upstreams (incl. body-dependent HMAC/JWT signing) are config+handler, not bespoke code. Seed the OFFICIAL built-ins; OpenAI-compat long-tail + relays become config-only clones. codex stays a code adapter (irreducible).

**Architecture:** `provider_plugin` row = `manifest` (declarative: axes, protocol, credential-form schema, params schema, `authStrategy` name) + `handler` (QuickJS-WASM JS: `mapRequest`/`mapResponse`/`mapPoll`/`mapCallback`). A generic `PluginAdapter` (registered as `providerType='plugin'`, dispatched when `channel.pluginId` is set) runs: `validate → mapRequest [sandbox] → signer-registry applies auth [outside sandbox, keys injected] → http → mapResponse/mapPoll [sandbox] → PluginResult`. `resource_version` freezes the plugin snapshot (manifest+handler+signer version).

**Tech Stack:** TS (exactOptionalPropertyTypes), zod, drizzle, **quickjs-emscripten** (WASM sandbox), node:crypto (HMAC/JWT signers), vitest.

**Scope:** sync + async-poll protocols this phase (matches P1). `webhook-only` real-mode + `ws-stream` + structured/batch modalities remain DEFERRED (P3/later per spec §6). Signers this phase: `bearer`, `query-key`, `custom-header`, `token`, `volcSignV4`, `tencentTC3`, `klingJwt` (the researched body-dependent set). Built-in seeds: OFFICIAL `openai-chat`/`anthropic`/`gemini`/`openai-images` + a couple CN signed examples; clone presets are data.

**Verification:** per-pkg `pnpm --filter @actionow/<pkg> typecheck|lint|test`; repo `pnpm typecheck && pnpm lint`. DB `db:generate`+`db:migrate`. Sandbox tests must assert: timeout, memory cap, no-I/O, determinism, secrets-absent-from-ctx.

---

## Task 1: contracts — provider_plugin manifest + views/requests

**Files:** Create `packages/contracts/src/provider-plugin.ts` + `.test.ts`; export from `index.ts`.

Define (zod + inferred types):

- `signerStrategySchema = z.enum(['bearer','query-key','custom-header','token','volcSignV4','tencentTC3','klingJwt','none'])`.
- `pluginProtocolSchema = z.enum(['sync','async-poll'])` (webhook-only/ws-stream reserved — add later).
- `credentialFieldSchema = z.object({ key, label, type: z.enum(['text','password','select']), required, options?, placeholder? })` — drives the UI form (≈ Dify credentials_for_provider).
- `pluginManifestSchema = z.object({ id, label, modalities: z.array(z.string()), protocol: pluginProtocolSchema, authStrategy: signerStrategySchema, credentialFields: z.array(credentialFieldSchema), paramFields: z.array(credentialFieldSchema).optional() })`.
- `providerPluginViewSchema` (id, label, modalities, protocol, authStrategy, manifest, handler, version, builtin, status, timestamps).
- `createPluginRequestSchema` / `updatePluginRequestSchema` (label/manifest/handler/status).
- **Tests:** manifest parse round-trip; bad authStrategy rejected; protocol enum.

- [ ] Write `.test.ts` (parse valid manifest; reject unknown authStrategy). [ ] Run → fail. [ ] Implement schema. [ ] Export from index. [ ] Run → pass. [ ] `pnpm --filter @actionow/contracts typecheck`. [ ] Commit `feat(contracts): provider_plugin manifest + views (P2)`.

---

## Task 2: db — provider_plugin table + channel plugin binding

**Files:** Modify `packages/db/src/schema/catalog.ts` (or new `plugin.ts`); generate migration; repo `packages/db/src/repositories/plugin.ts`; export.

- `provider_plugin` table: `id uuid pk`, `slug text notNull unique` (stable id e.g. 'openai-chat'), `label text`, `modalities text[]`, `protocol text`, `auth_strategy text`, `manifest jsonb notNull`, `handler text notNull`, `version int notNull default 1`, `builtin bool default false`, `status text default 'active'`, `created/updated/deleted_at`.
- `upstream_channel`: add `plugin_id uuid` (FK provider_plugin, nullable), `plugin_version int`, `trust text default 'trusted'` (trusted|untrusted), `model_map jsonb`.
- Repo: `listPlugins`, `getPluginBySlug`, `createPlugin`, `updatePlugin` (bumps version), `softDeletePlugin`.
- **Tests:** repo CRUD + version bump (int test or unit over a fake).

- [ ] Add schema. [ ] `db:generate` → migration NNNN. [ ] `db:migrate`. [ ] Repo + export. [ ] typecheck. [ ] Commit `feat(db): provider_plugin table + channel plugin binding (P2)`.

---

## Task 3: engine — named signer registry (the §4.5 / D7 core)

**Files:** Create `packages/engine/src/signers/index.ts` + per-signer files + `.test.ts`.

`SignerInput = { method, url, path, query, headers, body, credentials: Record<string,string>, nowMs }` → `SignerOutput = { headers, url }` (a signer may add headers and/or rewrite the URL/query). Registry: `Record<SignerStrategy, Signer>`. Implement:

- `bearer`: `Authorization: Bearer {credentials.api_key}`.
- `custom-header`: header name from `credentials.header_name` (e.g. x-api-key) = api_key.
- `query-key`: append `?key=` (Gemini) — rewrites url.
- `token`: `Authorization: Token {api_key}` (Vidu).
- `volcSignV4`: Volcengine SignerV4 (HMAC-SHA256 chain over canonical request; binds method+path+query+headers+body). Credentials: ak/sk/region/service.
- `tencentTC3`: TC3-HMAC-SHA256 (distinct canonicalization). Credentials: secret_id/secret_key/service.
- `klingJwt`: per-request HS256 JWT `{iss:ak, exp:now+1800, nbf:now-5}` signed with sk → `Authorization: Bearer {jwt}`.
- `none`.

**Secrets:** the registry runs OUTSIDE the sandbox; `credentials` are resolved by the platform from `secret_ref`/channel config and passed ONLY here. **Tests:** each signer's output matches a known vendor sample/fixed vector (use a frozen `nowMs`); volc/tencent canonicalization correctness; klingJwt decodes to expected claims; signers never appear in handler ctx (asserted in Task 4/5).

- [ ] Per-signer TDD (fixed nowMs vectors). [ ] Registry + `applySigner(strategy, input)`. [ ] Export from engine index. [ ] typecheck+test. [ ] Commit `feat(engine): named signer registry — bearer/header/query/token/volcV4/tencentTC3/klingJwt (P2)`.

---

## Task 4: engine — QuickJS-WASM sandbox runner

**Files:** add dep `quickjs-emscripten`; create `packages/engine/src/sandbox/quickjs.ts` + `.test.ts`.

`runHandler(handlerCode: string, fnName: 'mapRequest'|'mapResponse'|'mapPoll'|'mapCallback', arg: unknown, opts?: {timeoutMs?:number, memoryMb?:number}): Promise<unknown>` — instantiate a QuickJS context, inject `arg` as a frozen global, eval `handlerCode`, call `fnName(arg)`, marshal the JSON result out. Enforce: interrupt after `timeoutMs` (default 50ms), memory limit, NO host bindings (no fetch/timers/process/console — or a no-op console). Non-JSON or throw/timeout → throw `SandboxError`.

**Tests:** happy path (`mapRequest` returns object); infinite loop → timeout error; attempt to access `fetch`/`process` → undefined/throws; large alloc → memory error; determinism (same input→same output); arg is frozen (handler can't mutate host state).

- [ ] dep install. [ ] TDD runner. [ ] typecheck+test. [ ] Commit `feat(engine): QuickJS-WASM handler sandbox (timeboxed, no-IO, secrets-free) (P2)`.

---

## Task 5: engine — generic PluginAdapter + plugin run path

**Files:** `packages/adapters/src/plugin.ts` (the generic adapter) OR an engine-level runner invoked by JobRunner when `channel.pluginId` set; `.test.ts`.

The PluginAdapter implements `ProviderAdapter`: `submit` (sync→ runs mapRequest→sign→http→mapResponse→PluginResult; async→ mapRequest→sign→http→handle), `poll` (http→mapPoll→mapResponse). The platform resolves the plugin snapshot + credentials, runs handler fns in the QuickJS sandbox (Task 4), applies the signer (Task 3) OUTSIDE the sandbox, performs http via `ctx.http`, returns `mediaResult` on success (reusing P1's MediaResult contract). ctx passed to handler = `{ inputs, model, params, config }` — **no secrets**.

**Tests:** a fake plugin (manifest+handler) drives a sync image gen end-to-end with a fake http; asserts the signer header present, the handler ctx has no api_key, the result is a valid MediaResult; an async plugin poll reaches succeeded.

- [ ] TDD adapter. [ ] Register in default-registry as `'plugin'`. [ ] Wire JobRunner/execution-service dispatch on `channel.pluginId`. [ ] typecheck+test. [ ] Commit `feat(adapters,engine): generic plugin adapter over sandbox+signer (P2)`.

---

## Task 6: built-in plugin seeds (OFFICIAL) + clone presets

**Files:** `apps/api/src/seed/seed-plugins.ts` (or extend seed-providers); seed data.

Seed `builtin=true` plugins: `openai-chat`, `anthropic-messages`, `gemini-generatecontent`, `openai-images` (manifests + handlers translating IR↔wire). Provide clone presets (data) for OpenAI-compat long-tail (deepseek/xai/etc) = same handler, different base_url/model_map via channel config. **Tests:** seed idempotency; a seeded plugin parses against the manifest schema; openai-images handler maps a sample upstream response → MediaResult.

- [ ] Seed module + idempotent upsert. [ ] Tests. [ ] Commit `feat(api): seed built-in provider plugins + clone presets (P2)`.

---

## Task 7: resource_version plugin snapshot (version freeze)

**Files:** `packages/db/src/schema` resource_version `plugin_snapshot jsonb`; execution/run path snapshots the bound plugin (manifest+handler+signer version) at job creation; JobRunner uses the frozen snapshot, not the live plugin.

- [ ] Schema + migration. [ ] Snapshot on run. [ ] Runner reads snapshot. [ ] Tests (edit plugin after job created → old job uses frozen). [ ] Commit `feat(engine,db): freeze plugin snapshot in resource_version (P2)`.

---

## Task 8: full verification

- [ ] `pnpm typecheck && pnpm lint`. [ ] Targeted tests (contracts/db/engine/adapters/api/worker). [ ] Live smoke: create a custom plugin via seed, bind a channel, run a media job through the plugin path; confirm MediaResult + usage_log + (if signed) the signer header on the relay trace. [ ] Commit fixups.

---

## Self-Review

- Spec coverage: §3.2 manifest+handler (T1/T2/T6), §3.3 generic runner (T5), §3.4 QuickJS sandbox (T4), §4.5/D7 signer registry incl. body-dependent volc/tencent/kling (T3), §3.6 version freeze (T7), §2 axes on manifest (T1). Deferred-by-design: webhook-only/ws-stream/structured/batch, non-codex CLI.
- Risk: signer crypto correctness (T3) — test against vendor sample vectors; sandbox escape (T4) — assert no host bindings + secrets-free ctx; keep codex code-adapter untouched.
