import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createFileObject,
  createSubject,
  type FileObject,
  getFileObject,
  listFilesByTenant,
  markFileReady,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

const { fileObject, tenant } = schema;

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
  await client`TRUNCATE TABLE file_object, subject, tenant RESTART IDENTITY CASCADE`;
});

async function makeTenant(): Promise<string> {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  return t.id;
}

describe('file_object repository', () => {
  it('createFileObject inserts a pending row', async () => {
    const tenantId = await makeTenant();
    const file = await createFileObject(db, {
      tenantId,
      provider: 'minio',
      bucket: 'actionow',
      key: `${tenantId}/abc.png`,
    });

    expect(file.status).toBe('pending');
    expect(file.size).toBeNull();
    expect(file.etag).toBeNull();
    expect(file.key).toBe(`${tenantId}/abc.png`);
  });

  it('markFileReady moves the row to ready with observed metadata', async () => {
    const tenantId = await makeTenant();
    const file = await createFileObject(db, {
      tenantId,
      provider: 'minio',
      bucket: 'actionow',
      key: `${tenantId}/abc.png`,
    });

    const ready = await markFileReady(db, file.id, {
      size: 1234,
      contentType: 'image/png',
      etag: '"deadbeef"',
    });

    expect(ready?.status).toBe('ready');
    expect(ready?.size).toBe(1234);
    expect(ready?.contentType).toBe('image/png');
    expect(ready?.etag).toBe('"deadbeef"');
  });

  it('getFileObject is tenant-scoped (another tenant cannot read the file)', async () => {
    const owner = await makeTenant();
    const other = await makeTenant();
    const file = await createFileObject(db, {
      tenantId: owner,
      provider: 'minio',
      bucket: 'actionow',
      key: `${owner}/secret.bin`,
    });

    expect((await getFileObject(db, file.id, owner))?.id).toBe(file.id);
    expect(await getFileObject(db, file.id, other)).toBeUndefined();
    // Unscoped lookup still finds it (used internally).
    expect((await getFileObject(db, file.id))?.id).toBe(file.id);
  });

  it('§4b: subject-scoped reads see own + tenant-shared files, never another subject’s', async () => {
    const tenantId = await makeTenant();
    const subA = await createSubject(db, { tenantId, externalId: 'a' });
    const subB = await createSubject(db, { tenantId, externalId: 'b' });
    const mk = (subjectId: string | null, k: string) =>
      createFileObject(db, { tenantId, subjectId, provider: 'minio', bucket: 'b', key: k });
    const fa = await mk(subA.id, 'a.png');
    const fb = await mk(subB.id, 'b.png');
    const ft = await mk(null, 't.png');

    const listA = await listFilesByTenant(db, tenantId, {}, { limit: 10 }, subA.id);
    expect(listA.rows.map((r) => r.id).sort()).toEqual([fa.id, ft.id].sort());
    expect((await listFilesByTenant(db, tenantId, {}, { limit: 10 })).rows).toHaveLength(3);

    expect(await getFileObject(db, fb.id, tenantId, subA.id)).toBeUndefined();
    expect((await getFileObject(db, fa.id, tenantId, subA.id))?.id).toBe(fa.id);
    expect((await getFileObject(db, ft.id, tenantId, subA.id))?.id).toBe(ft.id);
  });
});

/** Insert a `file_object` row directly (so status/content_type/created_at are controllable). */
async function makeFile(
  tenantId: string,
  opts: { key: string; status?: 'pending' | 'ready'; contentType?: string | null; createdAt: Date },
): Promise<FileObject> {
  const [row] = await db
    .insert(fileObject)
    .values({
      tenantId,
      provider: 'r2',
      bucket: 'actionow',
      key: opts.key,
      status: opts.status ?? 'ready',
      contentType: opts.contentType ?? null,
      createdAt: opts.createdAt,
    })
    .returning();
  if (!row) throw new Error('file insert returned no row');
  return row;
}

describe('listFilesByTenant', () => {
  it('returns only the caller tenant files, newest-first', async () => {
    const owner = await makeTenant();
    const other = await makeTenant();
    await makeFile(owner, {
      key: 'a',
      contentType: 'image/png',
      createdAt: new Date('2026-01-01Z'),
    });
    await makeFile(owner, {
      key: 'b',
      contentType: 'image/png',
      createdAt: new Date('2026-01-02Z'),
    });
    await makeFile(other, {
      key: 'c',
      contentType: 'image/png',
      createdAt: new Date('2026-01-03Z'),
    });

    const { rows, hasMore } = await listFilesByTenant(db, owner, {}, { limit: 50 });

    expect(rows.map((r) => r.key)).toEqual(['b', 'a']); // newest-first; the other tenant excluded
    expect(hasMore).toBe(false);
  });

  it('filters by kind via the content_type prefix (null content-type excluded)', async () => {
    const owner = await makeTenant();
    await makeFile(owner, {
      key: 'img',
      contentType: 'image/jpeg',
      createdAt: new Date('2026-01-01Z'),
    });
    await makeFile(owner, {
      key: 'vid',
      contentType: 'video/mp4',
      createdAt: new Date('2026-01-02Z'),
    });
    await makeFile(owner, { key: 'none', contentType: null, createdAt: new Date('2026-01-03Z') });

    const images = await listFilesByTenant(db, owner, { kind: 'image' }, { limit: 50 });
    const videos = await listFilesByTenant(db, owner, { kind: 'video' }, { limit: 50 });

    expect(images.rows.map((r) => r.key)).toEqual(['img']);
    expect(videos.rows.map((r) => r.key)).toEqual(['vid']);
  });

  it('filters by status (ready-only excludes pending)', async () => {
    const owner = await makeTenant();
    await makeFile(owner, { key: 'ready', status: 'ready', createdAt: new Date('2026-01-01Z') });
    await makeFile(owner, {
      key: 'pending',
      status: 'pending',
      createdAt: new Date('2026-01-02Z'),
    });

    const ready = await listFilesByTenant(db, owner, { status: 'ready' }, { limit: 50 });

    expect(ready.rows.map((r) => r.key)).toEqual(['ready']);
  });

  it('paginates with the keyset cursor', async () => {
    const owner = await makeTenant();
    await makeFile(owner, { key: 'x1', createdAt: new Date('2026-01-01Z') });
    await makeFile(owner, { key: 'x2', createdAt: new Date('2026-01-02Z') });
    await makeFile(owner, { key: 'x3', createdAt: new Date('2026-01-03Z') });

    const first = await listFilesByTenant(db, owner, {}, { limit: 2 });
    expect(first.rows.map((r) => r.key)).toEqual(['x3', 'x2']);
    expect(first.hasMore).toBe(true);

    const last = first.rows[first.rows.length - 1];
    if (last === undefined) throw new Error('expected a last row');
    const second = await listFilesByTenant(
      db,
      owner,
      {},
      { limit: 2, cursor: { createdAt: last.createdAt, id: last.id } },
    );
    expect(second.rows.map((r) => r.key)).toEqual(['x1']);
    expect(second.hasMore).toBe(false);
  });
});
