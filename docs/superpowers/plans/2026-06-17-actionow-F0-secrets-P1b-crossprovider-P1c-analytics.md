# F0 secret-at-rest + P1b cross-provider channels + P1c usage analytics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. TDD always: write the failing test, see it fail, write minimal code, see it pass, commit.

**Goal:** (F0) store credentials AES-256-GCM-encrypted in the DB so operators create/rotate them at runtime instead of env-only; (P1b) let one model's channels target DIFFERENT providers and fail over across them, recording which channel served; (P1c) operator usage-analytics rollups (requests/tokens/cost/error-rate) by day/model/tenant/channel/api-key.

**Architecture:** Three independent tracks, sequenced F0 → P1b → P1c (F0 gives runtime channel credentials; P1b enriches `usage_log` with the served channel; P1c aggregates over the enriched `usage_log`). All three build on the merged Track A relay + P0a routing. No new external services (no Vault, no Redis beyond BullMQ); crypto via `node:crypto`.

**Tech Stack:** TypeScript (NodeNext ESM), Drizzle + drizzle-kit (migrations in `packages/db/drizzle`), NestJS 11, zod, vitest + Testcontainers (postgres:16-alpine). Money is bigint µcredits (never float). Strict ESLint (no `any`, `exactOptionalPropertyTypes`, `consistent-type-imports`, `simple-import-sort`).

## Conventions

- **Repo root:** `/Users/alienworm/actionow-core` (pnpm monorepo; turbo). Branch: `feat/secrets-crossprovider-analytics` (`git checkout -b ...`). Do NOT push until the verification gate passes.
- **Commits:** lowercase conventional subjects; commit body lines < 100 chars; end every body with:

  ```

  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

- **Migrations:** `pnpm --filter @actionow/db db:generate` auto-numbers the next file (latest is `0009`). Never hand-number; commit the generated `NNNN_*.sql` + `meta/` changes.
- **No vendor brand names** (e.g. huimeng) in code or commit messages.
- **`exactOptionalPropertyTypes` is ON:** optional repo-input fields that may receive an explicit `undefined` must be typed `?: T | undefined` (see the P0a `UpdateUpstreamChannelInput` precedent at `packages/db/src/repositories/catalog.ts`).
- **Empty catch blocks** must contain a comment (the repo's `no-empty`-with-comment idiom, e.g. `mirrorChatUsageLog`).

## File-structure map (locks decomposition)

**F0:** `packages/db/src/crypto.ts` (new, AES-256-GCM) · `packages/db/src/schema/catalog.ts` (+`secretMaterial`) · `packages/db/src/repositories/catalog.ts` (+`createEncryptedSecret`, extend `resolveSecretRef`) · `packages/infra` AppEnv (+`SECRET_ENCRYPTION_KEY`) · `apps/api/src/admin/{dto/admin.dto,admin.service,admin.controller}.ts` (+`POST /admin/secrets`).
**P1b:** `packages/engine/src/execution-service.ts` (`RunChannel.providerType`; per-channel adapter; capture served channel) · `packages/engine/src/stream.ts` (per-channel adapter; served channel → mirror) · `packages/db` (`usage_log` +`channel_id`/`provider_type`; `insertUsageLog` params) · `apps/api/src/chat/{chat-relay.service,*.controller}.ts` (map `providerType`; `x-actionow-channel` header on blocking).
**P1c:** `packages/db` (`usage_log` +`api_key_id`; `rollupUsage` repo) · `apps/api/src/{auth,chat,admin}` (thread `apiKeyId`; analytics endpoint).

---

# TRACK F0 — Secret-at-rest encryption + runtime credential creation

**Why:** `resolveSecretRef` (`packages/db/src/repositories/secrets.ts`-style logic, currently in `catalog`/`secrets`) resolves `provider='env'` only; `provider='vault'` returns `undefined` (a TODO at `apps/api/src/common/secret-resolver.ts`). Credentials therefore live only in `SECRET_*` env vars. F0 adds a `provider='enc'` kind whose value is AES-256-GCM ciphertext in the DB, plus an admin endpoint to create one at runtime — the first consumer is operators adding provider keys via API; the future consumers are P1a (OAuth sessions) and BYOK.

## Task F0.1 — AES-256-GCM crypto helper

**Files:** Create `packages/db/src/crypto.ts`; Test `packages/db/test/crypto.test.ts`.

- [ ] **Step 1 — failing test** `packages/db/test/crypto.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { decryptSecret, encryptSecret } from '../src/crypto.js';

