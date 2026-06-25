import { createUser, schema } from '@actionow/db';
import { hashPassword } from '@actionow/infra';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DB, ENV } from '../src/common/tokens.js';

/**
 * E2E for the route-group (分组; Track 3) admin CRUD: group CRUD (create→get→patch
 * ratio→delete→404), channel membership (PUT add/upsert→list shows
 * priority/weight→DELETE remove), and the api-key group binding (POST
 * routeGroupId + PATCH /group routeGroupId → reflected; bind to a nonexistent
 * group → 404). This track is ADDITIVE — no routing/pricing behavior changes.
 */

const ADMIN_SECRET = 'op-admin-secret';
const ADMIN_EMAIL = 'admin-rg@actionow.local';
const ADMIN_PASSWORD = 'hunter2';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;
let app: INestApplication;
let token: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(ENV)
    .useValue({
      NODE_ENV: 'production',
      CREDIT_RATE: 1000,
      DATABASE_URL: container.getConnectionUri(),
      REDIS_URL: 'redis://localhost:6379',
      API_PORT: 3000,
      LOG_LEVEL: 'info',
      RATE_LIMIT_TENANT_PER_MIN: 600,
      RATE_LIMIT_RESOURCE_PER_MIN: 120,
      ADMIN_JWT_SECRET: ADMIN_SECRET,
    })
    .compile();

  app = moduleRef.createNestApplication();
  await app.init();
}, 180_000);

afterAll(async () => {
  await app.close();
  await client.end();
  await container.stop();
});

beforeEach(async () => {
  await createUser(db, {
    email: ADMIN_EMAIL,
    passwordHash: hashPassword(ADMIN_PASSWORD),
    role: 'admin',
    emailVerified: true,
  });
  const login = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    .expect(200);
  token = login.body.token as string;
});

afterEach(async () => {
  await client`TRUNCATE TABLE request_idempotency, route_group_channel, route_group, api_key, upstream_channel, resource_version, resource, tenant, "user" RESTART IDENTITY CASCADE`;
});

function auth(req: request.Test): request.Test {
  return req.set('authorization', `Bearer ${token}`);
}

const server = (): ReturnType<typeof app.getHttpServer> => app.getHttpServer();

/** Create a tenant via the admin API; returns its id. */
async function makeTenant(): Promise<string> {
  const res = await auth(request(server()).post('/admin/tenants'))
    .send({ name: `t-${Math.random().toString(36).slice(2)}` })
    .expect(201);
  return res.body.id as string;
}

/** Create a chat resource + one channel; returns the channel id. */
async function makeChannel(tenantId: string): Promise<{ resourceId: string; channelId: string }> {
  const resourceId = `res-${Math.random().toString(36).slice(2)}`;
  await auth(request(server()).post('/admin/resources'))
    .send({
      id: resourceId,
      tenantId,
      kind: 'model',
      modality: 'text',
      providerType: 'openai',
      execModes: ['blocking'],
      ioSchema: { inputs: [], outputs: [] },
    })
    .expect(201);
  const ch = await auth(request(server()).post(`/admin/resources/${resourceId}/channels`))
    .send({ providerType: 'openai' })
    .expect(201);
  return { resourceId, channelId: ch.body.id as string };
}

describe('admin route-groups CRUD', () => {
  it('rejects unauthenticated requests with 401', async () => {
    await request(server()).post('/admin/route-groups').send({ name: 'x' }).expect(401);
  });

  it('creates (bps default 10000), gets, lists (envelope), patches ratio, deletes → 404', async () => {
    const created = await auth(request(server()).post('/admin/route-groups'))
      .send({ name: 'premium', description: 'top tier' })
      .expect(201);
    expect(created.body.group_ratio_bps).toBe(10000); // default
    expect(created.body.status).toBe('active');
    const id = created.body.id as string;

    const got = await auth(request(server()).get(`/admin/route-groups/${id}`)).expect(200);
    expect(got.body.name).toBe('premium');
    expect(got.body.description).toBe('top tier');

    // LIST — paginated Track-B envelope.
    const listed = await auth(request(server()).get('/admin/route-groups')).expect(200);
    expect(listed.body).toHaveProperty('data');
    expect(listed.body).toHaveProperty('next_cursor');
    expect(listed.body).toHaveProperty('has_more');
    expect((listed.body.data as { name: string }[]).map((r) => r.name)).toEqual(['premium']);

    // PATCH the ratio (basis points).
    const patched = await auth(request(server()).patch(`/admin/route-groups/${id}`))
      .send({ groupRatioBps: 12500, status: 'disabled' })
      .expect(200);
    expect(patched.body.group_ratio_bps).toBe(12500);
    expect(patched.body.status).toBe('disabled');

    // DELETE (soft) → 204, then GET → 404.
    await auth(request(server()).delete(`/admin/route-groups/${id}`)).expect(204);
    await auth(request(server()).get(`/admin/route-groups/${id}`)).expect(404);
  });

  it('maps a duplicate live name to a clean 400, and a missing id to 404', async () => {
    await auth(request(server()).post('/admin/route-groups')).send({ name: 'dup' }).expect(201);
    // Same name again → 400 (not 500).
    await auth(request(server()).post('/admin/route-groups')).send({ name: 'dup' }).expect(400);
    // Unknown id → 404.
    await auth(request(server()).get(`/admin/route-groups/${NIL_UUID}`)).expect(404);
  });
});

