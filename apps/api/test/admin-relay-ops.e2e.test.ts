import { createUser, insertRelayTrace, schema } from '@actionow/db';
import { hashPassword } from '@actionow/infra';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
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
let tenantId: string;

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

  const t = await request(app.getHttpServer())
    .post('/admin/tenants')
    .set('authorization', `Bearer ${token}`)
    .send({ name: 'acme' })
    .expect(201);
  tenantId = t.body.id as string;
});

afterEach(async () => {
  await resetDb(
    () =>
      client`TRUNCATE TABLE relay_trace, usage_log, redemption_code, api_key, ledger_txn, account, tenant, "user" RESTART IDENTITY CASCADE`,
  );
});

function auth(req: request.Test): request.Test {
  return req.set('authorization', `Bearer ${token}`);
}

/** Sign a non-admin (`role: 'user'`) JWT with the same secret as a real login. */
function userToken(): string {
  return new JwtService().sign(
    { sub: '00000000-0000-0000-0000-000000000001', role: 'user' },
    { secret: ADMIN_SECRET, expiresIn: '12h' },
  );
}

describe('admin redemption codes', () => {
  it('rejects a non-admin (user) JWT', async () => {
    await request(app.getHttpServer())
      .post('/admin/redemption-codes')
      .set('authorization', `Bearer ${userToken()}`)
      .send({ count: 1, creditsPerCode: 5 })
      .expect((res) => {
        expect([401, 403]).toContain(res.status);
      });
  });

  it('mints a batch of codes with serialized credit amounts', async () => {
    const res = await auth(
      request(app.getHttpServer())
        .post('/admin/redemption-codes')
        .send({ count: 3, creditsPerCode: 5 }),
    ).expect(201);
    expect(res.body.codes).toHaveLength(3);
    // 5 human credits → 5_000_000 µcredits, serialized as a decimal string.
    expect(res.body.credit_amount).toBe('5000000');
    // Codes are unique non-empty strings.
    const set = new Set<string>(res.body.codes);
    expect(set.size).toBe(3);

    // N rows landed, all `unused` with the right µcredit grant.
    const rows = await client`SELECT code, credit_amount, status FROM redemption_code`;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.status).toBe('unused');
      expect(row.credit_amount).toBe('5000000');
    }
  });
});

describe('admin global usage stats', () => {
  it('returns the global usage log (empty initially)', async () => {
    const res = await auth(request(app.getHttpServer()).get('/admin/usage')).expect(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.has_more).toBe(false);
    expect(res.body.next_cursor).toBeNull();
  });

  it('reflects an inserted usage_log row in the global view', async () => {
    await client`
      INSERT INTO usage_log (tenant_id, model, input_tokens, output_tokens, cost, status)
      VALUES (${tenantId}, ${'gpt-4o'}, 100, 50, 6000, ${'succeeded'})
    `;
    const res = await auth(request(app.getHttpServer()).get('/admin/usage')).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].model).toBe('gpt-4o');
    expect(res.body.data[0].cost).toBe('6000');
    expect(res.body.data[0].input_tokens).toBe(100);
  });
});

describe('admin analytics usage rollup', () => {
  it('rolls up usage by model with bigint sums as decimal strings', async () => {
    // Two gpt-4o rows (one failed) + one claude row → per-model buckets.
    await client`
      INSERT INTO usage_log (tenant_id, model, input_tokens, output_tokens, cost, status) VALUES
        (${tenantId}, ${'gpt-4o'}, 10, 4, 20, ${'succeeded'}),
        (${tenantId}, ${'gpt-4o'}, 20, 8, 45, ${'failed'}),
        (${tenantId}, ${'claude-3'}, 5, 2, 10, ${'succeeded'})
    `;
    const res = await auth(
      request(app.getHttpServer()).get('/admin/analytics/usage').query({ groupBy: 'model' }),
    ).expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    const gpt = res.body.find((r: { bucket: string }) => r.bucket === 'gpt-4o');
    expect(gpt).toMatchObject({
      bucket: 'gpt-4o',
      requests: 2,
      input_tokens: '30',
      output_tokens: '12',
      cost: '65',
      errors: 1,
    });
    const claude = res.body.find((r: { bucket: string }) => r.bucket === 'claude-3');
    expect(claude).toMatchObject({ requests: 1, input_tokens: '5', cost: '10', errors: 0 });
  });

  it('rejects an unknown groupBy with a 400', async () => {
    await auth(
      request(app.getHttpServer()).get('/admin/analytics/usage').query({ groupBy: 'bogus' }),
    ).expect(400);
  });
});