const KEY = Buffer.alloc(32, 7).toString('base64'); // 32-byte key, base64

describe('secret crypto (AES-256-GCM)', () => {
  it('round-trips plaintext through encrypt → decrypt', () => {
    const material = encryptSecret('sk-secret-value', KEY);
    expect(material).not.toContain('sk-secret-value'); // ciphertext, not plaintext
    expect(material.split('.')).toHaveLength(3); // iv.tag.ciphertext (base64 parts)
    expect(decryptSecret(material, KEY)).toBe('sk-secret-value');
  });

  it('uses a fresh iv per call (same plaintext → different material)', () => {
    expect(encryptSecret('x', KEY)).not.toBe(encryptSecret('x', KEY));
  });

  it('rejects a tampered ciphertext (auth tag mismatch)', () => {
    const m = encryptSecret('x', KEY);
    const [iv, tag, ct] = m.split('.');
    const tampered = `${iv}.${tag}.${Buffer.from('zzzz').toString('base64')}`;
    expect(() => decryptSecret(tampered, KEY)).toThrow();
  });

  it('throws on a non-32-byte key', () => {
    expect(() => encryptSecret('x', Buffer.alloc(16).toString('base64'))).toThrow(/32/);
  });
});
```

- [ ] **Step 2 — run, expect FAIL** (`crypto.ts` not found): `pnpm --filter @actionow/db exec vitest run test/crypto.test.ts`.
- [ ] **Step 3 — implement** `packages/db/src/crypto.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

/** Decode + validate the base64 master key as exactly 32 bytes (AES-256). */
function decodeKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) {
    throw new Error(`secret encryption key must be 32 bytes (got ${String(key.length)})`);
  }
  return key;
}

/**
 * Encrypt `plaintext` to a self-describing `iv.tag.ciphertext` string (each part
 * base64). A fresh random IV per call; GCM auth tag detects tampering on decrypt.
 */
