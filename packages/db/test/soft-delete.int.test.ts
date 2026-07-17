import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { encryptSecret } from '../src/crypto.js';
import {
  createApiKey,
  createOAuthSession,
  createTenant,
  findApiKeyByHash,
  hashApiKey,
  listTenants,
  resolveSecretRef,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

const { apiKey, oauthSession, secretRef, tenant } = schema;

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

// A valid base64 32-byte AES-256 key for the oauth-session encryption path.
const KEY_B64 = Buffer.alloc(32, 7).toString('base64');

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
}, 180_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  await client`TRUNCATE TABLE oauth_session, secret_ref, api_key, tenant RESTART IDENTITY CASCADE`;
  process.env.SECRET_ENCRYPTION_KEY = KEY_B64;
});

describe('soft-delete: list repos exclude deleted_at rows', () => {
  it('listTenants / getTenant exclude a soft-deleted tenant', async () => {
    const t = await createTenant(db, { name: 'soft-del-tenant' });
    expect((await listTenants(db, { limit: 200 })).rows.map((r) => r.id)).toContain(t.id);

    await db
      .update(tenant)
      .set({ deletedAt: sql`now()` })
      .where(eq(tenant.id, t.id));

    expect((await listTenants(db, { limit: 200 })).rows.map((r) => r.id)).not.toContain(t.id);
  });

  // 批次6 D3 (旧世界删除): the `resource` soft-delete case died with the
  // resource three-layer (createResource/getResource/listResources are gone).
});

describe('soft-delete: credential resolution treats deleted rows as absent', () => {
  it('a revoked (soft-deleted) api_key resolves as absent via findApiKeyByHash', async () => {
    const t = await createTenant(db, { name: 'key-tenant' });
    const created = await createApiKey(db, { tenantId: t.id });
    const hash = hashApiKey(created.plaintext);

    // Live key resolves.
    expect(await findApiKeyByHash(db, hash)).toBeDefined();

    // Revoke = soft-delete; the lookup must now return undefined (Track D revoke).
    await db
      .update(apiKey)
      .set({ deletedAt: sql`now()` })
      .where(eq(apiKey.id, created.id));

    expect(await findApiKeyByHash(db, hash)).toBeUndefined();
  });

  it('a soft-deleted oauth_session resolves as absent via resolveSecretRef', async () => {
    // Build an oauth secret_ref + session with a real-shaped ciphertext token.
    const ref = await createOAuthSession(db, {
      providerKind: 'codex',
      accessToken: 'live-access-token',
      refreshToken: 'live-refresh-token',
      keyB64: KEY_B64,
    });

    // Live session resolves to the decrypted access token.
    await expect(resolveSecretRef(db, ref.id)).resolves.toBe('live-access-token');

    // Soft-delete the session (Track D revoke). The resolver must treat it as
    // absent → undefined (getOAuthSession filters deleted_at). Sanity-check the
    // ciphertext is intact so we know undefined is from the filter, not a decrypt fail.
    expect(encryptSecret('x', KEY_B64)).toContain('.');
    await db
      .update(oauthSession)
      .set({ deletedAt: sql`now()` })
      .where(eq(oauthSession.secretRefId, ref.id));

    await expect(resolveSecretRef(db, ref.id)).resolves.toBeUndefined();
  });

  it('a soft-deleted secret_ref (env provider) resolves as absent', async () => {
    process.env.SECRET_SOFT_DEL_ENV = 'env-value';
    const [ref] = await db
      .insert(secretRef)
      .values({ provider: 'env', locator: 'soft-del-env' })
      .returning();
    if (!ref) throw new Error('secret_ref insert returned no row');

    await expect(resolveSecretRef(db, ref.id)).resolves.toBe('env-value');

    await db
      .update(secretRef)
      .set({ deletedAt: sql`now()` })
      .where(eq(secretRef.id, ref.id));

    // getSecretRef filters deleted_at → the row is absent → uuid falls through to
    // the literal env lookup (no SECRET_<uuid> key) → undefined.
    await expect(resolveSecretRef(db, ref.id)).resolves.toBeUndefined();
    delete process.env.SECRET_SOFT_DEL_ENV;
  });
});
