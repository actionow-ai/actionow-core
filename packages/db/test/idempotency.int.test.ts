import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { claimIdempotency } from '../src/repositories/index.js';
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
  await client`TRUNCATE TABLE idempotency_key, tenant RESTART IDENTITY CASCADE`;
});

async function makeTenant(): Promise<string> {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  return t.id;
}

describe('claimIdempotency', () => {
  it('first claim for a (tenant,key) returns {claimed:true}', async () => {
    const tenantId = await makeTenant();
    const jobId = randomUUID();

    const r = await claimIdempotency(db, tenantId, 'k1', jobId);

    expect(r).toEqual({ claimed: true });
  });

  it('a repeat claim returns {claimed:false} with the original jobId', async () => {
    const tenantId = await makeTenant();
    const firstJobId = randomUUID();
    const secondJobId = randomUUID();

    await claimIdempotency(db, tenantId, 'k1', firstJobId);
    const r = await claimIdempotency(db, tenantId, 'k1', secondJobId);

    expect(r).toEqual({ claimed: false, existingJobId: firstJobId });
  });

  it('the same key under a different tenant is an independent claim', async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const jobA = randomUUID();
    const jobB = randomUUID();

    const ra = await claimIdempotency(db, tenantA, 'shared', jobA);
    const rb = await claimIdempotency(db, tenantB, 'shared', jobB);

    expect(ra).toEqual({ claimed: true });
    expect(rb).toEqual({ claimed: true });
  });
});
