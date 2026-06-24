import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  appendAuditLog,
  createAccount,
  createSubject,
  createTenant,
  listAuditLog,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

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
  await client`TRUNCATE TABLE audit_log, subject, account, tenant RESTART IDENTITY CASCADE`;
});

describe('audit_log append + list', () => {
  it('appends records and lists newest-first with AND-combined filters', async () => {
    const t1 = await createTenant(db, { name: 'tenant-1' });
    const t2 = await createTenant(db, { name: 'tenant-2' });
    await createAccount(db, { tenantId: t1.id });
    const s1 = await createSubject(db, { tenantId: t1.id, externalId: 'u1' });

    const a = await appendAuditLog(db, {
      actorType: 'operator',
      actorId: 'op-1',
      tenantId: t1.id,
      action: 'tenant.topup',
      targetType: 'account',
      targetId: 'acc-1',
      meta: { amountMicro: '5000000' },
    });
    expect(a.id).toBeDefined();
    expect(a.meta).toEqual({ amountMicro: '5000000' });

    await appendAuditLog(db, {
      actorType: 'operator',
      actorId: 'op-1',
      tenantId: t1.id,
      action: 'limit_plan.update',
      targetType: 'limit_plan',
      targetId: 'plan-1',
    });
    await appendAuditLog(db, {
      actorType: 'member',
      actorId: 'user-9',
      tenantId: t1.id,
      subjectId: s1.id,
      action: 'api_key.create',
      targetType: 'api_key',
      targetId: 'key-1',
    });
    await appendAuditLog(db, {
      actorType: 'system',
      tenantId: t2.id,
      action: 'subject.jit',
      targetType: 'subject',
      targetId: 's-x',
    });

    // all, newest-first
    const all = await listAuditLog(db, {}, { limit: 50 });
    expect(all.rows.map((r) => r.action)).toEqual([
      'subject.jit',
      'api_key.create',
      'limit_plan.update',
      'tenant.topup',
    ]);

    // scope filters
    expect((await listAuditLog(db, { tenantId: t1.id }, { limit: 50 })).rows).toHaveLength(3);
    expect((await listAuditLog(db, { tenantId: t2.id }, { limit: 50 })).rows).toHaveLength(1);
    expect((await listAuditLog(db, { subjectId: s1.id }, { limit: 50 })).rows).toHaveLength(1);

    // dimension filters
    expect((await listAuditLog(db, { actorType: 'member' }, { limit: 50 })).rows).toHaveLength(1);
    expect((await listAuditLog(db, { action: 'tenant.topup' }, { limit: 50 })).rows).toHaveLength(
      1,
    );
    expect((await listAuditLog(db, { targetType: 'limit_plan' }, { limit: 50 })).rows).toHaveLength(
      1,
    );

    // combined AND: member + tenant t1 → just the api_key.create row
    const combined = await listAuditLog(
      db,
      { actorType: 'member', tenantId: t1.id },
      { limit: 50 },
    );
    expect(combined.rows.map((r) => r.action)).toEqual(['api_key.create']);

    // a system row survives subject deletion (FK SET NULL) — append-only audit
    expect((await listAuditLog(db, { actorType: 'system' }, { limit: 50 })).rows[0]?.actorId).toBe(
      null,
    );
  });

  it('subject FK is SET NULL on subject delete — the audit record survives', async () => {
    const t1 = await createTenant(db, { name: 'tenant-1' });
    const s1 = await createSubject(db, { tenantId: t1.id, externalId: 'u1' });
    await appendAuditLog(db, {
      actorType: 'operator',
      actorId: 'op-1',
      tenantId: t1.id,
      subjectId: s1.id,
      action: 'subject.update',
      targetType: 'subject',
      targetId: s1.id,
    });
    // hard-delete the subject row → FK ON DELETE SET NULL must blank the audit's subject_id, keep the row
    await client`DELETE FROM subject WHERE id = ${s1.id}`;
    const rows = (await listAuditLog(db, { tenantId: t1.id }, { limit: 50 })).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subjectId).toBe(null);
    expect(rows[0]?.action).toBe('subject.update');
  });
});