export function encryptSecret(plaintext: string, keyB64: string): string {
  const key = decodeKey(keyB64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

/** Inverse of {@link encryptSecret}; throws on a bad key, malformed input, or tampering. */
export function decryptSecret(material: string, keyB64: string): string {
  const key = decodeKey(keyB64);
  const parts = material.split('.');
  if (parts.length !== 3) throw new Error('malformed secret material');
  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}
```

- [ ] **Step 4 — run, expect PASS.** Add `export * from './crypto.js';` to `packages/db/src/index.ts` (keep alphabetical).
- [ ] **Step 5 — typecheck + lint** the db package; **commit** `feat(db): aes-256-gcm secret crypto helper`.

## Task F0.2 — `secret_material` table + migration

**Files:** Modify `packages/db/src/schema/catalog.ts`; generate `packages/db/drizzle/00NN_*.sql`.

- [ ] **Step 1 — add the table** after `secretRef` in `catalog.ts` (note `secretRef` is the FK target):

```ts
/**
 * AES-256-GCM ciphertext for a `provider='enc'` {@link secretRef}. Stored as the
 * `iv.tag.ciphertext` string produced by `encryptSecret`; decrypted on resolve
 * with the env master key. 1:1 with its `secret_ref`.
 */
export const secretMaterial = pgTable('secret_material', {
  secretRefId: uuid('secret_ref_id')
    .primaryKey()
    .references(() => secretRef.id),
  material: text('material').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2 — generate** the migration: `pnpm --filter @actionow/db db:generate`. Confirm a new `00NN_*.sql` with `CREATE TABLE "secret_material"` + the FK. (An int test in F0.3 proves it applies.)
- [ ] **Step 3 — commit** `feat(db): secret_material table + migration` (include the generated `.sql` + `meta/`).

## Task F0.3 — `createEncryptedSecret` repo + `resolveSecretRef` `enc` branch

**Files:** Modify the secret-ref repo (find it: `grep -rn "export async function resolveSecretRef" packages/db/src` — likely `packages/db/src/repositories/secrets.ts`); add `createEncryptedSecret`; Test `packages/db/test/enc-secret.int.test.ts`.

First READ the existing `resolveSecretRef` + `getSecretRef` + `createSecretRef` to mirror style and the `provider` switch.

- [ ] **Step 1 — failing int test** `packages/db/test/enc-secret.int.test.ts` (mirror the Testcontainers + `migrate(db, { migrationsFolder: './drizzle' })` setup from `packages/db/test/channel-health.int.test.ts`):

```ts
// ... container/migrate/afterEach(TRUNCATE secret_material, secret_ref ...) boilerplate ...
import { createEncryptedSecret, resolveSecretRef } from '../src/repositories/index.js';

const KEY = Buffer.alloc(32, 9).toString('base64');

it('stores an encrypted secret and resolves it back to plaintext', async () => {
  const ref = await createEncryptedSecret(db, {
    value: 'sk-live-123',
    label: 'openai',
    keyB64: KEY,
  });
  expect(ref.provider).toBe('enc');
  // the stored material is ciphertext, not the plaintext
  const [mat] = await db.select().from(schema.secretMaterial);
  expect(mat?.material).not.toContain('sk-live-123');
  // resolveSecretRef decrypts it (env master key)
  process.env.SECRET_ENCRYPTION_KEY = KEY;
  expect(await resolveSecretRef(db, ref.id)).toBe('sk-live-123');
});

it('returns undefined for an enc ref when the master key is absent', async () => {
  const ref = await createEncryptedSecret(db, { value: 'x', label: '', keyB64: KEY });
  delete process.env.SECRET_ENCRYPTION_KEY;
  expect(await resolveSecretRef(db, ref.id)).toBeUndefined();
});
```

- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** `createEncryptedSecret` in the secrets repo (one tx: insert `secret_ref` then `secret_material`):

```ts
export interface CreateEncryptedSecretInput {
  readonly value: string;
  readonly label?: string | undefined;
  readonly keyB64: string;
}

/** Create a `provider='enc'` secret_ref + its AES-GCM material in one transaction. */
export async function createEncryptedSecret(
  db: DbOrTx,
  input: CreateEncryptedSecretInput,
): Promise<SecretRefRow> {
  const material = encryptSecret(input.value, input.keyB64);
  return db.transaction(async (tx) => {
    const [ref] = await tx
      .insert(secretRef)
      .values({ provider: 'enc', locator: input.label ?? '' })
      .returning();
    if (!ref) throw new Error('createEncryptedSecret: secret_ref insert returned no row');
    await tx.insert(secretMaterial).values({ secretRefId: ref.id, material });
    return ref;
  });
}
```

And extend `resolveSecretRef`'s provider switch with the `enc` branch (READ the current function first; add alongside `env`/`vault`):

```ts
if (row.provider === 'enc') {
  const keyB64 = process.env.SECRET_ENCRYPTION_KEY;
  if (keyB64 === undefined || keyB64 === '') return undefined; // misconfig → no secret
  const [mat] = await db
    .select()
    .from(secretMaterial)
    .where(eq(secretMaterial.secretRefId, row.id))
    .limit(1);
  if (mat === undefined) return undefined;
  try {
    return decryptSecret(mat.material, keyB64);
  } catch {
    return undefined; // bad key / tampered → treat as unresolved, never throw to callers
  }
}
```

- [ ] **Step 4 — run, expect PASS.** Export `createEncryptedSecret` + `CreateEncryptedSecretInput` from `packages/db/src/repositories/index.js`. Add `secretMaterial`/`decryptSecret`/`encryptSecret` imports to the repo file.
- [ ] **Step 5 — full db suite + typecheck + lint; commit** `feat(db): create + resolve enc (encrypted-at-rest) secrets`.

## Task F0.4 — `SECRET_ENCRYPTION_KEY` in AppEnv

**Files:** Modify the infra env schema (`grep -rn "ADMIN_JWT_SECRET" packages/infra/src` to find the zod env schema + `AppEnv`).

- [ ] **Step 1 — add** `SECRET_ENCRYPTION_KEY: z.string().optional()` to the env schema (optional — only the `enc` path needs it; absence degrades enc resolution to `undefined`, never crashes boot). Update any `AppEnv`-shaped test stubs that use `satisfies AppEnv` exhaustively (search `RATE_LIMIT_RESOURCE_PER_MIN` in tests; add the optional field only where an exact object is required).
- [ ] **Step 2 — typecheck the repo;** commit `feat(infra): SECRET_ENCRYPTION_KEY env (optional)`.

## Task F0.5 — `POST /admin/secrets` (create an encrypted credential at runtime)

**Files:** `apps/api/src/admin/dto/admin.dto.ts` (+`createSecretSchema`); `apps/api/src/admin/admin.service.ts` (+`createSecret`); `apps/api/src/admin/admin.controller.ts` (+route, +`SecretView`); Test: extend `apps/api/test/admin-crud.e2e.test.ts`.

- [ ] **Step 1 — failing e2e** add to `admin-crud.e2e.test.ts` (and set `SECRET_ENCRYPTION_KEY` in that file's `overrideProvider(ENV)` block to a 32-byte base64 key):

```ts
it('creates an encrypted secret and uses it as a channel credential (F0)', async () => {
  const secret = await auth(
    request(app.getHttpServer())
      .post('/admin/secrets')
      .send({ value: 'sk-live-xyz', label: 'openai' }),
  ).expect(201);
  expect(secret.body.id).toBeTypeOf('string');
  expect(secret.body.provider).toBe('enc');
  expect(JSON.stringify(secret.body)).not.toContain('sk-live-xyz'); // never echo the plaintext
  // the returned id is a valid channel credentialRef (uuid)
  expect(secret.body.id).toMatch(/^[0-9a-f-]{36}$/);
});
```

- [ ] **Step 2 — run, expect FAIL** (404 — route missing).
- [ ] **Step 3 — DTO** in `admin.dto.ts`:

```ts
/** `POST /admin/secrets` — create an encrypted-at-rest credential. */
export const createSecretSchema = z.object({
  value: z.string().min(1),
  label: z.string().optional(),
});
export type CreateSecretDto = z.infer<typeof createSecretSchema>;
```

- [ ] **Step 4 — service** `admin.service.ts` (read the master key from the injected `ENV`; the service already has `@Inject(ENV)` patterns — if not, inject it like `ChatRelayService` does):

```ts
async createSecret(dto: CreateSecretDto): Promise<SecretRefRow> {
  const keyB64 = this.env.SECRET_ENCRYPTION_KEY;
  if (keyB64 === undefined || keyB64 === '') {
    throw engineInvalidInput('SECRET_ENCRYPTION_KEY is not configured');
  }
  return createEncryptedSecret(this.db, { value: dto.value, label: dto.label, keyB64 });
}
```

Import `createEncryptedSecret`, `type SecretRefRow` from `@actionow/db`; inject `ENV` (`@Inject(ENV) private readonly env: AppEnv`) if the service doesn't already have it.

- [ ] **Step 5 — controller** `admin.controller.ts` — add a `SecretView` (id + provider + created_at; **never** the value) + route mirroring the existing `createChannel` route shape:

```ts
@Post('secrets')
@HttpCode(201)
@ApiOperation({ summary: 'Create an encrypted-at-rest credential (returns its ref id)' })
async createSecret(
  @Body(new ZodBody(createSecretSchema)) dto: CreateSecretDto,
): Promise<SecretView> {
  const row = await this.admin.createSecret(dto);
  return { id: row.id, provider: row.provider, created_at: row.createdAt.toISOString() };
}
```

with `interface SecretView { id: string; provider: string; created_at: string }`.

- [ ] **Step 6 — run e2e, expect PASS; full api typecheck + lint; commit** `feat(api): POST /admin/secrets — runtime encrypted credentials`.

## Track F0 done-check

- [ ] `pnpm --filter @actionow/db test && pnpm --filter @actionow/api exec vitest run test/admin-crud.e2e.test.ts` green. An operator can `POST /admin/secrets` and use the returned id as a channel `credentialRef`; the engine's `resolveSecret` decrypts it at runtime. No plaintext is ever returned or logged.

---

# TRACK P1b — Cross-provider channels + fallback + served-by annotation

**Why:** P0a routes across a model's channels but they all use `resource.providerType` (one dialect). The `upstream_channel.providerType` column already exists per-row; selecting the adapter per-channel turns multi-channel into cross-provider fallback (OpenAI → Anthropic → relay) for free — the IR is dialect-neutral, so each channel's adapter renders the IR to its own wire format. We also record which channel actually served (audit + analytics input for P1c).

## Task P1b.1 — `RunChannel.providerType` + map it from the row

**Files:** `packages/engine/src/execution-service.ts` (`RunChannel`); `apps/api/src/chat/chat-relay.service.ts` (`toRunChannel`); also the run/media `buildRequest` that maps channels (search `toRunChannel`/`RunChannel` producers: `grep -rn "weight: row.weight" apps/api packages`).

- [ ] **Step 1 — add** `providerType?: string | undefined;` to the `RunChannel` interface (`execution-service.ts:46`), documented "per-channel provider/adapter; overrides `resource.providerType` for routing (cross-provider fallback)".
- [ ] **Step 2 — map it** in every `UpstreamChannelRow → RunChannel` mapper (the row's `providerType` is non-null): add `providerType: row.providerType,` to `toRunChannel` in `chat-relay.service.ts` and any sibling mapper (e.g. the non-chat `RunService.buildRequest`). Search and update all.
- [ ] **Step 3 — typecheck** engine + api; **commit** `feat(engine): carry per-channel providerType on RunChannel`.

## Task P1b.2 — Per-channel adapter selection on the blocking chat path + capture served channel

**Files:** `packages/engine/src/execution-service.ts` (`runChat`, `runBlocking`, `settleSync` served-channel threading).

READ the current `runChat` (the `routeBlocking` block) + `settleSync` + `mirrorUsageLog` first.

- [ ] **Step 1 — failing unit test** in `packages/engine/test/chat-stream.test.ts` (the mock `@actionow/db` already fakes `listCooledDownChannelIds`/`recordChannelFailure`; the `AdapterRegistry` can hold two adapters). Add an adapter that fails for `providerType:'openai'` and a second registered under `providerType:'anthropic'` that succeeds; assert `runChat` over two channels with distinct `providerType` fails over openai→anthropic and `settleCalls[0]` records the anthropic channel. (Model the fakes on the existing `fakeChatAdapter`; register both in the test's `AdapterRegistry`.)

  Key assertions:

```ts
const { response } = await svc.runChat(
  chatReq({
    channels: [
      { id: 'c1', weight: 2, providerType: 'openai-fail', model: 'm' },
      { id: 'c2', weight: 1, providerType: 'mock-chat', model: 'm' },
    ],
    rng: () => 0, // pick c1 (openai-fail) first → fail over to c2
  }),
);
expect(response.message.content[0]).toMatchObject({ kind: 'text' });
expect(usageLogCalls[0]).toMatchObject({ channelId: 'c2', providerType: 'mock-chat' });
```

(Register a `'openai-fail'` adapter whose `chat` throws an `AdapterError({retryable:true})`, and the existing `'mock-chat'` fake. Extend the chat-stream `insertUsageLog` mock to also capture `channelId`/`providerType`.)

- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** `runChat`: select the adapter PER CHANNEL inside the `routeBlocking` attempt and capture the winner. Replace the current single-adapter block:

```ts
// (remove the pre-loop `const adapter = ...; if (adapter.chat === undefined) ...` chat guard)
let served: RunChannel | undefined;
let response: ChatResponse;
try {
  response = await routeBlocking(
    { db: this.deps.db, now: this.deps.now, rng: this.deps.rng ?? Math.random },
    req.channels,
    async (channel) => {
      const adapter = this.deps.adapters.get(channel.providerType ?? req.resource.providerType);
      if (adapter.chat === undefined) {
        throw engineError('internal_error', `channel adapter ${adapter.providerType} cannot chat`);
      }
      const r = await adapter.chat.bind(adapter)(ir, await this.buildContext(req, channel));
      served = channel; // winner
      return r;
    },
  );
} catch (err) {
  await this.failBlocking(req, jobId, holdAmount, err);
  throw toEngineError(err);
}
```

Then thread `served` into the usage_log mirror. Extend `settleSync` (or its `mirrorUsageLog` call) to accept an optional `{ channelId, providerType }` and pass `served`'s `id`/`providerType ?? req.resource.providerType`. (Add the served channel as an extra arg on `settleSync`; the `mirrorUsageLog` already keys on `req.usageLogModel` — add the two columns to its `insertUsageLog` call once `insertUsageLog` supports them in P1b.4.) Return `{ jobId, response, cost, servedBy: served && { channelId: served.id, providerType: served.providerType ?? req.resource.providerType, model: served.model } }` — add `servedBy?` to `ChatRunOutcome`.

- [ ] **Step 4 — also update `runBlocking`** (non-chat submit path) to select the adapter per channel inside its `routeBlocking` attempt: `const adapter = this.deps.adapters.get(channel.providerType ?? req.resource.providerType);` then `adapter.submit(...)`. (Mirrors the chat change; keeps a heterogeneous-channel resource working for non-chat too.)
- [ ] **Step 5 — run, expect PASS; engine typecheck + lint; commit** `feat(engine): per-channel adapter selection on blocking paths + served channel` (defer the green of the usage_log columns to after P1b.4 if the mock needs them — sequence P1b.4 before this commit if so; see note).

> **Sequencing note:** P1b.4 (the `usage_log` columns + `insertUsageLog` params) has no engine dependency, so do **P1b.4 first**, then P1b.2/P1b.3 can record into the new columns and their tests assert them.

## Task P1b.3 — Per-channel adapter selection on the streaming chat path

**Files:** `packages/engine/src/stream.ts` (`createChatSettlingStream`).

READ the current `createChatSettlingStream` (the Phase-1 failover loop + `mirrorChatUsageLog`).

- [ ] **Step 1 — failing unit test** in `chat-stream.test.ts`: a 2-channel stream where channel 1 (`providerType:'openai-fail'`) yields a retryable first-frame `error` and channel 2 (`providerType:'mock-chat'`) streams normally; assert the consumer sees channel 2's full stream AND `usageLogCalls[0]` records `{ channelId:'c2', providerType:'mock-chat' }`. (Extend the existing failover test; the adapter is now chosen by the channel's `providerType`, so the fake must be registered under those provider types and pick behaviour by which adapter is selected — not by `ctx.model`.)
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** in the Phase-1 loop, resolve the adapter per channel and require `streamChat`:

```ts
// inside the `for (... of ordered)` loop, before building ctx:
const channel = ordered[i]?.value;
if (channel === undefined) continue;
const adapter = deps.adapters.get(channel.providerType ?? deps.req.resource.providerType);
if (adapter.streamChat === undefined) {
  // this channel's adapter can't stream — treat as a (non-retryable) miss for it
  lastError = { code: 'internal_error', message: `adapter ${adapter.providerType} cannot streamChat`, retryable: false };
  if (!isLast) continue;
  failure = lastError; yield { type: 'error', error: failure }; return;
}
const ctx = await buildContext(deps, channel);
const iterator = adapter.streamChat(ir, ctx)[Symbol.asyncIterator]();
// ... existing first-event failover logic, unchanged ...
```

(Remove the single pre-loop `const adapter = deps.adapters.get(deps.req.resource.providerType)` + its `streamChat === undefined` guard; selection is now per-channel. Keep the top-level `ir === undefined` guard.) Capture the committed channel (the `committed` object) and pass `{ channelId: channel.id, providerType: channel.providerType ?? deps.req.resource.providerType }` into `mirrorChatUsageLog` on the success settle.

- [ ] **Step 4 — run, expect PASS; full engine suite + typecheck + lint; commit** `feat(engine): per-channel adapter selection on the streaming chat path`.

## Task P1b.4 — `usage_log` served-channel columns

**Files:** `packages/db/src/schema/usage.ts` (+`channelId`/`providerType`); migration; `packages/db/src/repositories/usage.ts` (`insertUsageLog` params + `UsageLogRow`); the engine mirrors (`stream.ts` `mirrorChatUsageLog`, `execution-service.ts` `mirrorUsageLog`).

- [ ] **Step 1 — schema** add to `usageLog`: `channelId: uuid('channel_id')` (nullable), `providerType: text('provider_type')` (nullable). Generate the migration.
- [ ] **Step 2 — `insertUsageLog`** READ the current signature; add optional `channelId?: string`, `providerType?: string` to its input and set them (conditionally, `exactOptionalPropertyTypes`). Extend `UsageLogRow` automatically (InferSelectModel).
- [ ] **Step 3 — failing int test** in `packages/db/test/usage.int.test.ts` (or wherever `insertUsageLog` is tested): insert with `channelId`/`providerType`, read back, assert persisted.
- [ ] **Step 4 — wire the mirrors:** `mirrorChatUsageLog` (stream.ts) + `mirrorUsageLog` (execution-service.ts) accept the served `{channelId, providerType}` and pass to `insertUsageLog` (snake_case columns; camelCase repo input as today).
- [ ] **Step 5 — db + engine green; typecheck + lint; commit** `feat(db,engine): record served channel on usage_log`.

## Task P1b.5 — `x-actionow-channel` response header (blocking)

**Files:** `apps/api/src/chat/{openai,anthropic,gemini}.controller.ts`.

- [ ] **Step 1 — failing e2e** in `apps/api/test/chat-relay.e2e.test.ts`: a non-stream `POST /v1/chat/completions` response carries `x-actionow-channel` equal to the mock-chat channel's provider type (seed the chat resource with a `mock-chat` channel; the relay's `chat` now returns `servedBy`).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** the blocking controller path already has `@Res({ passthrough: true }) res`. After `const { response, servedBy } = await this.relay.chat(...)`, set `if (servedBy) res.setHeader('x-actionow-channel', servedBy.providerType)` before returning the rendered JSON. Thread `servedBy` from `ChatRunOutcome` through `ChatRelayService.chat` (return `{ response, servedBy }`). Streaming: **deferred** (the served channel is only known mid-stream, after SSE headers are committed) — note in code.
- [ ] **Step 4 — run, expect PASS; api typecheck + lint; commit** `feat(api): x-actionow-channel served-channel header on blocking chat`.

## Track P1b done-check

- [ ] A model can have channels with different `providerType`s; a request fails over across providers (proven by the engine unit tests) and `usage_log` + the blocking response header record which channel served. Cross-RESOURCE virtual models (one public name → multiple models) remain **out of scope** (documented).

---

# TRACK P1c — Usage analytics rollups (+ per-api-key attribution)

**Why:** `usage_log` mirrors per-call rows but the only read is `GET /admin/usage` (flat list). Operators need spend/requests/tokens/error-rate aggregated by day/model/tenant/channel/api-key. Per-key attribution needs an `api_key_id` column threaded from auth.

## Task P1c.1 — `usage_log.api_key_id` + thread it from auth

**Files:** `packages/db/src/schema/usage.ts` (+`apiKeyId`); migration; `insertUsageLog` (+param); `apps/api/src/auth/auth.service.ts` (`TenantContext` +`apiKeyId`) + `api-key.guard.ts` (put the key id on `req.auth`); `apps/api/src/chat/chat-relay.service.ts` (`RunRequest.usageLogApiKeyId`); the engine mirrors.

- [ ] **Step 1 — schema + migration:** add `apiKeyId: uuid('api_key_id')` (nullable) to `usageLog`; generate the migration.
- [ ] **Step 2 — auth:** READ `api-key.guard.ts` + `AuthService.resolve`. Ensure the validated api-key row's id is placed on `req.auth` (add if missing) and surfaced as `TenantContext.apiKeyId?: string`.
- [ ] **Step 3 — thread:** `RunRequest.usageLogApiKeyId?: string` (engine); `chat-relay.buildChatRunRequest` sets it from `ctx.apiKeyId`; the mirrors pass it to `insertUsageLog`.
- [ ] **Step 4 — int test:** `insertUsageLog` persists `apiKeyId`; round-trip assert. **Commit** `feat(db,api): attribute usage_log to the calling api key`.

## Task P1c.2 — `rollupUsage` repo (GROUP BY aggregation)

**Files:** `packages/db/src/repositories/usage.ts` (+`rollupUsage`); Test `packages/db/test/usage-rollup.int.test.ts`.

- [ ] **Step 1 — failing int test:** seed several `usage_log` rows across 2 models / 2 days / `status` ∈ {succeeded, failed}; assert `rollupUsage(db, { groupBy: 'model', ... })` returns per-model `{ bucket, requests, inputTokens, outputTokens, cost, errors }` with `cost` a bigint sum and `errors` counting non-succeeded.

```ts
const byModel = await rollupUsage(db, { groupBy: 'model', tenantId });
const gpt = byModel.find((r) => r.bucket === 'gpt-4o');
expect(gpt).toMatchObject({
  requests: 2,
  inputTokens: 30n,
  outputTokens: 12n,
  cost: 65n,
  errors: 0,
});
```

- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** using Drizzle's `sql`/`count`/`sum` with a `GROUP BY` keyed by the requested dimension. `groupBy`: `'day' | 'model' | 'tenant' | 'channel' | 'api_key'`. For `'day'`, bucket = `date_trunc('day', created_at)`; for the others the dimension column. Filter by optional `tenantId`, `from`, `to`. Return `bucket: string`, `requests: number`, `inputTokens: bigint`, `outputTokens: bigint`, `cost: bigint`, `errors: number`. Sum token/cost as bigint (Postgres `sum` of bigint returns numeric — cast/parse to `bigint`; mirror how other bigint sums are read in the repos). **No float.**

```ts
export interface UsageRollupRow {
  bucket: string;
  requests: number;
  inputTokens: bigint;
  outputTokens: bigint;
  cost: bigint;
  errors: number;
}
export interface UsageRollupQuery {
  groupBy: 'day' | 'model' | 'tenant' | 'channel' | 'api_key';
  tenantId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}
export async function rollupUsage(db: DbOrTx, q: UsageRollupQuery): Promise<UsageRollupRow[]> {
  // build `bucketExpr` per q.groupBy; SELECT bucketExpr AS bucket,
  //   count(*) requests, coalesce(sum(input_tokens),0), coalesce(sum(output_tokens),0),
  //   coalesce(sum(cost),0), count(*) FILTER (WHERE status <> 'succeeded') errors
  // FROM usage_log WHERE (tenantId?) AND (created_at >= from?) AND (created_at < to?)
  // GROUP BY bucket ORDER BY bucket;  map numerics → bigint, counts → number.
}
```

- [ ] **Step 4 — run, expect PASS;** export from the repo barrel; **commit** `feat(db): rollupUsage analytics aggregation`.

## Task P1c.3 — `GET /admin/analytics/usage`

**Files:** `apps/api/src/admin/dto/admin.dto.ts` (query schema); `admin.service.ts` (`analyticsUsage`); `admin.controller.ts` (route + view); Test: `apps/api/test/admin-relay-ops.e2e.test.ts` (or admin-crud).

- [ ] **Step 1 — failing e2e:** seed usage_log rows (via the engine settle path or direct insert), `GET /admin/analytics/usage?groupBy=model` → 200 with `[{ bucket, requests, input_tokens, output_tokens, cost, errors }]` (bigints serialized as decimal strings, matching the repo's existing money-as-string convention — see `toLedgerView`/`UsageLogView`).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** a `analyticsQuerySchema` (`groupBy` enum, optional `from`/`to` ISO, optional `tenantId`), `admin.service.analyticsUsage(q)` → `rollupUsage`, controller `@Get('analytics/usage')` mapping each row to a view with `cost`/`input_tokens`/`output_tokens` as decimal strings. Mirror the existing `@Get('usage')` + `UsageLogView` pattern.
- [ ] **Step 4 — run, expect PASS; full api typecheck + lint; commit** `feat(api): GET /admin/analytics/usage rollups`.

## Track P1c done-check

- [ ] Operators can query spend/requests/tokens/error-rate grouped by day/model/tenant/channel/api-key. **Dashboard UI is deferred** to the `actionow-web` worktree (`feat/admin-frontend`) as the immediate follow-up — it consumes `GET /admin/analytics/usage`. **Latency (p50/p95)** is deferred (needs a `duration_ms` capture on settle — note for a follow-up).

---

# Verification gate (run before merge)

- [ ] `docker info` ok. `pnpm install` (clean lockfile if deps changed — none expected).
- [ ] `pnpm typecheck` · `pnpm lint` · `pnpm build` — all green.
- [ ] `pnpm test` — all suites green **when run serially** (turbo parallel + Testcontainers can contend; the worker `webhook-outbox` due-time test is a known pre-existing clock-skew flake — if it flakes, re-run that package alone). Confirm: db (crypto + enc-secret + channel-health + usage-rollup), engine (per-channel failover blocking + streaming + served-channel), api (admin-crud secrets + chat-relay header).
- [ ] No `: any`/`as any` in the new code; no plaintext secret ever returned or logged (grep the new admin/secret code paths); migrations apply cleanly in sequence.
- [ ] Merge `feat/secrets-crossprovider-analytics` → `main` (fast-forward), delete branch, `git push origin main`.

# Out of scope / non-goals

- No Vault server, no Redis (beyond BullMQ), no key rotation (F0 v1). No cross-RESOURCE virtual models (P1b). No latency analytics, no dashboard UI in this repo (P1c — UI lands in `actionow-web`). No CLI-OAuth (P1a) — F0 is its groundwork.
