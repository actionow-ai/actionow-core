# Actionow Phase 7 — OSS / 文件存储 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. `- [ ]` steps. TDD.

**Goal:** A unified S3-backed object-storage layer covering R2 / S3 / MinIO / Aliyun OSS / Tencent COS / Volcano TOS via one `@aws-sdk/client-s3` v3 client (with the mandatory non-AWS checksum fix), plus `file_object` references and presigned upload/download endpoints. Real MinIO integration test proves it end to end.

**Architecture:** `StorageProvider` interface in `@actionow/contracts` (pure); `S3StorageProvider` in `@actionow/infra` (per-provider config + presign). `file_object` table + repo in `@actionow/db`. `/v1/files/*` in `apps/api`. Design ref: capabilities-expansion spec §Phase 7 (verified 2026-06).

**Tech Stack:** `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (+ `@aws-sdk/lib-storage` only if needed), pinned same version; MinIO docker service for the integration test.

---

## Conventions

- Repo root, branch `feat/phase-7-oss`. TDD; commit per task (lowercase conventional subject; commitlint enforces it). Don't push.
- Strict ESLint. `infra` imports only `@actionow/contracts`. apps may import any package. No secrets logged.
- Money/ids unchanged. Don't touch other phases' code.

---

## Task 1: `StorageProvider` interface + provider config types (`@actionow/contracts`)

**Files:** `packages/contracts/src/storage.ts`; barrel; test.

```ts
export const STORAGE_PROVIDERS = [
  'aws-s3',
  'r2',
  'minio',
  'aliyun-oss',
  'tencent-cos',
  'volcano-tos',
] as const;
export type StorageProviderKind = (typeof STORAGE_PROVIDERS)[number];

export interface StorageProviderConfig {
  kind: StorageProviderKind;
  bucket: string;
  region: string;
  endpoint?: string; // omitted for aws-s3
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  publicBaseUrl?: string; // optional CDN base for public reads
}

export interface PutPresign {
  url: string;
  key: string;
  expiresIn: number;
}
export interface GetPresign {
  url: string;
  expiresIn: number;
}
export interface HeadResult {
  exists: boolean;
  size?: number;
  contentType?: string;
  etag?: string;
}

export interface StorageProvider {
  readonly kind: StorageProviderKind;
  presignPut(key: string, opts?: { contentType?: string; expiresIn?: number }): Promise<PutPresign>;
  presignGet(key: string, opts?: { expiresIn?: number }): Promise<GetPresign>;
  head(key: string): Promise<HeadResult>;
  delete(key: string): Promise<void>;
}
```

- [ ] TDD: zod schema `storageProviderConfigSchema` validating the config (kind enum, required creds); barrel export. Commit `feat(contracts): storage provider interface + config schema`.

---

## Task 2: `S3StorageProvider` (`@actionow/infra`)

**Files:** `packages/infra/src/storage.ts`; barrel; unit test.

Build one `S3Client` per config. **The critical fix:** for every `kind !== 'aws-s3'`, set `requestChecksumCalculation: 'WHEN_REQUIRED'` and `responseChecksumValidation: 'WHEN_REQUIRED'` (the v3.729+ default CRC otherwise 400s R2/MinIO/OSS/COS/TOS). Implement `presignPut/presignGet/head/delete` via `getSignedUrl(client, new PutObjectCommand|GetObjectCommand)` / `HeadObjectCommand` / `DeleteObjectCommand`.

```ts
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageProvider, StorageProviderConfig /* … */ } from '@actionow/contracts';

