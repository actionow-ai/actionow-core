import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { insertRelayTrace } from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

const { relayTrace } = schema;
const DRIZZLE_DIR = join(import.meta.dirname, '..', 'drizzle');

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
  await client`TRUNCATE TABLE relay_trace RESTART IDENTITY CASCADE`;
});

describe('relay_trace repository + migration', () => {
  it('a migration creates the relay_trace table', async () => {
    const files = (await readdir(DRIZZLE_DIR)).filter((f) => f.endsWith('.sql'));
    let found = false;
    for (const file of files) {
      const body = await readFile(join(DRIZZLE_DIR, file), 'utf8');
      if (body.includes('CREATE TABLE "relay_trace"')) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it('insertRelayTrace round-trips the full audit row', async () => {
    const tenantId = '11111111-1111-1111-1111-111111111111';
    const jobId = '22222222-2222-2222-2222-222222222222';
    const channelId = '33333333-3333-3333-3333-333333333333';
    const inserted = await insertRelayTrace(db, {
      tenantId,
      jobId,
      channelId,
      providerType: 'codex-oauth',
      method: 'POST',
      url: 'https://chatgpt.com/backend-api/codex/responses',
      requestHeaders: { authorization: '[redacted]', 'content-type': 'application/json' },
      requestBody: '{"input":[],"instructions":"be brief"}',
      responseStatus: 200,
      responseBody: 'event: response.completed\ndata: {"type":"response.completed"}\n\n',
      isStream: true,
      latencyMs: 42,
      truncated: false,
    });

    expect(inserted.id).toBeDefined();
    expect(inserted.createdAt).toBeInstanceOf(Date);

    const [row] = await db.select().from(relayTrace).where(eq(relayTrace.id, inserted.id));
    expect(row?.tenantId).toBe(tenantId);
    expect(row?.jobId).toBe(jobId);
    expect(row?.channelId).toBe(channelId);
    expect(row?.providerType).toBe('codex-oauth');
    expect(row?.method).toBe('POST');
    expect(row?.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(row?.requestHeaders).toEqual({
      authorization: '[redacted]',
      'content-type': 'application/json',
    });
    expect(row?.requestBody).toContain('"instructions":"be brief"');
    expect(row?.responseStatus).toBe(200);
    expect(row?.responseBody).toContain('response.completed');
    expect(row?.isStream).toBe(true);
    expect(row?.latencyMs).toBe(42);
    expect(row?.error).toBeNull();
    expect(row?.truncated).toBe(false);
  });

  it('insertRelayTrace tolerates a minimal error-only row (no correlation ids)', async () => {
    const inserted = await insertRelayTrace(db, {
      method: 'GET',
      url: 'https://api.openai.com/v1/models',
      error: 'connect ECONNREFUSED',
    });
    const [row] = await db.select().from(relayTrace).where(eq(relayTrace.id, inserted.id));
    expect(row?.tenantId).toBeNull();
    expect(row?.jobId).toBeNull();
    expect(row?.error).toBe('connect ECONNREFUSED');
    expect(row?.isStream).toBe(false);
    expect(row?.truncated).toBe(false);
  });
});
