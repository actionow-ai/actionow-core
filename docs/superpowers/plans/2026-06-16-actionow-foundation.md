# Actionow Foundation (Phase 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the pnpm/TypeScript monorepo, lint/format toolchain, local infra (Postgres+Redis), all package/app skeletons, and the complete Drizzle schema + migrations — so every later phase has a compiling, testable, lint-enforced foundation to build on.

**Architecture:** Modular monolith in a pnpm monorepo. `apps/api` (NestJS HTTP) and `apps/worker` (NestJS standalone) consume shared packages `contracts/domain/db/adapters/dify/infra`. `domain` is a pure (no-IO) core; `eslint-plugin-boundaries` enforces the dependency direction at lint time. Postgres via Drizzle, Redis via ioredis, queues via BullMQ.

**Tech Stack:** TypeScript 5.x (Node 22), pnpm workspaces, Turborepo, NestJS 10, Drizzle ORM + drizzle-kit, ioredis, BullMQ, zod, Vitest + Testcontainers, ESLint(flat)+Prettier.

**Source spec:** `docs/superpowers/specs/2026-06-16-actionow-backend-scaffold-design.md` (§ references below point to it). Behavior is governed by the spec; this plan sequences and decomposes.

---

## Conventions for every task

- Package manager is `pnpm` (run from repo root unless noted). Node 22 (`.nvmrc`).
- Internal packages are named `@actionow/<name>` and exported via their `package.json` `exports`/`main` pointing at `src/index.ts` (we run TS directly in dev via `tsx`; build via `tsc` to `dist`).
- Commit messages use Conventional Commits. Each task ends with a commit.
- "Run" steps show the exact command and the expected signal (PASS/FAIL/output).

---

## Task 1: Monorepo root scaffolding

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `.npmrc`, `.nvmrc`, `tsconfig.base.json`, `turbo.json`
- Modify: `.gitignore`

- [ ] **Step 1: Create `.nvmrc`**

```
22
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

- [ ] **Step 3: Create `.npmrc`**

```
auto-install-peers=true
strict-peer-dependencies=false
```

- [ ] **Step 4: Create root `package.json`**

```json
{
  "name": "actionow-core",
  "version": "0.0.0",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "turbo run build",
    "lint": "turbo run lint",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "format": "prettier --write \"**/*.{ts,json,md,yaml}\"",
    "db:generate": "pnpm --filter @actionow/db db:generate",
    "db:migrate": "pnpm --filter @actionow/db db:migrate",
    "dev:api": "pnpm --filter @actionow/api start:dev",
    "dev:worker": "pnpm --filter @actionow/worker start:dev",
    "infra:up": "docker compose up -d",
    "infra:down": "docker compose down",
    "prepare": "husky"
  },
  "devDependencies": {
    "turbo": "^2.1.0",
    "typescript": "^5.6.0",
    "prettier": "^3.3.0",
    "tsx": "^4.19.0"
  }
}
```

- [ ] **Step 5: Create `tsconfig.base.json`** (strict per §14.3)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "useUnknownInCatchVariables": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "declaration": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

> Note: `verbatimModuleSyntax` + NestJS decorators coexist; NestJS DI relies on `emitDecoratorMetadata`. Keep both.

- [ ] **Step 6: Create `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "typecheck": { "dependsOn": ["^build"] },
    "lint": {},
    "test": { "dependsOn": ["^build"] }
  }
}
```

- [ ] **Step 7: Append to `.gitignore`**

```
dist/
.turbo/
*.tsbuildinfo
.env
.env.local
coverage/
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo root (turbo, tsconfig, workspace)"
```

---

## Task 2: Lint/format toolchain (Profile 1, §14)

**Files:**
- Create: `eslint.config.mjs`, `.prettierrc.json`, `.prettierignore`, `commitlint.config.cjs`, `.husky/pre-commit`, `.husky/commit-msg`
- Modify: root `package.json` (add devDeps + lint-staged)

- [ ] **Step 1: Add devDependencies** — run:

```bash
pnpm add -w -D eslint@^9 typescript-eslint@^8 eslint-config-prettier@^9 \
  eslint-plugin-import-x@^4 eslint-plugin-simple-import-sort@^12 \
  eslint-plugin-boundaries@^5 @commitlint/cli@^19 @commitlint/config-conventional@^19 \
  husky@^9 lint-staged@^15 globals@^15
