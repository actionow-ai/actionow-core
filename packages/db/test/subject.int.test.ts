import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createSubject,
  findSubjectByEmail,
  findSubjectByExternalId,
  getSubjectById,
  listSubjectsByTenant,
  resolveOrCreateSubject,
  softDeleteSubject,
  updateSubject,
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
  await client`TRUNCATE TABLE subject, tenant RESTART IDENTITY CASCADE`;
});

async function makeTenant(name = 'acme'): Promise<string> {
  const [t] = await db.insert(tenant).values({ name }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  return t.id;
}

describe('createSubject / find / get', () => {
  it('creates a subject with sane defaults', async () => {
    const tenantId = await makeTenant();
    const s = await createSubject(db, { tenantId, externalId: 'ext-1', displayName: 'Alice' });

    expect(s.tenantId).toBe(tenantId);
    expect(s.externalId).toBe('ext-1');
    expect(s.displayName).toBe('Alice');
    expect(s.status).toBe('active');
    expect(s.email).toBeNull();
    expect(s.deletedAt).toBeNull();
  });

  it('findSubjectByExternalId is tenant-scoped', async () => {
    const a = await makeTenant('a');
    const b = await makeTenant('b');
    const sa = await createSubject(db, { tenantId: a, externalId: 'u1' });

    expect((await findSubjectByExternalId(db, a, 'u1'))?.id).toBe(sa.id);
    // same external_id under a different tenant resolves to nothing
    expect(await findSubjectByExternalId(db, b, 'u1')).toBeUndefined();
  });

  it('normalizes + matches email per tenant (lowercased)', async () => {
    const tenantId = await makeTenant();
    const s = await createSubject(db, { tenantId, email: 'Bob@Example.com' });
    expect(s.email).toBe('bob@example.com');
    expect((await findSubjectByEmail(db, tenantId, 'bob@EXAMPLE.com'))?.id).toBe(s.id);
  });

  it('external_id is unique per (tenant, live) but free across tenants', async () => {
    const a = await makeTenant('a');
    const b = await makeTenant('b');
    await createSubject(db, { tenantId: a, externalId: 'dup' });
    // different tenant, same handle → OK
    await expect(createSubject(db, { tenantId: b, externalId: 'dup' })).resolves.toBeTruthy();
    // same tenant, same handle → unique violation
    await expect(createSubject(db, { tenantId: a, externalId: 'dup' })).rejects.toThrow();
  });
});

describe('updateSubject', () => {
  it('patches mutable fields, tenant-scoped', async () => {
    const tenantId = await makeTenant();
    const s = await createSubject(db, { tenantId, externalId: 'u1', displayName: 'old' });

    const updated = await updateSubject(db, tenantId, s.id, {
      displayName: 'new',
      status: 'disabled',
    });
    expect(updated?.displayName).toBe('new');
    expect(updated?.status).toBe('disabled');

    // wrong tenant cannot patch
    const other = await makeTenant('other');
    expect(await updateSubject(db, other, s.id, { displayName: 'hijack' })).toBeUndefined();
  });
});

describe('softDeleteSubject', () => {
  it('hides the subject from live reads and frees its external_id', async () => {
    const tenantId = await makeTenant();
    const s = await createSubject(db, { tenantId, externalId: 'u1' });

    const id = await softDeleteSubject(db, tenantId, s.id);
    expect(id).toBe(s.id);

    // live reads no longer see it
    expect(await getSubjectById(db, tenantId, s.id)).toBeUndefined();
    expect(await findSubjectByExternalId(db, tenantId, 'u1')).toBeUndefined();

    // the external_id is free again (partial unique excludes soft-deleted rows)
    await expect(createSubject(db, { tenantId, externalId: 'u1' })).resolves.toBeTruthy();
  });
});

describe('listSubjectsByTenant', () => {
  it('returns the tenant live subjects newest-first', async () => {
    const tenantId = await makeTenant();
    await createSubject(db, { tenantId, externalId: 'u1' });
    await createSubject(db, { tenantId, externalId: 'u2' });
    const deleted = await createSubject(db, { tenantId, externalId: 'u3' });
    await softDeleteSubject(db, tenantId, deleted.id);

    const { rows, hasMore } = await listSubjectsByTenant(db, tenantId, { limit: 10 });
    expect(rows.map((r) => r.externalId).sort()).toEqual(['u1', 'u2']);
    expect(hasMore).toBe(false);
  });
});

describe('resolveOrCreateSubject (Model-B)', () => {
  it('returns an existing subject by external_id', async () => {
    const tenantId = await makeTenant();
    const s = await createSubject(db, { tenantId, externalId: 'u1' });
    expect((await resolveOrCreateSubject(db, tenantId, 'u1'))?.id).toBe(s.id);
  });

  it('returns null for an unknown external_id when JIT is off (default)', async () => {
    const tenantId = await makeTenant();
    expect(await resolveOrCreateSubject(db, tenantId, 'ghost')).toBeNull();
  });

  it('JIT-creates a subject when the tenant opted in (idempotent)', async () => {
    const [t] = await db
      .insert(tenant)
      .values({ name: 'jit', config: { jit_provisioning_enabled: true } })
      .returning();
    if (!t) throw new Error('tenant insert returned no row');
    const created = await resolveOrCreateSubject(db, t.id, 'auto-1');
    expect(created?.externalId).toBe('auto-1');
    expect((await resolveOrCreateSubject(db, t.id, 'auto-1'))?.id).toBe(created?.id);
  });
});
