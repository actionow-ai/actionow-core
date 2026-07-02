import {
  createFaultPolicy,
  createJob,
  createUpstreamChannel,
  type Database,
  schema,
} from '@actionow/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadJobContext } from '../src/loaders.js';

const RESOURCE_ID = 'mock-image';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: Database;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });
}, 120_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  await client`TRUNCATE TABLE job, upstream_channel, fault_policy, pricebook_entry, resource_version, resource, account, tenant RESTART IDENTITY CASCADE`;
});

/** Seed the minimum a job needs to load: tenant + account + resource/version + pricebook. */
async function seedBase(): Promise<{ tenantId: string }> {
  const [t] = await db.insert(schema.tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('no tenant');
  await db.insert(schema.account).values({ tenantId: t.id, creditBalance: 1_000_000n });
  await db.insert(schema.resource).values({
    id: RESOURCE_ID,
    tenantId: t.id,
    kind: 'model',
    modality: 'image',
    providerType: 'async-media-mock',
    execModes: ['async-poll'],
    currentVersion: 1,
  });
  await db
    .insert(schema.resourceVersion)
    .values({ resourceId: RESOURCE_ID, version: 1, ioSchema: { inputs: [], outputs: [] } });
  await db.insert(schema.pricebookEntry).values({
    resourceId: RESOURCE_ID,
    resourceVersion: 1,
    version: 1,
    method: 'unit',
    timing: 'post',
    spec: { method: 'unit', dimensions: { images: { rate: 100 } } },
    active: true,
  });
  return { tenantId: t.id };
}

describe('loadJobContext — fault policy binding (调用容错) on the async/worker path', () => {
  it('attaches the bound channel fault policy; leaves an unbound channel without one', async () => {
    const { tenantId } = await seedBase();
    const policy = await createFaultPolicy(db, {
      name: 'aggressive',
      retryCount: 3,
      backoffType: 'exponential',
      backoffMs: 250,
      ttftTimeoutMs: 5_000,
      totalTimeoutMs: 60_000,
    });
    const bound = await createUpstreamChannel(db, {
      resourceId: RESOURCE_ID,
      providerType: 'async-media-mock',
      faultPolicyId: policy.id,
    });
    const unbound = await createUpstreamChannel(db, {
      resourceId: RESOURCE_ID,
      providerType: 'async-media-mock',
    });
    const job = await createJob(db, {
      tenantId,
      resourceId: RESOURCE_ID,
      resourceVersion: 1,
      execMode: 'async-poll',
      inputs: { prompt: 'a cat' },
      quotedCredits: 0n,
    });

    const ctx = await loadJobContext(db, job);
    const boundCh = ctx.channels.find((c) => c.id === bound.id);
    const unboundCh = ctx.channels.find((c) => c.id === unbound.id);

    // The async/media job now binds the SAME per-channel resilience the blocking
    // and streaming paths get (regression: the worker loader dropped faultPolicy).
    expect(boundCh?.faultPolicy).toEqual({
      fastFail: false,
      retryCount: 3,
      backoffType: 'exponential',
      backoffMs: 250,
      ttftTimeoutMs: 5_000,
      totalTimeoutMs: 60_000,
    });
    // A channel with no bound policy carries none → the engine applies its defaults.
    expect(unboundCh?.faultPolicy).toBeUndefined();
  });

  it('treats a DISABLED policy as absent (engine defaults)', async () => {
    const { tenantId } = await seedBase();
    const policy = await createFaultPolicy(db, {
      name: 'disabled-one',
      retryCount: 5,
      status: 'disabled',
    });
    const ch = await createUpstreamChannel(db, {
      resourceId: RESOURCE_ID,
      providerType: 'async-media-mock',
      faultPolicyId: policy.id,
    });
    const job = await createJob(db, {
      tenantId,
      resourceId: RESOURCE_ID,
      resourceVersion: 1,
      execMode: 'async-poll',
      inputs: { prompt: 'x' },
      quotedCredits: 0n,
    });

    const ctx = await loadJobContext(db, job);
    expect(ctx.channels.find((c) => c.id === ch.id)?.faultPolicy).toBeUndefined();
  });
});