```

Expected: packages added to root `devDependencies`.

- [ ] **Step 2: Create `.prettierrc.json`** (§14.2)

```json
{
  "singleQuote": true,
  "semi": true,
  "printWidth": 100,
  "tabWidth": 2,
  "trailingComma": "all",
  "arrowParens": "always"
}
```

- [ ] **Step 3: Create `.prettierignore`**

```
dist
.turbo
pnpm-lock.yaml
**/drizzle/**
```

- [ ] **Step 4: Create `eslint.config.mjs`** (flat config; strict-type-checked + boundaries per §14.5)

```js
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import boundaries from 'eslint-plugin-boundaries';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.turbo/**', '**/drizzle/**', 'eslint.config.mjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    plugins: {
      'import-x': importX,
      'simple-import-sort': simpleImportSort,
      boundaries,
    },
    settings: {
      'boundaries/elements': [
        { type: 'contracts', pattern: 'packages/contracts/*' },
        { type: 'domain', pattern: 'packages/domain/*' },
        { type: 'db', pattern: 'packages/db/*' },
        { type: 'adapters', pattern: 'packages/adapters/*' },
        { type: 'dify', pattern: 'packages/dify/*' },
        { type: 'infra', pattern: 'packages/infra/*' },
        { type: 'app', pattern: 'apps/*' },
      ],
    },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'interface', format: ['PascalCase'], custom: { regex: '^I[A-Z]', match: false } },
        { selector: 'typeLike', format: ['PascalCase'] },
      ],
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'contracts', allow: [] },
            { from: 'domain', allow: ['contracts'] },
            { from: 'db', allow: ['contracts', 'domain'] },
            { from: 'infra', allow: ['contracts'] },
            { from: 'adapters', allow: ['contracts', 'domain', 'infra'] },
            { from: 'dify', allow: ['contracts', 'domain', 'infra'] },
            { from: 'app', allow: ['contracts', 'domain', 'db', 'adapters', 'dify', 'infra'] },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: ['@nestjs/common', '@nestjs/core', 'drizzle-orm', 'ioredis', 'bullmq'] },
        { patterns: ['@actionow/db', '@actionow/infra', '@actionow/adapters'] },
      ],
    },
  },
  { files: ['**/*.spec.ts', '**/*.test.ts'], rules: { '@typescript-eslint/no-unsafe-assignment': 'off' } },
  prettier,
);
```

- [ ] **Step 5: Create `commitlint.config.cjs`**

```js
module.exports = { extends: ['@commitlint/config-conventional'] };
```

- [ ] **Step 6: Add `lint-staged` to root `package.json`**

```json
"lint-staged": {
  "*.ts": ["eslint --fix", "prettier --write"],
  "*.{json,md,yaml}": ["prettier --write"]
}
```

- [ ] **Step 7: Init husky hooks**

Run:
```bash
pnpm exec husky init
printf "pnpm exec lint-staged\n" > .husky/pre-commit
printf "pnpm exec commitlint --edit \$1\n" > .husky/commit-msg
```

- [ ] **Step 8: Verify ESLint loads** (no files yet, should exit clean)

Run: `pnpm exec eslint . || true`
Expected: ESLint runs without config errors (0 files linted is fine).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: add eslint(flat)+prettier+boundaries+husky+commitlint"
```

---

## Task 3: Local infra (docker-compose) + env

**Files:**
- Create: `docker-compose.yml`, `.env.example`

- [ ] **Step 1: Create `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: actionow
      POSTGRES_PASSWORD: actionow
      POSTGRES_DB: actionow
    ports: ['5432:5432']
    volumes: ['actionow_pg:/var/lib/postgresql/data']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U actionow']
      interval: 5s
      timeout: 3s
      retries: 10
  redis:
    image: redis:7-alpine
    ports: ['6379:6379']
    volumes: ['actionow_redis:/data']
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 3s
      retries: 10
volumes:
  actionow_pg:
  actionow_redis:
```

- [ ] **Step 2: Create `.env.example`**

```
NODE_ENV=development
DATABASE_URL=postgresql://actionow:actionow@localhost:5432/actionow
REDIS_URL=redis://localhost:6379
API_PORT=3000
LOG_LEVEL=info
```

- [ ] **Step 3: Verify infra boots**

Run: `docker compose up -d && docker compose ps`
Expected: both `postgres` and `redis` show `healthy`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: add docker-compose (postgres+redis) and .env.example"
```

---

## Task 4: Leaf package skeletons (contracts, infra)

**Files:**
- Create: `packages/contracts/{package.json,tsconfig.json,src/index.ts}`
- Create: `packages/infra/{package.json,tsconfig.json,src/index.ts,src/config.ts}`

- [ ] **Step 1: `packages/contracts/package.json`**

```json
{
  "name": "@actionow/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint src",
    "test": "vitest run"
  },
  "dependencies": { "zod": "^3.23.0" },
  "devDependencies": { "vitest": "^2.1.0", "typescript": "^5.6.0" }
}
```

- [ ] **Step 2: `packages/contracts/tsconfig.json`**

```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
```

- [ ] **Step 3: `packages/contracts/src/index.ts`** (placeholder export so the package is importable)

```ts
export const CONTRACTS_VERSION = '0.0.0' as const;
```

- [ ] **Step 4: `packages/infra/package.json`** (same shape; deps: ioredis, bullmq, pino, zod, @nestjs/config peer optional)

```json
{
  "name": "@actionow/infra",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint src",
    "test": "vitest run"
  },
  "dependencies": {
    "@actionow/contracts": "workspace:*",
    "ioredis": "^5.4.0",
    "bullmq": "^5.13.0",
    "pino": "^9.4.0",
    "zod": "^3.23.0"
  },
  "devDependencies": { "vitest": "^2.1.0", "typescript": "^5.6.0" }
}
```

- [ ] **Step 5: `packages/infra/tsconfig.json`** — same as Step 2 (copy with rootDir src/outDir dist).

- [ ] **Step 6: `packages/infra/src/config.ts`** (zod-validated env per §9)

```ts
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  API_PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type AppEnv = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  return EnvSchema.parse(source);
}
```

- [ ] **Step 7: `packages/infra/src/index.ts`**

```ts
export { loadEnv, type AppEnv } from './config.js';
```

- [ ] **Step 8: Verify install + typecheck**

Run: `pnpm install && pnpm --filter @actionow/contracts --filter @actionow/infra typecheck`
Expected: PASS (no type errors).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(packages): add contracts + infra skeletons with zod env config"
```

---

## Task 5: `packages/db` skeleton + Drizzle wiring

**Files:**
- Create: `packages/db/{package.json,tsconfig.json,drizzle.config.ts,src/index.ts,src/client.ts}`
- Create: `packages/db/src/schema/index.ts`

- [ ] **Step 1: `packages/db/package.json`**

```json
{
  "name": "@actionow/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts", "./schema": "./src/schema/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint src",
    "test": "vitest run",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  },
  "dependencies": {
    "@actionow/contracts": "workspace:*",
    "@actionow/domain": "workspace:*",
    "drizzle-orm": "^0.33.0",
    "postgres": "^3.4.0"
  },
  "devDependencies": {
    "drizzle-kit": "^0.24.0",
    "vitest": "^2.1.0",
    "typescript": "^5.6.0",
    "@testcontainers/postgresql": "^10.13.0"
  }
}
```

- [ ] **Step 2: `packages/db/tsconfig.json`** — extends base, rootDir `src`, outDir `dist`, include `src` + `drizzle.config.ts`.

- [ ] **Step 3: `packages/db/drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgresql://actionow:actionow@localhost:5432/actionow' },
});
```

- [ ] **Step 4: `packages/db/src/client.ts`**

```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema/index.js';

export type Database = ReturnType<typeof createDb>;

export function createDb(url: string) {
  const sql = postgres(url, { max: 10 });
  return drizzle(sql, { schema });
}
```

- [ ] **Step 5: `packages/db/src/schema/index.ts`** (empty barrel for now)

```ts
export {};
```

- [ ] **Step 6: `packages/db/src/index.ts`**

```ts
export { createDb, type Database } from './client.js';
export * as schema from './schema/index.js';
```

- [ ] **Step 7: Add empty `domain`, `adapters`, `dify` package skeletons** so dependencies and boundaries elements resolve. For each, create `packages/<name>/{package.json,tsconfig.json,src/index.ts}` mirroring Task 4:
  - `@actionow/domain` — deps: `@actionow/contracts` + `zod`; `src/index.ts`: `export const DOMAIN_VERSION = '0.0.0' as const;`
  - `@actionow/adapters` — deps: `@actionow/contracts`, `@actionow/domain`, `@actionow/infra`; `src/index.ts`: `export const ADAPTERS_VERSION = '0.0.0' as const;`
  - `@actionow/dify` — deps: `@actionow/contracts`, `@actionow/domain`, `@actionow/infra`; `src/index.ts`: `export const DIFY_VERSION = '0.0.0' as const;`

- [ ] **Step 8: Verify**

Run: `pnpm install && pnpm --filter @actionow/db typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(db): add drizzle client + db/domain package skeletons"
```

---

## Task 6: Drizzle schema — identity & accounts (§5)

**Files:**
- Create: `packages/db/src/schema/identity.ts`, `packages/db/src/schema/accounts.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: `identity.ts`** — `tenant`, `api_key`, `admin_user`

```ts
import { sql } from 'drizzle-orm';
import { bigint, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const tenant = pgTable('tenant', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  isolationMode: text('isolation_mode').notNull().default('field'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiKey = pgTable(
  'api_key',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
    hash: text('hash').notNull(),
    resourceAllowlist: jsonb('resource_allowlist').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    rateLimit: bigint('rate_limit', { mode: 'number' }),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ hashIdx: uniqueIndex('api_key_hash_idx').on(t.hash), tenantIdx: index('api_key_tenant_idx').on(t.tenantId) }),
);

export const adminUser = pgTable('admin_user', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('admin'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: `accounts.ts`** — `account` with the `CHECK(credit_balance >= credit_held)` invariant (§5, review #10)

```ts
import { sql } from 'drizzle-orm';
import { bigint, check, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

import { tenant } from './identity.js';

export const account = pgTable(
  'account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
    creditBalance: bigint('credit_balance', { mode: 'bigint' }).notNull().default(0n),
    creditHeld: bigint('credit_held', { mode: 'bigint' }).notNull().default(0n),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ balanceCheck: check('account_balance_ge_held', sql`${t.creditBalance} >= ${t.creditHeld}`) }),
);
```

- [ ] **Step 3: Re-export from `schema/index.ts`**

```ts
export * from './identity.js';
export * from './accounts.js';
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @actionow/db typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(db): add identity + account schema with balance>=held check"
```

---

## Task 7: Drizzle schema — catalog & pricing (§5)

**Files:**
- Create: `packages/db/src/schema/catalog.ts`, `packages/db/src/schema/pricing.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: `catalog.ts`** — `resource`, `resource_version` (unique(resource_id,version)), `upstream_channel`, `dify_binding`, `secret_ref`

```ts
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { tenant } from './identity.js';

export const resource = pgTable('resource', {
  id: text('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
  kind: text('kind').notNull(), // model | workflow
  modality: text('modality').notNull(), // text|image|video|audio|composite
  providerType: text('provider_type').notNull(),
  execModes: jsonb('exec_modes').$type<string[]>().notNull(),
  status: text('status').notNull().default('active'),
  currentVersion: integer('current_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const resourceVersion = pgTable(
  'resource_version',
  {
    resourceId: text('resource_id').notNull().references(() => resource.id),
    version: integer('version').notNull(),
    ioSchema: jsonb('io_schema').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: uniqueIndex('resource_version_pk').on(t.resourceId, t.version) }),
);

export const upstreamChannel = pgTable(
  'upstream_channel',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    resourceId: text('resource_id').notNull().references(() => resource.id),
    providerType: text('provider_type').notNull(),
    credentialRef: uuid('credential_ref'),
    weight: integer('weight').notNull().default(1),
    status: text('status').notNull().default('active'),
  },
  (t) => ({ resIdx: index('upstream_resource_idx').on(t.resourceId) }),
);

export const difyBinding = pgTable('dify_binding', {
  resourceId: text('resource_id').notNull().references(() => resource.id),
  resourceVersion: integer('resource_version').notNull(),
  mode: text('mode').notNull(), // workflow | advanced-chat
  difyAppEndpoint: text('dify_app_endpoint').notNull(),
  difyServiceKeyRef: uuid('dify_service_key_ref'),
  dslHash: text('dsl_hash').notNull(),
  pricingModel: text('pricing_model').notNull(), // metered | fixed | matrix
  provisionMode: text('provision_mode').notNull().default('byo'), // byo | hosted
  requiredSecrets: jsonb('required_secrets').$type<string[]>().notNull().default([]),
  compatReport: jsonb('compat_report'),
});

export const secretRef = pgTable('secret_ref', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull(), // env | vault
  locator: text('locator').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: `pricing.ts`** — `pricebook_entry` (versioned), `modifier` (versioned, review #7), `gift_code`

```ts
import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { resource } from './catalog.js';

export const pricebookEntry = pgTable(
  'pricebook_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    resourceId: text('resource_id').notNull().references(() => resource.id),
    resourceVersion: integer('resource_version').notNull(),
    version: integer('version').notNull(),
    method: text('method').notNull(), // unit|matrix|fixed|formula|passthrough
    timing: text('timing').notNull(), // pre|post
    spec: jsonb('spec').notNull(), // dimensions|table|amount|formula
    markup: jsonb('markup'),
    active: boolean('active').notNull().default(true),
  },
  (t) => ({ resIdx: index('pricebook_resource_idx').on(t.resourceId, t.version) }),
);

export const modifier = pgTable('modifier', {
  id: uuid('id').primaryKey().defaultRandom(),
  scope: text('scope').notNull(),
  whenExpr: text('when_expr'),
  op: text('op').notNull(),
  value: bigint('value', { mode: 'bigint' }),
  stackable: boolean('stackable').notNull().default(true),
  priority: integer('priority').notNull().default(0),
  version: integer('version').notNull().default(1),
  active: boolean('active').notNull().default(true),
});

export const giftCode = pgTable('gift_code', {
  code: text('code').primaryKey(),
  tenantScope: uuid('tenant_scope'),
  credits: bigint('credits', { mode: 'bigint' }).notNull(),
  kind: text('kind').notNull(), // grant | discount
  status: text('status').notNull().default('active'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
});
```

- [ ] **Step 3: Re-export both from `schema/index.ts`** (append `export * from './catalog.js';` and `export * from './pricing.js';`).

- [ ] **Step 4: Typecheck** — Run: `pnpm --filter @actionow/db typecheck` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(db): add catalog + pricing schema (versioned pricebook/modifier)"
```

---

## Task 8: Drizzle schema — jobs, ledger, idempotency, outbox (§5, review #4/#11/#12)

**Files:**
- Create: `packages/db/src/schema/execution.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: `execution.ts`** — `job` (with frozen version snapshot cols + hold_id + hold_expires_at + idempotency_key + end_user), `ledger_txn` (append-only + balance_after), `idempotency_key`, `webhook_outbox`

```ts
import { sql } from 'drizzle-orm';
import { bigint, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { account } from './accounts.js';
import { resource } from './catalog.js';
import { tenant } from './identity.js';

export const job = pgTable(
  'job',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
    resourceId: text('resource_id').notNull().references(() => resource.id),
    resourceVersion: bigint('resource_version', { mode: 'number' }).notNull(),
    status: text('status').notNull(), // queued|running|succeeded|failed|canceled
    execMode: text('exec_mode').notNull(),
    inputs: jsonb('inputs').notNull(),
    output: jsonb('output'),
    usage: jsonb('usage'),
    upstreamJobHandle: text('upstream_job_handle'),
    pricebookEntryId: uuid('pricebook_entry_id'),
    pricebookVersion: bigint('pricebook_version', { mode: 'number' }),
    modifiersSnapshot: jsonb('modifiers_snapshot'),
    quotedCredits: bigint('quoted_credits', { mode: 'bigint' }),
    costCredits: bigint('cost_credits', { mode: 'bigint' }),
    holdId: uuid('hold_id'),
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
    callbackUrl: text('callback_url'),
    idempotencyKey: text('idempotency_key'),
    endUser: text('end_user'),
    error: jsonb('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ statusIdx: index('job_status_idx').on(t.status), tenantIdx: index('job_tenant_idx').on(t.tenantId) }),
);

export const ledgerTxn = pgTable(
  'ledger_txn',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
    accountId: uuid('account_id').notNull().references(() => account.id),
    type: text('type').notNull(), // topup|giftcode|hold|settle|refund
    creditsDelta: bigint('credits_delta', { mode: 'bigint' }).notNull(),
    balanceAfter: bigint('balance_after', { mode: 'bigint' }).notNull(),
    resourceId: text('resource_id'),
    jobId: uuid('job_id'),
    pricebookVersion: bigint('pricebook_version', { mode: 'number' }),
    modifiersApplied: jsonb('modifiers_applied'),
    usageVector: jsonb('usage_vector'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // review #11: at most one settle per job
    settleUniq: uniqueIndex('ledger_settle_per_job').on(t.jobId).where(sql`type = 'settle'`),
    jobIdx: index('ledger_job_idx').on(t.jobId),
  }),
);

export const idempotencyKey = pgTable(
  'idempotency_key',
  {
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id),
    key: text('key').notNull(),
    jobId: uuid('job_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: uniqueIndex('idempotency_tenant_key').on(t.tenantId, t.key) }),
);

export const webhookOutbox = pgTable(
  'webhook_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id').notNull(),
    url: text('url').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: bigint('attempts', { mode: 'number' }).notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ dueIdx: index('outbox_due_idx').on(t.status, t.nextAttemptAt) }),
);
```

> Note: the partial-unique `ledger_settle_per_job` index uses `.where(sql\`type = 'settle'\`)` — `sql` is imported at the top of the file (review #11: at most one settle row per job).

- [ ] **Step 2: Re-export** — append `export * from './execution.js';` to `schema/index.ts`.

- [ ] **Step 3: Typecheck** — Run: `pnpm --filter @actionow/db typecheck` — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(db): add job/ledger/idempotency/outbox schema with settle uniqueness"
```

---

## Task 9: Generate migration + integration smoke test (Testcontainers)

**Files:**
- Create: `packages/db/drizzle/*` (generated), `packages/db/test/schema.int.test.ts`, `packages/db/vitest.config.ts`

- [ ] **Step 1: Generate migration**

Run: `pnpm --filter @actionow/db db:generate`
Expected: a SQL migration file appears under `packages/db/drizzle/` containing all tables.

- [ ] **Step 2: `packages/db/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 60000, hookTimeout: 120000 } });
```

- [ ] **Step 3: Write the failing integration test** `packages/db/test/schema.int.test.ts`

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { account, tenant } from '../src/schema/index.js';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 1 });
  db = drizzle(client);
  await migrate(db, { migrationsFolder: './drizzle' });
});

afterAll(async () => {
  await client.end();
  await container.stop();
});

it('applies migrations and enforces balance>=held check', async () => {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  await db.insert(account).values({ tenantId: t.id, creditBalance: 100n, creditHeld: 0n });
  // violating the check must throw
  await expect(
    db.insert(account).values({ tenantId: t.id, creditBalance: 10n, creditHeld: 50n }),
  ).rejects.toThrow();
});
```

- [ ] **Step 4: Run the test to verify it passes** (migration applies, check constraint fires)

Run: `pnpm --filter @actionow/db test`
Expected: PASS (1 test). If the check insert does not throw, the constraint is wrong — fix Task 6 Step 2.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(db): migration + balance check integration test (testcontainers)"
```

---

## Task 10: `apps/api` NestJS skeleton + health

**Files:**
- Create: `apps/api/{package.json,tsconfig.json,nest-cli.json,src/main.ts,src/app.module.ts}`
- Create: `apps/api/src/health/health.controller.ts`, `apps/api/test/health.e2e.test.ts`

- [ ] **Step 1: `apps/api/package.json`**

```json
{
  "name": "@actionow/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "nest build",
    "start:dev": "nest start --watch",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint src",
    "test": "vitest run"
  },
  "dependencies": {
    "@actionow/contracts": "workspace:*",
    "@actionow/db": "workspace:*",
    "@actionow/domain": "workspace:*",
    "@actionow/infra": "workspace:*",
    "@nestjs/common": "^10.4.0",
    "@nestjs/core": "^10.4.0",
    "@nestjs/platform-express": "^10.4.0",
    "reflect-metadata": "^0.2.0",
    "rxjs": "^7.8.0"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.4.0",
    "@nestjs/testing": "^10.4.0",
    "supertest": "^7.0.0",
    "vitest": "^2.1.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: `apps/api/nest-cli.json`**

```json
{ "$schema": "https://json.schemastore.org/nest-cli", "collection": "@nestjs/schematics", "sourceRoot": "src" }
```

- [ ] **Step 3: `apps/api/tsconfig.json`** — extends base; `outDir dist`, `rootDir .`, include `src`.

- [ ] **Step 4: `apps/api/src/health/health.controller.ts`**

```ts
import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  ready(): { status: 'ready' } {
    return { status: 'ready' };
  }
}
```

- [ ] **Step 5: `apps/api/src/app.module.ts`**

```ts
import { Module } from '@nestjs/common';

import { HealthController } from './health/health.controller.js';

@Module({ controllers: [HealthController] })
export class AppModule {}
```

- [ ] **Step 6: `apps/api/src/main.ts`**

```ts
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { loadEnv } from '@actionow/infra';

import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule);
  await app.listen(env.API_PORT);
}

void bootstrap();
```

- [ ] **Step 7: Write failing e2e test** `apps/api/test/health.e2e.test.ts`

```ts
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app.close();
});

it('GET /health returns ok', async () => {
  await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
});
```

- [ ] **Step 8: Run test** — Run: `pnpm --filter @actionow/api test` — Expected: PASS (1 test).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(api): NestJS skeleton with health/ready + e2e test"
```

---

## Task 11: `apps/worker` skeleton (BullMQ wiring, no-op queue)

**Files:**
- Create: `apps/worker/{package.json,tsconfig.json,src/main.ts,src/queues.ts}`

- [ ] **Step 1: `apps/worker/package.json`** — mirror `apps/api/package.json` (Task 10 Step 1) with name `@actionow/worker`, but:
  - dependencies: `@actionow/contracts`, `@actionow/db`, `@actionow/domain`, `@actionow/infra` (all `workspace:*`), plus `bullmq` `^5.13.0`, `ioredis` `^5.4.0`, `reflect-metadata` `^0.2.0`. (No `@actionow/adapters` in Phase 0 — wired in Phase 3.)
  - devDependencies: `tsx` `^4.19.0`, `vitest` `^2.1.0`, `typescript` `^5.6.0`.
  - scripts: `"start:dev": "tsx watch src/main.ts"`, `"build": "tsc -p tsconfig.json"`, `"typecheck": "tsc -p tsconfig.json --noEmit"`, `"lint": "eslint src"`, `"test": "vitest run"`.

- [ ] **Step 2: `apps/worker/src/queues.ts`** — declare the four queue names (§9)

```ts
export const QUEUE_NAMES = ['job-exec', 'webhook-outbox', 'hold-reaper', 'poll-upstream'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];
```

- [ ] **Step 3: `apps/worker/src/main.ts`** — boot a BullMQ Worker bound to `job-exec` that just logs (placeholder processor)

```ts
import 'reflect-metadata';

import { Worker } from 'bullmq';
import IORedis from 'ioredis';

import { loadEnv } from '@actionow/infra';

function bootstrap(): void {
  const env = loadEnv();
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const worker = new Worker(
    'job-exec',
    (job) => {
      // placeholder: real processor added in Phase 3
      return Promise.resolve({ received: job.id });
    },
    { connection },
  );
  worker.on('ready', () => {
    // eslint-disable-next-line no-console
    console.log('worker ready: job-exec');
  });
}

bootstrap();
```

- [ ] **Step 4: Verify it boots against running Redis**

Run (with `docker compose up -d` active): `timeout 5 pnpm --filter @actionow/worker start:dev || true`
Expected: logs `worker ready: job-exec` (then timeout kills it — that's fine).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(worker): BullMQ worker skeleton with queue name registry"
```

---

## Task 12: Root verification gate

- [ ] **Step 1: Install + typecheck everything** — Run: `pnpm install && pnpm typecheck` — Expected: PASS across all packages.
- [ ] **Step 2: Lint everything (boundaries enforced)** — Run: `pnpm lint` — Expected: PASS (0 errors).
- [ ] **Step 3: Build everything** — Run: `pnpm build` — Expected: PASS.
- [ ] **Step 4: Full test** — Run: `docker compose up -d && pnpm test` — Expected: db + api tests PASS.
- [ ] **Step 5: Add a boundaries regression guard** — temporarily add `import { account } from '@actionow/db';` into `packages/domain/src/index.ts`, run `pnpm lint`, confirm it FAILS with a boundaries/no-restricted-imports error, then revert. This proves §14.5 enforcement is live.
- [ ] **Step 6: Commit (if any fixes were needed)**

```bash
git add -A
git commit -m "chore: phase-0 verification gate green (typecheck/lint/build/test)"
```

---

## Phase 0 Definition of Done

- `pnpm install && pnpm typecheck && pnpm lint && pnpm build` all green.
- `docker compose up -d && pnpm db:migrate` applies the full schema.
- `pnpm test` green: db migration/constraint test + api health e2e.
- `eslint-plugin-boundaries` proven to reject a `domain → db` import (Task 12 Step 5).
- All six packages (`contracts/domain/db/adapters/dify/infra`) and both apps (`api/worker`) exist and compile (adapters/dify created as one-line skeletons in Task 5 Step 7).

> **Next plan:** Phase 1 — Domain core (io_schema→zod compiler, pricing engine, ledger quote/hold/settle, job state machine) authored against this foundation with full TDD.
