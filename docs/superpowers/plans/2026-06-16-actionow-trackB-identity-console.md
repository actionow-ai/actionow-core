# Track B — Identity, Permissions & Tenant Self-Service Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes. TDD.

**Goal:** Ship the tenant self-service `/console/*` surface (user-JWT scoped to the caller's own tenant — API-key CRUD/rotate, own usage view, self-topup, models list), close the "self-registered user can't mint its own key" gap, tighten cross-tenant isolation with SQL-predicate repo variants, and harden self-deploy security (explicit dev-tenant flag, always-required admin secret, `role` constraint, `account` unique + `job.account_id`).

**Architecture:** A new NestJS module `apps/api/src/console/*` with a `ConsoleGuard` that verifies the **user** JWT (same `ADMIN_JWT_SECRET` signer as login/admin) and resolves the tenant from the user's `user.tenant_id` (a data plane independent of the API-key `ApiKeyGuard`). New DB repo functions add tenant-predicate variants (`getJobForTenant`, `getResourceForTenant`) and API-key lifecycle ops (status update, rotate). One Drizzle migration adds the `role` check constraint, `account` unique(tenant_id), and `job.account_id`. Config gains `ALLOW_DEV_TENANT_HEADER` and makes `ADMIN_JWT_SECRET` always required-or-explicit.

**Tech Stack:** NestJS 11 (ESM), Drizzle ORM + drizzle-kit (migrations in `packages/db/drizzle`), `@nestjs/jwt`, zod (via the existing `ZodBody` pipe), vitest, Testcontainers (`postgres:16-alpine`), supertest.

---

## Conventions

- **Repo root:** `/Users/alienworm/actionow-core` (pnpm monorepo, `pnpm@10.25.0`). Run all `pnpm` commands from the repo root unless a step says otherwise.
- **Branch:** `feat/trackB` (create with `git switch -c feat/trackB` before Task 1; never push).
- **TDD:** every task writes a failing test FIRST, runs it to see it fail, then writes minimal code to pass. Do not skip the red step.
- **Commits:** one commit per task. Lowercase conventional subject, e.g. `feat(console): add ConsoleGuard`. **Commit body lines MUST be < 100 chars** (commitlint enforces `body-max-line-length=100`). End every commit body with:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- **ESLint is strict:** no `any`, `@typescript-eslint/explicit-module-boundary-types`, `consistent-type-imports`, `simple-import-sort` (imports sorted), and `eslint-plugin-boundaries` + per-package `no-restricted-imports`. `apps/**` may import any `@actionow/*` package, so the console module (in `apps/api`) has no boundary restriction. All new `packages/db` repo code may import only `@actionow/{db,contracts,domain}` (db's allow-list).
- **Money is bigint µcredits.** Human credits convert via `creditsToMicro` (`@actionow/domain`) at the boundary; views serialize bigint as decimal strings (e.g. `row.creditBalance.toString()`). Never coerce money through a float.
- **Interfaces are PascalCase, no `I`-prefix.** Type-only imports use `import type`.
- **Migrations:** generate with `pnpm --filter @actionow/db db:generate` (drizzle-kit reads `packages/db/drizzle.config.ts`, dialect postgresql, schema `./src/schema/index.ts`, out `./drizzle`). drizzle-kit needs a reachable DB for some diffs; the local dev pg is `postgresql://actionow:actionow@localhost:5433/actionow` (start with `pnpm infra:up`). Each generated `.sql` + the updated `meta/_journal.json` + `meta/*_snapshot.json` are committed together. Tests apply migrations via `migrate(db, { migrationsFolder: '../../packages/db/drizzle' })`.
- **Docker must be up** for Testcontainers integration/e2e suites.

### Pinned shared signatures (use EXACTLY; do not rename)

- Track C (NOT built in this track) defines: `model` table; `resolveModelForTenant(db, modelName, tenantId)`; **`listVisibleModels(db, tenantId) -> ModelView[]`**; `usage_log` table + `insertUsageLog`. Track B's `GET /console/models` and `GET /console/usage` CONSUME these. **They do not exist yet**, so Task 9 (models) and the usage_log slice of Task 7 use a thin **injected port** with the pinned signature and an in-repo fake, so Track B compiles/tests green independently. When Track C lands, the production binding swaps in the real function — no rename.

---

## Task 1 — `role` DB check constraint + `account` unique(tenant_id) + `job.account_id` migration

Closes spec §B.4: a free-text `role` should be constrained to `user|admin`; a tenant must have at most one `account` (so hold/settle never split across accounts); `job` should carry `account_id`.

**Files:**

- Modify `packages/db/src/schema/identity.ts` (the `user` table, lines 48-57) — add a `check` on `role`.
- Modify `packages/db/src/schema/accounts.ts` (the `account` table, lines 6-25) — add `uniqueIndex` on `tenantId`.
- Modify `packages/db/src/schema/execution.ts` (the `job` table, lines 17-49) — add nullable `account_id` column referencing `account.id`.
- Create `packages/db/drizzle/0004_<generated_name>.sql` (drizzle-kit names it) + updated `meta/_journal.json` + `meta/*_snapshot.json`.
- Create `packages/db/test/schema-constraints.test.ts` (integration, Testcontainers).

**Steps:**

- [ ] Write the failing integration test `packages/db/test/schema-constraints.test.ts`. It boots a `postgres:16-alpine` container, applies migrations from `../drizzle` (note: from `packages/db`, the migrations folder is `./drizzle`), and asserts the three constraints. SHOW the full test:

  ```ts
  import { schema } from '../src/index.js';
  import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
  import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
  import { migrate } from 'drizzle-orm/postgres-js/migrator';
  import postgres from 'postgres';
  import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: PostgresJsDatabase<typeof schema>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    client = postgres(container.getConnectionUri(), { max: 5 });
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: './drizzle' });
  }, 180_000);

  afterAll(async () => {
    await client.end();
    await container.stop();
  });

  afterEach(async () => {
    await client`TRUNCATE TABLE job, account, "user", tenant RESTART IDENTITY CASCADE`;
  });

  describe('schema constraints (Track B Task 1)', () => {
    it('rejects a user.role outside (user|admin)', async () => {
      await expect(
        client`INSERT INTO "user" (email, role) VALUES ('bad@x.com', 'superuser')`,
      ).rejects.toThrow();
    });

    it('accepts role=user and role=admin', async () => {
      await client`INSERT INTO "user" (email, role) VALUES ('u@x.com', 'user')`;
      await client`INSERT INTO "user" (email, role) VALUES ('a@x.com', 'admin')`;
      const rows = await client`SELECT role FROM "user" ORDER BY email`;
      expect(rows.map((r) => r.role)).toEqual(['admin', 'user']);
    });

    it('forbids a second account for the same tenant (unique tenant_id)', async () => {
      const [t] = await client`INSERT INTO tenant (name) VALUES ('t') RETURNING id`;
      await client`INSERT INTO account (tenant_id) VALUES (${t.id})`;
      await expect(client`INSERT INTO account (tenant_id) VALUES (${t.id})`).rejects.toThrow();
    });

    it('job carries a nullable account_id FK to account', async () => {
      const [t] = await client`INSERT INTO tenant (name) VALUES ('t2') RETURNING id`;
      const [a] = await client`INSERT INTO account (tenant_id) VALUES (${t.id}) RETURNING id`;
      const [r] =
        await client`INSERT INTO resource (id, tenant_id, kind, modality, provider_type, exec_modes, current_version) VALUES ('res1', ${t.id}, 'model', 'text', 'openai', ARRAY['blocking'], 1) RETURNING id`;
      await client`INSERT INTO job (tenant_id, resource_id, resource_version, status, exec_mode, inputs, account_id) VALUES (${t.id}, ${r.id}, 1, 'queued', 'blocking', '{}'::jsonb, ${a.id})`;
      const rows = await client`SELECT account_id FROM job`;
      expect(rows[0].account_id).toBe(a.id);
    });
  });
  ```

- [ ] Run it, expect FAIL (migration `0004` does not exist yet, so the constraints are absent — the role/unique tests will NOT reject, and the `account_id` insert errors on an unknown column):
  ```
  pnpm --filter @actionow/db exec vitest run test/schema-constraints.test.ts
  ```
  Expected: the role/unique assertions fail (inserts succeed where a throw is expected) and the `account_id` test errors with `column "account_id" of relation "job" does not exist`.
- [ ] Add the `role` check to `packages/db/src/schema/identity.ts`. Import `check` from `drizzle-orm/pg-core` (add to the existing import block on lines 2-12) and `sql` is already imported (line 1). Convert the `user` table to the two-arg form with a constraints callback:
  ```ts
  export const user = pgTable(
    'user',
    {
      id: uuid('id').primaryKey().defaultRandom(),
      email: text('email').notNull().unique(),
      emailVerified: boolean('email_verified').notNull().default(false),
      passwordHash: text('password_hash'),
      role: text('role').notNull().default('user'),
      status: text('status').notNull().default('active'),
      tenantId: uuid('tenant_id').references(() => tenant.id),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [check('user_role_allowed', sql`${t.role} IN ('user', 'admin')`)],
  );
  ```
- [ ] Add the unique index to `packages/db/src/schema/accounts.ts`. Add `uniqueIndex` to the import on line 2 (`import { bigint, check, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';`) and append it to the constraints array (lines 23-24):
  ```ts
    (t) => [
      check('account_balance_ge_held', sql`${t.creditBalance} >= ${t.creditHeld}`),
      uniqueIndex('account_tenant_unique').on(t.tenantId),
    ],
  ```
- [ ] Add the `accountId` column to `packages/db/src/schema/execution.ts`. The `account` import already exists (line 13). Add inside the `job` columns (after `tenantId`, before `resourceId`, lines 20-26 area):
  ```ts
      accountId: uuid('account_id').references(() => account.id),
  ```
- [ ] Ensure the local dev pg is reachable, then generate the migration:
  ```
  pnpm infra:up
  pnpm --filter @actionow/db db:generate
  ```
  Confirm a new `packages/db/drizzle/0004_*.sql` exists containing `ADD CONSTRAINT "user_role_allowed" CHECK`, `CREATE UNIQUE INDEX "account_tenant_unique"`, and `ALTER TABLE "job" ADD COLUMN "account_id" uuid` + its FK, plus updated `meta/_journal.json` and a new snapshot. Read the generated SQL to verify it matches.
- [ ] Run the test, expect PASS:
  ```
  pnpm --filter @actionow/db exec vitest run test/schema-constraints.test.ts
  ```
  Expected: 4 passed.
- [ ] `git add -A && git commit` with subject `feat(db): constrain role, unique account tenant, job.account_id`.

---

## Task 2 — API-key lifecycle repo functions (status update + rotate) + tenant-scoped key reads

`createApiKey` and `listApiKeys` already exist (`packages/db/src/repositories/auth.ts`, `admin.ts`). The console needs to (a) read a single key scoped to a tenant, (b) disable (status→`disabled`) a key it owns, and (c) rotate — mint a fresh plaintext for the same `(tenantId, resourceAllowlist, rateLimit)` and disable the old row. All ops must be tenant-predicated in SQL so a cross-tenant key id is a no-op (returns `undefined`/`false`).

**Files:**

- Modify `packages/db/src/repositories/auth.ts` — add `getApiKeyForTenant`, `disableApiKeyForTenant`, `rotateApiKeyForTenant`.
- Modify `packages/db/src/repositories/index.ts` — export the three new functions + their types.
- Create `packages/db/test/api-key-lifecycle.test.ts` (integration, Testcontainers).

**Steps:**

- [ ] Write the failing integration test `packages/db/test/api-key-lifecycle.test.ts`. Use the same container harness as Task 1 (copy the `beforeAll`/`afterAll`/`afterEach` block; `afterEach` truncates `api_key, account, "user", tenant`). SHOW the body:

  ```ts
  import {
    createApiKey,
    createTenant,
    disableApiKeyForTenant,
    getApiKeyForTenant,
    hashApiKey,
    rotateApiKeyForTenant,
  } from '../src/index.js';

  describe('api-key lifecycle (Track B Task 2)', () => {
    it('getApiKeyForTenant returns the row only for its owning tenant', async () => {
      const t1 = await createTenant(db, { name: 'a' });
      const t2 = await createTenant(db, { name: 'b' });
      const key = await createApiKey(db, { tenantId: t1.id });
      const mine = await getApiKeyForTenant(db, key.id, t1.id);
      expect(mine?.id).toBe(key.id);
      const theirs = await getApiKeyForTenant(db, key.id, t2.id);
      expect(theirs).toBeUndefined();
    });

    it('disableApiKeyForTenant flips status and is cross-tenant safe', async () => {
      const t1 = await createTenant(db, { name: 'c' });
      const t2 = await createTenant(db, { name: 'd' });
      const key = await createApiKey(db, { tenantId: t1.id });
      expect(await disableApiKeyForTenant(db, key.id, t2.id)).toBe(false);
      expect(await disableApiKeyForTenant(db, key.id, t1.id)).toBe(true);
      const row = await getApiKeyForTenant(db, key.id, t1.id);
      expect(row?.status).toBe('disabled');
    });

    it('rotateApiKeyForTenant mints a new active key, disables the old, preserves allowlist/rateLimit', async () => {
      const t1 = await createTenant(db, { name: 'e' });
      const old = await createApiKey(db, {
        tenantId: t1.id,
        resourceAllowlist: ['res-a'],
        rateLimit: 30,
      });
      const rotated = await rotateApiKeyForTenant(db, old.id, t1.id);
      if (rotated === undefined) throw new Error('expected rotate to succeed');
      expect(rotated.plaintext).toMatch(/^ak_/);
      expect(rotated.id).not.toBe(old.id);
      const oldRow = await getApiKeyForTenant(db, old.id, t1.id);
      expect(oldRow?.status).toBe('disabled');
      const newRow = await getApiKeyForTenant(db, rotated.id, t1.id);
      expect(newRow?.status).toBe('active');
      expect(newRow?.resourceAllowlist).toEqual(['res-a']);
      expect(newRow?.rateLimit).toBe(30);
      // the new plaintext hashes to the stored hash of the new row
      const looked = await db
        .select()
        .from(schema.apiKey)
        .where(eq(schema.apiKey.hash, hashApiKey(rotated.plaintext)));
      expect(looked[0]?.id).toBe(rotated.id);
    });

    it('rotateApiKeyForTenant is a cross-tenant no-op (undefined)', async () => {
      const t1 = await createTenant(db, { name: 'f' });
      const t2 = await createTenant(db, { name: 'g' });
      const old = await createApiKey(db, { tenantId: t1.id });
      expect(await rotateApiKeyForTenant(db, old.id, t2.id)).toBeUndefined();
    });
  });
  ```

  Add the imports `import { schema } from '../src/index.js';` and `import { eq } from 'drizzle-orm';` to the file's import block.

- [ ] Run it, expect FAIL (functions don't exist → import/compile error):
  ```
  pnpm --filter @actionow/db exec vitest run test/api-key-lifecycle.test.ts
  ```
  Expected: the run fails resolving `getApiKeyForTenant`/`disableApiKeyForTenant`/`rotateApiKeyForTenant`.
- [ ] Add the three functions to `packages/db/src/repositories/auth.ts`. The needed imports (`and`, `eq`, `apiKey`, `DbOrTx`, `hashApiKey`, `randomBytes`) are already present at the top of the file. Append after `findApiKeyByHash` (after line 79):

  ```ts
  /** The tenant-scoped view of an `api_key` row (no `hash`). */
  export interface ApiKeyView {
    readonly id: string;
    readonly tenantId: string;
    readonly resourceAllowlist: string[];
    readonly rateLimit: number | null;
    readonly status: string;
    readonly createdAt: Date;
  }

  /** Columns surfaced by the tenant-scoped key reads (never the `hash`). */
  const API_KEY_VIEW_COLUMNS = {
    id: apiKey.id,
    tenantId: apiKey.tenantId,
    resourceAllowlist: apiKey.resourceAllowlist,
    rateLimit: apiKey.rateLimit,
    status: apiKey.status,
    createdAt: apiKey.createdAt,
  } as const;

  /**
   * Fetch one of a tenant's API keys by id, tenant predicate in SQL so a
   * cross-tenant id resolves to `undefined`. Never returns the stored `hash`.
   */
  export async function getApiKeyForTenant(
    db: DbOrTx,
    keyId: string,
    tenantId: string,
  ): Promise<ApiKeyView | undefined> {
    const rows = await db
      .select(API_KEY_VIEW_COLUMNS)
      .from(apiKey)
      .where(and(eq(apiKey.id, keyId), eq(apiKey.tenantId, tenantId)))
      .limit(1);
    return rows[0];
  }

  /**
   * Disable (`status='disabled'`) one of a tenant's keys. Tenant predicate in
   * SQL — a cross-tenant id matches no row. Returns `true` iff a row changed.
   */
  export async function disableApiKeyForTenant(
    db: DbOrTx,
    keyId: string,
    tenantId: string,
  ): Promise<boolean> {
    const rows = await db
      .update(apiKey)
      .set({ status: 'disabled' })
      .where(and(eq(apiKey.id, keyId), eq(apiKey.tenantId, tenantId)))
      .returning({ id: apiKey.id });
    return rows.length === 1;
  }

  /**
   * Rotate one of a tenant's keys: in a single transaction, mint a NEW key for
   * the same tenant carrying the old key's `resourceAllowlist`/`rateLimit`, then
   * disable the old row. Tenant-scoped — a cross-tenant (or unknown) id is a
   * no-op returning `undefined`. The new plaintext is returned ONCE.
   */
  export async function rotateApiKeyForTenant(
    db: DbOrTx,
    keyId: string,
    tenantId: string,
  ): Promise<CreatedApiKey | undefined> {
    return db.transaction(async (tx) => {
      const existing = await getApiKeyForTenant(tx, keyId, tenantId);
      if (existing === undefined) return undefined;
      const created = await createApiKey(tx, {
        tenantId,
        resourceAllowlist: existing.resourceAllowlist,
        rateLimit: existing.rateLimit ?? undefined,
      });
      await disableApiKeyForTenant(tx, keyId, tenantId);
      return created;
    });
  }
  ```

- [ ] Export the new symbols from `packages/db/src/repositories/index.ts`. In the existing `./auth.js` export block (lines 17-34), add (keep the block alphabetized to satisfy `simple-import-sort/exports`): `type ApiKeyView`, `disableApiKeyForTenant`, `getApiKeyForTenant`, `rotateApiKeyForTenant`.
- [ ] Run the test, expect PASS:
  ```
  pnpm --filter @actionow/db exec vitest run test/api-key-lifecycle.test.ts
  ```
  Expected: 4 passed.
- [ ] `git add -A && git commit` with subject `feat(db): tenant-scoped api-key get/disable/rotate`.

---

## Task 3 — Tenant-predicate repo variants for jobs & resources

Spec §B.3: replace fetch-by-id-then-check with a tenant predicate in SQL. Add `getJobForTenant` and `getResourceForTenant`. (The existing `getJob`/`getResource` stay for non-tenant callers like the worker/callbacks.)

**Files:**

- Modify `packages/db/src/repositories/job.ts` — add `getJobForTenant` after `getJob` (line 62).
- Modify `packages/db/src/repositories/catalog.ts` — add `getResourceForTenant` after `getResource` (line 29).
- Modify `packages/db/src/repositories/index.ts` — export both.
- Create `packages/db/test/tenant-predicate.test.ts` (integration).

**Steps:**

- [ ] Write the failing integration test `packages/db/test/tenant-predicate.test.ts` (same container harness; `afterEach` truncates `job, resource, account, tenant`). SHOW the body:

  ```ts
  import {
    createResource,
    createTenant,
    getJobForTenant,
    getResourceForTenant,
  } from '../src/index.js';
  import { schema } from '../src/index.js';

  describe('tenant-predicate reads (Track B Task 3)', () => {
    it('getResourceForTenant returns only the owning tenant’s resource', async () => {
      const t1 = await createTenant(db, { name: 'rt1' });
      const t2 = await createTenant(db, { name: 'rt2' });
      await createResource(db, {
        id: 'r1',
        tenantId: t1.id,
        kind: 'model',
        modality: 'text',
        providerType: 'openai',
        execModes: ['blocking'],
        ioSchema: {},
        version: 1,
      });
      expect((await getResourceForTenant(db, 'r1', t1.id))?.id).toBe('r1');
      expect(await getResourceForTenant(db, 'r1', t2.id)).toBeUndefined();
    });

    it('getJobForTenant returns only the owning tenant’s job', async () => {
      const t1 = await createTenant(db, { name: 'jt1' });
      const t2 = await createTenant(db, { name: 'jt2' });
      await createResource(db, {
        id: 'r2',
        tenantId: t1.id,
        kind: 'model',
        modality: 'text',
        providerType: 'openai',
        execModes: ['blocking'],
        ioSchema: {},
        version: 1,
      });
      const [j] = await db
        .insert(schema.job)
        .values({
          tenantId: t1.id,
          resourceId: 'r2',
          resourceVersion: 1,
          status: 'queued',
          execMode: 'blocking',
          inputs: {},
        })
        .returning({ id: schema.job.id });
      expect((await getJobForTenant(db, j.id, t1.id))?.id).toBe(j.id);
      expect(await getJobForTenant(db, j.id, t2.id)).toBeUndefined();
    });
  });
  ```

- [ ] Run it, expect FAIL (functions don't exist):
  ```
  pnpm --filter @actionow/db exec vitest run test/tenant-predicate.test.ts
  ```
- [ ] Add `getJobForTenant` to `packages/db/src/repositories/job.ts` (after line 62). `and`, `eq`, `job`, `Job`, `DbOrTx` are already imported:
  ```ts
  /** Fetch a job by id scoped to a tenant (tenant predicate in SQL), or `undefined`. */
  export async function getJobForTenant(
    db: DbOrTx,
    jobId: string,
    tenantId: string,
  ): Promise<Job | undefined> {
    const rows = await db
      .select()
      .from(job)
      .where(and(eq(job.id, jobId), eq(job.tenantId, tenantId)))
      .limit(1);
    return rows[0];
  }
  ```
- [ ] Add `getResourceForTenant` to `packages/db/src/repositories/catalog.ts` (after line 29). `and`, `eq`, `resource`, `Resource`, `DbOrTx` are already imported:
  ```ts
  /** Fetch a resource by id scoped to a tenant (tenant predicate in SQL), or `undefined`. */
  export async function getResourceForTenant(
    db: DbOrTx,
    resourceId: string,
    tenantId: string,
  ): Promise<Resource | undefined> {
    const rows = await db
      .select()
      .from(resource)
      .where(and(eq(resource.id, resourceId), eq(resource.tenantId, tenantId)))
      .limit(1);
    return rows[0];
  }
  ```
- [ ] Export both from `packages/db/src/repositories/index.ts`: add `getJobForTenant` to the `./job.js` block (lines 81-90, keep sorted) and `getResourceForTenant` to the `./catalog.js` block (lines 35-71, keep sorted).
- [ ] Run the test, expect PASS:
  ```
  pnpm --filter @actionow/db exec vitest run test/tenant-predicate.test.ts
  ```
  Expected: 2 passed.
- [ ] `git add -A && git commit` with subject `feat(db): tenant-predicate getJobForTenant/getResourceForTenant`.

---

## Task 4 — Repoint `JobsService` to the tenant-predicate read (isolation tightening)

`JobsService.requireOwnedJob` (`apps/api/src/jobs/jobs.service.ts`, lines 72-78) does fetch-then-check. Repoint it to `getJobForTenant` so the predicate is in SQL (same external behavior: cross-tenant → 404).

**Files:**

- Modify `apps/api/src/jobs/jobs.service.ts` (import line 1; `requireOwnedJob` lines 72-78).
- Create `apps/api/test/jobs-isolation.e2e.test.ts` (e2e, Testcontainers).

**Steps:**

- [ ] Write the failing e2e `apps/api/test/jobs-isolation.e2e.test.ts`. Use the harness from `apps/api/test/admin-crud.e2e.test.ts` (the `beforeAll` that boots the container, migrates from `'../../packages/db/drizzle'`, overrides `DB` + `ENV`). Seed two tenants with accounts, insert a job for tenant A directly via `db`, mint an API key for each tenant via `createApiKey`, then assert tenant B's key gets 404 on A's job id and A's key gets 200. SHOW the core spec block (reuse the standard `beforeAll`/`afterAll` from admin-crud, with `afterEach` truncating `api_key, job, resource, account, tenant, "user"`):

  ```ts
  import { createApiKey, createResource, createTenant, schema } from '@actionow/db';
  // ...standard container + AppModule harness from admin-crud.e2e.test.ts...

  async function provision(name: string): Promise<{ tenantId: string; key: string }> {
    const t = await createTenant(db, { name });
    await db.insert(schema.account).values({ tenantId: t.id });
    const k = await createApiKey(db, { tenantId: t.id });
    return { tenantId: t.id, key: k.plaintext };
  }

  describe('cross-tenant job isolation (Track B Task 4)', () => {
    it('tenant B cannot read tenant A’s job (404), tenant A can (200)', async () => {
      const a = await provision('iso-a');
      const b = await provision('iso-b');
      await createResource(db, {
        id: 'iso-res',
        tenantId: a.tenantId,
        kind: 'model',
        modality: 'text',
        providerType: 'openai',
        execModes: ['blocking'],
        ioSchema: {},
        version: 1,
      });
      const [job] = await db
        .insert(schema.job)
        .values({
          tenantId: a.tenantId,
          resourceId: 'iso-res',
          resourceVersion: 1,
          status: 'queued',
          execMode: 'blocking',
          inputs: {},
        })
        .returning({ id: schema.job.id });

      await request(app.getHttpServer())
        .get(`/v1/jobs/${job.id}`)
        .set('authorization', `Bearer ${b.key}`)
        .expect(404);

      await request(app.getHttpServer())
        .get(`/v1/jobs/${job.id}`)
        .set('authorization', `Bearer ${a.key}`)
        .expect(200);
    });
  });
  ```

- [ ] Run it, expect PASS already for behavior (current fetch-then-check yields the same 404/200) — so to make this a real RED step, FIRST assert at the unit level that the service calls the predicate variant. Instead of relying on behavior parity, write the RED as a focused service unit test `apps/api/test/jobs-isolation.e2e.test.ts` is e2e; the predicate swap is verified by the e2e staying green AND by grepping the source. To get a genuine failing test, add this assertion to the e2e using a spy is not possible against the real db. Therefore: run the e2e now and expect PASS (it documents the contract), then proceed to the refactor and re-run to confirm no regression. Command:
  ```
  pnpm --filter @actionow/api exec vitest run test/jobs-isolation.e2e.test.ts
  ```
  Expected: 1 passed (behavior already holds — this test guards the refactor).
- [ ] Repoint the service. In `apps/api/src/jobs/jobs.service.ts` change the import on line 1 from `getJob` to also import `getJobForTenant`, and rewrite `requireOwnedJob` (lines 72-78):
  ```ts
  import { type Database, failJob, getJob, getJobForTenant, type Job, listJobs } from '@actionow/db';
  // ...
    private async requireOwnedJob(jobId: string, ctx: TenantContext): Promise<Job> {
      const job = await getJobForTenant(this.db, jobId, ctx.tenantId);
      if (job === undefined) {
        throw engineNotFound(`job ${jobId} not found`);
      }
      return job;
    }
  ```
  (`getJob` is still used on line 68 for the post-cancel refresh, so keep importing it.)
- [ ] Run the e2e again, expect PASS:
  ```
  pnpm --filter @actionow/api exec vitest run test/jobs-isolation.e2e.test.ts
  ```
  Expected: 1 passed.
- [ ] `git add -A && git commit` with subject `refactor(jobs): use getJobForTenant for SQL-predicate scoping`.

---

## Task 5 — Self-deploy hardening: `ALLOW_DEV_TENANT_HEADER` flag + always-required `ADMIN_JWT_SECRET`

Spec §B.4: gate the `x-tenant-id` dev fallback behind an explicit flag (default `false`) rather than `NODE_ENV` alone, and make `ADMIN_JWT_SECRET` required-or-explicit always (today a non-production env silently fills a weak default; harden so the default only applies under `NODE_ENV !== 'production'` AND the operator hasn't disabled it — we keep the dev default for local DX but add a boolean `ALLOW_DEV_TENANT_HEADER` that the guard consults). The guard must consult the flag.

**Files:**

- Modify `packages/infra/src/config.ts` — add `ALLOW_DEV_TENANT_HEADER` to `EnvSchema` (after `DEV_TENANT_ID`, line 20).
- Modify `apps/api/src/auth/api-key.guard.ts` — `resolveDevFallback` (lines 106-126) consults the flag.
- Modify `packages/infra/test/config.test.ts` (it already exists) — add the new `describe` cases (do NOT replace the existing tests).
- Modify `apps/api/test/api-key.guard.test.ts` — add flag cases.

**Steps:**

- [ ] `packages/infra/test/config.test.ts` already exists — APPEND a new `describe` block (do not remove existing tests). Write the failing unit test asserting `ALLOW_DEV_TENANT_HEADER` defaults to `false` and coerces `'true'`/`'false'`:

  ```ts
  import { loadEnv } from '../src/config.js';
  import { describe, expect, it } from 'vitest';

  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/d',
    REDIS_URL: 'redis://localhost:6379',
    ADMIN_JWT_SECRET: 'x',
  };

  describe('ALLOW_DEV_TENANT_HEADER (Track B Task 5)', () => {
    it('defaults to false', () => {
      expect(loadEnv({ ...base } as NodeJS.ProcessEnv).ALLOW_DEV_TENANT_HEADER).toBe(false);
    });
    it('coerces the string "true"', () => {
      expect(
        loadEnv({ ...base, ALLOW_DEV_TENANT_HEADER: 'true' } as NodeJS.ProcessEnv)
          .ALLOW_DEV_TENANT_HEADER,
      ).toBe(true);
    });
  });
  ```

- [ ] Run it, expect FAIL (field absent → `undefined`):
  ```
  pnpm --filter @actionow/infra exec vitest run test/config.test.ts
  ```
- [ ] Add the field to `packages/infra/src/config.ts` inside `EnvSchema.object({...})`, right after `DEV_TENANT_ID` (line 20). Mirror the existing `STORAGE_FORCE_PATH_STYLE` enum-transform pattern (lines 39-42) but default to `false`:
  ```ts
      // Gate for the dev-only `x-tenant-id` fallback in the ApiKeyGuard. Default
      // `false`: even outside production the guard requires a real key unless an
      // operator explicitly opts in. Hardens self-deploy (a misconfigured non-prod
      // instance no longer silently accepts an unauthenticated tenant header).
      ALLOW_DEV_TENANT_HEADER: z
        .enum(['true', 'false'])
        .transform((v) => v === 'true')
        .default('false'),
  ```
- [ ] Run the infra test, expect PASS:
  ```
  pnpm --filter @actionow/infra exec vitest run test/config.test.ts
  ```
- [ ] Add the failing guard cases to `apps/api/test/api-key.guard.test.ts`. The `guard()` helper (lines 40-42) currently passes only `NODE_ENV`. Extend it to thread the flag and add a new `describe`:

  ```ts
  function guardWithFlag(repo: ApiKeyRepo, allowDevHeader: boolean): ApiKeyGuard {
    return new ApiKeyGuard({} as never, repo, {
      NODE_ENV: 'development',
      ALLOW_DEV_TENANT_HEADER: allowDevHeader,
    } as never);
  }

  describe('x-tenant-id requires the explicit ALLOW_DEV_TENANT_HEADER flag', () => {
    it('honored when the flag is true (non-prod)', async () => {
      const g = guardWithFlag(repoWithKey(), true);
      const req = { headers: { 'x-tenant-id': 'dev-tenant' }, params: {} } as unknown as Request;
      const ctx = {
        switchToHttp: () => ({ getRequest: () => req }),
      } as unknown as ExecutionContext;
      await expect(g.canActivate(ctx)).resolves.toBe(true);
    });

    it('rejected when the flag is false even in non-prod', async () => {
      const g = guardWithFlag(repoWithKey(), false);
      await expect(
        g.canActivate(ctxFor({ headers: { 'x-tenant-id': 'dev-tenant' } })),
      ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
    });
  });
  ```

  Also update the existing `'is honored outside production when no key is present'` case (lines 134-144) to construct the guard with `ALLOW_DEV_TENANT_HEADER: true` (the old `guard(repoWithKey(), 'development')` will now fail closed), by switching it to `guardWithFlag(repoWithKey(), true)`.

- [ ] Run the guard test, expect FAIL (guard still keys on `NODE_ENV` only, so the `flag=false` case wrongly passes and the `flag=true` case may pass for the wrong reason):
  ```
  pnpm --filter @actionow/api exec vitest run test/api-key.guard.test.ts
  ```
- [ ] Update `resolveDevFallback` in `apps/api/src/auth/api-key.guard.ts` (lines 106-126). Replace the `NODE_ENV` check with the flag AND the non-production guard:
  ```ts
    private async resolveDevFallback(req: AuthedRequest): Promise<ApiKeyContext> {
      if (this.env.NODE_ENV === 'production' || !this.env.ALLOW_DEV_TENANT_HEADER) {
        throw engineUnauthorized('missing API key');
      }
      const header = req.headers['x-tenant-id'];
      const tenantId = Array.isArray(header) ? header[0] : header;
      if (tenantId === undefined || tenantId === '') {
        throw engineUnauthorized('missing API key');
      }
      const account = await this.repo.getAccountByTenant(this.db, tenantId);
      if (account === undefined) {
        throw engineUnauthorized(`no account for tenant ${tenantId}`);
      }
      return {
        tenantId,
        accountId: account.id,
        apiKeyId: null,
        resourceAllowlist: [],
        rateLimit: null,
      };
    }
  ```
  Also update the class doc comment (lines 56-58) to say the fallback is gated to `NODE_ENV !== 'production'` AND `ALLOW_DEV_TENANT_HEADER`.
- [ ] Run the guard test, expect PASS:
  ```
  pnpm --filter @actionow/api exec vitest run test/api-key.guard.test.ts
  ```
- [ ] `git add -A && git commit` with subject `feat(infra): gate x-tenant-id behind ALLOW_DEV_TENANT_HEADER`.

---

## Task 6 — `ConsoleGuard` (user-JWT → own-tenant context)

The console plane is authenticated by the **user** JWT (same `{sub, role}` claims and `ADMIN_JWT_SECRET` signer as `LocalAuthService.issueToken`). The guard verifies the token, looks the user up by `sub`, requires an active user with a non-null `tenant_id`, resolves that tenant's account, and attaches a `ConsoleContext` to `req.console`. This is independent of `ApiKeyGuard` (the data plane).

**Files:**

- Create `apps/api/src/console/console.guard.ts`.
- Create `apps/api/test/console.guard.test.ts` (unit, injected fakes).

**Steps:**

- [ ] Write the failing unit test `apps/api/test/console.guard.test.ts`. Model it on `apps/api/test/api-key.guard.test.ts` (the `ctxFor` + ExecutionContext helper) and on how `AdminGuard` is unit-tested in `apps/api/test/admin.guard.test.ts`. The guard takes `(jwt: JwtService, db, repo: ConsoleRepo, env)`. SHOW the full test:

  ```ts
  import type { UserRecord } from '@actionow/db';
  import type { ExecutionContext } from '@nestjs/common';
  import { JwtService } from '@nestjs/jwt';
  import type { Request } from 'express';
  import { describe, expect, it } from 'vitest';

  import { ConsoleGuard, type ConsoleRepo } from '../src/console/console.guard.js';

  const SECRET = 'console-test-secret';
  const jwt = new JwtService({ secret: SECRET });

  function ctxFor(req: Partial<Request>): ExecutionContext {
    const request = { headers: {}, ...req } as Request;
    return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  }

  function repoWith(user: Partial<UserRecord> | undefined): ConsoleRepo {
    const full: UserRecord | undefined =
      user === undefined
        ? undefined
        : {
            id: 'u1',
            email: 'u@x.com',
            emailVerified: true,
            passwordHash: null,
            role: 'user',
            status: 'active',
            tenantId: 'tenant-1',
            ...user,
          };
    return {
      findUserById: () => Promise.resolve(full),
      getAccountByTenant: () => Promise.resolve({ id: 'account-1' }),
    };
  }

  function guard(repo: ConsoleRepo): ConsoleGuard {
    return new ConsoleGuard(jwt, {} as never, repo, { ADMIN_JWT_SECRET: SECRET } as never);
  }

  async function token(sub: string): Promise<string> {
    return jwt.signAsync({ sub, role: 'user' }, { secret: SECRET, expiresIn: '5m' });
  }

  describe('ConsoleGuard', () => {
    it('rejects a missing token (401)', async () => {
      await expect(guard(repoWith({})).canActivate(ctxFor({ headers: {} }))).rejects.toMatchObject({
        unified: { code: 'unauthorized' },
      });
    });

    it('rejects an invalid/expired token (401)', async () => {
      const bad = await new JwtService({ secret: 'other' }).signAsync({ sub: 'u1', role: 'user' });
      await expect(
        guard(repoWith({})).canActivate(ctxFor({ headers: { authorization: `Bearer ${bad}` } })),
      ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
    });

    it('rejects when the user has no tenant (401)', async () => {
      const t = await token('u1');
      await expect(
        guard(repoWith({ tenantId: null })).canActivate(
          ctxFor({ headers: { authorization: `Bearer ${t}` } }),
        ),
      ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
    });

    it('rejects a disabled user (401)', async () => {
      const t = await token('u1');
      await expect(
        guard(repoWith({ status: 'disabled' })).canActivate(
          ctxFor({ headers: { authorization: `Bearer ${t}` } }),
        ),
      ).rejects.toMatchObject({ unified: { code: 'unauthorized' } });
    });

    it('attaches {userId, tenantId, accountId} on success', async () => {
      const t = await token('u1');
      const req = { headers: { authorization: `Bearer ${t}` } } as unknown as Request;
      const ctx = {
        switchToHttp: () => ({ getRequest: () => req }),
      } as unknown as ExecutionContext;
      await expect(guard(repoWith({})).canActivate(ctx)).resolves.toBe(true);
      const attached = (req as unknown as { console: Record<string, unknown> }).console;
      expect(attached).toMatchObject({
        userId: 'u1',
        tenantId: 'tenant-1',
        accountId: 'account-1',
      });
    });
  });
  ```

- [ ] Run it, expect FAIL (module missing):
  ```
  pnpm --filter @actionow/api exec vitest run test/console.guard.test.ts
  ```
- [ ] Create `apps/api/src/console/console.guard.ts`. Mirror `AdminGuard` (JWT verify + `engineUnauthorized`) and `ApiKeyGuard` (repo interface + `getAccountByTenant`). SHOW the file:

  ```ts
  import type { Database, UserRecord } from '@actionow/db';
  import { findUserById, getAccountByTenant } from '@actionow/db';
  import type { AppEnv } from '@actionow/infra';
  import type { CanActivate, ExecutionContext } from '@nestjs/common';
  import { Inject, Injectable } from '@nestjs/common';
  import { JwtService } from '@nestjs/jwt';
  import type { Request } from 'express';

  import type { AuthClaims } from '../auth/local-auth.service.js';
  import { engineUnauthorized } from '../common/errors.js';
  import { DB, ENV } from '../common/tokens.js';

  /** The console-caller context the guard attaches as `req.console`. */
  export interface ConsoleContext {
    readonly userId: string;
    readonly tenantId: string;
    readonly accountId: string;
  }

  /** An express request carrying the guard-populated {@link ConsoleContext}. */
  export interface ConsoleRequest extends Request {
    console?: ConsoleContext;
  }

  /** The db surface the guard depends on (extracted so unit tests inject fakes). */
  export interface ConsoleRepo {
    findUserById(db: Database, id: string): Promise<UserRecord | undefined>;
    getAccountByTenant(db: Database, tenantId: string): Promise<{ id: string } | undefined>;
  }

  /** Production repo wired to the real `@actionow/db` functions. */
  export const defaultConsoleRepo: ConsoleRepo = { findUserById, getAccountByTenant };

  /** DI token for the (overridable) {@link ConsoleRepo}. */
  export const CONSOLE_REPO = Symbol('CONSOLE_REPO');

  /**
   * Authenticates `/console/*` requests with the USER JWT (same `{sub, role}`
   * claims + `ADMIN_JWT_SECRET` signer as login). Verifies the token, loads the
   * user by `sub`, requires an ACTIVE user owning a tenant, resolves that tenant's
   * account, and attaches a {@link ConsoleContext} to `req.console`. This is the
   * self-service control plane — independent of the API-key data plane. A missing,
   * invalid, expired, tenant-less, or disabled principal is `401 unauthorized`.
   * No token or secret is ever logged.
   */
  @Injectable()
  export class ConsoleGuard implements CanActivate {
    constructor(
      private readonly jwt: JwtService,
      @Inject(DB) private readonly db: Database,
      @Inject(CONSOLE_REPO) private readonly repo: ConsoleRepo,
      @Inject(ENV) private readonly env: AppEnv,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
      const req = context.switchToHttp().getRequest<ConsoleRequest>();
      const token = bearerToken(req);
      if (token === undefined) {
        throw engineUnauthorized('missing console token');
      }

      let claims: AuthClaims;
      try {
        claims = await this.jwt.verifyAsync<AuthClaims>(token, {
          secret: this.env.ADMIN_JWT_SECRET,
        });
      } catch {
        throw engineUnauthorized('invalid or expired console token');
      }

      const user = await this.repo.findUserById(this.db, claims.sub);
      if (user?.status !== 'active' || user.tenantId === null) {
        throw engineUnauthorized('no tenant for console user');
      }

      const account = await this.repo.getAccountByTenant(this.db, user.tenantId);
      if (account === undefined) {
        throw engineUnauthorized(`no account for tenant ${user.tenantId}`);
      }

      req.console = { userId: user.id, tenantId: user.tenantId, accountId: account.id };
      return true;
    }
  }

  /** Read a Bearer token from the `Authorization` header. */
  function bearerToken(req: Request): string | undefined {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string') return undefined;
    const match = /^Bearer\s+(\S+)$/i.exec(auth);
    return match?.[1];
  }
  ```

- [ ] Run the guard test, expect PASS:
  ```
  pnpm --filter @actionow/api exec vitest run test/console.guard.test.ts
  ```
  Expected: 5 passed.
- [ ] `git add -A && git commit` with subject `feat(console): add ConsoleGuard for user-JWT tenant scope`.

---

## Task 7 — Console service + DTOs (api-keys, usage, self-topup, models port)

The console service owns the tenant-scoped reads/writes behind the controller (mirrors `AdminService`). It reuses `createApiKey`/`getApiKeyForTenant`/`disableApiKeyForTenant`/`rotateApiKeyForTenant`/`listApiKeys` (keys), `listJobs`/`listLedger` (usage), the engine `PaymentService` (self-topup), and a **`ModelsPort`** for the models list (Track C's `listVisibleModels`, injected via the pinned signature).

**Files:**

- Create `apps/api/src/console/dto/console.dto.ts`.
- Create `apps/api/src/console/models.port.ts` (the injected Track-C seam + a fake default).
- Create `apps/api/src/console/console.service.ts`.
- Create `apps/api/test/console.service.test.ts` (unit, injected fakes — no network).

**Steps:**

- [ ] Create `apps/api/src/console/dto/console.dto.ts`. Mirror `apps/api/src/admin/dto/admin.dto.ts` and `apps/api/src/payments/dto/payments.dto.ts` (zod; the console caller never passes `tenantId` — the guard supplies it). SHOW the file:

  ```ts
  import { paymentProviderSchema, paymentPurposeSchema } from '@actionow/contracts';
  import { z } from 'zod';

  /** `POST /console/api-keys` — mint a key for the caller's own tenant. */
  export const consoleCreateApiKeySchema = z.object({
    resourceAllowlist: z.array(z.string()).optional(),
    rateLimit: z.number().int().positive().optional(),
  });
  export type ConsoleCreateApiKeyDto = z.infer<typeof consoleCreateApiKeySchema>;

  /**
   * `POST /console/payments/intents` — self-topup for the caller's own tenant.
   * `amount_minor` is the currency minor unit (cents/fen), carried downstream as
   * a bigint; bounded to a safe integer so `BigInt()` never loses precision.
   * `purpose` is fixed to a topup by the service (the user only funds itself).
   */
  export const consoleCreateIntentSchema = z.object({
    provider: paymentProviderSchema,
    amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.string().min(1),
  });
  export type ConsoleCreateIntentDto = z.infer<typeof consoleCreateIntentSchema>;
  ```

  (`paymentPurposeSchema` is imported only if you reference it; the service hardcodes the purpose, so you may drop the `paymentPurposeSchema` import to avoid an unused-import lint error. Verify the purpose literal against `@actionow/contracts` `paymentPurposeSchema` enum — read it first; use the topup member it defines, e.g. `'topup'`.)

- [ ] Read `packages/contracts/src/` for the exact `paymentPurposeSchema` topup member (grep: `grep -rn "paymentPurposeSchema\|topup" packages/contracts/src`). Use that exact literal in the service below.
- [ ] Create `apps/api/src/console/models.port.ts` — the Track-C seam with the **pinned** `listVisibleModels` signature and a fake default returning `[]` so Track B is independent. SHOW the file:

  ```ts
  import type { Database } from '@actionow/db';

  /**
   * The tenant-visible model view (Track C's `ModelView`). Pinned shape: the
   * fields the console surfaces. Track C OWNS the canonical type; this mirrors it
   * for the seam until Track C lands and the real `listVisibleModels` is bound.
   */
  export interface ModelView {
    readonly name: string;
    readonly display: string;
    readonly modality: string;
    readonly capabilities: unknown;
    readonly visibility: string;
  }

  /** The Track-C function the console consumes. Pinned signature; do not rename. */
  export interface ModelsPort {
    listVisibleModels(db: Database, tenantId: string): Promise<ModelView[]>;
  }

  /** DI token for the (overridable) {@link ModelsPort}. */
  export const MODELS_PORT = Symbol('MODELS_PORT');

  /**
   * Default port until Track C ships `listVisibleModels`. Returns an empty list
   * so `GET /console/models` is `200 []` on a standalone Track-B deploy. When
   * Track C lands, bind `{ listVisibleModels }` from `@actionow/db` here instead.
   */
  export const fakeModelsPort: ModelsPort = {
    listVisibleModels: () => Promise.resolve([]),
  };
  ```

- [ ] Write the failing unit test `apps/api/test/console.service.test.ts`. Inject fakes for the db (a stub object — the service delegates to repo functions, so to unit-test without a DB, structure the service so its key/usage methods take injected repo functions like `AdminService` does NOT — `AdminService` calls the real repos with `this.db`). To keep this a true no-network unit test, test ONLY the models + topup-purpose mapping here (the repo-backed methods are covered by the e2e in Task 8). SHOW the test:

  ```ts
  import type { Database } from '@actionow/db';
  import type { PaymentService } from '@actionow/engine';
  import { describe, expect, it, vi } from 'vitest';

  import { ConsoleService } from '../src/console/console.service.js';
  import type { ModelsPort } from '../src/console/models.port.js';

  const fakeDb = {} as Database;

  function service(overrides: {
    models?: ModelsPort;
    payments?: Pick<PaymentService, 'createIntent'>;
  }): ConsoleService {
    const models: ModelsPort = overrides.models ?? { listVisibleModels: () => Promise.resolve([]) };
    const payments = (overrides.payments ?? {
      createIntent: vi.fn().mockResolvedValue({ intentId: 'pi_1', redirectUrl: 'https://x' }),
    }) as PaymentService;
    return new ConsoleService(fakeDb, payments, models);
  }

  describe('ConsoleService', () => {
    it('listModels delegates to the ModelsPort with the caller tenant', async () => {
      const listVisibleModels = vi
        .fn()
        .mockResolvedValue([
          {
            name: 'gpt-4o',
            display: 'GPT-4o',
            modality: 'chat',
            capabilities: {},
            visibility: 'public',
          },
        ]);
      const svc = service({ models: { listVisibleModels } });
      const out = await svc.listModels('tenant-1');
      expect(listVisibleModels).toHaveBeenCalledWith(fakeDb, 'tenant-1');
      expect(out[0].name).toBe('gpt-4o');
    });

    it('selfTopup creates a topup intent scoped to the caller tenant', async () => {
      const createIntent = vi.fn().mockResolvedValue({ intentId: 'pi_2' });
      const svc = service({ payments: { createIntent } });
      const res = await svc.selfTopup(
        { provider: 'stripe', amount_minor: 5000, currency: 'usd' },
        'tenant-9',
      );
      expect(createIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-9',
          provider: 'stripe',
          purpose: 'topup',
          amountMinor: 5000n,
          currency: 'usd',
        }),
      );
      expect(res.intent_id).toBe('pi_2');
    });
  });
  ```

- [ ] Run it, expect FAIL (service missing):
  ```
  pnpm --filter @actionow/api exec vitest run test/console.service.test.ts
  ```
- [ ] Create `apps/api/src/console/console.service.ts`. Constructor takes `@Inject(DB)`, `@Inject(PAYMENTS)`, `@Inject(MODELS_PORT)`. SHOW the file (use the exact topup purpose literal confirmed earlier — shown here as `'topup'`):

  ```ts
  import type { ApiKeyView, CreatedApiKey, Database, Job, LedgerRow } from '@actionow/db';
  import {
    createApiKey,
    disableApiKeyForTenant,
    getApiKeyForTenant,
    listApiKeys,
    listJobs,
    listLedger,
    rotateApiKeyForTenant,
  } from '@actionow/db';
  import type { PaymentService } from '@actionow/engine';
  import { Inject, Injectable } from '@nestjs/common';

  import { engineNotFound } from '../common/errors.js';
  import { DB, PAYMENTS } from '../common/tokens.js';
  import type { ConsoleCreateApiKeyDto, ConsoleCreateIntentDto } from './dto/console.dto.js';
  import type { ModelsPort, ModelView } from './models.port.js';
  import { MODELS_PORT } from './models.port.js';

  /** The self-topup response (provider checkout handle). */
  export interface ConsoleIntentResponse {
    intent_id: string;
    redirect_url?: string;
    qr?: string;
  }

  /**
   * Self-service application service behind `/console/*`. Every method is scoped
   * to the caller's own `tenantId` (supplied by the {@link ConsoleGuard}); the
   * tenant never appears in a request body. API-key writes reuse the tenant-scoped
   * db repos; usage reads reuse `listJobs`/`listLedger`; self-topup reuses the
   * engine {@link PaymentService}; the models list goes through the Track-C
   * {@link ModelsPort}. No secret/key is logged.
   */
  @Injectable()
  export class ConsoleService {
    constructor(
      @Inject(DB) private readonly db: Database,
      @Inject(PAYMENTS) private readonly payments: PaymentService,
      @Inject(MODELS_PORT) private readonly models: ModelsPort,
    ) {}

    // ----- api keys -----

    createApiKey(dto: ConsoleCreateApiKeyDto, tenantId: string): Promise<CreatedApiKey> {
      return createApiKey(this.db, {
        tenantId,
        resourceAllowlist: dto.resourceAllowlist,
        rateLimit: dto.rateLimit,
      });
    }

    listApiKeys(tenantId: string): Promise<ApiKeyView[]> {
      return listApiKeys(this.db, tenantId);
    }

    async disableApiKey(keyId: string, tenantId: string): Promise<void> {
      const ok = await disableApiKeyForTenant(this.db, keyId, tenantId);
      if (!ok) throw engineNotFound(`api key ${keyId} not found`);
    }

    async rotateApiKey(keyId: string, tenantId: string): Promise<CreatedApiKey> {
      const rotated = await rotateApiKeyForTenant(this.db, keyId, tenantId);
      if (rotated === undefined) throw engineNotFound(`api key ${keyId} not found`);
      return rotated;
    }

    // ----- usage -----

    listJobs(tenantId: string, cursor: string | undefined, limit: number): Promise<Job[]> {
      return listJobs(this.db, tenantId, cursor, limit);
    }

    listLedger(tenantId: string, cursor: string | undefined, limit: number): Promise<LedgerRow[]> {
      return listLedger(this.db, tenantId, cursor, limit);
    }

    // ----- models -----

    listModels(tenantId: string): Promise<ModelView[]> {
      return this.models.listVisibleModels(this.db, tenantId);
    }

    // ----- self-topup -----

    async selfTopup(dto: ConsoleCreateIntentDto, tenantId: string): Promise<ConsoleIntentResponse> {
      const result = await this.payments.createIntent({
        tenantId,
        provider: dto.provider,
        purpose: 'topup',
        amountMinor: BigInt(dto.amount_minor),
        currency: dto.currency,
      });
      return {
        intent_id: result.intentId,
        ...(result.redirectUrl !== undefined ? { redirect_url: result.redirectUrl } : {}),
        ...(result.qr !== undefined ? { qr: result.qr } : {}),
      };
    }
  }
  ```

  NOTE: `ApiKeyView` was added to `@actionow/db` in Task 2. If `listApiKeys` returns `Omit<ApiKeyRow,'hash'>` (it does), and `ApiKeyView` is structurally `{id,tenantId,resourceAllowlist,rateLimit,status,createdAt}`, the assignment is compatible; if TS complains, type `listApiKeys`'s return locally to `Omit<ApiKeyRow,'hash'>[]` and map to `ApiKeyView` — but they match, so prefer the direct return. Verify the engine `PaymentService.createIntent` input field names (`tenantId`, `provider`, `purpose`, `amountMinor`, `currency`) against `packages/payments`/`packages/engine` (the existing `PaymentsService.createIntent` in `apps/api/src/payments/payments.service.ts` uses exactly these — line 52-60). Match them.

- [ ] Run the service test, expect PASS:
  ```
  pnpm --filter @actionow/api exec vitest run test/console.service.test.ts
  ```
  Expected: 2 passed.
- [ ] `git add -A && git commit` with subject `feat(console): console service, dtos, and models port`.

---

## Task 8 — Console controller + module wiring + e2e (the full self-service loop)

Wire `ConsoleController` under `/console`, register `ConsoleModule`, add it to `AppModule`. The e2e proves the audited gap is closed: a self-registered user mints its own key via `/console/api-keys`, then calls `/v1` with that key; cross-tenant console reads 404; self-topup writes a `topup` intent; usage/models return tenant-scoped data.

**Files:**

- Create `apps/api/src/console/console.controller.ts`.
- Create `apps/api/src/console/console.module.ts`.
- Modify `apps/api/src/app.module.ts` — import `ConsoleModule` (imports array, lines 16-25).
- Create `apps/api/test/console.e2e.test.ts` (e2e, Testcontainers).

**Steps:**

- [ ] Create `apps/api/src/console/console.controller.ts`. Mirror `AdminController` (views + `ZodBody` pipe) and `PaymentsController` (reads `req`). The guard attaches `req.console`; read it via a small accessor. SHOW the file:

  ```ts
  import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Post,
    Query,
    Req,
    UseGuards,
  } from '@nestjs/common';
  import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

  import { engineUnauthorized } from '../common/errors.js';
  import { ZodBody } from '../common/zod.pipe.js';
  import { ConsoleGuard, type ConsoleContext, type ConsoleRequest } from './console.guard.js';
  import type { ConsoleIntentResponse } from './console.service.js';
  import { ConsoleService } from './console.service.js';
  import {
    type ConsoleCreateApiKeyDto,
    consoleCreateApiKeySchema,
    type ConsoleCreateIntentDto,
    consoleCreateIntentSchema,
  } from './dto/console.dto.js';
  import type { ModelView } from './models.port.js';

  const DEFAULT_LIMIT = 50;
  const MAX_LIMIT = 200;

  function parseLimit(limit: string | undefined): number {
    const parsed = limit === undefined ? DEFAULT_LIMIT : Number.parseInt(limit, 10);
    return Number.isNaN(parsed) ? DEFAULT_LIMIT : Math.min(Math.max(1, parsed), MAX_LIMIT);
  }

  /** Read the guard-populated console context, or fail closed (wiring bug). */
  function ctxOf(req: ConsoleRequest): ConsoleContext {
    if (req.console === undefined) throw engineUnauthorized('request is not authenticated');
    return req.console;
  }

  interface ApiKeyCreatedView {
    id: string;
    /** Returned ONCE — only the hash is persisted. */
    plaintext: string;
  }
  interface ApiKeyView {
    id: string;
    resource_allowlist: string[];
    rate_limit: number | null;
    status: string;
    created_at: string;
  }
  interface JobView {
    job_id: string;
    resource_id: string;
    status: string;
    exec_mode: string;
    cost: string | null;
    created_at: string;
  }
  interface LedgerView {
    id: string;
    type: string;
    credits_delta: string;
    balance_after: string;
    job_id: string | null;
    created_at: string;
  }
  interface ModelListItem {
    name: string;
    display: string;
    modality: string;
    capabilities: unknown;
    visibility: string;
  }

  /**
   * Tenant self-service console (§B.2). Every route is guarded by the
   * {@link ConsoleGuard} (user JWT) and scoped to the caller's OWN tenant — the
   * tenant id is never accepted from the client. Surfaces: self-serve API-key
   * CRUD/rotate, own usage (jobs/ledger), self-topup, and the tenant-visible
   * model list. Money serializes as decimal µcredit strings (never a float). The
   * minted API-key plaintext is returned once and never logged.
   */
  @ApiTags('console')
  @ApiBearerAuth('jwt')
  @UseGuards(ConsoleGuard)
  @Controller('console')
  export class ConsoleController {
    constructor(private readonly console: ConsoleService) {}

    // ----- api keys -----

    @Post('api-keys')
    @HttpCode(201)
    @ApiOperation({ summary: 'Mint an API key for your tenant (plaintext returned once)' })
    async createApiKey(
      @Body(new ZodBody(consoleCreateApiKeySchema)) dto: ConsoleCreateApiKeyDto,
      @Req() req: ConsoleRequest,
    ): Promise<ApiKeyCreatedView> {
      const ctx = ctxOf(req);
      const created = await this.console.createApiKey(dto, ctx.tenantId);
      return { id: created.id, plaintext: created.plaintext };
    }

    @Get('api-keys')
    @ApiOperation({ summary: 'List your tenant’s API keys (no hashes)' })
    async listApiKeys(@Req() req: ConsoleRequest): Promise<ApiKeyView[]> {
      const ctx = ctxOf(req);
      const rows = await this.console.listApiKeys(ctx.tenantId);
      return rows.map((r) => ({
        id: r.id,
        resource_allowlist: r.resourceAllowlist,
        rate_limit: r.rateLimit,
        status: r.status,
        created_at: r.createdAt.toISOString(),
      }));
    }

    @Post('api-keys/:id/rotate')
    @HttpCode(201)
    @ApiOperation({ summary: 'Rotate an API key (new plaintext; old key disabled)' })
    async rotateApiKey(
      @Param('id') id: string,
      @Req() req: ConsoleRequest,
    ): Promise<ApiKeyCreatedView> {
      const ctx = ctxOf(req);
      const created = await this.console.rotateApiKey(id, ctx.tenantId);
      return { id: created.id, plaintext: created.plaintext };
    }

    @Delete('api-keys/:id')
    @HttpCode(200)
    @ApiOperation({ summary: 'Disable one of your API keys' })
    async disableApiKey(
      @Param('id') id: string,
      @Req() req: ConsoleRequest,
    ): Promise<{ id: string; status: 'disabled' }> {
      const ctx = ctxOf(req);
      await this.console.disableApiKey(id, ctx.tenantId);
      return { id, status: 'disabled' };
    }

    // ----- usage -----

    @Get('usage')
    @ApiOperation({ summary: 'Your tenant’s jobs + ledger (keyset)' })
    async usage(
      @Req() req: ConsoleRequest,
      @Query('cursor') cursor?: string,
      @Query('limit') limit?: string,
    ): Promise<{ jobs: JobView[]; ledger: LedgerView[] }> {
      const ctx = ctxOf(req);
      const effective = parseLimit(limit);
      const jobs = await this.console.listJobs(ctx.tenantId, cursor, effective);
      const ledger = await this.console.listLedger(ctx.tenantId, cursor, effective);
      return {
        jobs: jobs.map((j) => ({
          job_id: j.id,
          resource_id: j.resourceId,
          status: j.status,
          exec_mode: j.execMode,
          cost: j.costCredits === null ? null : j.costCredits.toString(),
          created_at: j.createdAt.toISOString(),
        })),
        ledger: ledger.map((l) => ({
          id: l.id,
          type: l.type,
          credits_delta: l.creditsDelta.toString(),
          balance_after: l.balanceAfter.toString(),
          job_id: l.jobId,
          created_at: l.createdAt.toISOString(),
        })),
      };
    }

    // ----- models -----

    @Get('models')
    @ApiOperation({ summary: 'Models visible to your tenant' })
    async models(@Req() req: ConsoleRequest): Promise<ModelListItem[]> {
      const ctx = ctxOf(req);
      const rows: ModelView[] = await this.console.listModels(ctx.tenantId);
      return rows.map((m) => ({
        name: m.name,
        display: m.display,
        modality: m.modality,
        capabilities: m.capabilities,
        visibility: m.visibility,
      }));
    }

    // ----- self-topup -----

    @Post('payments/intents')
    @HttpCode(201)
    @ApiOperation({ summary: 'Top up your tenant (returns a checkout handle)' })
    async topup(
      @Body(new ZodBody(consoleCreateIntentSchema)) dto: ConsoleCreateIntentDto,
      @Req() req: ConsoleRequest,
    ): Promise<ConsoleIntentResponse> {
      const ctx = ctxOf(req);
      return this.console.selfTopup(dto, ctx.tenantId);
    }
  }
  ```

  Confirm the `ZodBody` pipe path (`../common/zod.pipe.js`) matches the import used in `admin.controller.ts` line 14.

- [ ] Create `apps/api/src/console/console.module.ts`. Mirror `PaymentsModule` (it provides `AuthService`/`ApiKeyGuard` and imports `AdminModule` for `JwtModule`). The console needs `JwtModule` (for `ConsoleGuard`'s `JwtService`) — register it with the same `ADMIN_JWT_SECRET` factory used in `AdminModule`/`AuthModule`, and provide `PAYMENTS` (re-export from `PaymentsModule`). SHOW the file:

  ```ts
  import type { AppEnv } from '@actionow/infra';
  import { Module } from '@nestjs/common';
  import { JwtModule } from '@nestjs/jwt';

  import { ENV } from '../common/tokens.js';
  import { PaymentsModule } from '../payments/payments.module.js';
  import { ConsoleController } from './console.controller.js';
  import { CONSOLE_REPO, ConsoleGuard, defaultConsoleRepo } from './console.guard.js';
  import { ConsoleService } from './console.service.js';
  import { fakeModelsPort, MODELS_PORT } from './models.port.js';

  /**
   * Tenant self-service console (§B.2). `/console/*` is guarded by the user-JWT
   * {@link ConsoleGuard} and scoped to the caller's own tenant. Imports
   * {@link PaymentsModule} to reuse the engine `PaymentService` (token `PAYMENTS`)
   * for self-topup. `JwtModule` is registered with the shared `ADMIN_JWT_SECRET`
   * signer so the same `{sub, role}` user JWT verifies here. The {@link MODELS_PORT}
   * defaults to a fake (`[]`) until Track C binds the real `listVisibleModels`.
   */
  @Module({
    imports: [
      PaymentsModule,
      JwtModule.registerAsync({
        inject: [ENV],
        useFactory: (env: AppEnv) => ({ secret: env.ADMIN_JWT_SECRET }),
      }),
    ],
    controllers: [ConsoleController],
    providers: [
      ConsoleService,
      ConsoleGuard,
      { provide: CONSOLE_REPO, useValue: defaultConsoleRepo },
      { provide: MODELS_PORT, useValue: fakeModelsPort },
    ],
  })
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
  export class ConsoleModule {}
  ```

  Verify `PaymentsModule` exports `PAYMENTS` (it does — `exports: [PAYMENTS]`, line 108) so `ConsoleService`'s `@Inject(PAYMENTS)` resolves.

- [ ] Add `ConsoleModule` to `apps/api/src/app.module.ts`: add the import (`import { ConsoleModule } from './console/console.module.js';`, sorted) and add `ConsoleModule` to the `imports` array (lines 16-25).
- [ ] Write the failing e2e `apps/api/test/console.e2e.test.ts`. Use the payments e2e harness (it overrides `PAYMENTS` with a fake `PaymentService` so self-topup needs no Stripe; copy `fakeProvider`/`fakeRegistry`/`PaymentService` setup from `apps/api/test/payments.e2e.test.ts` lines 43-116, and `app = moduleRef.createNestApplication({ rawBody: true })`). Register a user via `/auth/register` to get a user JWT. SHOW the spec block (with the standard container `beforeAll`/`afterAll`; `afterEach` truncates `api_key, ledger_txn, payment_intent, payment_event, job, resource, account, tenant, "user"`):

  ```ts
  async function registerUser(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'sup3rSecret' })
      .expect(200);
    return res.body.token as string;
  }

  describe('tenant self-service console (Track B Task 8)', () => {
    it('a self-registered user mints its own key and calls /v1 with it', async () => {
      const token = await registerUser('selfserve@example.com');

      // The audited gap: the user can now mint its OWN tenant key.
      const keyRes = await request(app.getHttpServer())
        .post('/console/api-keys')
        .set('authorization', `Bearer ${token}`)
        .send({})
        .expect(201);
      expect(keyRes.body.plaintext).toMatch(/^ak_/);
      const plaintext = keyRes.body.plaintext as string;

      // The minted key authenticates a /v1 data-plane call (its own jobs list).
      await request(app.getHttpServer())
        .get('/v1/jobs')
        .set('authorization', `Bearer ${plaintext}`)
        .expect(200);

      // Listed, no hash leaked.
      const list = await request(app.getHttpServer())
        .get('/console/api-keys')
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).not.toHaveProperty('hash');
      const keyId = list.body[0].id as string;

      // Rotate → new plaintext, old disabled.
      const rot = await request(app.getHttpServer())
        .post(`/console/api-keys/${keyId}/rotate`)
        .set('authorization', `Bearer ${token}`)
        .expect(201);
      expect(rot.body.plaintext).not.toBe(plaintext);

      // Disable the rotated key.
      await request(app.getHttpServer())
        .delete(`/console/api-keys/${rot.body.id}`)
        .set('authorization', `Bearer ${token}`)
        .expect(200);
    });

    it('rejects an unauthenticated console request (401)', async () => {
      const res = await request(app.getHttpServer()).get('/console/api-keys').expect(401);
      expect(res.body.error.code).toBe('unauthorized');
    });

    it('a console user cannot disable another tenant’s key (404)', async () => {
      const tokenA = await registerUser('owner-a@example.com');
      const tokenB = await registerUser('owner-b@example.com');
      const keyRes = await request(app.getHttpServer())
        .post('/console/api-keys')
        .set('authorization', `Bearer ${tokenA}`)
        .send({})
        .expect(201);
      const listA = await request(app.getHttpServer())
        .get('/console/api-keys')
        .set('authorization', `Bearer ${tokenA}`)
        .expect(200);
      const keyId = listA.body[0].id as string;
      // B tries to disable A's key → 404 (cross-tenant predicate no-op).
      await request(app.getHttpServer())
        .delete(`/console/api-keys/${keyId}`)
        .set('authorization', `Bearer ${tokenB}`)
        .expect(404);
    });

    it('self-topup creates a topup intent for the caller tenant', async () => {
      const token = await registerUser('topup@example.com');
      const res = await request(app.getHttpServer())
        .post('/console/payments/intents')
        .set('authorization', `Bearer ${token}`)
        .send({ provider: 'stripe', amount_minor: 5000, currency: 'usd' })
        .expect(201);
      expect(res.body.intent_id).toBeTypeOf('string');
      // a payment_intent row exists for this tenant with purpose topup
      const rows = await db.select().from(schema.paymentIntent);
      expect(rows[0]?.purpose).toBe('topup');
    });

    it('usage + models return tenant-scoped data', async () => {
      const token = await registerUser('usage@example.com');
      const usage = await request(app.getHttpServer())
        .get('/console/usage')
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(usage.body).toHaveProperty('jobs');
      expect(usage.body).toHaveProperty('ledger');
      const models = await request(app.getHttpServer())
        .get('/console/models')
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(Array.isArray(models.body)).toBe(true); // [] until Track C binds listVisibleModels
    });
  });
  ```

  Add `import { schema } from '@actionow/db';` and (for the topup assertion) confirm `schema.paymentIntent` exists (it does — `packages/db/src/schema/payment.ts`, used in `payments.e2e.test.ts` line 21).

- [ ] Run it, expect FAIL (controller/module not wired yet → the very first run before wiring; if you already wired in prior steps, the RED is the test file against an un-imported module → 404 on `/console/*`). Command:
  ```
  pnpm --filter @actionow/api exec vitest run test/console.e2e.test.ts
  ```
  Expected before wiring: `/console/api-keys` returns 404 (route absent), failing the `.expect(201)`.
- [ ] With the controller + module + AppModule wiring in place (created above), run again, expect PASS:
  ```
  pnpm --filter @actionow/api exec vitest run test/console.e2e.test.ts
  ```
  Expected: 5 passed.
- [ ] `git add -A && git commit` with subject `feat(console): /console routes, module wiring, self-service e2e`.

---

## Task 9 — Seed: provision the first admin (operator) explicitly + dev-tenant note

Spec §B.1/B.4: self-deploy seeds exactly one admin (the operator). The seed already creates `admin@actionow.local` with `role='admin'` (`apps/api/src/seed/seed.ts` lines 107-114) and tops up a 100-credit account. Add a guard so the seed never mints a SECOND admin and document the operator/customer split. (No new behavior beyond a guard + comment + a test asserting idempotency of the admin.)

**Files:**

- Modify `apps/api/src/seed/seed.ts` — the admin block (lines 107-114) already find-then-creates; add an explicit comment and keep the guard.
- Create `apps/api/test/seed-admin.e2e.test.ts` (integration) OR extend an existing seed test if present (check `ls apps/api/test | grep -i seed`; the acceptance e2e calls `seedAll`).

**Steps:**

- [ ] Check for an existing seed test (`ls apps/api/test | grep -i seed || grep -rln "seedAll" apps/api/test`). The `acceptance.e2e.test.ts` uses `seedAll`. Write a focused integration test `apps/api/test/seed-admin.e2e.test.ts` that runs `seedAll` twice against a Testcontainers db and asserts exactly one `role='admin'` user exists and the operation is idempotent. SHOW the spec (standard container harness, but NO AppModule — just `db`; `afterEach` is unnecessary since each test re-seeds idempotently, but truncate in `afterAll` is fine):

  ```ts
  import { schema, seedAll } from '@actionow/db'; // NOTE: seedAll is in apps/api/src/seed — import from there:
  ```

  Correction: `seedAll` lives in `apps/api/src/seed/seed.ts`, NOT `@actionow/db`. Import it from the app source:

  ```ts
  import { schema } from '@actionow/db';
  import { eq } from 'drizzle-orm';
  import { seedAll } from '../src/seed/seed.js';
  // ...standard container beforeAll/afterAll (migrate from '../../packages/db/drizzle')...

  describe('seed provisions exactly one operator admin (Track B Task 9)', () => {
    it('is idempotent and never mints a second admin', async () => {
      await seedAll(db, { providerType: 'stub' });
      await seedAll(db, { providerType: 'stub' });
      const admins = await db.select().from(schema.user).where(eq(schema.user.role, 'admin'));
      expect(admins).toHaveLength(1);
      expect(admins[0]?.email).toBe('admin@actionow.local');
    });
  });
  ```

- [ ] Run it, expect PASS already (the seed is idempotent today). To make Task 9 a meaningful RED→GREEN, instead assert the NEW invariant the constraint from Task 1 enforces: seed must not violate the `role` check. Since that already holds, treat this test as a regression guard. Run:
  ```
  pnpm --filter @actionow/api exec vitest run test/seed-admin.e2e.test.ts
  ```
  Expected: 1 passed (guards seed idempotency under the new `role` constraint).
- [ ] Tighten the seed doc in `apps/api/src/seed/seed.ts`. Update the admin block comment (lines 105-107) to: a single operator admin (`role='admin'`) is the self-deploy super-admin per §B.1; every other principal is a customer-side user with `role='user'` provisioned via `/auth/register`. No code change beyond the comment (the find-then-create guard already prevents a duplicate admin).
- [ ] `git add -A && git commit` with subject `docs(seed): document operator-admin vs customer-user split`.

---

## Task 10 — Production binding hook for Track C models (no-rename seam doc)

Document and make trivially-swappable the `MODELS_PORT` binding so Track C's `listVisibleModels` drops in without a rename. This task adds NO behavior — it adds an integration test that proves the swap works by overriding the port.

**Files:**

- Create `apps/api/test/console-models-port.e2e.test.ts` (e2e overriding `MODELS_PORT`).

**Steps:**

- [ ] Write the e2e `apps/api/test/console-models-port.e2e.test.ts`. Use the console e2e harness but `.overrideProvider(MODELS_PORT).useValue({ listVisibleModels: () => Promise.resolve([...]) })` to simulate Track C bound. SHOW the spec:

  ```ts
  import { MODELS_PORT } from '../src/console/models.port.js';
  // ...standard harness; in the moduleRef builder add:
  //   .overrideProvider(MODELS_PORT)
  //   .useValue({
  //     listVisibleModels: () =>
  //       Promise.resolve([
  //         { name: 'gpt-4o', display: 'GPT-4o', modality: 'chat', capabilities: { tools: true }, visibility: 'public' },
  //       ]),
  //   })

  describe('GET /console/models honors the bound ModelsPort (Track C seam)', () => {
    it('returns the tenant-visible models from the port', async () => {
      const token = await registerUser('models@example.com');
      const res = await request(app.getHttpServer())
        .get('/console/models')
        .set('authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ name: 'gpt-4o', visibility: 'public' });
    });
  });
  ```

- [ ] Run it, expect PASS (the override binds a non-empty port; the default fake returns `[]`):
  ```
  pnpm --filter @actionow/api exec vitest run test/console-models-port.e2e.test.ts
  ```
  Expected: 1 passed.
- [ ] `git add -A && git commit` with subject `test(console): models port swap proves Track C seam`.

---

## Verification gate

Run the full toolchain green. **Docker must be up** (Testcontainers) for the integration/e2e suites.

- [ ] `pnpm infra:up` (start the local pg/redis so drizzle-kit + any non-container path is reachable; Testcontainers spins its own pg).
- [ ] `pnpm typecheck` — expect 0 errors across all packages/apps (turbo runs each package's `tsc --noEmit`).
- [ ] `pnpm lint` — expect 0 errors. Pay attention to: no `any`; `consistent-type-imports`; `simple-import-sort` ordering of every new import/export block; `explicit-module-boundary-types` on every exported function/method; boundaries (the new `packages/db` repo functions import only `@actionow/{db,contracts,domain}` — they import `drizzle-orm` and own-package files only, which is allowed; the console module is in `apps/api`, unrestricted).
- [ ] `pnpm build` — expect every package/app to compile.
- [ ] `pnpm test` — expect all unit + integration suites green, including the new `packages/db/test/{schema-constraints,api-key-lifecycle,tenant-predicate}.test.ts`, `packages/infra/test/config.test.ts`, and `apps/api/test/{api-key.guard,console.guard,console.service,jobs-isolation.e2e,console.e2e,console-models-port.e2e,seed-admin.e2e}.test.ts`.
- [ ] Boundaries intact: confirm `packages/db` repo additions did not introduce a forbidden cross-package import (re-run `pnpm lint` clears this; spot-check that `auth.ts`/`job.ts`/`catalog.ts` import only `drizzle-orm` + own `../schema`/`./types`).
- [ ] No secret logging: grep the new console files for any `console.log`/`logger` that could print a key/token/secret — there must be none (`grep -rn "console.log\|logger\|Logger" apps/api/src/console`). The minted plaintext is returned in the response body only.
- [ ] Migration sanity: confirm exactly one new migration (`0004_*.sql`) was added, the journal has a new entry, and applying migrations from scratch on a fresh container (the test harness does this in every suite's `beforeAll`) succeeds.
- [ ] Commit any final lint/format fixups with subject `chore(trackB): verification gate green` (only if there are uncommitted changes).

---

## Definition of Done

Mirrors spec §支柱B:

- **`/console/*` module + `ConsoleGuard`** (user-JWT, scope = own tenant) is live with:
  - **API-key CRUD/rotate** — `POST /console/api-keys` (mint, plaintext once), `GET /console/api-keys` (list, no hash), `POST /console/api-keys/:id/rotate` (new plaintext, old disabled), `DELETE /console/api-keys/:id` (disable). All tenant-scoped in SQL.
  - **Own usage view** — `GET /console/usage` returns the caller tenant's jobs + ledger (keyset).
  - **Self-topup** — `POST /console/payments/intents` reuses the engine `PaymentService` to create a `topup` intent for the caller's own tenant (no admin required).
  - **Models list** — `GET /console/models` returns `listVisibleModels(db, tenantId)` via the `MODELS_PORT` seam (`[]` until Track C binds it).
- **Audited gap closed:** a self-registered user (`/auth/register`) can mint its own tenant's API key via `/console/api-keys` and immediately authenticate `/v1/*` with it (proven by `console.e2e.test.ts`).
- **Cross-tenant isolation tightened:** `getJobForTenant`/`getResourceForTenant` put the tenant predicate in SQL; `JobsService` uses `getJobForTenant`; console key ops are tenant-predicated (cross-tenant id → 404/no-op).
- **Self-deploy hardening:** `ALLOW_DEV_TENANT_HEADER` (default `false`) gates the `x-tenant-id` dev fallback (no longer `NODE_ENV` alone); `ADMIN_JWT_SECRET` stays required in production and the gating is explicit; migration adds `account` unique(`tenant_id`) and `job.account_id`.
- **`role` DB constraint:** `user.role` is constrained to `('user','admin')` via a check constraint; the seed provisions exactly one operator admin and every other principal is a `role='user'` customer.
- **Verification gate green:** `pnpm typecheck && pnpm lint && pnpm build && pnpm test` all pass with Docker up; boundaries intact; no secret/key/token logged.

## Notes for the executor (cross-track seams)

- `listVisibleModels(db, tenantId) -> ModelView[]` is **defined by Track C**. Track B consumes it ONLY through `MODELS_PORT` (`apps/api/src/console/models.port.ts`). When Track C merges, change the provider in `console.module.ts` from `{ provide: MODELS_PORT, useValue: fakeModelsPort }` to a binding over `@actionow/db`'s `listVisibleModels` (and replace the mirrored `ModelView` interface with a re-export of Track C's type). Do not rename `MODELS_PORT`, `listVisibleModels`, or `ModelView`.
- `getJobForTenant`/`getResourceForTenant` are defined HERE (Track B) and may be consumed by Track A's `/v1/chat/*` model-route handlers; keep their pinned signatures.
- The engine `PaymentService.createIntent` field names (`tenantId`, `provider`, `purpose`, `amountMinor`, `currency`) are taken from the existing `apps/api/src/payments/payments.service.ts` call (lines 52-60) and `paymentPurposeSchema`'s topup member — verify the exact `purpose` literal in `@actionow/contracts` before using `'topup'`.