describe('admin route-group channel membership', () => {
  it('adds a channel (priority/weight), lists it, then removes it', async () => {
    const tenantId = await makeTenant();
    const { channelId } = await makeChannel(tenantId);
    const group = await auth(request(server()).post('/admin/route-groups'))
      .send({ name: 'g' })
      .expect(201);
    const groupId = group.body.id as string;

    // Add the channel with explicit priority/weight (PUT to the membership URL).
    const added = await auth(
      request(server()).put(`/admin/route-groups/${groupId}/channels/${channelId}`),
    )
      .send({ priority: 7, weight: 4 })
      .expect(200);
    expect(added.body.channel_id).toBe(channelId);
    expect(added.body.priority).toBe(7);
    expect(added.body.weight).toBe(4);

    // PUT again with new knobs → upserts (idempotent on the membership URL).
    const reput = await auth(
      request(server()).put(`/admin/route-groups/${groupId}/channels/${channelId}`),
    )
      .send({ priority: 9, weight: 6 })
      .expect(200);
    expect(reput.body.priority).toBe(9);
    expect(reput.body.weight).toBe(6);

    // List shows the membership with its priority/weight (paginated envelope).
    const listed = await auth(
      request(server()).get(`/admin/route-groups/${groupId}/channels`),
    ).expect(200);
    expect(listed.body).toHaveProperty('data');
    const rows = listed.body.data as { channel_id: string; priority: number; weight: number }[];
    expect(rows).toHaveLength(1); // upsert did not create a duplicate row
    expect(rows[0]?.channel_id).toBe(channelId);
    expect(rows[0]?.priority).toBe(9);
    expect(rows[0]?.weight).toBe(6);

    // Remove → 204; list is then empty.
    await auth(
      request(server()).delete(`/admin/route-groups/${groupId}/channels/${channelId}`),
    ).expect(204);
    const after = await auth(
      request(server()).get(`/admin/route-groups/${groupId}/channels`),
    ).expect(200);
    expect((after.body.data as unknown[]).length).toBe(0);
  });

  it('404s adding a channel to an unknown group, or an unknown channel to a group', async () => {
    const tenantId = await makeTenant();
    const { channelId } = await makeChannel(tenantId);
    const group = await auth(request(server()).post('/admin/route-groups'))
      .send({ name: 'g2' })
      .expect(201);
    const groupId = group.body.id as string;

    // unknown group → 404
    await auth(request(server()).put(`/admin/route-groups/${NIL_UUID}/channels/${channelId}`))
      .send({})
      .expect(404);
    // unknown channel → 404
    await auth(request(server()).put(`/admin/route-groups/${groupId}/channels/${NIL_UUID}`))
      .send({})
      .expect(404);
    // removing a non-member channel from a known group → 404
    await auth(
      request(server()).delete(`/admin/route-groups/${groupId}/channels/${channelId}`),
    ).expect(404);
  });
});

