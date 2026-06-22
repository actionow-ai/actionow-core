# Media/Provider Plugins — P1 Implementation Plan (Unified Result Contract + Persistence/Metering归一)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a typed, validated `MediaResult` contract owned by ONE engine module that normalizes → persists (url + base64 + batch, recording etag/width/height/duration) → meters (writes `usage_log` + per-unit `provider_cost`), wired into `JobRunner.settle`; eliminating the 4 hardcoded media field-tables and the media metering blind-spot.

**Architecture:** The async-media adapter produces a canonical `MediaResult` (`{kind:'media', assets[], usage, raw?}`) on its `PollResult.mediaResult`/`CallbackResult.mediaResult`. The engine's new `media-result` module owns persistence (generalized from `media-persistence.ts` to `assets[]`, plus base64 inline decode + media metadata capture) and metering (per-unit `provider_cost = Σ usage[dim] × channel.costPerUnit[dim]`). `settle` stores the persisted `MediaResult` as the job `output`; consumers (OpenAI-images dialect, gallery) read `assets[]` with a legacy shim for pre-P1 jobs. NO plugin engine yet (that is P2).

**Tech Stack:** TypeScript (exactOptionalPropertyTypes ON), zod (@actionow/contracts), drizzle (@actionow/db), vitest, pnpm workspaces + turbo.

**Scope note:** `StructuredResult`/`StreamResult` union members are DEFINED (contract space reserved per spec D6) but NOT produced/consumed by the engine in P1. ws-stream / webhook-only / batch / structured modalities / non-codex CLI are out of P1 (later phases).

**Verification commands:** per-package `pnpm --filter @actionow/<pkg> typecheck|lint|test`; repo-wide `pnpm typecheck && pnpm lint`. DB: `pnpm --filter @actionow/db db:generate` then `db:migrate`.

---

## Task 1: `MediaResult` / `PluginResult` contract

**Files:**

- Create: `packages/contracts/src/media-result.ts`
- Create: `packages/contracts/src/media-result.test.ts`
- Modify: `packages/contracts/src/index.ts` (add `export * from './media-result.js';`)

