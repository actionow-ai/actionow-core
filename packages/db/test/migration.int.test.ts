import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DRIZZLE_DIR = join(import.meta.dirname, '..', 'drizzle');

/** Read the ordered list of `NNNN_*.sql` migration files. */
async function migrationFiles(): Promise<string[]> {
  const entries = await readdir(DRIZZLE_DIR);
  return entries.filter((f) => f.endsWith('.sql')).sort();
}

/**
 * Apply a single migration file. Drizzle uses `--> statement-breakpoint` between
 * statements; split on it and run each in order so multi-statement migrations
 * (CREATE … then INSERT … then DROP …) execute in their authored sequence.
 */
async function applyMigration(client: ReturnType<typeof postgres>, file: string): Promise<void> {
  const sql = await readFile(join(DRIZZLE_DIR, file), 'utf8');
  const statements = sql
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const statement of statements) {
    await client.unsafe(statement);
  }
}

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 1 });
}, 120_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

describe('admin_user → user data migration', () => {
  it('copies an existing admin_user row into the new user table, then drops admin_user', async () => {
    const files = await migrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(2);

    // The phase-9 migration creates user/user_identity, copies admin_user rows,
    // then drops admin_user. Locate it by content (the `admin_user` → `user`
    // data migration) rather than position, so later migrations appended after
    // it don't shift which file we target.
    let phase9: string | undefined;
    for (const file of files) {
      const body = await readFile(join(DRIZZLE_DIR, file), 'utf8');
      if (body.includes('INSERT INTO "user"') && body.includes('DROP TABLE "admin_user"')) {
        phase9 = file;
        break;
      }
    }
    if (phase9 === undefined) throw new Error('phase-9 admin_user→user migration not found');
    // Apply only the migrations up to (and not including) the phase-9 one; any
    // migrations after it are irrelevant to this data-migration assertion.
    const phase9Index = files.indexOf(phase9);
    const earlier = files.slice(0, phase9Index);

    // 1. Apply every migration BEFORE the phase-9 one. This creates admin_user.
    for (const file of earlier) {
      await applyMigration(client, file);
    }

    // 2. Seed a live admin_user-shaped row (as the phase-5 seed/tests produce).
    const adminId = '11111111-1111-1111-1111-111111111111';
    const pwHash = 'scrypt$deadbeef$cafebabe';
    await client`
      INSERT INTO admin_user (id, email, password_hash, role, status)
      VALUES (${adminId}, ${'admin@actionow.local'}, ${pwHash}, ${'admin'}, ${'active'})
    `;

    // admin_user exists right now.
    const before = await client`SELECT to_regclass('public.admin_user') AS reg`;
    expect(before[0]?.reg).toBe('admin_user');

    // 3. Apply the phase-9 migration (create user/user_identity, copy, drop).
    await applyMigration(client, phase9);

    // 4. The admin row survived into "user" with email_verified=true.
    const migrated = await client`
      SELECT id, email, email_verified, password_hash, role, status
      FROM "user" WHERE id = ${adminId}
    `;
    expect(migrated).toHaveLength(1);
    const row = migrated[0];
    expect(row?.email).toBe('admin@actionow.local');
    expect(row?.email_verified).toBe(true);
    expect(row?.password_hash).toBe(pwHash);
    expect(row?.role).toBe('admin');
    expect(row?.status).toBe('active');

    // 5. admin_user is gone; user_identity exists.
    const adminGone = await client`SELECT to_regclass('public.admin_user') AS reg`;
    expect(adminGone[0]?.reg).toBeNull();
    const identity = await client`SELECT to_regclass('public.user_identity') AS reg`;
    expect(identity[0]?.reg).toBe('user_identity');
  }, 60_000);
});
