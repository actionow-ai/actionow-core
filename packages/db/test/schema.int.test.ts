import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { account, tenant } from '../src/schema/index.js';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 1 });
  db = drizzle(client);
  await migrate(db, { migrationsFolder: './drizzle' });
});

afterAll(async () => {
  await client.end();
  await container.stop();
});

it('applies migrations and enforces balance>=held check', async () => {
  const [t] = await db.insert(tenant).values({ name: 'acme' }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  const tenantId = t.id;
  await db.insert(account).values({ tenantId, creditBalance: 100n, creditHeld: 0n });
  // violating the check must throw
  await expect(
    db.insert(account).values({ tenantId, creditBalance: 10n, creditHeld: 50n }),
  ).rejects.toThrow();
});
