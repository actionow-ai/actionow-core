import {
  addChannelToGroup,
  createResource,
  createRouteGroup,
  createUpstreamChannel,
  listCandidateChannelsWithFallback,
  listChannels,
  listGroupChannelsForResource,
  schema,
  updateUpstreamChannel,
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
  await client`TRUNCATE TABLE route_group_channel, route_group, upstream_channel, resource_version, resource, tenant RESTART IDENTITY CASCADE`;
});

describe('upstream_channel endpoint/model/proxy_ref/config columns', () => {
  it('persists and reads back endpoint, model, proxy_ref, and config (jsonb round-trip)', async () => {
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
    const config = {
      submitPath: '/api/v1/tasks',
      pollPath: '/api/v1/tasks/{id}',
      signatureHeader: 'X-Relay-Signature',
      timestampHeader: 'X-Relay-Timestamp',
    };
    await createUpstreamChannel(db, {
      resourceId: 'deepseek-chat',
      providerType: 'openai',
      endpoint: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      proxyRef: 'upstream_proxy',
      config,
      weight: 1,
      status: 'active',
    });
    const [row] = await listChannels(db, 'deepseek-chat');
    expect(row?.endpoint).toBe('https://api.deepseek.com/v1');
    expect(row?.model).toBe('deepseek-chat');
    expect(row?.proxyRef).toBe('upstream_proxy');
    expect(row?.config).toEqual(config);
  });

  it('defaults the new columns to null when omitted', async () => {
    const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
    if (!t) throw new Error('no tenant');
    await createResource(db, {
      id: 'bare-model',
      tenantId: t.id,
      kind: 'model',
      modality: 'text',
      providerType: 'openai',
      execModes: ['blocking'],
      ioSchema: { inputs: [], outputs: [] },
      version: 1,
    });
    await createUpstreamChannel(db, {
      resourceId: 'bare-model',
      providerType: 'openai',
    });
    const [row] = await listChannels(db, 'bare-model');
    expect(row?.endpoint).toBeNull();
    expect(row?.model).toBeNull();
    expect(row?.proxyRef).toBeNull();
    expect(row?.config).toBeNull();
  });
});

describe('upstream_channel tags (route tagging 染色)', () => {
  async function seedResource(id: string): Promise<void> {
    const [t] = await db
      .insert(tenant)
      .values({ name: `t-${id}` })
      .returning();
    if (!t) throw new Error('no tenant');
    await createResource(db, {
      id,
      tenantId: t.id,
      kind: 'model',
      modality: 'text',
      providerType: 'openai',
      execModes: ['blocking'],
      ioSchema: { inputs: [], outputs: [] },
      version: 1,
    });
  }

  it('create accepts tags and listChannels returns them; defaults to []', async () => {
    await seedResource('tagged-model');
    await createUpstreamChannel(db, {
      resourceId: 'tagged-model',
      providerType: 'openai',
      tags: ['canary', 'beta'],
    });
    await createUpstreamChannel(db, {
      resourceId: 'tagged-model',
      providerType: 'openai',
    });
    const rows = await listChannels(db, 'tagged-model');
    const tagged = rows.find((r) => r.tags.length > 0);
    const bare = rows.find((r) => r.tags.length === 0);
    expect(tagged?.tags).toEqual(['canary', 'beta']);
    expect(bare?.tags).toEqual([]);
  });

  it('update accepts tags and persists them (and can clear to [])', async () => {
    await seedResource('upd-model');
    const created = await createUpstreamChannel(db, {
      resourceId: 'upd-model',
      providerType: 'openai',
      tags: ['canary'],
    });
    const updated = await updateUpstreamChannel(db, created.id, { tags: ['stable', 'eu'] });
    expect(updated?.tags).toEqual(['stable', 'eu']);
    const cleared = await updateUpstreamChannel(db, created.id, { tags: [] });
    expect(cleared?.tags).toEqual([]);
  });

  it('group candidate queries carry the channel tags through the join', async () => {
    await seedResource('grp-model');
    const group = await createRouteGroup(db, { name: 'g-tags' });
    const ch = await createUpstreamChannel(db, {
      resourceId: 'grp-model',
      providerType: 'openai',
      tags: ['canary'],
    });
    await addChannelToGroup(db, { groupId: group.id, channelId: ch.id, priority: 1, weight: 1 });

    const grouped = await listGroupChannelsForResource(db, 'grp-model', group.id);
    expect(grouped[0]?.tags).toEqual(['canary']);

    const withFallback = await listCandidateChannelsWithFallback(db, 'grp-model', group.id);
    expect(withFallback[0]?.tags).toEqual(['canary']);
  });
});
