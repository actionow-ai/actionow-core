import {
  addChannelToGroup,
  createDb,
  createResource,
  createRouteGroup,
  createUpstreamChannel,
  type Database,
  schema,
} from '@actionow/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ChannelRoutingService } from '../src/common/channel-routing.service.js';

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
    sql`TRUNCATE TABLE route_group_channel, route_group, channel_model, model, upstream_channel, resource_version, resource, tenant RESTART IDENTITY CASCADE`,
  );
});

/** Seed a model platform with two channels: A tagged `canary`, B untagged. */
async function seed(): Promise<{ canary: string; plain: string }> {
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
  const a = await createUpstreamChannel(db, {
    resourceId: 'p',
    providerType: 'openai',
    tags: ['canary'],
  });
  const b = await createUpstreamChannel(db, { resourceId: 'p', providerType: 'openai' });
  return { canary: a.id, plain: b.id };
}

describe('ChannelRoutingService — route-tag intersect (染色)', () => {
  it('no routeTag → the full candidate set, unchanged', async () => {
    const { canary, plain } = await seed();
    const cands = await routing.candidatesFor('p', null);
    expect(new Set(cands.map((c) => c.id))).toEqual(new Set([canary, plain]));
  });

  it('routeTag narrows to only the channels carrying the tag (ungrouped branch)', async () => {
    const { canary, plain } = await seed();
    const cands = await routing.candidatesFor('p', null, undefined, 'canary');
    expect(cands.map((c) => c.id)).toEqual([canary]);
    expect(cands.some((c) => c.id === plain)).toBe(false);
  });

  it('blank / whitespace-only routeTag is a no-op (header-less semantics)', async () => {
    const { canary, plain } = await seed();
    const cands = await routing.candidatesFor('p', null, undefined, '   ');
    expect(new Set(cands.map((c) => c.id))).toEqual(new Set([canary, plain]));
  });

  it('a tag matching no available channel throws an invalid_input (400) error', async () => {
    await seed();
    await expect(routing.candidatesFor('p', null, undefined, 'nope')).rejects.toMatchObject({
      unified: { code: 'invalid_input' },
    });
  });

  it('narrows within the GROUPED branch and never widens to non-tagged channels', async () => {
    const { canary, plain } = await seed();
    const g = await createRouteGroup(db, { name: 'g' });
    await addChannelToGroup(db, { groupId: g.id, channelId: canary });
    await addChannelToGroup(db, { groupId: g.id, channelId: plain });

    // Sanity: ungated grouped resolution returns both members.
    const all = await routing.candidatesFor('p', g.id);
    expect(new Set(all.map((c) => c.id))).toEqual(new Set([canary, plain]));

    // Tagged → only the canary member.
    const tagged = await routing.candidatesFor('p', g.id, undefined, 'canary');
    expect(tagged.map((c) => c.id)).toEqual([canary]);

    // A grouped tag-miss must HARD-fail (NOT fall through to the widening
    // ungrouped branch, which would leak to non-member / non-tagged channels).
    await expect(routing.candidatesFor('p', g.id, undefined, 'nope')).rejects.toMatchObject({
      unified: { code: 'invalid_input' },
    });
  });
});
