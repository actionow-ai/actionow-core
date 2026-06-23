import {
  channelIdsByModelIds,
  countModelsByChannelIds,
  createModel,
  createResource,
  createUpstreamChannel,
  linkChannelModel,
  linkChannelModelsByNames,
  listChannelModels,
  listModelChannels,
  schema,
  unlinkAllForChannel,
  unlinkChannelModel,
} from '@actionow/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const { tenant } = schema;
let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 5 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
}, 120_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  await client`TRUNCATE TABLE channel_model, model, upstream_channel, resource_version, resource, tenant RESTART IDENTITY CASCADE`;
});

async function seed(): Promise<{ channelId: string; modelId: string; modelName: string }> {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('no tenant');
  await createResource(db, {
    id: 'deepseek-chat',
    tenantId: t.id,
    kind: 'model',
    modality: 'text',
    providerType: 'openai',
    execModes: ['blocking'],
    ioSchema: { inputs: [], outputs: [] },
    version: 1,
  });
  const channel = await createUpstreamChannel(db, {
    resourceId: 'deepseek-chat',
    providerType: 'openai',
  });
  const m = await createModel(db, { name: 'deepseek-chat', resourceId: 'deepseek-chat' });
  return { channelId: channel.id, modelId: m.id, modelName: m.name };
}

describe('channel_model links', () => {
  it('links, lists both directions, and unlinks (idempotent)', async () => {
    const { channelId, modelId } = await seed();

    await linkChannelModel(db, channelId, modelId);
    await linkChannelModel(db, channelId, modelId); // idempotent — no PK violation

    expect((await listChannelModels(db, channelId)).map((m) => m.id)).toEqual([modelId]);
    expect(await listModelChannels(db, modelId)).toEqual([channelId]);

    await unlinkChannelModel(db, channelId, modelId);
    expect(await listChannelModels(db, channelId)).toHaveLength(0);
    expect(await listModelChannels(db, modelId)).toHaveLength(0);
  });

  it('batch counts + inverse map + link-by-names', async () => {
    const { channelId, modelId, modelName } = await seed();

    await linkChannelModelsByNames(db, channelId, [modelName, 'does-not-exist']);
    expect(await listModelChannels(db, modelId)).toEqual([channelId]);

    const counts = await countModelsByChannelIds(db, [channelId]);
    expect(counts.get(channelId)).toBe(1);

    const inverse = await channelIdsByModelIds(db, [modelId]);
    expect(inverse.get(modelId)).toEqual([channelId]);
  });

  it('unlinkAllForChannel removes every link for a channel', async () => {
    const { channelId, modelId } = await seed();
    await linkChannelModel(db, channelId, modelId);
    await unlinkAllForChannel(db, channelId);
    expect(await listChannelModels(db, channelId)).toHaveLength(0);
  });
});
