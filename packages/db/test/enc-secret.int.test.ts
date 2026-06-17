import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createEncryptedSecret, resolveSecretRef } from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

const KEY = Buffer.alloc(32, 9).toString('base64');
const PRIOR_KEY = process.env.SECRET_ENCRYPTION_KEY;

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
  await client`TRUNCATE TABLE secret_material, secret_ref RESTART IDENTITY CASCADE`;
  if (PRIOR_KEY === undefined) delete process.env.SECRET_ENCRYPTION_KEY;
  else process.env.SECRET_ENCRYPTION_KEY = PRIOR_KEY;
});

describe('encrypted-at-rest secrets (F0.3)', () => {
  it('stores an encrypted secret and resolves it back to plaintext', async () => {
    const ref = await createEncryptedSecret(db, {
      value: 'sk-live-123',
      label: 'openai',
      keyB64: KEY,
    });
    expect(ref.provider).toBe('enc');
    const [mat] = await db.select().from(schema.secretMaterial);
    expect(mat?.material).not.toContain('sk-live-123'); // ciphertext, not plaintext
    process.env.SECRET_ENCRYPTION_KEY = KEY;
    expect(await resolveSecretRef(db, ref.id)).toBe('sk-live-123');
  });

  it('returns undefined for an enc ref when the master key is absent', async () => {
    const ref = await createEncryptedSecret(db, { value: 'x', label: '', keyB64: KEY });
    delete process.env.SECRET_ENCRYPTION_KEY;
    expect(await resolveSecretRef(db, ref.id)).toBeUndefined();
  });
});
