import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  addChannelToGroup,
  createApiKey,
  createResource,
  createRouteGroup,
  createTenant,
  createUpstreamChannel,
  getApiKeyForTenant,
  getRouteGroupById,
  getRouteGroupByName,
  listApiKeys,
  listCandidateChannelsWithFallback,
  listGroupChannels,
  listGroupChannelsForResource,
  listRouteGroups,
  removeChannelFromGroup,
  setApiKeyGroup,
  softDeleteChannel,
  softDeleteRouteGroup,
  updateRouteGroup,
  type UpstreamChannelRow,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

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
  await client`TRUNCATE TABLE route_group_channel, route_group, api_key, upstream_channel, resource_version, resource, secret_ref, tenant RESTART IDENTITY CASCADE`;
});

/** Create a tenant + a chat resource and return ids (resource for channel FKs). */
async function seedResource(idSuffix: string): Promise<{ tenantId: string; resourceId: string }> {
  const tenant = await createTenant(db, { name: `t-${idSuffix}` });
  const resourceId = `res-${idSuffix}`;
  await createResource(db, {
    id: resourceId,
    tenantId: tenant.id,
    kind: 'model',
    modality: 'text',
    providerType: 'openai',
    execModes: ['blocking'],
    ioSchema: { inputs: [], outputs: [] },
    version: 1,
  });
  return { tenantId: tenant.id, resourceId };
}

/** Create an upstream channel on a resource. */
function mkChannel(resourceId: string, status = 'active'): Promise<UpstreamChannelRow> {
  return createUpstreamChannel(db, { resourceId, providerType: 'openai', status });
}

