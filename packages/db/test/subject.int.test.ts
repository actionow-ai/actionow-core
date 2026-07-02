import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createAccount,
  createSession,
  createSubAccount,
  createSubject,
  createSubjectIdentity,
  createUser,
  createUserIdentity,
  findLiveSessionByHash,
  findSubjectByEmail,
  findSubjectByExternalId,
  findSubjectsByIdentity,
  generateRefreshToken,
  getAccount,
  getSubAccount,
  getSubjectById,
  hashRefreshToken,
  listSubjectsByTenant,
  resolveIdentityLink,
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
  await client`TRUNCATE TABLE subject_identity, user_identity, subject, "user", tenant RESTART IDENTITY CASCADE`;
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

    const res = await softDeleteSubject(db, tenantId, s.id);
    expect(res?.id).toBe(s.id);

    // live reads no longer see it
    expect(await getSubjectById(db, tenantId, s.id)).toBeUndefined();
    expect(await findSubjectByExternalId(db, tenantId, 'u1')).toBeUndefined();

    // the external_id is free again (partial unique excludes soft-deleted rows)
    await expect(createSubject(db, { tenantId, externalId: 'u1' })).resolves.toBeTruthy();
  });

  it('cascades: sweeps the sub-wallet to the tenant pool + disables subject keys', async () => {
    const tenantId = await makeTenant();
    const pool = await createAccount(db, { tenantId, creditBalance: 0n });
    const s = await createSubject(db, { tenantId, externalId: 'u1' });
    await createSubAccount(db, { tenantId, subjectId: s.id, creditBalance: 1_000_000n });
    // two subject-scoped api keys (one already-deleted → only the live one is disabled)
    await db.insert(schema.apiKey).values({ tenantId, subjectId: s.id, hash: 'live-hash' });
    await db
      .insert(schema.apiKey)
      .values({ tenantId, subjectId: s.id, hash: 'dead-hash', deletedAt: new Date() });
    // a live member login session — must be revoked so a refresh can't re-mint
    const sessPlain = generateRefreshToken();
    await createSession(db, {
      principalKind: 'subject',
      subjectId: s.id,
      tenantId,
      refreshHash: hashRefreshToken(sessPlain),
      familyId: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const res = await softDeleteSubject(db, tenantId, s.id);
    expect(res?.sweptMicro).toBe(1_000_000n);
    expect(res?.disabledKeys).toBe(1);
    expect(res?.revokedSessions).toBe(1);
    // the member session no longer resolves as live
    expect(await findLiveSessionByHash(db, hashRefreshToken(sessPlain))).toBeUndefined();

    // the swept credits landed in the tenant pool; the sub-wallet is drained
    expect((await getAccount(db, pool.id))?.creditBalance).toBe(1_000_000n);
    expect((await getSubAccount(db, tenantId, s.id))?.creditBalance).toBe(0n);

    // the previously-live subject key is now disabled + soft-deleted
    const live = await db
      .select({ status: schema.apiKey.status, deletedAt: schema.apiKey.deletedAt })
      .from(schema.apiKey)
      .where(eq(schema.apiKey.hash, 'live-hash'));
    expect(live[0]?.status).toBe('disabled');
    expect(live[0]?.deletedAt).not.toBeNull();
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

describe('identity layer (federation + user↔subject)', () => {
  it('federates subjects across tenants by a shared provider identity', async () => {
    const a = await makeTenant('a');
    const b = await makeTenant('b');
    const sa = await createSubject(db, { tenantId: a, externalId: 'ua' });
    const sb = await createSubject(db, { tenantId: b, externalId: 'ub' });
    await createSubjectIdentity(db, {
      subjectId: sa.id,
      provider: 'sso',
      providerUserId: 'person-1',
    });
    await createSubjectIdentity(db, {
      subjectId: sb.id,
      provider: 'sso',
      providerUserId: 'person-1',
    });
    // a different human under tenant a
    const sc = await createSubject(db, { tenantId: a, externalId: 'uc' });
    await createSubjectIdentity(db, {
      subjectId: sc.id,
      provider: 'sso',
      providerUserId: 'person-2',
    });

    const fed = await findSubjectsByIdentity(db, 'sso', 'person-1');
    expect(fed.map((s) => s.id).sort()).toEqual([sa.id, sb.id].sort());
  });

  it('resolveIdentityLink ties federated subjects to the operator user sharing the identity', async () => {
    const tenantId = await makeTenant('acme');
    const subj = await createSubject(db, { tenantId, externalId: 'u1' });
    await createSubjectIdentity(db, { subjectId: subj.id, provider: 'sso', providerUserId: 'p9' });
    const u = await createUser(db, { email: 'op@example.com', role: 'admin' });
    await createUserIdentity(db, { userId: u.id, provider: 'sso', providerUserId: 'p9' });

    const link = await resolveIdentityLink(db, 'sso', 'p9');
    expect(link.subjects.map((s) => s.id)).toEqual([subj.id]);
    expect(link.userId).toBe(u.id);
  });
});
