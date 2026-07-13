// 批次6 D2 — carved out of the old processors.int.test.ts (whose job-exec /
// hold-reaper / webhook-outbox suites died with the legacy job world): the
// token-refresh sweep still runs, so its coverage survives here unchanged.
import type { HttpClient } from '@actionow/contracts';
import { createOAuthSession, getDecryptedOAuthSession, schema } from '@actionow/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createTokenRefreshProcessor } from '../src/processors/index.js';
import type { WorkerRuntime } from '../src/runtime.js';

const { oauthSession } = schema;

/** Base64 AES-256 master key the token-refresh sweep encrypts/decrypts with. */
const KEY = Buffer.alloc(32, 9).toString('base64');

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });
}, 120_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  await client`TRUNCATE TABLE oauth_session, secret_ref RESTART IDENTITY CASCADE`;
});

function runtimeWith(http: HttpClient): WorkerRuntime {
  return {
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: container.getConnectionUri(),
      REDIS_URL: 'redis://localhost:6379',
      API_PORT: 3000,
      LOG_LEVEL: 'info',
      RATE_LIMIT_TENANT_PER_MIN: 600,
      RATE_LIMIT_RESOURCE_PER_MIN: 120,
      ADMIN_JWT_SECRET: 'test-secret',
      STORAGE_MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
      CREDIT_RATE: 1000,
      ALLOW_DEV_TENANT_HEADER: false,
      SECRET_ENCRYPTION_KEY: KEY,
      RELAY_TRACE: 'off',
      RELAY_TRACE_MAX_BYTES: 1_000_000,
    },
    db,
    http,
    storage: null,
    publicBaseUrl: undefined,
  };
}

function codexTokenHttp(res: { status: number; ok: boolean; body: unknown; text: string }): {
  http: HttpClient;
  calls: { url: string }[];
} {
  const calls: { url: string }[] = [];
  const http: HttpClient = {
    request: (req) => {
      calls.push({ url: req.url });
      return Promise.resolve(res);
    },
  };
  return { http, calls };
}

describe('token-refresh processor', () => {
  it('rotates a near-expiry codex session, advances expiry, clears the lock', async () => {
    const ref = await createOAuthSession(db, {
      providerKind: 'codex-oauth',
      accessToken: 'old',
      refreshToken: 'rt-1',
      keyB64: KEY,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { http, calls } = codexTokenHttp({
      status: 200,
      ok: true,
      body: { access_token: 'new', refresh_token: 'rt-2', id_token: 'id.jwt.x', expires_in: 3600 },
      text: 'ok',
    });
    const process = createTokenRefreshProcessor(runtimeWith(http));

    const refreshed = await process();

    expect(refreshed).toBe(1);
    expect(calls).toHaveLength(1);
    const after = await getDecryptedOAuthSession(db, ref.id, KEY);
    expect(after?.accessToken).toBe('new');
    expect(after?.refreshToken).toBe('rt-2');
    // Expiry advanced to ~now + 3600s, well past the original now+60s.
    expect(after?.expiresAt?.getTime() ?? 0).toBeGreaterThan(Date.now() + 60 * 60_000 - 60_000);
    const [row] = await db.select().from(oauthSession).where(eq(oauthSession.secretRefId, ref.id));
    expect(row?.refreshLockAt).toBeNull();
  });

  it('does NOT refresh a session whose expiry is far in the future', async () => {
    const ref = await createOAuthSession(db, {
      providerKind: 'codex-oauth',
      accessToken: 'old',
      refreshToken: 'rt-1',
      keyB64: KEY,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    });
    const { http, calls } = codexTokenHttp({
      status: 200,
      ok: true,
      body: { access_token: 'new', refresh_token: 'rt-2', expires_in: 3600 },
      text: 'ok',
    });
    const process = createTokenRefreshProcessor(runtimeWith(http));

    const refreshed = await process();

    expect(refreshed).toBe(0);
    expect(calls).toHaveLength(0);
    const after = await getDecryptedOAuthSession(db, ref.id, KEY);
    expect(after?.accessToken).toBe('old');
  });

  it('marks a session needs_reauth when the refresh token was reused', async () => {
    const ref = await createOAuthSession(db, {
      providerKind: 'codex-oauth',
      accessToken: 'old',
      refreshToken: 'rt-1',
      keyB64: KEY,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { http } = codexTokenHttp({
      status: 400,
      ok: false,
      body: { error: 'invalid_grant', error_description: 'refresh_token_reused' },
      text: 'refresh_token_reused',
    });
    const process = createTokenRefreshProcessor(runtimeWith(http));

    const refreshed = await process();

    expect(refreshed).toBe(0);
    const [row] = await db.select().from(oauthSession).where(eq(oauthSession.secretRefId, ref.id));
    expect(row?.status).toBe('needs_reauth');
    expect(row?.refreshLockAt).toBeNull();
    // Tokens untouched (still decrypts to the original).
    const after = await getDecryptedOAuthSession(db, ref.id, KEY);
    expect(after?.accessToken).toBe('old');
  });
});
