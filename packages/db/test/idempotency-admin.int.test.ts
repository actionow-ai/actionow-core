import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { getIdempotentResponse, putIdempotentResponse } from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

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
  await client`TRUNCATE TABLE request_idempotency RESTART IDENTITY CASCADE`;
});

describe('request_idempotency repo', () => {
  it('returns undefined on a miss', async () => {
    const hit = await getIdempotentResponse(db, 'nope', 'POST /admin/tenants');
    expect(hit).toBeUndefined();
  });

  it('put then get round-trips status + body', async () => {
    const body = { id: 'abc', name: 'acme' };
    const wrote = await putIdempotentResponse(db, {
      key: 'k1',
      scope: 'POST /admin/tenants',
      status: 201,
      body,
    });
    expect(wrote).toBe(true);

    const hit = await getIdempotentResponse(db, 'k1', 'POST /admin/tenants');
    expect(hit).toEqual({ status: 201, body });
  });

  it('a second put for the same (key, scope) is a no-op and keeps the first body', async () => {
    await putIdempotentResponse(db, {
      key: 'k1',
      scope: 'POST /admin/tenants',
      status: 201,
      body: { id: 'first' },
    });
    const wroteAgain = await putIdempotentResponse(db, {
      key: 'k1',
      scope: 'POST /admin/tenants',
      status: 201,
      body: { id: 'second' },
    });
    // The concurrent-duplicate race: the write is a no-op, NOT an error.
    expect(wroteAgain).toBe(false);

    const hit = await getIdempotentResponse(db, 'k1', 'POST /admin/tenants');
    expect(hit).toEqual({ status: 201, body: { id: 'first' } });
  });

  it('the same key under a DIFFERENT scope is independent', async () => {
    await putIdempotentResponse(db, {
      key: 'shared',
      scope: 'POST /admin/tenants',
      status: 201,
      body: { id: 'tenant' },
    });
    const wrote = await putIdempotentResponse(db, {
      key: 'shared',
      scope: 'POST /admin/models',
      status: 201,
      body: { id: 'model' },
    });
    expect(wrote).toBe(true);

    expect(await getIdempotentResponse(db, 'shared', 'POST /admin/tenants')).toEqual({
      status: 201,
      body: { id: 'tenant' },
    });
    expect(await getIdempotentResponse(db, 'shared', 'POST /admin/models')).toEqual({
      status: 201,
      body: { id: 'model' },
    });
  });

  it('stores a null body (a response with no JSON body)', async () => {
    await putIdempotentResponse(db, {
      key: 'k-null',
      scope: 'POST /admin/x',
      status: 204,
      body: null,
    });
    expect(await getIdempotentResponse(db, 'k-null', 'POST /admin/x')).toEqual({
      status: 204,
      body: null,
    });
  });
});
