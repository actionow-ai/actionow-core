import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { keysetPage, type PageParams } from '../src/repositories/pagination.js';
import * as schema from '../src/schema/index.js';

const { model, resource, tenant } = schema;

type ModelRow = typeof model.$inferSelect;
type ResourceRow = typeof resource.$inferSelect;

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 20 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
}, 120_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  await client`TRUNCATE TABLE model, resource, tenant RESTART IDENTITY CASCADE`;
});

/** Seed N models all pointing at one resource, with distinct created_at values. */
async function seedModels(n: number): Promise<void> {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  await db.insert(resource).values({
    id: 'res-chat',
    tenantId: t.id,
    kind: 'model',
    modality: 'text',
    providerType: 'openai',
    execModes: ['blocking'],
  });
  // Spread created_at one second apart so DESC ordering is deterministic.
  const base = Date.UTC(2026, 5, 17, 0, 0, 0);
  for (let i = 0; i < n; i += 1) {
    await db.insert(model).values({
      name: `m-${String(i).padStart(3, '0')}`,
      resourceId: 'res-chat',
      createdAt: new Date(base + i * 1000),
    });
  }
}

describe('keysetPage — uuid PK (model)', () => {
  it('orders created_at DESC, id DESC and trims to limit with hasMore', async () => {
    await seedModels(5);

    const page = await keysetPage<ModelRow>(db, {
      table: model,
      createdAtCol: model.createdAt,
      idCol: model.id,
      page: { limit: 2 },
    });

    expect(page.rows).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    // newest-first: m-004 then m-003
    expect(page.rows.map((r) => r.name)).toEqual(['m-004', 'm-003']);
  });

  it('pages through all rows via cursor with no overlap and no gaps', async () => {
    await seedModels(5);

    const seen: string[] = [];
    let cursor: PageParams['cursor'];
    let hasMore = true;
    let pages = 0;
    while (hasMore) {
      pages += 1;
      if (pages > 10) throw new Error('paging did not terminate');
      const page = await keysetPage<ModelRow>(db, {
        table: model,
        createdAtCol: model.createdAt,
        idCol: model.id,
        page: cursor === undefined ? { limit: 2 } : { limit: 2, cursor },
      });
      for (const r of page.rows) seen.push(r.name);
      hasMore = page.hasMore;
      const last = page.rows.at(-1);
      cursor = last === undefined ? undefined : { createdAt: last.createdAt, id: last.id };
    }

    // 5 rows over pages of 2 → 3 pages (2,2,1); last page hasMore=false.
    expect(seen).toEqual(['m-004', 'm-003', 'm-002', 'm-001', 'm-000']);
    expect(new Set(seen).size).toBe(5);
    expect(pages).toBe(3);
  });

  it('final page returns hasMore=false when fewer than limit rows remain', async () => {
    await seedModels(3);
    const page1 = await keysetPage<ModelRow>(db, {
      table: model,
      createdAtCol: model.createdAt,
      idCol: model.id,
      page: { limit: 2 },
    });
    expect(page1.hasMore).toBe(true);
    const last = page1.rows.at(-1);
    if (last === undefined) throw new Error('page1 returned no rows');
    const page2 = await keysetPage<ModelRow>(db, {
      table: model,
      createdAtCol: model.createdAt,
      idCol: model.id,
      page: { limit: 2, cursor: { createdAt: last.createdAt, id: last.id } },
    });
    expect(page2.rows).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
  });

  it('composes an extra WHERE filter with the keyset', async () => {
    await seedModels(5);
    // Filter to a single model name; the keyset still applies, one row, no more.
    const page = await keysetPage<ModelRow>(db, {
      table: model,
      createdAtCol: model.createdAt,
      idCol: model.id,
      where: eq(model.name, 'm-002'),
      page: { limit: 10 },
    });
    expect(page.rows.map((r) => r.name)).toEqual(['m-002']);
    expect(page.hasMore).toBe(false);
  });
});

describe('keysetPage — text PK (resource)', () => {
  it('paginates a text-PK table using the text id as tiebreaker', async () => {
    const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
    if (!t) throw new Error('tenant insert returned no row');
    const base = Date.UTC(2026, 5, 17, 0, 0, 0);
    for (let i = 0; i < 4; i += 1) {
      await db.insert(resource).values({
        id: `res-${String(i).padStart(2, '0')}`,
        tenantId: t.id,
        kind: 'model',
        modality: 'text',
        providerType: 'openai',
        execModes: ['blocking'],
        createdAt: new Date(base + i * 1000),
      });
    }

    const page = await keysetPage<ResourceRow>(db, {
      table: resource,
      createdAtCol: resource.createdAt,
      idCol: resource.id,
      page: { limit: 2 },
    });
    expect(page.rows.map((r) => r.id)).toEqual(['res-03', 'res-02']);
    expect(page.hasMore).toBe(true);

    const last = page.rows.at(-1);
    if (last === undefined) throw new Error('page returned no rows');
    const page2 = await keysetPage<ResourceRow>(db, {
      table: resource,
      createdAtCol: resource.createdAt,
      idCol: resource.id,
      page: { limit: 2, cursor: { createdAt: last.createdAt, id: last.id } },
    });
    expect(page2.rows.map((r) => r.id)).toEqual(['res-01', 'res-00']);
    expect(page2.hasMore).toBe(false);
  });
});

describe('keysetPage — equal created_at tiebreaker', () => {
  it('breaks ties on id DESC so two rows with identical created_at do not collide', async () => {
    const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
    if (!t) throw new Error('tenant insert returned no row');
    await db.insert(resource).values({
      id: 'res-chat',
      tenantId: t.id,
      kind: 'model',
      modality: 'text',
      providerType: 'openai',
      execModes: ['blocking'],
    });
    const ts = new Date('2026-06-17T00:00:00.000Z');
    // Three models sharing the SAME created_at; ordering falls back to id DESC.
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const [row] = await db
        .insert(model)
        .values({ name: `same-${String(i)}`, resourceId: 'res-chat', createdAt: ts })
        .returning();
      if (!row) throw new Error('model insert returned no row');
      ids.push(row.id);
    }
    const sortedDesc = [...ids].sort().reverse();

    // Page size 1, walk all three: must visit each id exactly once, id DESC.
    const seen: string[] = [];
    let cursor: PageParams['cursor'];
    let hasMore = true;
    for (let i = 0; i < 5 && hasMore; i += 1) {
      const page = await keysetPage<ModelRow>(db, {
        table: model,
        createdAtCol: model.createdAt,
        idCol: model.id,
        page: cursor === undefined ? { limit: 1 } : { limit: 1, cursor },
      });
      const r = page.rows[0];
      if (r) seen.push(r.id);
      hasMore = page.hasMore;
      cursor = r === undefined ? undefined : { createdAt: r.createdAt, id: r.id };
    }
    expect(seen).toEqual(sortedDesc);
  });
});
