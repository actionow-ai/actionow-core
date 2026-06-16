import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createSecretRef, resolveSecretRef } from '../src/repositories/index.js';
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
  await client`TRUNCATE TABLE secret_ref RESTART IDENTITY CASCADE`;
  // Clear any env keys this suite sets so cases don't leak into each other.
  delete process.env.SECRET_DEMO_KEY;
  delete process.env.SECRET_LITERAL_REF;
});

describe('resolveSecretRef', () => {
  it('dereferences an env-provider secret_ref via SECRET_<locator>', async () => {
    const ref = await createSecretRef(db, { provider: 'env', locator: 'demo-key' });
    process.env.SECRET_DEMO_KEY = 'val';

    await expect(resolveSecretRef(db, ref.id)).resolves.toBe('val');
  });

  it('reads SECRET_<ref> for a literal (non-uuid) ref', async () => {
    process.env.SECRET_LITERAL_REF = 'proxy-url';

    await expect(resolveSecretRef(db, 'literal-ref')).resolves.toBe('proxy-url');
  });

  it('returns undefined for a uuid-shaped ref with no secret_ref row', async () => {
    // A well-formed uuid that is not in the table — must NOT throw a pg type
    // error and must resolve to undefined (no matching row, no env fallback).
    await expect(
      resolveSecretRef(db, '00000000-0000-4000-8000-000000000000'),
    ).resolves.toBeUndefined();
  });

  it('returns undefined for a vault-provider secret_ref (Phase 5 TODO)', async () => {
    const ref = await createSecretRef(db, { provider: 'vault', locator: 'demo-key' });
    // Even with the env key set, a vault provider does not fall back to env.
    process.env.SECRET_DEMO_KEY = 'val';

    await expect(resolveSecretRef(db, ref.id)).resolves.toBeUndefined();
  });
});
