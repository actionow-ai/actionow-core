import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { deleteRelayTracesOlderThan } from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

const { relayTrace } = schema;

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
  await client`TRUNCATE TABLE relay_trace RESTART IDENTITY CASCADE`;
});

/** Insert N relay_trace rows stamped at `createdAt`. */
async function seedTraces(createdAt: Date, n: number): Promise<void> {
  await db.insert(relayTrace).values(
    Array.from({ length: n }, (_, i) => ({
      method: 'POST',
      url: `http://upstream/${String(i)}`,
      createdAt,
    })),
  );
}

describe('deleteRelayTracesOlderThan', () => {
  it('deletes rows older than the cutoff, keeps newer, returns the count', async () => {
    await seedTraces(new Date('2026-01-01Z'), 3);
    await seedTraces(new Date('2026-06-01Z'), 2);

    const removed = await deleteRelayTracesOlderThan(db, new Date('2026-03-01Z'));
    expect(removed).toBe(3);
    expect(await db.select().from(relayTrace)).toHaveLength(2);
  });

  it('returns 0 when nothing is older than the cutoff', async () => {
    await seedTraces(new Date('2026-06-01Z'), 4);
    expect(await deleteRelayTracesOlderThan(db, new Date('2026-01-01Z'))).toBe(0);
    expect(await db.select().from(relayTrace)).toHaveLength(4);
  });

  it('batches a large prune (deletes all eligible across batches)', async () => {
    await seedTraces(new Date('2026-01-01Z'), 12);
    const removed = await deleteRelayTracesOlderThan(db, new Date('2026-02-01Z'), 5);
    expect(removed).toBe(12);
    expect(await db.select().from(relayTrace)).toHaveLength(0);
  });
});
