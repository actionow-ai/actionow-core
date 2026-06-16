import { schema } from '@actionow/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedAll } from '../src/seed/seed.js';

/**
 * Track B Task 9 regression — guards §B.1's "exactly one operator admin"
 * invariant. The seed's admin block is a find-then-create on the unique `email`,
 * so re-running it must never mint a second `role='admin'` principal. This runs
 * `seedAll` directly against a plain Testcontainers db (no AppModule) and asserts
 * idempotency under the Task-1 `user_role_allowed` check constraint.
 */

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });
}, 180_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

describe('seed provisions exactly one operator admin (Track B Task 9)', () => {
  it('is idempotent and never mints a second admin', async () => {
    await seedAll(db, { providerType: 'stub' });
    await seedAll(db, { providerType: 'stub' });

    const admins = await db.select().from(schema.user).where(eq(schema.user.role, 'admin'));
    expect(admins).toHaveLength(1);
    expect(admins[0]?.email).toBe('admin@actionow.local');
  });
});
