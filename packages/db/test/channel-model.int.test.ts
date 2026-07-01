import type { ParamOverride } from '@actionow/contracts';
import { paramOverrideSchema } from '@actionow/contracts';
import {
  channelIdsByModelIds,
  countModelsByChannelIds,
  createModel,
  createResource,
  createUpstreamChannel,
  getChannelModelOverride,
  getChannelModelOverrides,
  linkChannelModel,
  linkChannelModelsByNames,
  listChannelModels,
  listModelChannels,
  schema,
  setChannelModelOverride,
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

describe('channel_model.param_override (mig 0062)', () => {
  const override: ParamOverride = {
    ops: [
      { op: 'set', name: 'temperature', value: 0 },
      { op: 'clamp', name: 'top_p', min: 0, max: 0.9 },
    ],
  };

  it('I0-2 existing plain links read back with param_override === null', async () => {
    const { channelId, modelId } = await seed();
    await linkChannelModel(db, channelId, modelId);

    expect(await getChannelModelOverride(db, channelId, modelId)).toBeNull();
    const rows = await listChannelModels(db, channelId);
    expect(rows[0]?.paramOverride ?? null).toBeNull();
  });

  it('I0-3 round-trip: setChannelModelOverride writes, getChannelModelOverride reads exact jsonb', async () => {
    const { channelId, modelId } = await seed();
    await linkChannelModel(db, channelId, modelId);

    await setChannelModelOverride(db, channelId, modelId, override);
    expect(await getChannelModelOverride(db, channelId, modelId)).toEqual(override);

    // surfaced on the listChannelModels row (drives the col-3 chip)
    const rows = await listChannelModels(db, channelId);
    expect(rows[0]?.paramOverride).toEqual(override);

    // batch loader returns the same override keyed by channel
    const map = await getChannelModelOverrides(db, modelId, [channelId]);
    expect(map.get(channelId)).toEqual(override);
  });

  it('I0-3b upserts the link when absent, and clears with null', async () => {
    const { channelId, modelId } = await seed();
    // no explicit linkChannelModel — the override upsert creates the link
    await setChannelModelOverride(db, channelId, modelId, override);
    expect(await listModelChannels(db, modelId)).toEqual([channelId]);

    // clearing sets it back to null (== today); append-only trigger does NOT
    // block this UPDATE (channel_model is a free link table, mig 0052 clearance)
    await setChannelModelOverride(db, channelId, modelId, null);
    expect(await getChannelModelOverride(db, channelId, modelId)).toBeNull();

    // only channels WITH an override appear in the batch map → empty here
    expect((await getChannelModelOverrides(db, modelId, [channelId])).size).toBe(0);
  });

  it('I0-4 zod rejects a malformed op (move) at the repo boundary', () => {
    expect(() =>
      paramOverrideSchema.parse({ ops: [{ op: 'move', name: 'temperature' }] }),
    ).toThrow();
  });
});
