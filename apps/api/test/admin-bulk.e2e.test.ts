import { createUser, schema } from '@actionow/db';
import { hashPassword } from '@actionow/infra';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DB, ENV } from '../src/common/tokens.js';
import { resetDb } from './reset-db.js';

// 批次6 D3 (旧世界删除): the bulk model/channel actions (and their fixtures
// over /admin/resources + /admin/models) died with the resource three-layer.
// What survives here: the oauth-sessions bulk revoke, the latest-audit badge
// batch, and the single-row audit emissions on KEPT entities.

const ADMIN_SECRET = 'e2e-admin-secret';
const ADMIN_EMAIL = 'admin@actionow.local';
const ADMIN_PASSWORD = 'hunter2';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;
let app: INestApplication;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(ENV)
    .useValue({
      NODE_ENV: 'production',
      CREDIT_RATE: 1000,
      DATABASE_URL: container.getConnectionUri(),
      REDIS_URL: 'redis://localhost:6379',
      API_PORT: 3000,
      LOG_LEVEL: 'info',
      DEV_TENANT_ID: undefined,
      RATE_LIMIT_TENANT_PER_MIN: 600,
      RATE_LIMIT_RESOURCE_PER_MIN: 120,
      ADMIN_JWT_SECRET: ADMIN_SECRET,
    })
    .compile();

  app = moduleRef.createNestApplication();
  await app.init();
}, 180_000);

afterAll(async () => {
  await app.close();
  await client.end();
  await container.stop();
});

let token: string;

beforeEach(async () => {
  await createUser(db, {
    email: ADMIN_EMAIL,
    passwordHash: hashPassword(ADMIN_PASSWORD),
    role: 'admin',
    emailVerified: true,
  });
  const login = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    .expect(200);
  token = login.body.token as string;
});

afterEach(async () => {
  await resetDb(
    () =>
      client`TRUNCATE TABLE audit_log, request_idempotency, api_key, ledger_txn, fault_policy, route_group, account, tenant, "user" RESTART IDENTITY CASCADE`,
  );
});

function auth(req: request.Test): request.Test {
  return req.set('authorization', `Bearer ${token}`);
}

async function createFaultPolicy(name: string): Promise<string> {
  const fp = await auth(
    request(app.getHttpServer()).post('/admin/fault-policies').send({ name }),
  ).expect(201);
  return fp.body.id as string;
}

async function createRouteGroup(name: string): Promise<string> {
  const rg = await auth(
    request(app.getHttpServer()).post('/admin/route-groups').send({ name }),
  ).expect(201);
  return rg.body.id as string;
}

/**
 * Newest audit row for one target via the badge endpoint, or undefined. The
 * `@Audit` interceptor writes the row fire-and-forget AFTER the response (see
 * audit.interceptor.ts), so we poll briefly for it to appear.
 */
async function latestAuditFor(
  targetType: string,
  id: string,
  expectedAction?: string,
): Promise<{ action: string; actor_type: string } | undefined> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const res = await auth(
      request(app.getHttpServer())
        .post('/admin/audit-log/latest')
        .send({ target_type: targetType, ids: [id] }),
    ).expect(200);
    const row = (res.body as { target_id: string; action: string; actor_type: string }[]).find(
      (r) => r.target_id === id,
    );
    if (row !== undefined && (expectedAction === undefined || row.action === expectedAction)) {
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

describe('bulk oauth-sessions (smoke)', () => {
  it('revoke of bogus ids → all in failed (partial-success, never aborts)', async () => {
    const res = await auth(
      request(app.getHttpServer())
        .post('/admin/oauth-sessions/bulk')
        .send({ ids: ['nope-1', 'nope-2'], action: 'revoke' }),
    ).expect(200);
    expect(res.body.succeeded).toEqual([]);
    expect(res.body.failed.map((f: { id: string }) => f.id)).toEqual(
      expect.arrayContaining(['nope-1', 'nope-2']),
    );
  });
});

describe('latest-audit batch (前端打磨 — entity-list audit badges)', () => {
  it('returns the newest audit row per target and omits ids with no history', async () => {
    // Two audited creates (fault_policy.create) — the badge source.
    const fp1 = await createFaultPolicy('badge-fp1');
    const fp2 = await createFaultPolicy('badge-fp2');

    // Barrier: the audits are fire-and-forget — wait for both to land.
    await latestAuditFor('fault_policy', fp1, 'fault_policy.create');
    await latestAuditFor('fault_policy', fp2, 'fault_policy.create');

    const res = await auth(
      request(app.getHttpServer())
        .post('/admin/audit-log/latest')
        // `nope` has no audit row → must be absent from the response.
        .send({ target_type: 'fault_policy', ids: [fp1, fp2, 'nope'] }),
    ).expect(200);

    const byId = new Map<string, { action: string; actor_type: string; created_at: string }>(
      (
        res.body as { target_id: string; action: string; actor_type: string; created_at: string }[]
      ).map((r) => [r.target_id, r]),
    );
    expect(res.body).toHaveLength(2);
    expect(byId.has('nope')).toBe(false);
    expect(byId.get(fp1)?.action).toBe('fault_policy.create');
    expect(byId.get(fp1)?.actor_type).toBe('operator');
    expect(typeof byId.get(fp1)?.created_at).toBe('string');
    expect(byId.get(fp2)?.action).toBe('fault_policy.create');
  });

  it('returns [] for an empty ids[]', async () => {
    const res = await auth(
      request(app.getHttpServer())
        .post('/admin/audit-log/latest')
        .send({ target_type: 'fault_policy', ids: [] }),
    ).expect(200);
    expect(res.body).toEqual([]);
  });
});

describe('single-row audit emission feeds badges (前端打磨)', () => {
  it('creating a fault policy emits a fault_policy.create row (previously badge-less)', async () => {
    const id = await createFaultPolicy('single-fp');
    const row = await latestAuditFor('fault_policy', id, 'fault_policy.create');
    expect(row?.action).toBe('fault_policy.create');
    expect(row?.actor_type).toBe('operator');
  });

  it('creating a route group emits a route_group.create row (previously badge-less)', async () => {
    const id = await createRouteGroup('single-rg');
    const row = await latestAuditFor('route_group', id, 'route_group.create');
    expect(row?.action).toBe('route_group.create');
  });
});
