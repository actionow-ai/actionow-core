import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createResource,
  createUpstreamChannel,
  listChannelsForResource,
  updateUpstreamChannel,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

// NOTE (resilience-v2 Task 2): the binary `channel_health` cooldown
// (`recordChannelFailure` / `listCooledDownChannelIds` + the `channel_health`
// table) was removed and superseded by the stateful per-(channel,model) circuit
// breaker — its repo coverage lives in `channel-breaker.int.test.ts`. This file
// now only exercises the channel admin repos that survive (P0b).

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
  await client`TRUNCATE TABLE upstream_channel, resource, tenant RESTART IDENTITY CASCADE`;
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
    const { rows: all } = await listChannelsForResource(db, 'chat-res', { limit: 200 });
    const ids = all.map((c) => c.id);
    expect(ids).toContain(activeId);
    expect(ids).toContain(disabled.id);
    // Keyset order is created_at DESC: the disabled channel was inserted last,
    // so it sorts ahead of the earlier active one.
    expect(all[0]?.id).toBe(disabled.id);
  });
});
