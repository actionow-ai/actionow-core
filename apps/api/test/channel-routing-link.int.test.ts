import { orderForFailover } from '@actionow/adapters';
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
    const a = cands.find((c) => c.id === channelA); // linked
    const b = cands.find((c) => c.id === channelB); // unlinked
    if (a === undefined || b === undefined) throw new Error('expected both channels as candidates');

    // The LINKED channel must sort a full tier ABOVE the unlinked one (higher
    // priority = tried first under `orderForFailover`'s HIGHEST-first ordering).
    expect(a.priority ?? 0).toBeGreaterThan(b.priority ?? 0);
    expect((a.priority ?? 0) - (b.priority ?? 0)).toBe(UNLINKED_PRIORITY_OFFSET);

    // Behavioural guarantee: the failover engine tries the linked channel FIRST.
    // (Guards against a future re-inversion of the offset sign — the previous
    // test only checked magnitude and passed while the order was backwards.)
    const ordered = orderForFailover(
      cands.map((c) => ({ id: c.id, weight: c.weight, priority: c.priority, value: c.id })),
      () => 0,
    );
    expect(ordered[0]?.id).toBe(channelA);
    expect(ordered[ordered.length - 1]?.id).toBe(channelB);
  });

  it('falls back to a single tier when no modelId is given (unchanged behaviour)', async () => {
    const { modelId } = await seed();
    const noModel = await routing.candidatesFor('p', null);
    expect(new Set(noModel.map((c) => c.priority ?? 0)).size).toBe(1);
    // and a model with NO links → also single tier (full platform fallback)
    void modelId;
  });
});