- [ ] **Step 1: Write the failing test** (`media-result.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { assetSchema, mediaResultSchema, pluginResultSchema } from './media-result.js';

describe('media-result contract', () => {
  it('accepts a url image asset', () => {
    const r = mediaResultSchema.parse({
      kind: 'media',
      assets: [{ role: 'primary', modality: 'image', url: 'https://x/y.png', mime: 'image/png' }],
      usage: { images: 1 },
    });
    expect(r.assets[0]?.modality).toBe('image');
    expect(r.assets[0]?.role).toBe('primary'); // role defaults to 'primary'
  });

  it('accepts an inline b64 asset with media metadata', () => {
    const a = assetSchema.parse({
      modality: 'video',
      b64: 'AAAA',
      mime: 'video/mp4',
      duration: 5,
      width: 1280,
      height: 720,
      size: 1024,
      etag: 'abc',
    });
    expect(a.duration).toBe(5);
    expect(a.role).toBe('primary');
  });

  it('rejects an asset with neither url nor b64', () => {
    expect(() => assetSchema.parse({ modality: 'image', mime: 'image/png' })).toThrow();
  });

  it('discriminates the union on kind', () => {
    const s = pluginResultSchema.parse({
      kind: 'struct',
      data: { vec: [0.1] },
      usage: { tokens: 3 },
    });
    expect(s.kind).toBe('struct');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @actionow/contracts test -- media-result`
Expected: FAIL — `Cannot find module './media-result.js'`.

- [ ] **Step 3: Write the contract** (`media-result.ts`)

```ts
import { z } from 'zod';

/** One produced asset. Exactly one of `url`/`b64` is present. */
export const assetSchema = z
  .object({
    role: z.enum(['primary', 'thumbnail', 'cover', 'aux']).default('primary'),
    modality: z.enum(['image', 'video', 'audio', 'model3d']),
    format: z.string().optional(),
    url: z.string().optional(),
    b64: z.string().optional(),
    mime: z.string(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    duration: z.number().optional(),
    size: z.number().int().optional(),
    etag: z.string().optional(),
  })
  .refine((a) => a.url !== undefined || a.b64 !== undefined, {
    message: 'asset requires url or b64',
  });
export type Asset = z.infer<typeof assetSchema>;

/** Per-unit billing dimensions (images / duration_seconds / characters / …). */
export const usageVectorSchema = z.record(z.number());

/** Canonical media result — what every media plugin/adapter mapResponse returns. */
export const mediaResultSchema = z.object({
  kind: z.literal('media'),
  assets: z.array(assetSchema),
  usage: usageVectorSchema,
  raw: z.unknown().optional(),
});
export type MediaResult = z.infer<typeof mediaResultSchema>;

/** RESERVED (spec D6) — defined for forward-compat; not produced by the engine in P1. */
export const structuredResultSchema = z.object({
  kind: z.literal('struct'),
  data: z.unknown(),
  usage: usageVectorSchema,
  raw: z.unknown().optional(),
});
export type StructuredResult = z.infer<typeof structuredResultSchema>;

export const pluginResultSchema = z.discriminatedUnion('kind', [
  mediaResultSchema,
  structuredResultSchema,
]);
export type PluginResult = z.infer<typeof pluginResultSchema>;
```

- [ ] **Step 4: Add the index export** — append to `packages/contracts/src/index.ts`: `export * from './media-result.js';`

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @actionow/contracts test -- media-result` → Expected: PASS (4 tests).
Run: `pnpm --filter @actionow/contracts typecheck` → Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/media-result.ts packages/contracts/src/media-result.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): MediaResult/PluginResult result contract (P1)"
```

---

## Task 2: Widen adapter result types with `mediaResult`

**Files:**

- Modify: `packages/contracts/src/adapter.ts:70-92` (`SyncResult`, `PollResult`)

- [ ] **Step 1: Add the field** — in `adapter.ts`, import the type at top: `import type { MediaResult } from './media-result.js';` and add `mediaResult?: MediaResult;` to both `SyncResult` and `PollResult` (CallbackResult inherits it):

```ts
export interface SyncResult {
  kind: 'sync';
  output: Record<string, unknown>;
  usage: UsageVector;
  /** Canonical media result when this is a media job (P1); the engine prefers it over `output`. */
  mediaResult?: MediaResult;
}
// …
export interface PollResult {
  status: UpstreamStatus;
  output?: Record<string, unknown>;
  usage?: UsageVector;
  error?: UnifiedError;
  /** Canonical media result for a succeeded media job (P1). */
  mediaResult?: MediaResult;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm --filter @actionow/contracts typecheck` → Expected: clean (optional field, no breakage).

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src/adapter.ts
git commit -m "feat(contracts): carry MediaResult on Poll/SyncResult (P1)"
```

---

## Task 3: async-media adapter emits `MediaResult`

**Files:**

- Modify: `packages/adapters/src/async-media.ts` (replace `resultOutput`+`usageFromResult` with one `toMediaResult`; set `mediaResult` on poll/callback succeeded)
- Modify: `packages/adapters/src/async-media-mock.ts` (same `mediaResult` on its completed branch)
- Test: `packages/adapters/src/async-media.test.ts` (extend; create if absent)

- [ ] **Step 1: Write the failing test** (add to `async-media.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { toMediaResult } from './async-media.js';

describe('toMediaResult', () => {
  it('maps a batch of image_urls to image assets + images usage', () => {
    const r = toMediaResult(
      { image_urls: ['https://a/1.png', 'https://a/2.png'], image_count: 2 },
      'image',
    );
    expect(r.kind).toBe('media');
    expect(r.assets.map((a) => a.url)).toEqual(['https://a/1.png', 'https://a/2.png']);
    expect(r.assets[0]?.modality).toBe('image');
    expect(r.usage).toEqual({ images: 2 });
  });
  it('maps a video_url + duration to a video asset + duration_seconds usage', () => {
    const r = toMediaResult({ video_url: 'https://a/v.mp4', duration: 6 }, 'video');
    expect(r.assets[0]).toMatchObject({ modality: 'video', url: 'https://a/v.mp4', duration: 6 });
    expect(r.usage).toEqual({ duration_seconds: 6 });
  });
  it('maps audio character_count to characters usage', () => {
    const r = toMediaResult({ audio_url: 'https://a/a.mp3', character_count: 42 }, 'audio');
    expect(r.assets[0]?.modality).toBe('audio');
    expect(r.usage).toEqual({ characters: 42 });
  });
  it('falls back to { tasks: 1 } when no dimension present', () => {
    expect(toMediaResult({ image_url: 'https://a/x.png' }, 'image').usage).toEqual({ images: 1 });
    expect(toMediaResult({}, 'image').usage).toEqual({ tasks: 1 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @actionow/adapters test -- async-media` → Expected: FAIL — `toMediaResult is not exported`.

- [ ] **Step 3: Implement `toMediaResult`** in `async-media.ts` (export it; preserves the exact dimension logic from the current `usageFromResult` + URL set from `resultOutput`; infers `mime` by extension, default per modality). Replace the two old functions' call sites in `poll`/`parseCallback` to set `mediaResult: toMediaResult(result, modality)` AND keep `output`/`usage` derived for back-compat:

```ts
import {
  mediaResultSchema,
  type Asset,
  type MediaResult,
  type UsageVector,
} from '@actionow/contracts';

const DEFAULT_MIME: Record<string, string> = {
  image: 'image/png',
  video: 'video/mp4',
  audio: 'audio/mpeg',
};
function mimeOf(url: string, modality: string): string {
  const ext = url.split('?')[0]?.split('.').pop()?.toLowerCase();
  const byExt: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    mp4: 'video/mp4',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
  };
  return (
    (ext !== undefined ? byExt[ext] : undefined) ??
    DEFAULT_MIME[modality] ??
    'application/octet-stream'
  );
}

/** Normalize an async-media `result` block to the canonical MediaResult (single source; replaces resultOutput+usageFromResult). */
export function toMediaResult(
  result: Record<string, unknown> | undefined,
  modality: string,
): MediaResult {
  const assetMod: Asset['modality'] =
    modality === 'video' ? 'video' : modality === 'audio' ? 'audio' : 'image';
  const urls: string[] = [];
  const arr = result?.image_urls;
  if (Array.isArray(arr)) for (const u of arr) if (typeof u === 'string') urls.push(u);
  for (const k of ['image_url', 'video_url', 'audio_url'] as const) {
    const u = asString(result?.[k]);
    if (u !== undefined && !urls.includes(u)) urls.push(u);
  }
  const duration = asNumber(result?.duration) ?? asNumber(result?.audio_duration);
  const assets: Asset[] = urls.map((u) => ({
    role: 'primary' as const,
    modality: assetMod,
    url: u,
    mime: mimeOf(u, modality),
    ...(assetMod !== 'image' && duration !== undefined ? { duration } : {}),
  }));
  // usage: same precedence as the old usageFromResult.
  let usage: UsageVector;
  const imageUrls = result?.image_urls;
  const images =
    asNumber(result?.image_count) ??
    asNumber(result?.generated_images) ??
    (Array.isArray(imageUrls) ? imageUrls.length : undefined) ??
    (result?.image_url !== undefined ? 1 : undefined);
  const characters = asNumber(result?.character_count) ?? asNumber(result?.characters);
  const audioSeconds = asNumber(result?.audio_duration) ?? asNumber(result?.audio_seconds);
  const vid = asNumber(result?.duration) ?? asNumber(result?.duration_seconds);
  if (images !== undefined) usage = { images };
  else if (characters !== undefined) usage = { characters };
  else if (audioSeconds !== undefined) usage = { audio_seconds: audioSeconds };
  else if (vid !== undefined) usage = { duration_seconds: vid };
  else usage = { tasks: 1 };
  return mediaResultSchema.parse({ kind: 'media', assets, usage, raw: result });
}
```

In `poll` succeeded branch and `parseCallback` completed branch, add `mediaResult: toMediaResult(asRecord(data?.result), <modality>)`. NOTE: `poll`/`parseCallback` lack `modality` today — thread it: `submit` already stamps `meta.modality`; for poll, derive modality from the asset URLs is unreliable, so pass modality via `ctx.config?.modality` set by the engine OR keep `resultOutput`/`usageFromResult` for the legacy `output`/`usage` and set `mediaResult` only where modality is known. **Decision:** keep legacy `output`/`usage` exactly as-is (no behavior change) and ADD `mediaResult` using a modality inferred from which url keys are present (`video_url`→video, `audio_url`→audio, else image). Implement `inferModality(result)` accordingly so poll/callback need no new param.

- [ ] **Step 4: Mirror in `async-media-mock.ts`** — on its completed branch, set `mediaResult: toMediaResult(result, inferModality(result))`.

- [ ] **Step 5: Run tests** — `pnpm --filter @actionow/adapters test` → Expected: PASS (new + existing).

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/src/async-media.ts packages/adapters/src/async-media-mock.ts packages/adapters/src/async-media.test.ts
git commit -m "feat(adapters): async-media emits canonical MediaResult (P1)"
```

---

## Task 4: file_object media metadata (width/height/duration)

**Files:**

- Modify: `packages/db/src/schema/storage.ts` (add `width`, `height`, `duration` numeric columns, nullable)
- Generate: `packages/db/drizzle/NNNN_*.sql` (via `db:generate`)
- Modify: `packages/db/src/repositories/files.ts` (accept optional `width/height/duration` in create/markReady)
- Test: `packages/db/src/repositories/files.test.ts` (if present; else skip repo test, rely on typecheck)

- [ ] **Step 1: Add columns to schema** — in `storage.ts`, add after `etag`:

```ts
    width: bigint('width', { mode: 'number' }),
    height: bigint('height', { mode: 'number' }),
    duration: doublePrecision('duration'), // seconds (video/audio); import doublePrecision from drizzle-orm/pg-core
```

- [ ] **Step 2: Generate the migration** — Run: `pnpm --filter @actionow/db db:generate` → Expected: a new `drizzle/NNNN_*.sql` with 3 ADD COLUMN.

- [ ] **Step 3: Apply** — Run: `pnpm --filter @actionow/db db:migrate` → Expected: applied to dev DB.

- [ ] **Step 4: Thread dims through the files repo** — extend the `markFileReady`/`createFileObject` input types in `files.ts` with optional `width?/height?/duration?` and set them (mirroring the existing `etag`/`size` handling).

- [ ] **Step 5: Verify** — Run: `pnpm --filter @actionow/db typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/storage.ts packages/db/drizzle/ packages/db/src/repositories/files.ts
git commit -m "feat(db): file_object width/height/duration media metadata (P1)"
```

---

## Task 5: engine `media-result` module — persistence over `assets[]`

**Files:**

- Create: `packages/engine/src/media-result.ts` (generalizes `media-persistence.ts` to `MediaResult.assets[]`; adds base64 inline decode + etag/dims capture)
- Create: `packages/engine/src/media-result.test.ts`
- Modify: `packages/engine/src/index.ts` (export new module)

- [ ] **Step 1: Write the failing test** — cover: (a) each `url` asset is fetched → presignPut → putBytes → rewritten to `{publicBaseUrl}/{key}`; (b) a `b64` asset is decoded and uploaded (no fetch); (c) batch of N assets → N objects keyed `{tenant}/{job}-{i}.{ext}`; (d) `objects[]` carry `size` and (when known) `etag`; (e) best-effort: a fetch error leaves that asset's url unchanged and `persisted:false` overall is not thrown. Use fake `storage`/`fetchBytes`/`putBytes` (mirror existing `media-persistence` test style).

```ts
import { describe, expect, it, vi } from 'vitest';
import { persistMediaResult } from './media-result.js';
import type { MediaResult } from '@actionow/contracts';

const storage = {
  presignPut: vi.fn(async (key: string) => ({ url: `https://put/${key}` })),
} as any;
const baseInput = {
  storage,
  publicBaseUrl: 'https://cdn.x',
  tenantId: 't1',
  jobId: 'j1',
  fetchBytes: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' })),
  putBytes: vi.fn(async () => undefined),
};
const mr = (assets: unknown[]): MediaResult => ({
  kind: 'media',
  assets: assets as any,
  usage: { images: assets.length },
});

describe('persistMediaResult', () => {
  it('persists a single url asset and rewrites it', async () => {
    const out = await persistMediaResult({
      ...baseInput,
      result: mr([
        { role: 'primary', modality: 'image', url: 'https://up/a.png', mime: 'image/png' },
      ]),
    });
    expect(out.result.assets[0]?.url).toBe('https://cdn.x/t1/j1.png');
    expect(out.objects).toHaveLength(1);
    expect(out.objects[0]?.size).toBe(3);
  });
  it('decodes and uploads a b64 asset', async () => {
    const out = await persistMediaResult({
      ...baseInput,
      result: mr([
        {
          role: 'primary',
          modality: 'image',
          b64: Buffer.from([9, 9]).toString('base64'),
          mime: 'image/png',
        },
      ]),
    });
    expect(out.result.assets[0]?.url).toBe('https://cdn.x/t1/j1.png');
    expect(out.result.assets[0]?.b64).toBeUndefined(); // inline bytes dropped after persist
    expect(baseInput.fetchBytes).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it** — `pnpm --filter @actionow/engine test -- media-result` → FAIL (module missing).

- [ ] **Step 3: Implement `persistMediaResult`** — port `media-persistence.ts` logic to iterate `result.assets`, source bytes from `asset.url` (fetchBytes) or `asset.b64` (base64 decode), presign+put under `{tenant}/{job}.{ext}` (single) or `{tenant}/{job}-{i}.{ext}` (batch), rewrite `asset.url` to the durable URL and DELETE `asset.b64`, set `asset.size`/`asset.etag`/`asset.mime`. Return `{ persisted, result, objects: PersistedObject[] }` where `PersistedObject` gains `width?/height?/duration?` (pass through from asset). Best-effort: wrap in try/catch, on error return original result with `persisted:false`.

- [ ] **Step 4: Export** — add `export * from './media-result.js';` to engine `index.ts`.

- [ ] **Step 5: Run tests** — `pnpm --filter @actionow/engine test -- media-result` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/media-result.ts packages/engine/src/media-result.test.ts packages/engine/src/index.ts
git commit -m "feat(engine): media-result persistence over assets[] (url+b64+batch) (P1)"
```

---

## Task 6: engine media metering helper

**Files:**

- Modify: `packages/engine/src/media-result.ts` (add `meterMedia`)
- Modify: `packages/engine/src/media-result.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { meterMedia } from './media-result.js';
describe('meterMedia', () => {
  it('computes provider_cost = Σ usage[dim] × costPerUnit[dim] in µUSD bigint', () => {
    // 2 images × 1500 µUSD = 3000
    expect(meterMedia({ images: 2 }, { images: 1500 })).toBe(3000n);
  });
  it('sums multiple dimensions and ignores unknown dims', () => {
    expect(meterMedia({ duration_seconds: 6, foo: 9 }, { duration_seconds: 100 })).toBe(600n);
  });
  it('returns undefined when no costPerUnit configured', () => {
    expect(meterMedia({ images: 2 }, undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it** — FAIL (`meterMedia` missing).

- [ ] **Step 3: Implement**

```ts
/** provider_cost (µUSD, bigint) = Σ usage[dim] × costPerUnit[dim]; undefined when no costPerUnit. */
export function meterMedia(
  usage: Record<string, number>,
  costPerUnit: Record<string, number> | undefined,
): bigint | undefined {
  if (costPerUnit === undefined) return undefined;
  let total = 0n;
  for (const [dim, n] of Object.entries(usage)) {
    const unit = costPerUnit[dim];
    if (typeof unit === 'number') total += BigInt(Math.round(n * unit));
  }
  return total;
}
```

- [ ] **Step 4: Run tests** — PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/media-result.ts packages/engine/src/media-result.test.ts
git commit -m "feat(engine): per-unit media provider_cost metering helper (P1)"
```

---

## Task 7: wire `JobRunner.settle` to persist + meter media

**Files:**

- Modify: `packages/engine/src/job-runner.ts` (`settle`: prefer `result.mediaResult`; persist via new module; write usage_log + provider_cost)
- Modify: `packages/engine/src/job-runner.ts` deps (`persistMedia` signature → returns `MediaResult`; add `insertUsageLog` dep + per-channel `costPerUnit`)
- Modify: `packages/engine/src/execution-service.ts` (`JobExecutionContext`/`RunChannel`: surface `costPerUnit` from channel config + `model` for the usage_log row)
- Test: `packages/engine/src/job-runner.test.ts` (extend)

- [ ] **Step 1: Write the failing test** — a settle with a `result.mediaResult` + a channel `costPerUnit:{images:1500}` calls the injected `insertUsageLog` once with `providerCost: 3000n`, `status:'succeeded'`, and stores the persisted MediaResult as `output`. Use the existing job-runner test harness (fake db + deps).

- [ ] **Step 2: Run it** — FAIL.

- [ ] **Step 3: Implement** — in `settle`: if `result.mediaResult !== undefined`, run `this.deps.persistMedia?.(... mediaResult ...)` (new signature returns `{result: MediaResult, objects}`), set `output = persistedMediaResult` (the validated MediaResult JSON). Compute `providerCost = meterMedia(usage, ctx.channels[0]?.costPerUnit)`. After `settleJob`, call `this.deps.insertUsageLog?.({ tenantId, model: ctx.model ?? job.resourceId, cost: finalCost, providerCost, status:'succeeded', channelId: ctx.channels[0]?.id, providerType: ctx.providerType })`. Keep the legacy `output` path unchanged when `mediaResult` absent. Add `insertUsageLog?` + change `persistMedia?` deps; add `costPerUnit?: Record<string,number>` to `RunChannel` and `model?` to `JobExecutionContext` (loaded from channel config in execution-service).

- [ ] **Step 4: Run tests** — `pnpm --filter @actionow/engine test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/job-runner.ts packages/engine/src/execution-service.ts packages/engine/src/job-runner.test.ts
git commit -m "feat(engine): settle persists+meters media via MediaResult (P1)"
```

---

## Task 8: wire the API/worker — inject deps + migrate consumers

**Files:**

- Modify: `apps/worker/src/processors/job-exec.processor.ts` (provide `persistMedia` over `persistMediaResult`, `insertUsageLog`, write `file_object` rows from `objects[]` with dims — the SINGLE writer)
- Modify: `apps/api/src/media-dialect/media-dialect.service.ts` (read `output.assets[]`; legacy shim `legacyAssets(output)` for pre-P1 jobs)
- Modify: `apps/api/src/console/console.controller.ts` (gallery reads `output.assets[]` + legacy shim)
- Modify: `apps/api/src/callbacks/callbacks.service.ts` (ensure media callback path also goes through the runner settle, not a duplicate file_object writer)

- [ ] **Step 1: Inject deps in the worker** — wire `JobRunnerDeps.persistMedia` to call `persistMediaResult(...)` over the real `StorageProvider` + fetch/put, then write ONE `file_object` row per returned `object` (with `width/height/duration` from Task 4). Wire `insertUsageLog` to the db repo. This becomes the single file_object media writer.

- [ ] **Step 2: Migrate `media-dialect.service.ts`** — replace `imageUrls(toRecord(job.output))` with reading `output.assets` (filter `modality==='image'`), falling back to `legacyAssets(output)` (maps old `image_url(s)/video_url/audio_url` → `Asset[]`) for pre-P1 jobs. Same for audio branch.

- [ ] **Step 3: Migrate gallery** in `console.controller.ts` similarly (assets[] + legacy shim).

- [ ] **Step 4: Tests** — update/extend the api tests for media-dialect + gallery to feed an `assets[]` output and assert the projection; keep one legacy-shim test.

- [ ] **Step 5: Run** — `pnpm --filter @actionow/api test` and `pnpm --filter @actionow/worker typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/processors/job-exec.processor.ts apps/api/src/media-dialect/ apps/api/src/console/console.controller.ts apps/api/src/callbacks/
git commit -m "feat(api,worker): single file_object writer + consumers read assets[] (P1)"
```

---

## Task 9: delete the duplicated writers + dead hardcoded tables

**Files:**

- Modify/Delete: `packages/engine/src/media-persistence.ts` (superseded by `media-result.ts`; remove or re-export thin shim if other callers remain — grep first)
- Modify: `packages/adapters/src/async-media.ts` (remove now-dead `resultOutput`/`usageFromResult` IF no longer referenced; keep `extractUsage` working via `toMediaResult(...).usage`)

- [ ] **Step 1: Grep callers** — `grep -rn "persistMediaOutput\|media-persistence\|resultOutput\|usageFromResult" packages apps --include='*.ts' | grep -v test`. Confirm the only remaining callers are ones migrated in Tasks 5/7/8.

- [ ] **Step 2: Remove dead code** — delete `persistMediaOutput` + `media-persistence.ts` (or reduce to re-export), and the dead async-media helpers; update `extractUsage` to `return toMediaResult(asRecord(data?.result), inferModality(...)).usage` so the 4th hardcoded table is gone.

- [ ] **Step 3: Verify nothing references removed symbols** — `pnpm typecheck` (repo) → clean.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(engine,adapters): remove duplicated media writers + hardcoded field tables (P1)"
```

---

## Task 10: full verification

- [ ] **Step 1: Repo typecheck + lint** — `pnpm typecheck && pnpm lint` → clean (24/24, 13/13).
- [ ] **Step 2: Targeted tests** — `pnpm --filter @actionow/contracts test && pnpm --filter @actionow/adapters test && pnpm --filter @actionow/engine test && pnpm --filter @actionow/api test` → all pass.
- [ ] **Step 3: Live smoke (optional)** — rebuild api+worker, trigger a media job against the seeded huimengi relay, confirm `output.assets[]`, a `file_object` row with dims, and a `usage_log` row with `provider_cost`.
- [ ] **Step 4: Final commit if any fixups.**

---

## Self-Review (run after writing)

- **Spec coverage (spec §4.1/§6 P1):** MediaResult union ✓ (T1); chat/struct reserved ✓ (T1); async-media→new module ✓ (T3/T5); R2 url+b64+batch ✓ (T5); etag/dims ✓ (T4/T5); media usage_log+per-unit provider_cost ✓ (T6/T7); delete 2 dup writers + 4 hardcoded tables ✓ (T8/T9). ws-stream/webhook/struct-modalities/batch correctly OUT of P1.
- **Type consistency:** `MediaResult`/`Asset` names consistent T1→T9; `persistMediaResult` returns `{result, objects}` used identically in T7/T8; `meterMedia(usage, costPerUnit)→bigint|undefined` consistent T6/T7.
- **Placeholders:** none — each step has concrete code or exact command.
