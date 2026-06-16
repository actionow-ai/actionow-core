import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createFileObject, getFileObject, markFileReady } from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

const { tenant } = schema;

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
}, 120_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  await client`TRUNCATE TABLE file_object, tenant RESTART IDENTITY CASCADE`;
});

async function makeTenant(): Promise<string> {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  return t.id;
}

describe('file_object repository', () => {
  it('createFileObject inserts a pending row', async () => {
    const tenantId = await makeTenant();
    const file = await createFileObject(db, {
      tenantId,
      provider: 'minio',
      bucket: 'actionow',
      key: `${tenantId}/abc.png`,
    });

    expect(file.status).toBe('pending');
    expect(file.size).toBeNull();
    expect(file.etag).toBeNull();
    expect(file.key).toBe(`${tenantId}/abc.png`);
  });

  it('markFileReady moves the row to ready with observed metadata', async () => {
    const tenantId = await makeTenant();
    const file = await createFileObject(db, {
      tenantId,
      provider: 'minio',
      bucket: 'actionow',
      key: `${tenantId}/abc.png`,
    });

    const ready = await markFileReady(db, file.id, {
      size: 1234,
      contentType: 'image/png',
      etag: '"deadbeef"',
    });

    expect(ready?.status).toBe('ready');
    expect(ready?.size).toBe(1234);
    expect(ready?.contentType).toBe('image/png');
    expect(ready?.etag).toBe('"deadbeef"');
  });

  it('getFileObject is tenant-scoped (another tenant cannot read the file)', async () => {
    const owner = await makeTenant();
    const other = await makeTenant();
    const file = await createFileObject(db, {
      tenantId: owner,
      provider: 'minio',
      bucket: 'actionow',
      key: `${owner}/secret.bin`,
    });

    expect((await getFileObject(db, file.id, owner))?.id).toBe(file.id);
    expect(await getFileObject(db, file.id, other)).toBeUndefined();
    // Unscoped lookup still finds it (used internally).
    expect((await getFileObject(db, file.id))?.id).toBe(file.id);
  });
});