describe('admin relay-traces read endpoint', () => {
  const jobA = '11111111-1111-1111-1111-111111111111';
  const jobB = '22222222-2222-2222-2222-222222222222';

  /**
   * Seed 3 relay_trace rows via the real writer: two for jobA (one carrying a
   * raw bearer token in request_headers to prove READ-SIDE redaction), one for
   * jobB. Inserted oldest-first so the newest jobA row pages first.
   */
  async function seedTraces(): Promise<void> {
    await insertRelayTrace(db, {
      jobId: jobA,
      providerType: 'codex-oauth',
      method: 'POST',
      url: 'https://upstream.example/a-old',
      // A row that slipped past write-side redaction — read-side must scrub it.
      requestHeaders: { authorization: 'Bearer leak-me-xyz', 'content-type': 'application/json' },
      requestBody: '{"input":[]}',
      responseStatus: 200,
    });
    await insertRelayTrace(db, {
      jobId: jobB,
      providerType: 'openai',
      method: 'POST',
      url: 'https://upstream.example/b',
      responseStatus: 200,
    });
    await insertRelayTrace(db, {
      jobId: jobA,
      providerType: 'codex-oauth',
      method: 'POST',
      url: 'https://upstream.example/a-new',
      responseStatus: 200,
    });
  }

  it('rejects a non-admin (user) JWT', async () => {
    await request(app.getHttpServer())
      .get('/admin/relay-traces')
      .set('authorization', `Bearer ${userToken()}`)
      .expect((res) => {
        expect([401, 403]).toContain(res.status);
      });
  });

  it('filters by job_id, paginates via cursor, and never leaks a token', async () => {
    await seedTraces();

    // Page 1: jobA only, limit 1 → newest jobA row, has_more, a cursor.
    const page1 = await auth(
      request(app.getHttpServer()).get('/admin/relay-traces').query({ jobId: jobA, limit: 1 }),
    ).expect(200);

    expect(page1.body.data).toHaveLength(1);
    expect(page1.body.has_more).toBe(true);
    expect(typeof page1.body.next_cursor).toBe('string');
    expect(page1.body.next_cursor.length).toBeGreaterThan(0);
    // Newest jobA trace first; every row honours the filter.
    expect(page1.body.data[0].job_id).toBe(jobA);
    expect(page1.body.data[0].url).toBe('https://upstream.example/a-new');
    for (const row of page1.body.data) expect(row.job_id).toBe(jobA);

    // Page 2: follow the cursor → the older jobA row, no more.
    const page2 = await auth(
      request(app.getHttpServer())
        .get('/admin/relay-traces')
        .query({ jobId: jobA, limit: 1, cursor: page1.body.next_cursor }),
    ).expect(200);

    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.has_more).toBe(false);
    expect(page2.body.next_cursor).toBeNull();
    expect(page2.body.data[0].job_id).toBe(jobA);
    expect(page2.body.data[0].url).toBe('https://upstream.example/a-old');

    // READ-SIDE REDACTION: the leaked token never surfaces in either page.
    expect(JSON.stringify(page1.body)).not.toContain('leak-me-xyz');
    expect(JSON.stringify(page2.body)).not.toContain('leak-me-xyz');
    // The row that carried it has the authorization header redacted.
    expect(page2.body.data[0].request_headers.authorization).toBe('[redacted]');
    // A non-secret header passes through unchanged.
    expect(page2.body.data[0].request_headers['content-type']).toBe('application/json');
  });

  it('rejects a malformed cursor with a 400', async () => {
    await auth(
      request(app.getHttpServer()).get('/admin/relay-traces').query({ cursor: 'not-a-cursor' }),
    ).expect(400);
  });
});
