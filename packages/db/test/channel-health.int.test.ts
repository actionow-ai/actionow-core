import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createResource,
  createUpstreamChannel,
  listChannelsForResource,
  listCooledDownChannelIds,
  recordChannelFailure,
  updateUpstreamChannel,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

const { channelHealth, tenant } = schema;

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
  await client`TRUNCATE TABLE channel_health, upstream_channel, resource, tenant RESTART IDENTITY CASCADE`;
});

async function seedChannel(weight = 1, status = 'active'): Promise<string> {
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
    weight,
    status,
  });
  return ch.id;
}

describe('channel health / cooldown (P0a)', () => {
  it('records a failure, cools the channel down, and recovers after the cooldown passes', async () => {
    const channelId = await seedChannel();
    const t0 = new Date('2026-06-17T00:00:00.000Z');

    // Healthy before any failure.
    expect(await listCooledDownChannelIds(db, [channelId], t0)).toEqual([]);

    await recordChannelFailure(db, channelId, t0);

    // First failure → 1s base cooldown. Cooled down at t0+0.5s, healthy at t0+2s.
    expect(await listCooledDownChannelIds(db, [channelId], new Date(t0.getTime() + 500))).toEqual([
      channelId,
    ]);
    expect(await listCooledDownChannelIds(db, [channelId], new Date(t0.getTime() + 2_000))).toEqual(
      [],
    );
  });

  it('backs off exponentially within the reset window, then resets after it', async () => {
    const channelId = await seedChannel();
    const t0 = new Date('2026-06-17T00:00:00.000Z');

    await recordChannelFailure(db, channelId, t0); // failures=1 → 1s
    await recordChannelFailure(db, channelId, new Date(t0.getTime() + 1_500)); // failures=2 → 2s

    const [h2] = await db.select().from(channelHealth);
    expect(h2?.consecutiveFailures).toBe(2);
    // Still cooled 1.5s after the 2nd failure (2s backoff), healthy past it.
    expect(
      await listCooledDownChannelIds(db, [channelId], new Date(t0.getTime() + 1_500 + 1_900)),
    ).toEqual([channelId]);

    // A failure long after the reset window (5min) restarts the streak at 1.
    await recordChannelFailure(db, channelId, new Date(t0.getTime() + 10 * 60_000));
    const [h3] = await db.select().from(channelHealth);
    expect(h3?.consecutiveFailures).toBe(1);
  });

  it('honors retryAfterMs when larger than the computed backoff', async () => {
    const channelId = await seedChannel();
    const t0 = new Date('2026-06-17T00:00:00.000Z');
    await recordChannelFailure(db, channelId, t0, 30_000); // 30s > 1s base
    expect(
      await listCooledDownChannelIds(db, [channelId], new Date(t0.getTime() + 20_000)),
    ).toEqual([channelId]);
  });

  it('ignores channels with no health row and never-failed ids', async () => {
    const channelId = await seedChannel();
    expect(await listCooledDownChannelIds(db, [channelId], new Date())).toEqual([]);
    expect(await listCooledDownChannelIds(db, [], new Date())).toEqual([]);
  });
});

describe('channel admin repos (P0b)', () => {
  it('updateUpstreamChannel patches only the supplied fields', async () => {
    const channelId = await seedChannel(1, 'active');
    const updated = await updateUpstreamChannel(db, channelId, {
      endpoint: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      weight: 5,
      status: 'disabled',
    });
    expect(updated?.endpoint).toBe('https://api.deepseek.com/v1');
    expect(updated?.model).toBe('deepseek-chat');
    expect(updated?.weight).toBe(5);
    expect(updated?.status).toBe('disabled');
    expect(updated?.proxyRef).toBeNull(); // untouched
  });

  it('listChannelsForResource includes disabled channels (operator view)', async () => {
    const activeId = await seedChannel(3, 'active');
    const disabled = await createUpstreamChannel(db, {
      resourceId: 'chat-res',
      providerType: 'mock-chat',
      weight: 1,
      status: 'disabled',
    });
    const all = await listChannelsForResource(db, 'chat-res');
    const ids = all.map((c) => c.id);
    expect(ids).toContain(activeId);
    expect(ids).toContain(disabled.id);
    // Ordered by descending weight (active=3 before disabled=1).
    expect(all[0]?.id).toBe(activeId);
  });
});
