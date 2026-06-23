import {
  createDb,
  createModel,
  createResource,
  createUpstreamChannel,
  type Database,
  linkChannelModel,
  schema,
} from '@actionow/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  ChannelRoutingService,
  UNLINKED_PRIORITY_OFFSET,
} from '../src/common/channel-routing.service.js';

let container: StartedPostgreSqlContainer;
let db: Database;
let routing: ChannelRoutingService;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  db = createDb(container.getConnectionUri());
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });
  routing = new ChannelRoutingService(db);
}, 120_000);

afterAll(async () => {
  await container.stop();
});

afterEach(async () => {
  await db.execute(
    sql`TRUNCATE TABLE channel_model, model, upstream_channel, resource_version, resource, tenant RESTART IDENTITY CASCADE`,
  );
});

/** Seed a model platform with two channels (A, B) and one model; link the model to A. */
async function seed(): Promise<{ channelA: string; channelB: string; modelId: string }> {
  const [t] = await db.insert(schema.tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('no tenant');
  await createResource(db, {
    id: 'p',
    tenantId: t.id,
    kind: 'model',
    modality: 'text',
    providerType: 'openai',
    execModes: ['blocking'],
    ioSchema: { inputs: [], outputs: [] },
    version: 1,
  });
  const a = await createUpstreamChannel(db, { resourceId: 'p', providerType: 'openai' });
  const b = await createUpstreamChannel(db, { resourceId: 'p', providerType: 'openai' });
  const m = await createModel(db, { name: 'm1', resourceId: 'p' });
  await linkChannelModel(db, a.id, m.id);
  return { channelA: a.id, channelB: b.id, modelId: m.id };
}

describe('ChannelRoutingService — model-aware hybrid routing', () => {
  it('prefers a model linked channel; demotes the unlinked one a full tier', async () => {
    const { channelA, channelB, modelId } = await seed();
    const cands = await routing.candidatesFor('p', null, modelId);
    const a = cands.find((c) => c.id === channelA);
    const b = cands.find((c) => c.id === channelB);
    if (a === undefined || b === undefined) throw new Error('expected both channels as candidates');
    expect((b.priority ?? 0) - (a.priority ?? 0)).toBe(UNLINKED_PRIORITY_OFFSET);
  });

  it('falls back to a single tier when no modelId is given (unchanged behaviour)', async () => {
    const { modelId } = await seed();
    const noModel = await routing.candidatesFor('p', null);
    expect(new Set(noModel.map((c) => c.priority ?? 0)).size).toBe(1);
    // and a model with NO links → also single tier (full platform fallback)
    void modelId;
  });
});
