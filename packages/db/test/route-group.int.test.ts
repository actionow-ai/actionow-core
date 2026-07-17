import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  addChannelToGroup,
  createApiKey,
  createRouteGroup,
  createTenant,
  getApiKeyForTenant,
  getRouteGroupById,
  getRouteGroupByName,
  listApiKeys,
  listGroupChannels,
  listRouteGroups,
  removeChannelFromGroup,
  setApiKeyGroup,
  softDeleteRouteGroup,
  updateRouteGroup,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

// 批次6 D3 (旧世界删除): the Track-4 router consumers over the deleted
// `upstream_channel` table (`listGroupChannelsForResource` /
// `listCandidateChannelsWithFallback`, and the resource/channel fixtures)
// died with the resource three-layer. Route groups survive as the
// pricing/access tier entity; the membership CRUD below still backs the
// retained `/admin/route-groups/:id/channels` face.

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
  await client`TRUNCATE TABLE route_group_channel, route_group, api_key, tenant RESTART IDENTITY CASCADE`;
});

/**
 * 批次6 D4: `route_group_channel.channel_id` is a plain uuid — mig 0072
 * dropped both the old `resource`/`upstream_channel` tables and the FK — so a
 * fresh random uuid stands in for a channel id with no backing row.
 */
function seedChannelRaw(): string {
  return randomUUID();
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
    const group = await createRouteGroup(db, { name: 'g' });
    const c1 = seedChannelRaw();
    const c2 = seedChannelRaw();

    await addChannelToGroup(db, { groupId: group.id, channelId: c1, priority: 10, weight: 3 });
    await addChannelToGroup(db, { groupId: group.id, channelId: c2 }); // defaults 0/1

    const { rows } = await listGroupChannels(db, group.id, { limit: 50 });
    const byChannel = new Map(rows.map((r) => [r.channelId, r]));
    expect(byChannel.get(c1)?.priority).toBe(10);
    expect(byChannel.get(c1)?.weight).toBe(3);
    expect(byChannel.get(c2)?.priority).toBe(0);
    expect(byChannel.get(c2)?.weight).toBe(1);

    // Upsert on PK conflict → updates priority/weight (no duplicate row).
    await addChannelToGroup(db, { groupId: group.id, channelId: c1, priority: 20, weight: 5 });
    const after = await listGroupChannels(db, group.id, { limit: 50 });
    expect(after.rows).toHaveLength(2);
    expect(after.rows.find((r) => r.channelId === c1)?.priority).toBe(20);
    expect(after.rows.find((r) => r.channelId === c1)?.weight).toBe(5);

    // Remove the membership row (no soft-delete; the row is gone).
    const removed = await removeChannelFromGroup(db, group.id, c1);
    expect(removed).toBe(true);
    expect((await listGroupChannels(db, group.id, { limit: 50 })).rows).toHaveLength(1);
    // A second remove is a no-op (false).
    expect(await removeChannelFromGroup(db, group.id, c1)).toBe(false);
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
