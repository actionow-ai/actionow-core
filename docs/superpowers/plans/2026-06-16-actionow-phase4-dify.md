# Actionow Phase 4 — Dify DSL Parse + BYO Registration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. `- [ ]` steps. TDD.

**Goal:** Implement Dify workflow registration (§7): a **pure** DSL parser in `@actionow/dify` (YAML → `io_schema` + compat/cost report + a resource draft, with the `byo ⇒ pricing_model≠metered` constraint), the db catalog write repos, and a `DifyRegistrationService` in `@actionow/engine` that orchestrates parse → persist (create `resource` + `resource_version` + `dify_binding`). The runtime `dify-workflow` adapter already exists (Phase 2).

**Architecture:** `@actionow/dify` is pure (parse/report/assemble, NO db/network) — it imports only contracts/domain/infra. The orchestration that persists to db lives in `@actionow/engine` (engine may import dify + db). First期 supports only `app.mode: workflow` (not `advanced-chat`).

**Tech Stack:** `yaml` parser, `node:crypto` for the DSL hash, Vitest + Testcontainers (registration integration test).

**Source spec:** `docs/superpowers/specs/2026-06-16-actionow-backend-scaffold-design.md` — §7.1 (DSL→io_schema, type table), §7.2 (import pipeline), §7.3 (metered/blackbox + BYO constraint), §10 (resource/resource_version/dify_binding schema).

---

## Conventions

