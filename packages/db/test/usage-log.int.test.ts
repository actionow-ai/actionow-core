import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  insertUsageLog,
  listUsageLogsByTenant,
  listUsageLogsGlobal,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

const { tenant } = schema;

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

describe('usage_log served-channel columns (P1b.4)', () => {
  it('persists channelId and providerType when supplied', async () => {
    const tenantId = await makeTenant('p1b');
    const channelId = '11111111-1111-1111-1111-111111111111';
    const row = await insertUsageLog(db, {
      tenantId,
      model: 'gpt-4o',
      inputTokens: 10,
      outputTokens: 5,
      cost: 65n,
      status: 'succeeded',
      channelId,
      providerType: 'openai',
    });
    expect(row.channelId).toBe(channelId);
    expect(row.providerType).toBe('openai');
  });

  it('leaves channelId and providerType null when omitted', async () => {
    const tenantId = await makeTenant('p1b-null');
    const row = await insertUsageLog(db, {
      tenantId,
      model: 'gpt-4o',
      cost: 1n,
      status: 'succeeded',
    });
    expect(row.channelId).toBeNull();
    expect(row.providerType).toBeNull();
  });
});

describe('usage_log api_key_id column (P1c.1)', () => {
  it('persists apiKeyId when supplied', async () => {
    const tenantId = await makeTenant('p1c');
    const apiKeyId = '22222222-2222-2222-2222-222222222222';
    const row = await insertUsageLog(db, {
      tenantId,
      model: 'gpt-4o',
      inputTokens: 10,
      outputTokens: 5,
      cost: 65n,
      status: 'succeeded',
      apiKeyId,
    });
    expect(row.apiKeyId).toBe(apiKeyId);
  });

  it('leaves apiKeyId null when omitted', async () => {
    const tenantId = await makeTenant('p1c-null');
    const row = await insertUsageLog(db, {
      tenantId,
      model: 'gpt-4o',
      cost: 1n,
      status: 'succeeded',
    });
    expect(row.apiKeyId).toBeNull();
  });
});

describe('usage_log repository', () => {
  it('inserts a call log with bigint cost preserved', async () => {
    const tenantId = await makeTenant('acme');
    const row = await insertUsageLog(db, {
      tenantId,
      model: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
      cost: 6000n,
      latencyMs: 1234,
      status: 'succeeded',
    });
    expect(row.cost).toBe(6000n);
    expect(row.inputTokens).toBe(100);
    expect(row.status).toBe('succeeded');
  });

  it('listUsageLogsByTenant scopes to one tenant, newest-first', async () => {
    const a = await makeTenant('a');
    const b = await makeTenant('b');
    await insertUsageLog(db, { tenantId: a, model: 'm', cost: 1n, status: 'succeeded' });
    await insertUsageLog(db, { tenantId: b, model: 'm', cost: 2n, status: 'succeeded' });

    const forA = await listUsageLogsByTenant(db, a, 50);
    expect(forA).toHaveLength(1);
    expect(forA[0]?.tenantId).toBe(a);
  });

  it('listUsageLogsGlobal returns every tenant (admin view)', async () => {
    const a = await makeTenant('a');
    const b = await makeTenant('b');
    await insertUsageLog(db, { tenantId: a, model: 'm', cost: 1n, status: 'succeeded' });
    await insertUsageLog(db, { tenantId: b, model: 'm', cost: 2n, status: 'failed' });
    const all = await listUsageLogsGlobal(db, 50);
    expect(all).toHaveLength(2);
  });
});