describe('route_group CRUD', () => {
  it('creates with bps default 10000, fetches by id + name, lists newest-first', async () => {
    const a = await createRouteGroup(db, { name: 'default' });
    expect(a.groupRatioBps).toBe(10000);
    expect(a.status).toBe('active');

    const b = await createRouteGroup(db, {
      name: 'premium',
      groupRatioBps: 12000,
      description: 'higher tier',
    });
    expect(b.groupRatioBps).toBe(12000);

    expect((await getRouteGroupById(db, a.id))?.name).toBe('default');
    expect((await getRouteGroupByName(db, 'premium'))?.id).toBe(b.id);
    expect(await getRouteGroupByName(db, 'nope')).toBeUndefined();

    const { rows } = await listRouteGroups(db, { limit: 50 });
    expect(rows.map((r) => r.id)).toEqual([b.id, a.id]); // newest-first
  });

  it('updates name/ratio/status/description and bumps updated_at', async () => {
    const row = await createRouteGroup(db, { name: 'g1' });
    const updated = await updateRouteGroup(db, row.id, {
      name: 'g1-renamed',
      groupRatioBps: 9000,
      status: 'disabled',
      description: 'x',
    });
    expect(updated?.name).toBe('g1-renamed');
    expect(updated?.groupRatioBps).toBe(9000);
    expect(updated?.status).toBe('disabled');
    expect(updated?.description).toBe('x');
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(row.updatedAt.getTime());
  });

  // 模型参数绑定 Phase 2 (mig 0065): require_params column round-trips + defaults false.
  it('require_params defaults false on create and round-trips through create + update', async () => {
    const def = await createRouteGroup(db, { name: 'rp-default' });
    expect(def.requireParams).toBe(false); // default OFF (regression invariant)

    const on = await createRouteGroup(db, { name: 'rp-on', requireParams: true });
    expect(on.requireParams).toBe(true);

    const toggledOff = await updateRouteGroup(db, on.id, { requireParams: false });
    expect(toggledOff?.requireParams).toBe(false);

    const toggledOn = await updateRouteGroup(db, def.id, { requireParams: true });
    expect(toggledOn?.requireParams).toBe(true);
    // An unrelated patch leaves require_params untouched.
    const patchedElsewhere = await updateRouteGroup(db, def.id, { description: 'x' });
    expect(patchedElsewhere?.requireParams).toBe(true);
  });

  it('soft-deletes (drops from get/list) and frees the name for re-create (partial unique)', async () => {
    const row = await createRouteGroup(db, { name: 'dup' });
    const deletedId = await softDeleteRouteGroup(db, row.id);
    expect(deletedId).toBe(row.id);

    expect(await getRouteGroupById(db, row.id)).toBeUndefined();
    expect(await getRouteGroupByName(db, 'dup')).toBeUndefined();
    expect((await listRouteGroups(db, { limit: 50 })).rows).toHaveLength(0);

    // PARTIAL unique frees the name → a re-create yields a NEW live row.
    const recreated = await createRouteGroup(db, { name: 'dup' });
    expect(recreated.id).not.toBe(row.id);
    expect((await getRouteGroupByName(db, 'dup'))?.id).toBe(recreated.id);
  });

  it('rejects a duplicate live name (partial unique) with a 23505', async () => {
    await createRouteGroup(db, { name: 'unique-name' });
    // Drizzle wraps the postgres error; the SQLSTATE `23505` lives on `.cause`
    // (the same shape `isUniqueViolation` walks at the admin boundary → 400).
    const err = await createRouteGroup(db, { name: 'unique-name' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeDefined();
    expect((err as { cause?: { code?: string } }).cause?.code).toBe('23505');
  });
});

describe('route_group_channel membership', () => {
  it('adds, lists with priority/weight, upserts on conflict, and removes', async () => {
    const { resourceId } = await seedResource('m1');
    const group = await createRouteGroup(db, { name: 'g' });
    const c1 = await mkChannel(resourceId);
    const c2 = await mkChannel(resourceId);

    await addChannelToGroup(db, { groupId: group.id, channelId: c1.id, priority: 10, weight: 3 });
    await addChannelToGroup(db, { groupId: group.id, channelId: c2.id }); // defaults 0/1

    const { rows } = await listGroupChannels(db, group.id, { limit: 50 });
    const byChannel = new Map(rows.map((r) => [r.channelId, r]));
    expect(byChannel.get(c1.id)?.priority).toBe(10);
    expect(byChannel.get(c1.id)?.weight).toBe(3);
    expect(byChannel.get(c2.id)?.priority).toBe(0);
    expect(byChannel.get(c2.id)?.weight).toBe(1);

    // Upsert on PK conflict → updates priority/weight (no duplicate row).
    await addChannelToGroup(db, { groupId: group.id, channelId: c1.id, priority: 20, weight: 5 });
    const after = await listGroupChannels(db, group.id, { limit: 50 });
    expect(after.rows).toHaveLength(2);
    expect(after.rows.find((r) => r.channelId === c1.id)?.priority).toBe(20);
    expect(after.rows.find((r) => r.channelId === c1.id)?.weight).toBe(5);

    // Remove the membership row (no soft-delete; the row is gone).
    const removed = await removeChannelFromGroup(db, group.id, c1.id);
    expect(removed).toBe(true);
    expect((await listGroupChannels(db, group.id, { limit: 50 })).rows).toHaveLength(1);
    // A second remove is a no-op (false).
    expect(await removeChannelFromGroup(db, group.id, c1.id)).toBe(false);
  });
});

describe('listGroupChannelsForResource (Track 4 consumer shape)', () => {
  it('returns only the resource’s channels in the group, priority DESC, weight DESC', async () => {
    const { resourceId: resA } = await seedResource('a');
    const { resourceId: resB } = await seedResource('b');
    const group = await createRouteGroup(db, { name: 'g' });

    // resA channels: a1 (pri 5, w 2), a2 (pri 5, w 9 → sorts before a1), a3 (pri 10).
    const a1 = await mkChannel(resA);
    const a2 = await mkChannel(resA);
    const a3 = await mkChannel(resA);
    // resB channel b1 is in the group too — must be EXCLUDED (wrong resource).
    const b1 = await mkChannel(resB);

    await addChannelToGroup(db, { groupId: group.id, channelId: a1.id, priority: 5, weight: 2 });
    await addChannelToGroup(db, { groupId: group.id, channelId: a2.id, priority: 5, weight: 9 });
    await addChannelToGroup(db, { groupId: group.id, channelId: a3.id, priority: 10, weight: 1 });
    await addChannelToGroup(db, { groupId: group.id, channelId: b1.id, priority: 99, weight: 1 });

    const rows = await listGroupChannelsForResource(db, resA, group.id);
    expect(rows.map((r) => r.id)).toEqual([a3.id, a2.id, a1.id]); // pri DESC, then weight DESC
    // each row carries the per-(group,channel) priority + weight + channel fields.
    expect(rows[0]?.priority).toBe(10);
    expect(rows[1]?.weight).toBe(9);
    expect(rows[0]?.resourceId).toBe(resA);
    expect(rows.some((r) => r.id === b1.id)).toBe(false);
  });

  it('excludes soft-deleted channels and disabled/soft-deleted groups', async () => {
    const { resourceId } = await seedResource('s');
    const group = await createRouteGroup(db, { name: 'live' });
    const live = await mkChannel(resourceId);
    const dead = await mkChannel(resourceId);
    const disabled = await mkChannel(resourceId, 'disabled');

    await addChannelToGroup(db, { groupId: group.id, channelId: live.id, priority: 1, weight: 1 });
    await addChannelToGroup(db, { groupId: group.id, channelId: dead.id, priority: 2, weight: 1 });
    await addChannelToGroup(db, {
      groupId: group.id,
      channelId: disabled.id,
      priority: 3,
      weight: 1,
    });

    await softDeleteChannel(db, dead.id);

    const rows = await listGroupChannelsForResource(db, resourceId, group.id);
    // soft-deleted + disabled channels are excluded → only the active live one.
    expect(rows.map((r) => r.id)).toEqual([live.id]);

    // A soft-deleted group yields no candidates.
    await softDeleteRouteGroup(db, group.id);
    expect(await listGroupChannelsForResource(db, resourceId, group.id)).toHaveLength(0);

    // Re-create the group + re-add the live channel; disable the group → no candidates.
    const g2 = await createRouteGroup(db, { name: 'disabled-group', status: 'disabled' });
    await addChannelToGroup(db, { groupId: g2.id, channelId: live.id, priority: 1, weight: 1 });
    expect(await listGroupChannelsForResource(db, resourceId, g2.id)).toHaveLength(0);
  });
});

describe('listCandidateChannelsWithFallback (cross-group failover, 弹性2.0)', () => {
  it('appends the fallback group’s channels at a strictly lower tier', async () => {
    const { resourceId } = await seedResource('fb1');
    // Group A (a1 pri 5, a2 pri 10) → fallback group B (b1 pri 99).
    const a1 = await mkChannel(resourceId);
    const a2 = await mkChannel(resourceId);
    const b1 = await mkChannel(resourceId);
    const groupB = await createRouteGroup(db, { name: 'fb-b' });
    const groupA = await createRouteGroup(db, { name: 'fb-a', fallbackGroupId: groupB.id });
    await addChannelToGroup(db, { groupId: groupA.id, channelId: a1.id, priority: 5, weight: 1 });
    await addChannelToGroup(db, { groupId: groupA.id, channelId: a2.id, priority: 10, weight: 1 });
    await addChannelToGroup(db, { groupId: groupB.id, channelId: b1.id, priority: 99, weight: 1 });

    const rows = await listCandidateChannelsWithFallback(db, resourceId, groupA.id);
    // A's own channels keep their (group,channel) priority; B's are demoted below.
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(a1.id)?.priority).toBe(5);
    expect(byId.get(a2.id)?.priority).toBe(10);
    // b1 (own priority 99) is demoted by one hop's offset → strictly below A's lowest.
    const b1Pri = byId.get(b1.id)?.priority ?? 0;
    expect(b1Pri).toBeLessThan(5);
    expect(b1Pri).toBeLessThan(byId.get(a1.id)?.priority ?? 0);
    expect(rows).toHaveLength(3);
  });

  it('stops at a cycle (A→B→A) — each group’s channels appear once', async () => {
    const { resourceId } = await seedResource('fb2');
    const a1 = await mkChannel(resourceId);
    const b1 = await mkChannel(resourceId);
    const groupA = await createRouteGroup(db, { name: 'cyc-a' });
    const groupB = await createRouteGroup(db, { name: 'cyc-b', fallbackGroupId: groupA.id });
    await updateRouteGroup(db, groupA.id, { fallbackGroupId: groupB.id }); // A→B, B→A
    await addChannelToGroup(db, { groupId: groupA.id, channelId: a1.id, priority: 1, weight: 1 });
    await addChannelToGroup(db, { groupId: groupB.id, channelId: b1.id, priority: 1, weight: 1 });

    const rows = await listCandidateChannelsWithFallback(db, resourceId, groupA.id);
    const ids = rows.map((r) => r.id);
    // Cycle guard: A and B each contribute exactly once, no infinite loop.
    expect(ids.filter((id) => id === a1.id)).toHaveLength(1);
    expect(ids.filter((id) => id === b1.id)).toHaveLength(1);
    expect(rows).toHaveLength(2);
  });

  it('truncates a chain longer than the depth cap (5 hops)', async () => {
    const { resourceId } = await seedResource('fb3');
    // Build a linear chain g0 → g1 → ... → g6 (7 groups), one channel each.
    const groups: string[] = [];
    const channels: string[] = [];
    let nextFallback: string | null = null;
    for (let i = 6; i >= 0; i--) {
      const g = await createRouteGroup(db, {
        name: `depth-${String(i)}`,
        ...(nextFallback !== null ? { fallbackGroupId: nextFallback } : {}),
      });
      const ch = await mkChannel(resourceId);
      await addChannelToGroup(db, { groupId: g.id, channelId: ch.id, priority: 1, weight: 1 });
      groups[i] = g.id;
      channels[i] = ch.id;
      nextFallback = g.id;
    }

    const startGroupId = groups[0];
    if (startGroupId === undefined) throw new Error('no start group');
    const rows = await listCandidateChannelsWithFallback(db, resourceId, startGroupId);
    // Depth cap = 5 hops → at most 5 groups' channels (g0..g4), never the full 7.
    expect(rows.length).toBeLessThanOrEqual(5);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // The starting group's channel is always present.
    expect(rows.some((r) => r.id === channels[0])).toBe(true);
    // The deepest groups beyond the cap are truncated.
    expect(rows.some((r) => r.id === channels[6])).toBe(false);
  });

  it('returns just the group’s own channels when there is no fallback', async () => {
    const { resourceId } = await seedResource('fb4');
    const a1 = await mkChannel(resourceId);
    const group = await createRouteGroup(db, { name: 'no-fb' });
    await addChannelToGroup(db, { groupId: group.id, channelId: a1.id, priority: 3, weight: 1 });

    const rows = await listCandidateChannelsWithFallback(db, resourceId, group.id);
    expect(rows.map((r) => r.id)).toEqual([a1.id]);
    expect(rows[0]?.priority).toBe(3); // own tier unchanged at hop 0
  });
});

describe('setApiKeyGroup + api_key view surfacing', () => {
  it('binds + rebinds + unbinds a key’s route_group_id, surfaced via list/get', async () => {
    const tenant = await createTenant(db, { name: 't' });
    const group = await createRouteGroup(db, { name: 'bind-me' });
    const key = await createApiKey(db, { tenantId: tenant.id });

    // bind
    expect(await setApiKeyGroup(db, key.id, group.id)).toBe(true);
    const got = await getApiKeyForTenant(db, key.id, tenant.id);
    expect(got?.routeGroupId).toBe(group.id);
    const { rows } = await listApiKeys(db, tenant.id, { limit: 50 });
    expect(rows.find((r) => r.id === key.id)?.routeGroupId).toBe(group.id);

    // unbind (null → default group at routing time)
    expect(await setApiKeyGroup(db, key.id, null)).toBe(true);
    expect((await getApiKeyForTenant(db, key.id, tenant.id))?.routeGroupId).toBeNull();

    // unknown key → false (no row updated)
    expect(await setApiKeyGroup(db, '00000000-0000-0000-0000-000000000000', group.id)).toBe(false);
  });
});
