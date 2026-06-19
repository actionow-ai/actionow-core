import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createResource,
  createTenant,
  getJobForTenant,
  getResourceForTenant,
  schema,
} from '../src/index.js';

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
  await client`TRUNCATE TABLE job, resource, account, tenant RESTART IDENTITY CASCADE`;
});

describe('tenant-predicate reads (Track B Task 3)', () => {
  it('getResourceForTenant returns only the owning tenant resource', async () => {
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

  it('getJobForTenant returns only the owning tenant job', async () => {
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
    if (!j) throw new Error('job insert returned no row');
    expect((await getJobForTenant(db, j.id, t1.id))?.id).toBe(j.id);
    expect(await getJobForTenant(db, j.id, t2.id)).toBeUndefined();
  });
});
