import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createResource,
  createUpstreamChannel,
  getBreakerRows,
  listBreakers,
  resetBreaker,
  upsertBreaker,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

const { channelBreaker, tenant } = schema;

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
  await client`TRUNCATE TABLE channel_breaker, upstream_channel, resource, tenant RESTART IDENTITY CASCADE`;
});

async function seedChannel(): Promise<string> {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  await createResource(db, {
    id: 'chat-res',
    tenantId: t.id,
    kind: 'model',
    modality: 'text',
    providerType: 'mock-chat',
    execModes: ['stream'],
    ioSchema: { inputs: [], outputs: [] },
    version: 1,
  });
  const ch = await createUpstreamChannel(db, {
    resourceId: 'chat-res',
    providerType: 'mock-chat',
    weight: 1,
    status: 'active',
  });
  return ch.id;
}

describe('channel_breaker repo (弹性2.0)', () => {
  const t0 = new Date('2026-06-25T00:00:00.000Z');

  it('getBreakerRows returns the rows for the given channels+model (closed = no row)', async () => {
    const ch = await seedChannel();
    // No row yet → empty.
    expect(await getBreakerRows(db, [ch], 'gpt-x')).toEqual([]);
    expect(await getBreakerRows(db, [], 'gpt-x')).toEqual([]);

    await db.insert(channelBreaker).values({ channelId: ch, model: 'gpt-x', state: 'open' });
    const rows = await getBreakerRows(db, [ch], 'gpt-x');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.channelId).toBe(ch);
    expect(rows[0]?.state).toBe('open');
    // A different model is not returned.
    expect(await getBreakerRows(db, [ch], 'other-model')).toEqual([]);
  });

  it('upsertBreaker inserts then updates on the composite PK', async () => {
    const ch = await seedChannel();
    await upsertBreaker(db, {
      channelId: ch,
      model: 'gpt-x',
      state: 'open',
      openedAt: t0,
      cooldownUntil: new Date(t0.getTime() + 5_000),
      tripCount: 1,
      halfOpenSuccesses: 0,
      now: t0,
    });
    let rows = await getBreakerRows(db, [ch], 'gpt-x');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('open');
    expect(rows[0]?.tripCount).toBe(1);

    // Second upsert updates the same (channel, model) row, not a new one.
    await upsertBreaker(db, {
      channelId: ch,
      model: 'gpt-x',
      state: 'closed',
      openedAt: null,
      cooldownUntil: null,
      tripCount: 0,
      halfOpenSuccesses: 0,
      now: new Date(t0.getTime() + 10_000),
    });
    rows = await getBreakerRows(db, [ch], 'gpt-x');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('closed');
    expect(rows[0]?.tripCount).toBe(0);
    expect(rows[0]?.cooldownUntil).toBeNull();
  });

  it('resetBreaker deletes the (channel, model) row back to closed', async () => {
    const ch = await seedChannel();
    await upsertBreaker(db, {
      channelId: ch,
      model: 'gpt-x',
      state: 'open',
      tripCount: 2,
      halfOpenSuccesses: 0,
      now: t0,
    });
    expect(await getBreakerRows(db, [ch], 'gpt-x')).toHaveLength(1);
    await resetBreaker(db, ch, 'gpt-x');
    expect(await getBreakerRows(db, [ch], 'gpt-x')).toEqual([]);
    // Idempotent: resetting an absent row is a no-op.
    await resetBreaker(db, ch, 'gpt-x');
    expect(
      await db
        .select()
        .from(channelBreaker)
        .where(and(eq(channelBreaker.channelId, ch))),
    ).toEqual([]);
  });

  it('listBreakers returns every breaker row across channels+models', async () => {
    const ch = await seedChannel();
    await upsertBreaker(db, {
      channelId: ch,
      model: 'gpt-x',
      state: 'open',
      tripCount: 1,
      halfOpenSuccesses: 0,
      now: t0,
    });
    await upsertBreaker(db, {
      channelId: ch,
      model: 'gpt-y',
      state: 'half_open',
      tripCount: 1,
      halfOpenSuccesses: 1,
      now: t0,
    });
    const all = await listBreakers(db);
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.model).sort()).toEqual(['gpt-x', 'gpt-y']);
  });
});
