import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { insertRelayTrace, listRelayTraces } from '../src/repositories/index.js';
import type { PageParams } from '../src/repositories/pagination.js';
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

  it('insertRelayTrace records routeTag when set (route tagging 染色); null otherwise', async () => {
    const tagged = await insertRelayTrace(db, {
      method: 'POST',
      url: 'https://upstream.example/canary',
      routeTag: 'canary',
    });
    const untagged = await insertRelayTrace(db, {
      method: 'POST',
      url: 'https://upstream.example/plain',
    });
    const [taggedRow] = await db.select().from(relayTrace).where(eq(relayTrace.id, tagged.id));
    const [untaggedRow] = await db.select().from(relayTrace).where(eq(relayTrace.id, untagged.id));
    expect(taggedRow?.routeTag).toBe('canary');
    expect(untaggedRow?.routeTag).toBeNull();
  });
});

describe('listRelayTraces — filter + keyset pagination', () => {
  const jobA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const jobB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const base = Date.UTC(2026, 5, 17, 0, 0, 0);

  /** Seed N traces with distinct created_at, alternating job + provider type. */
  async function seedTraces(n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await db.insert(relayTrace).values({
        jobId: i % 2 === 0 ? jobA : jobB,
        providerType: i % 2 === 0 ? 'codex-oauth' : 'openai',
        method: 'POST',
        url: `https://upstream.example/${String(i)}`,
        // Spread one second apart so DESC ordering is deterministic.
        createdAt: new Date(base + i * 1000),
      });
    }
  }

  it('filters by job_id AND provider_type and pages created_at DESC with no dupes', async () => {
    // 6 traces: even idx → jobA/codex-oauth, odd idx → jobB/openai.
    await seedTraces(6);

    // Filter to jobA + codex-oauth → indices 0,2,4 (3 rows), newest-first 4,2,0.
    const filter = { jobId: jobA, providerType: 'codex-oauth' };

    const seen: string[] = [];
    let cursor: PageParams['cursor'];
    let hasMore = true;
    let pages = 0;
    while (hasMore) {
      pages += 1;
      if (pages > 10) throw new Error('paging did not terminate');
      const page = await listRelayTraces(
        db,
        filter,
        cursor === undefined ? { limit: 2 } : { limit: 2, cursor },
      );
      for (const r of page.rows) {
        // Every returned row honours BOTH filter predicates.
        expect(r.jobId).toBe(jobA);
        expect(r.providerType).toBe('codex-oauth');
        seen.push(r.url);
      }
      hasMore = page.hasMore;
      const last = page.rows.at(-1);
      cursor = last === undefined ? undefined : { createdAt: last.createdAt, id: last.id };
    }

    // 3 matching rows over pages of 2 → newest-first, no overlap, no gaps.
    expect(seen).toEqual([
      'https://upstream.example/4',
      'https://upstream.example/2',
      'https://upstream.example/0',
    ]);
    expect(new Set(seen).size).toBe(3);
    expect(pages).toBe(2);
  });

  it('with no filter pages every trace newest-first', async () => {
    await seedTraces(3);
    const page = await listRelayTraces(db, {}, { limit: 2 });
    expect(page.rows).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.rows.map((r) => r.url)).toEqual([
      'https://upstream.example/2',
      'https://upstream.example/1',
    ]);
  });

  it('filters by created_at range (from/to inclusive)', async () => {
    await seedTraces(5); // created_at base+0..base+4000ms
    const from = new Date(base + 1000);
    const to = new Date(base + 3000);
    const page = await listRelayTraces(db, { from, to }, { limit: 10 });
    // indices 1,2,3 fall in [from,to]; newest-first 3,2,1.
    expect(page.rows.map((r) => r.url)).toEqual([
      'https://upstream.example/3',
      'https://upstream.example/2',
      'https://upstream.example/1',
    ]);
    expect(page.hasMore).toBe(false);
  });
});