export function createS3StorageProvider(cfg: StorageProviderConfig): StorageProvider {
  const client = new S3Client({
    region: cfg.region,
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    forcePathStyle: cfg.forcePathStyle ?? false,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    ...(cfg.kind !== 'aws-s3'
      ? {
          requestChecksumCalculation: 'WHEN_REQUIRED' as const,
          responseChecksumValidation: 'WHEN_REQUIRED' as const,
        }
      : {}),
  });
  // … presignPut/presignGet/head/delete using client + getSignedUrl …
}
```

Also export a `providerDefaults(kind)` helper documenting endpoint/region/forcePathStyle conventions per provider (r2 region `auto`; oss `s3.oss-<region>` endpoint; cos virtual-host; tos `tos-s3-<region>`; minio forcePathStyle true) — used by config builders/tests.

- [ ] **Step 1: Unit tests (no network):** assert the client config per kind — e.g. constructing an `r2` provider yields `forcePathStyle:false` + checksum `WHEN_REQUIRED`; `minio` yields `forcePathStyle:true` + checksum `WHEN_REQUIRED`; `aws-s3` keeps defaults (no checksum override). Assert `presignPut` returns a URL containing the key and a signature query (`X-Amz-Signature`), expiry default 900s; `presignGet` default 3600s. (Inspect the client `config` and the returned URL string — no live S3.)
- [ ] **Step 2–4:** Implement; green. Add `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` to `packages/infra` (same version). Barrel export.
- [ ] **Step 5:** Commit `feat(infra): unified S3 storage provider with non-AWS checksum fix`.

---

## Task 3: `file_object` schema + repo (`@actionow/db`) + MinIO real integration test

**Files:** `packages/db/src/schema/storage.ts` (new), migration; `packages/db/src/repositories/files.ts`; `docker-compose.yml` (+minio); `packages/infra/test/storage.int.test.ts`.

- `file_object(id uuid pk, tenant_id uuid fk, provider text, bucket text, key text, size bigint?, content_type text?, etag text?, status text default 'pending', created_at)`. Generate the migration.
- Repo: `createFileObject`, `markFileReady(id, {size,contentType,etag})`, `getFileObject`.
- **docker-compose:** add a `minio` service:
  ```yaml
  minio:
    image: minio/minio:latest
    command: server /data
    environment: { MINIO_ROOT_USER: actionow, MINIO_ROOT_PASSWORD: actionow123 }
    ports: ['9000:9000']
    healthcheck: { test: ['CMD', 'mc', 'ready', 'local'], interval: 5s, timeout: 3s, retries: 10 }
  ```
  (host port may conflict — if 9000 is taken, use 9100:9000; reflect in `.env.example` as `MINIO_ENDPOINT`.)
- **Real integration test** (`@testcontainers` MinIO OR the compose minio): create a bucket; build an `S3StorageProvider{kind:'minio', endpoint, forcePathStyle:true, …}`; **presign PUT → upload bytes via `fetch(putUrl,{method:'PUT',body})` → `head()` confirms size/etag → presign GET → `fetch(getUrl)` returns the same bytes**. This proves the checksum fix (without it the PUT 400s). Prefer `@testcontainers/minio` if available, else `GenericContainer('minio/minio').withCommand(['server','/data'])`.

- [ ] **Step 1:** failing integration test (real MinIO round-trip). **Step 2–4:** implement schema+migration+repo+test; green. **Step 5:** Commit `feat(db,infra): file_object repo + real MinIO presign round-trip test`.

---

## Task 4: `/v1/files` endpoints + io_schema file resolution (`apps/api`)

**Files:** `apps/api/src/files/` (module, controller, service, DTOs); a `STORAGE` provider in `db.module.ts` built from env config; tests.

- Env config (`packages/infra/src/config.ts`): default storage provider settings (`STORAGE_PROVIDER`, `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_ENDPOINT?`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_FORCE_PATH_STYLE?`). Build a default `StorageProvider` and provide via a `STORAGE` DI token.
- Endpoints (`@UseGuards(ApiKeyGuard)`):
  - `POST /v1/files/presign-upload {filename, content_type, size}` → validate (size ≤ a configured max; content_type allowlist optional) → key `{tenantId}/{uuid}.{ext}` → `createFileObject(status:'pending')` → `presignPut` → return `{ file_id, upload_url, key, expires_in }`.
  - `POST /v1/files/{id}/confirm` → `head(key)`; if exists → `markFileReady` (size/etag/contentType) and return the object; else 404/`invalid_input`.
  - `GET /v1/files/{id}/url` → tenant-scoped `getFileObject` → `presignGet` → `{ url, expires_in }`.
- (Note for Phase 8/exec): io_schema `file`/`file_list` inputs carry a `file_id`; a small resolver maps it to a presigned GET URL before handing inputs to the adapter — implement a `resolveFileInputs(ioSchema, inputs, storage, db, tenantId)` helper in the files service, used by RunService (wire minimally; full media-output upload can be a follow-up).

- [ ] **Step 1:** e2e (Testcontainers pg + the MinIO container; stub nothing): presign-upload → real PUT to MinIO → confirm (head) → get-url → GET returns bytes; tenant isolation (other tenant's file_id → 404). **Step 2–4:** implement; green. **Step 5:** Commit `feat(api): /v1/files presigned upload/confirm/download`.

---

## Task 5: Verification gate

- [ ] `pnpm typecheck && pnpm lint && pnpm build && pnpm test` green (Docker up, incl. minio). Boundaries intact (infra→contracts only). No secret logging (creds/presigned signatures not logged). Commit any fixups `chore: phase-7 oss verification gate green`.

---

## Phase 7 Definition of Done

- One `S3StorageProvider` drives all six providers by config; the **non-AWS checksum fix** is applied and **proven by a real MinIO presign PUT→HEAD→GET round-trip**.
- `file_object` references persisted (not URLs); `/v1/files/presign-upload|confirm|url` work tenant-scoped over real HTTP; io_schema `file` inputs resolvable to URLs.
- `pnpm typecheck/lint/build/test` green; boundaries enforced; no secret leakage.

> **Next:** Phase 8 — SSE streaming + async-callback.
