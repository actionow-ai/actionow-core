import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createProxy, createSecretRef, resolveSecretRef } from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

/** A valid 32-byte base64 AES key for the proxy encryption cases. */
const KEY = Buffer.alloc(32, 7).toString('base64');

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
  await client`TRUNCATE TABLE proxy RESTART IDENTITY CASCADE`;
  // Clear any env keys this suite sets so cases don't leak into each other.
  delete process.env.SECRET_DEMO_KEY;
  delete process.env.SECRET_LITERAL_REF;
  delete process.env.SECRET_ENCRYPTION_KEY;
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

  it('resolves an ACTIVE managed proxy id to its decrypted URL', async () => {
    process.env.SECRET_ENCRYPTION_KEY = KEY;
    const url = 'http://user:pass@proxy.example:8080';
    const px = await createProxy(db, { name: 'p1', url, keyB64: KEY });

    await expect(resolveSecretRef(db, px.id)).resolves.toBe(url);
  });

  it('returns undefined for a DISABLED proxy (→ engine falls back to no/global proxy)', async () => {
    process.env.SECRET_ENCRYPTION_KEY = KEY;
    const px = await createProxy(db, {
      name: 'p2',
      url: 'socks5://proxy.example:1080',
      keyB64: KEY,
      status: 'disabled',
    });

    await expect(resolveSecretRef(db, px.id)).resolves.toBeUndefined();
  });
});
