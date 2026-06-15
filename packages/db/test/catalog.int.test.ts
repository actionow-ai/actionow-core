import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createDifyBinding,
  createModifier,
  createResource,
  getResourceWithSchema,
  listApplicableModifiers,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

const { difyBinding, modifier, resource, resourceVersion, tenant } = schema;

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
  await client`TRUNCATE TABLE dify_binding, resource_version, resource, modifier, tenant RESTART IDENTITY CASCADE`;
});

async function makeTenant(): Promise<string> {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  return t.id;
}

const IO_SCHEMA = {
  inputs: [{ key: 'topic', type: 'string', required: true }],
  outputs: [{ key: 'caption', type: 'string' }],
};

describe('createResource', () => {
  it('writes the resource and resource_version rows in one tx', async () => {
    const tenantId = await makeTenant();

    const res = await createResource(db, {
      id: 'xhs-writer',
      tenantId,
      kind: 'workflow',
      modality: 'composite',
      providerType: 'dify-workflow',
      execModes: ['blocking'],
      ioSchema: IO_SCHEMA,
      version: 1,
    });

    expect(res.id).toBe('xhs-writer');
    expect(res.currentVersion).toBe(1);
    expect(res.kind).toBe('workflow');
    expect(res.providerType).toBe('dify-workflow');

    const [resRow] = await db.select().from(resource).where(eq(resource.id, 'xhs-writer'));
    expect(resRow?.execModes).toEqual(['blocking']);

    const [verRow] = await db
      .select()
      .from(resourceVersion)
      .where(and(eq(resourceVersion.resourceId, 'xhs-writer'), eq(resourceVersion.version, 1)));
    expect(verRow?.ioSchema).toEqual(IO_SCHEMA);
  });

  it('rejects a duplicate (resource_id, version) via resource_version_pk', async () => {
    const tenantId = await makeTenant();
    const base = {
      id: 'dup',
      tenantId,
      kind: 'workflow',
      modality: 'composite',
      providerType: 'dify-workflow',
      execModes: ['blocking'],
      ioSchema: IO_SCHEMA,
      version: 1,
    };
    await createResource(db, base);
    await expect(createResource(db, base)).rejects.toThrow();
  });

  it('bumps current_version and inserts a new resource_version on re-import', async () => {
    const tenantId = await makeTenant();
    const base = {
      id: 'bump',
      tenantId,
      kind: 'workflow',
      modality: 'composite',
      providerType: 'dify-workflow',
      execModes: ['blocking'],
      ioSchema: IO_SCHEMA,
    };
    await createResource(db, { ...base, version: 1 });
    const res = await createResource(db, { ...base, version: 2 });

    expect(res.currentVersion).toBe(2);
    const versions = await db
      .select()
      .from(resourceVersion)
      .where(eq(resourceVersion.resourceId, 'bump'));
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
  });
});

describe('createDifyBinding', () => {
  it('writes the binding with provision_mode=byo and pricing_model=fixed', async () => {
    const tenantId = await makeTenant();
    await createResource(db, {
      id: 'bound',
      tenantId,
      kind: 'workflow',
      modality: 'composite',
      providerType: 'dify-workflow',
      execModes: ['blocking'],
      ioSchema: IO_SCHEMA,
      version: 1,
    });

    const binding = await createDifyBinding(db, {
      resourceId: 'bound',
      resourceVersion: 1,
      mode: 'workflow',
      difyAppEndpoint: 'https://dify.example/v1',
      difyServiceKeyRef: null,
      dslHash: 'deadbeef',
      pricingModel: 'fixed',
      provisionMode: 'byo',
      requiredSecrets: ['dalle3'],
      compatReport: { items: [], hasBlockers: false },
    });

    expect(binding.provisionMode).toBe('byo');
    expect(binding.pricingModel).toBe('fixed');
    expect(binding.requiredSecrets).toEqual(['dalle3']);

    const [row] = await db.select().from(difyBinding).where(eq(difyBinding.resourceId, 'bound'));
    expect(row?.dslHash).toBe('deadbeef');
    expect(row?.difyAppEndpoint).toBe('https://dify.example/v1');
    expect(row?.compatReport).toEqual({ items: [], hasBlockers: false });
  });
});

describe('listApplicableModifiers', () => {
  it('returns only global + matching tenant/resource scopes, highest priority first', async () => {
    const tenantId = await makeTenant();
    const otherTenant = await makeTenant();

    // In scope for (tenantId, 'res-a').
    await createModifier(db, { scope: 'global', op: 'percent_off', value: 10n, priority: 1 });
    await createModifier(db, {
      scope: `tenant:${tenantId}`,
      op: 'percent_off',
      value: 5n,
      priority: 3,
    });
    await createModifier(db, {
      scope: 'capability:res-a',
      op: 'flat_off',
      value: 100n,
      priority: 2,
    });
    await createModifier(db, {
      scope: 'resource:res-a',
      op: 'flat_off',
      value: 200n,
      priority: 4,
    });

    // Out of scope: a different tenant, a different resource, and an inactive
    // global modifier.
    await createModifier(db, { scope: `tenant:${otherTenant}`, op: 'percent_off', value: 9n });
    await createModifier(db, { scope: 'resource:res-b', op: 'flat_off', value: 9n });
    await createModifier(db, {
      scope: 'global',
      op: 'percent_off',
      value: 99n,
      active: false,
    });

    const rows = await listApplicableModifiers(db, { tenantId, resourceId: 'res-a' });

    expect(rows.map((r) => r.scope)).toEqual([
      'resource:res-a', // priority 4
      `tenant:${tenantId}`, // priority 3
      'capability:res-a', // priority 2
      'global', // priority 1
    ]);
  });

  it('excludes a modifier scoped to a different resource', async () => {
    const tenantId = await makeTenant();
    await createModifier(db, { scope: 'resource:res-b', op: 'flat_off', value: 9n });
    const rows = await listApplicableModifiers(db, { tenantId, resourceId: 'res-a' });
    expect(rows).toHaveLength(0);
    // sanity: the row IS present in the table
    const all = await db.select().from(modifier);
    expect(all).toHaveLength(1);
  });
});

describe('getResourceWithSchema', () => {
  it('returns the resource joined with its current io_schema', async () => {
    const tenantId = await makeTenant();
    await createResource(db, {
      id: 'with-schema',
      tenantId,
      kind: 'workflow',
      modality: 'composite',
      providerType: 'dify-workflow',
      execModes: ['blocking'],
      ioSchema: IO_SCHEMA,
      version: 1,
    });

    const got = await getResourceWithSchema(db, 'with-schema');
    expect(got?.id).toBe('with-schema');
    expect(got?.currentVersion).toBe(1);
    expect(got?.ioSchema).toEqual(IO_SCHEMA);
  });

  it('returns undefined for an unknown resource', async () => {
    const got = await getResourceWithSchema(db, 'nope');
    expect(got).toBeUndefined();
  });
});
