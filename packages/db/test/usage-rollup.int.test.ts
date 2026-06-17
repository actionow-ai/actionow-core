import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { insertUsageLog, rollupUsage } from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

const { tenant, usageLog } = schema;

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
  await client`TRUNCATE TABLE usage_log, tenant RESTART IDENTITY CASCADE`;
});

async function makeTenant(name: string): Promise<string> {
  const [t] = await db.insert(tenant).values({ name }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  return t.id;
}

/** Overwrite a row's created_at so day-bucketing is deterministic. */
async function setCreatedAt(id: string, iso: string): Promise<void> {
  await db
    .update(usageLog)
    .set({ createdAt: new Date(iso) })
    .where(eq(usageLog.id, id));
}

describe('rollupUsage (P1c.2)', () => {
  it('groups by model with bigint token/cost sums and error counts', async () => {
    const tenantId = await makeTenant('acme');
    // gpt-4o: 2 succeeded rows → requests 2, in 30, out 12, cost 65, errors 0
    await insertUsageLog(db, {
      tenantId,
      model: 'gpt-4o',
      inputTokens: 10,
      outputTokens: 5,
      cost: 25n,
      status: 'succeeded',
    });
    await insertUsageLog(db, {
      tenantId,
      model: 'gpt-4o',
      inputTokens: 20,
      outputTokens: 7,
      cost: 40n,
      status: 'succeeded',
    });
    // claude-3: 1 succeeded + 1 failed → requests 2, errors 1
    await insertUsageLog(db, {
      tenantId,
      model: 'claude-3',
      inputTokens: 100,
      outputTokens: 50,
      cost: 1000n,
      status: 'succeeded',
    });
    await insertUsageLog(db, {
      tenantId,
      model: 'claude-3',
      inputTokens: 1,
      outputTokens: 2,
      cost: 3n,
      status: 'failed',
    });

    const byModel = await rollupUsage(db, { groupBy: 'model', tenantId });

    const gpt = byModel.find((r) => r.bucket === 'gpt-4o');
    expect(gpt).toMatchObject({
      bucket: 'gpt-4o',
      requests: 2,
      inputTokens: 30n,
      outputTokens: 12n,
      cost: 65n,
      errors: 0,
    });
    expect(typeof gpt?.inputTokens).toBe('bigint');
    expect(typeof gpt?.cost).toBe('bigint');

    const claude = byModel.find((r) => r.bucket === 'claude-3');
    expect(claude).toMatchObject({
      bucket: 'claude-3',
      requests: 2,
      inputTokens: 101n,
      outputTokens: 52n,
      cost: 1003n,
      errors: 1,
    });

    // ORDER BY bucket → claude-3 before gpt-4o
    expect(byModel.map((r) => r.bucket)).toEqual(['claude-3', 'gpt-4o']);
  });

  it('groups by day with an ISO date-string bucket', async () => {
    const tenantId = await makeTenant('days');
    const a = await insertUsageLog(db, {
      tenantId,
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
      cost: 1n,
      status: 'succeeded',
    });
    const b = await insertUsageLog(db, {
      tenantId,
      model: 'm',
      inputTokens: 2,
      outputTokens: 2,
      cost: 2n,
      status: 'succeeded',
    });
    await setCreatedAt(a.id, '2026-06-15T08:00:00Z');
    await setCreatedAt(b.id, '2026-06-15T20:00:00Z');

    const byDay = await rollupUsage(db, { groupBy: 'day', tenantId });
    expect(byDay).toHaveLength(1);
    const day = byDay[0];
    expect(day?.bucket).toBe('2026-06-15');
    expect(day).toMatchObject({ requests: 2, inputTokens: 3n, outputTokens: 3n, cost: 3n });
  });

  it('respects the from/to window', async () => {
    const tenantId = await makeTenant('window');
    const inside = await insertUsageLog(db, {
      tenantId,
      model: 'm',
      inputTokens: 5,
      outputTokens: 5,
      cost: 5n,
      status: 'succeeded',
    });
    const before = await insertUsageLog(db, {
      tenantId,
      model: 'm',
      inputTokens: 99,
      outputTokens: 99,
      cost: 99n,
      status: 'succeeded',
    });
    const after = await insertUsageLog(db, {
      tenantId,
      model: 'm',
      inputTokens: 77,
      outputTokens: 77,
      cost: 77n,
      status: 'succeeded',
    });
    await setCreatedAt(inside.id, '2026-06-10T12:00:00Z');
    await setCreatedAt(before.id, '2026-06-01T12:00:00Z');
    await setCreatedAt(after.id, '2026-06-20T12:00:00Z');

    const rows = await rollupUsage(db, {
      groupBy: 'model',
      tenantId,
      from: new Date('2026-06-05T00:00:00Z'),
      to: new Date('2026-06-15T00:00:00Z'),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bucket: 'm', requests: 1, inputTokens: 5n, cost: 5n });
  });

  it('buckets channel/api_key with coalesce(unknown) for nulls', async () => {
    const tenantId = await makeTenant('cov');
    await insertUsageLog(db, {
      tenantId,
      model: 'm',
      cost: 1n,
      status: 'succeeded',
      channelId: '11111111-1111-1111-1111-111111111111',
    });
    await insertUsageLog(db, { tenantId, model: 'm', cost: 2n, status: 'succeeded' });

    const byChannel = await rollupUsage(db, { groupBy: 'channel', tenantId });
    expect(byChannel.map((r) => r.bucket).sort()).toEqual([
      '11111111-1111-1111-1111-111111111111',
      'unknown',
    ]);

    const byKey = await rollupUsage(db, { groupBy: 'api_key', tenantId });
    expect(byKey).toHaveLength(1);
    expect(byKey[0]?.bucket).toBe('unknown');
    expect(byKey[0]?.requests).toBe(2);
  });
});