- Repo root, branch `feat/phase-4-dify`. TDD; commit per task (lowercase conventional subject). Don't push.
- Strict ESLint. `@actionow/dify` may import only contracts/domain/infra (boundaries now deterministically enforced via `no-restricted-imports` — don't import db from dify). Add the `yaml` dep to `packages/dify` (`pnpm add --filter @actionow/dify yaml`).
- Parse Dify DSL defensively: it's external YAML — narrow `unknown` with typed guards, never `any`; malformed/unsupported → a typed `DifyParseError` (carry a `code`).

---

## Task 1: DSL parse → io_schema (`@actionow/dify`)

**Files:** `packages/dify/src/types.ts`, `parse.ts`, `io-schema.ts`, `errors.ts`, `hash.ts`; barrel; test `packages/dify/test/parse.test.ts` with a sample DSL fixture.

- `errors.ts`: `DifyParseError extends Error` with `code: 'invalid_dsl' | 'unsupported_mode' | 'unsupported_version' | 'metered_not_allowed'`.
- `hash.ts`: `dslHash(yamlText: string): string` = `crypto.createHash('sha256').update(yamlText).digest('hex')`.
- `parse.ts`: `parseDsl(yamlText): ParsedDsl` — `yaml.parse`; assert `kind === 'app'` (else `invalid_dsl`); read `version` (string) and `app.mode`; if `app.mode !== 'workflow'` → `unsupported_mode` (first期 only workflow). Locate `workflow.graph.nodes` (array). Returns `{ mode, version, name, icon, nodes, raw }`.
- `io-schema.ts`:
  - `extractInputs(nodes): IoField[]` — find the `start` node (`data.type === 'start'`), map each `data.variables[i]` by Dify `type` → unified (§7.1 table):
    | Dify `variable.type` | unified `type` | widget | extra |
    |---|---|---|---|
    | `text-input` | string | text | `maxLength` from `max_length` |
    | `paragraph` | string | textarea | |
    | `select` | enum | select | `options`, `default` |
    | `number` | number | number | |
    | `file` | file | file-upload | |
    | `file-list` | file_list | multi-file-upload | |
    carry `key` (=`variable`), `label`, `required`.
  - `extractOutputs(nodes): IoField[]` — find `end` node; for each `data.outputs[i]` `{variable, value_selector:[nodeId, field]}`, infer `type` by following `value_selector` to the referenced node: `llm`→string; `code`→from the code node's declared output type if present else string; `tool`→string (default); set `render` to a best-guess (`text`/`image`/`file`) but mark `renderConfirmed:false` (human confirms at import). `key` = `variable`.

- [ ] **Step 1: Failing test** — put a sample DSL fixture (the §7.1 小红书 example) inline in the test as a YAML string:

```ts
import { describe, expect, it } from 'vitest';
import { parseDsl } from '../src/parse.js';
import { extractInputs, extractOutputs } from '../src/io-schema.js';

const DSL = `
app: { mode: workflow, name: 小红书文案配图, icon: "🎨" }
kind: app
version: "0.1.5"
workflow:
  graph:
    nodes:
      - { id: start, data: { type: start, variables: [
            { variable: topic, label: 主题, type: text-input, required: true, max_length: 100 },
            { variable: tone,  label: 语气, type: select, options: [活泼,专业,种草], default: 活泼 } ] } }
      - { id: llm1, data: { type: llm, model: { provider: openai, name: gpt-4o-mini } } }
      - { id: img1, data: { type: tool, provider_type: builtin, tool_name: dalle3 } }
      - { id: end, data: { type: end, outputs: [
            { variable: caption,   value_selector: [llm1, text] },
            { variable: image_url, value_selector: [img1, image] } ] } }
`;

describe('dify parse', () => {
  it('parses workflow mode and extracts typed inputs', () => {
    const p = parseDsl(DSL);
    expect(p.mode).toBe('workflow');
    const inputs = extractInputs(p.nodes);
    expect(inputs).toEqual([
      {
        key: 'topic',
        label: '主题',
        type: 'string',
        widget: 'text',
        required: true,
        maxLength: 100,
      },
      {
        key: 'tone',
        label: '语气',
        type: 'enum',
        widget: 'select',
        options: ['活泼', '专业', '种草'],
        default: '活泼',
      },
    ]);
  });
  it('extracts outputs with inferred types', () => {
    const p = parseDsl(DSL);
    const outputs = extractOutputs(p.nodes);
    expect(outputs[0]).toMatchObject({ key: 'caption', type: 'string' });
    expect(outputs[1]).toMatchObject({ key: 'image_url' });
  });
  it('rejects advanced-chat mode', () => {
    expect(() => parseDsl(DSL.replace('mode: workflow', 'mode: advanced-chat'))).toThrow(
      /unsupported_mode/,
    );
  });
});
```

- [ ] **Step 2–4:** Implement defensively (typed guards over `unknown`), run green, add cases (missing start node → invalid_dsl; paragraph/number/file mappings; kind!==app rejected).
- [ ] **Step 5:** Commit `feat(dify): parse workflow DSL into io_schema`.

---

## Task 2: Graph inventory → compat & cost report (`@actionow/dify`)

**Files:** `packages/dify/src/report.ts`; test.

`buildCompatReport(parsed, opts: { knownModels: Set<string> }): CompatReport` — walk `nodes` and top-level `dependencies` (`parsed.raw`):

- model nodes (`llm`/`agent`/`parameter-extractor`/`question-classifier`): read `data.model.provider`+`name`; classify `model_known` (in `knownModels`, key `provider/name`) or `model_unknown` (needs mapping).
- `tool` nodes → `tool_needs_credentials` (image/video/tts hidden here; DSL has no creds).
- `knowledge-retrieval`/`datasource` → `knowledge_reference` (will break — source workspace dataset).
- `http-request` → `external_http` (SSRF/cost-opaque).
- `code` → `code_node` (sandbox).
- top-level `dependencies` (plugins) → `missing_plugin` entries.
  Return `{ items: { kind, severity: 'ok'|'warn'|'block', detail }[], hasBlockers: boolean }`. `knowledge_reference` is `block` for首期 (spec §7.4: reject knowledge-dependent workflows); the rest are `warn`.

- [ ] TDD: the sample DSL yields `model_known` (if gpt-4o-mini in knownModels) + `tool_needs_credentials` (dalle3); a knowledge-retrieval node → a `block` item & `hasBlockers:true`; an http-request/code node → `warn`. Commit `feat(dify): graph inventory compat & cost report`.

---

## Task 3: Resource draft assembly + metered constraint (`@actionow/dify`)

**Files:** `packages/dify/src/register.ts`; test.

`buildResourceDraft(yamlText, opts): ResourceDraft` where `opts = { resourceId, provisionMode: 'byo', pricingModel: 'fixed'|'matrix'|'metered', knownModels }`:

- parse → extract io_schema → build report.
- **Enforce (review #2 / §7.3):** if `provisionMode === 'byo'` AND `pricingModel === 'metered'` → throw `DifyParseError('metered_not_allowed', 'BYO workflows cannot use metered pricing — use fixed/matrix')`.
- Returns `{ ioSchema: {inputs, outputs}, mode, dslHash, compatReport, providerType: 'dify-workflow', modality: 'composite' }` plus the binding fields to persist (mode, pricingModel, provisionMode, requiredSecrets from `tool_needs_credentials` items).

- [ ] TDD: a BYO+metered draft throws `metered_not_allowed`; a BYO+fixed draft returns a draft with io_schema + dslHash + report; `requiredSecrets` lists the credential-needing tools. Commit `feat(dify): resource draft assembly with byo metered guard`.

---

## Task 4: Catalog write repositories (`@actionow/db`)

**Files:** `packages/db/src/repositories/catalog.ts` (extend); test (integration).

Add: `createResource(db, {id,tenantId,kind,modality,providerType,execModes,ioSchema,version})` — inserts `resource` (currentVersion=version) + `resource_version` (ioSchema) in one tx. `createDifyBinding(db, binding)` — inserts `dify_binding`. `getResourceWithSchema(db, id)` — resource + its current `resource_version.io_schema` (if not already present). (Reuse the read helpers added in Phase 3.)

- [ ] TDD (Testcontainers): createResource writes both rows (unique resource_version_pk holds); createDifyBinding writes the binding with `provision_mode='byo'`, `pricing_model='fixed'`. Commit `feat(db): catalog write repositories (resource + dify binding)`.

---

## Task 5: `DifyRegistrationService` (`@actionow/engine`)

**Files:** `packages/engine/src/dify-registration.ts`; barrel; test (integration).

`DifyRegistrationService.register(input): Promise<{ resourceId, version, ioSchema, compatReport }>` constructed with `{ db, knownModels }`:

1. `buildResourceDraft(input.yamlText, { resourceId, provisionMode:'byo', pricingModel, knownModels })` (dify) — throws `metered_not_allowed`/parse errors.
2. **If `compatReport.hasBlockers` and not `input.allowBlockers`** → throw a registration error listing blockers (首期 rejects knowledge-dependent workflows).
3. Persist: `createResource(db, {...draft, version: <derived>})` + `createDifyBinding(db, { resourceId, resourceVersion, mode:'workflow', difyAppEndpoint: input.endpoint, difyServiceKeyRef: input.serviceKeyRef, dslHash: draft.dslHash, pricingModel, provisionMode:'byo', requiredSecrets, compatReport })`.
4. Version = `1` for first import; re-import with a different `dslHash` → new version (bump `resource.current_version`, insert new `resource_version` + binding). Use the dslHash to detect a no-op re-import (same hash → return existing).

- [ ] **Step 1: Failing integration test** (Testcontainers): register the sample BYO workflow DSL (pricingModel fixed) → a `resource` (kind=workflow, provider_type=dify-workflow) + `resource_version` (io_schema) + `dify_binding` exist; `getResourceWithSchema` returns the io_schema. Assert BYO+metered → `metered_not_allowed`. Assert a knowledge-retrieval DSL → blocked.
- [ ] **Step 2–4:** Implement; green.
- [ ] **Step 5:** Commit `feat(engine): dify BYO registration service`.

---

## Task 6: Verification gate

- [ ] `pnpm typecheck && pnpm lint && pnpm build && pnpm test` green (Docker up). Boundaries: dify imports only contracts/domain/infra (prove a `dify → db` import is rejected, then revert). Commit any fixups `chore: phase-4 dify verification gate green`.

---

## Phase 4 Definition of Done

- `@actionow/dify` (pure) parses a `workflow`-mode DSL into a typed `io_schema`, produces a compat/cost report (models/tools/knowledge/http/code/plugins classified), assembles a resource draft, and **rejects BYO+metered** and `advanced-chat` mode.
- `DifyRegistrationService` persists a BYO workflow as `resource` + `resource_version` + `dify_binding`; knowledge-dependent DSL is blocked首期; re-import with a new DSL hash creates a new version.
- The registered workflow resource is runnable via the existing Phase-2 `dify-workflow` adapter (the runtime path is already wired through the engine).
- `pnpm typecheck/lint/build/test` green; dify imports only contracts/domain/infra.

> **Next:** Phase 5 — API-key auth + per-tenant/resource rate-limit, admin CRUD endpoints (catalog/pricing/tenants/keys/dify-import/jobs/ledger), OpenAPI, and a seed script (the acceptance-criteria capstone).