describe('admin route-group fallback cycle guard (resilience v2)', () => {
  /** Create a live route group; returns its id. */
  async function makeGroup(name: string): Promise<string> {
    const res = await auth(request(server()).post('/admin/route-groups'))
      .send({ name })
      .expect(201);
    return res.body.id as string;
  }

  it('accepts a valid fallback target and reflects it on the view', async () => {
    const b = await makeGroup('fb-b');
    const created = await auth(request(server()).post('/admin/route-groups'))
      .send({ name: 'fb-a', fallbackGroupId: b })
      .expect(201);
    expect(created.body.fallback_group_id).toBe(b);
    const aId = created.body.id as string;

    const got = await auth(request(server()).get(`/admin/route-groups/${aId}`)).expect(200);
    expect(got.body.fallback_group_id).toBe(b);

    // null clears it back out (PATCH)
    const cleared = await auth(request(server()).patch(`/admin/route-groups/${aId}`))
      .send({ fallbackGroupId: null })
      .expect(200);
    expect(cleared.body.fallback_group_id).toBeNull();
  });

  it('rejects a self-fallback (A→A) on create with 400', async () => {
    // No row exists yet to point at itself on create, so a self-cycle is only
    // reachable via PATCH; create with an unknown target is a clean 400 too.
    const a = await makeGroup('self-a');
    await auth(request(server()).patch(`/admin/route-groups/${a}`))
      .send({ fallbackGroupId: a })
      .expect(400);
  });

  it('rejects a 2-cycle (A→B, then B→A) with 400', async () => {
    const a = await makeGroup('cyc-a');
    const b = await makeGroup('cyc-b');
    // A → B is fine.
    await auth(request(server()).patch(`/admin/route-groups/${a}`))
      .send({ fallbackGroupId: b })
      .expect(200);
    // B → A would close the loop → 400.
    await auth(request(server()).patch(`/admin/route-groups/${b}`))
      .send({ fallbackGroupId: a })
      .expect(400);
  });

  it('rejects a chain that would exceed the max fallback depth with 400', async () => {
    // Build a straight chain g4→g3→g2→g1 (4 groups), link a head g5→g4 (5 groups,
    // exactly the cap → ok), then g6→g5 would be 6 groups > FALLBACK_MAX_DEPTH (5).
    const g1 = await makeGroup('depth-g1');
    const g2 = await makeGroup('depth-g2');
    const g3 = await makeGroup('depth-g3');
    const g4 = await makeGroup('depth-g4');
    const g5 = await makeGroup('depth-g5');
    const g6 = await makeGroup('depth-g6');
    const link = async (from: string, to: string, status: number): Promise<void> => {
      await auth(request(server()).patch(`/admin/route-groups/${from}`))
        .send({ fallbackGroupId: to })
        .expect(status);
    };
    await link(g2, g1, 200);
    await link(g3, g2, 200);
    await link(g4, g3, 200);
    // g5 → g4 = a 5-group chain (g5→g4→g3→g2→g1), exactly at the cap → ok.
    await link(g5, g4, 200);
    // g6 → g5 = a 6-group chain, exceeding FALLBACK_MAX_DEPTH (5) → 400.
    await link(g6, g5, 400);
  });

  it('404s a create/patch pointing at a nonexistent fallback group', async () => {
    await auth(request(server()).post('/admin/route-groups'))
      .send({ name: 'fb-missing', fallbackGroupId: NIL_UUID })
      .expect(404);
    const a = await makeGroup('fb-patch-missing');
    await auth(request(server()).patch(`/admin/route-groups/${a}`))
      .send({ fallbackGroupId: NIL_UUID })
      .expect(404);
  });
});

describe('admin api-key route-group binding', () => {
  it('binds at create, rebinds + unbinds via PATCH (reflected in list/get)', async () => {
    const tenantId = await makeTenant();
    const g1 = await auth(request(server()).post('/admin/route-groups'))
      .send({ name: 'g1' })
      .expect(201);
    const g2 = await auth(request(server()).post('/admin/route-groups'))
      .send({ name: 'g2' })
      .expect(201);

    // Create a key bound to g1.
    const created = await auth(request(server()).post('/admin/api-keys'))
      .send({ tenantId, routeGroupId: g1.body.id })
      .expect(201);
    const keyId = created.body.id as string;

    const listed = await auth(request(server()).get(`/admin/api-keys?tenantId=${tenantId}`)).expect(
      200,
    );
    expect(
      (listed.body.data as { id: string; route_group_id: string | null }[]).find(
        (r) => r.id === keyId,
      )?.route_group_id,
    ).toBe(g1.body.id);

    // PATCH rebind to g2.
    const rebound = await auth(request(server()).patch(`/admin/api-keys/${keyId}/group`))
      .send({ routeGroupId: g2.body.id })
      .expect(200);
    expect(rebound.body.route_group_id).toBe(g2.body.id);
    const afterRebind = await auth(
      request(server()).get(`/admin/api-keys?tenantId=${tenantId}`),
    ).expect(200);
    expect(
      (afterRebind.body.data as { id: string; route_group_id: string | null }[]).find(
        (r) => r.id === keyId,
      )?.route_group_id,
    ).toBe(g2.body.id);

    // PATCH unbind (null → default group at routing time).
    const unbound = await auth(request(server()).patch(`/admin/api-keys/${keyId}/group`))
      .send({ routeGroupId: null })
      .expect(200);
    expect(unbound.body.route_group_id).toBeNull();
  });

  it('404s binding a key to a nonexistent group (create + patch), and patching an unknown key', async () => {
    const tenantId = await makeTenant();

    // create with a nonexistent group → 404
    await auth(request(server()).post('/admin/api-keys'))
      .send({ tenantId, routeGroupId: NIL_UUID })
      .expect(404);

    // an unbound key, then PATCH to a nonexistent group → 404
    const created = await auth(request(server()).post('/admin/api-keys'))
      .send({ tenantId })
      .expect(201);
    const keyId = created.body.id as string;
    await auth(request(server()).patch(`/admin/api-keys/${keyId}/group`))
      .send({ routeGroupId: NIL_UUID })
      .expect(404);

    // PATCH an unknown key id → 404
    const group = await auth(request(server()).post('/admin/route-groups'))
      .send({ name: 'g' })
      .expect(201);
    await auth(request(server()).patch(`/admin/api-keys/${NIL_UUID}/group`))
      .send({ routeGroupId: group.body.id })
      .expect(404);
  });
});
