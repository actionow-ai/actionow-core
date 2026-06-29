import { createApiKey, createResource, createTenant, schema } from '@actionow/db';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DB, ENV } from '../src/common/tokens.js';
import { resetDb } from './reset-db.js';

const ADMIN_SECRET = 'e2e-admin-secret';

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

afterEach(async () => {
  await resetDb(
    () =>
      client`TRUNCATE TABLE api_key, job, resource, account, tenant, "user" RESTART IDENTITY CASCADE`,
  );
});

async function provision(name: string): Promise<{ tenantId: string; key: string }> {
  const t = await createTenant(db, { name });
  await db.insert(schema.account).values({ tenantId: t.id });
  const k = await createApiKey(db, { tenantId: t.id });
  return { tenantId: t.id, key: k.plaintext };
}

describe('cross-tenant job isolation (Track B Task 4)', () => {
  it('tenant B cannot read tenant A job (404), tenant A can (200)', async () => {
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
    if (job === undefined) throw new Error('failed to insert job');

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
