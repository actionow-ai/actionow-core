import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  claimRefreshLock,
  createOAuthSession,
  getDecryptedOAuthSession,
  getOAuthSession,
  listOAuthSessions,
  listRefreshableSessions,
  markNeedsReauth,
  resolveSecretRef,
  updateOAuthTokens,
} from '../src/repositories/index.js';
import * as schema from '../src/schema/index.js';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

const KEY = Buffer.alloc(32, 9).toString('base64');

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
  await client`TRUNCATE TABLE oauth_session, secret_ref RESTART IDENTITY CASCADE`;
});

describe('oauth_session repos (S1.2)', () => {
  it('stores tokens encrypted at rest and round-trips them via the decrypt fn', async () => {
    const ref = await createOAuthSession(db, {
      providerKind: 'codex',
      accessToken: 'access-plain-123',
      refreshToken: 'refresh-plain-456',
      accountLabel: 'work',
      accountId: 'acct-789',
      keyB64: KEY,
      expiresAt: new Date('2026-06-17T01:00:00.000Z'),
    });
    expect(ref.provider).toBe('oauth');

    // Ciphertext-at-rest: the raw row must NOT contain the plaintext tokens.
    const raw = await getOAuthSession(db, ref.id);
    expect(raw?.accessEnc).not.toContain('access-plain-123');
    expect(raw?.refreshEnc).not.toContain('refresh-plain-456');

    const dec = await getDecryptedOAuthSession(db, ref.id, KEY);
    expect(dec?.accessToken).toBe('access-plain-123');
    expect(dec?.refreshToken).toBe('refresh-plain-456');
    expect(dec?.accountId).toBe('acct-789');
    expect(dec?.providerKind).toBe('codex');
    expect(dec?.status).toBe('active');
  });

  it('singleflight refresh lock: first claim wins, second is rejected, clears on update', async () => {
    const ref = await createOAuthSession(db, {
      providerKind: 'codex',
      accessToken: 'a',
      refreshToken: 'r',
      keyB64: KEY,
    });
    const now = new Date('2026-06-17T00:00:00.000Z');

    expect(await claimRefreshLock(db, ref.id, now)).toBe(true);
    // A second claim within the staleness window is rejected (lock held).
    expect(await claimRefreshLock(db, ref.id, new Date(now.getTime() + 1_000))).toBe(false);

    // After a token update clears the lock, a fresh claim succeeds again.
    await updateOAuthTokens(db, ref.id, {
      accessToken: 'a2',
      refreshToken: 'r2',
      expiresAt: new Date(now.getTime() + 3_600_000),
      keyB64: KEY,
      now: new Date(now.getTime() + 2_000),
    });
    expect(await claimRefreshLock(db, ref.id, new Date(now.getTime() + 3_000))).toBe(true);
  });

  it('updateOAuthTokens rotates the tokens, stamps lastRefreshAt, and clears the lock', async () => {
    const ref = await createOAuthSession(db, {
      providerKind: 'codex',
      accessToken: 'old',
      refreshToken: 'oldr',
      keyB64: KEY,
    });
    const now = new Date('2026-06-17T00:30:00.000Z');
    const expiresAt = new Date(now.getTime() + 3_600_000);
    await claimRefreshLock(db, ref.id, now);

    await updateOAuthTokens(db, ref.id, {
      accessToken: 'new',
      refreshToken: 'new2',
      expiresAt,
      keyB64: KEY,
      now,
    });

    const dec = await getDecryptedOAuthSession(db, ref.id, KEY);
    expect(dec?.accessToken).toBe('new');
    expect(dec?.refreshToken).toBe('new2');

    const raw = await getOAuthSession(db, ref.id);
    expect(raw?.lastRefreshAt?.getTime()).toBe(now.getTime());
    expect(raw?.refreshLockAt).toBeNull();
    expect(raw?.expiresAt?.getTime()).toBe(expiresAt.getTime());
  });

  it('markNeedsReauth flips the status to needs_reauth', async () => {
    const ref = await createOAuthSession(db, {
      providerKind: 'codex',
      accessToken: 'a',
      refreshToken: 'r',
      keyB64: KEY,
    });
    await markNeedsReauth(db, ref.id);
    const raw = await getOAuthSession(db, ref.id);
    expect(raw?.status).toBe('needs_reauth');
  });

  it('listOAuthSessions returns every session token-free (no access/refresh enc keys)', async () => {
    await createOAuthSession(db, {
      providerKind: 'codex',
      accessToken: 'access-plain-1',
      refreshToken: 'refresh-plain-1',
      accountLabel: 'work',
      accountId: 'acct-1',
      keyB64: KEY,
      expiresAt: new Date('2026-06-17T01:00:00.000Z'),
    });
    await createOAuthSession(db, {
      providerKind: 'codex-oauth',
      accessToken: 'access-plain-2',
      refreshToken: 'refresh-plain-2',
      accountLabel: 'home',
      accountId: 'acct-2',
      keyB64: KEY,
    });

    const { rows } = await listOAuthSessions(db, { limit: 200 });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // token-free: ciphertext columns are not selected at all.
      expect(row).not.toHaveProperty('accessEnc');
      expect(row).not.toHaveProperty('refreshEnc');
      expect(row).not.toHaveProperty('refreshLockAt');
      // the metadata columns the admin view maps from ARE present.
      expect(row.secretRefId).toBeTypeOf('string');
      expect(row.providerKind).toBeTypeOf('string');
      expect(row.status).toBe('active');
    }
    // no plaintext token ever leaks into the listing.
    expect(JSON.stringify(rows)).not.toContain('access-plain-1');
    expect(JSON.stringify(rows)).not.toContain('refresh-plain-2');
  });

  it('listRefreshableSessions returns due+unlocked+active, excluding locked and needs_reauth', async () => {
    const now = new Date('2026-06-17T00:00:00.000Z');
    const leadMs = 5 * 60_000;
    const due = new Date(now.getTime() + 60_000); // within lead window

    // Due + unlocked + active → included.
    const refDue = await createOAuthSession(db, {
      providerKind: 'codex',
      accessToken: 'a',
      refreshToken: 'r',
      keyB64: KEY,
      expiresAt: due,
    });
    // Due but currently locked → excluded.
    const refLocked = await createOAuthSession(db, {
      providerKind: 'codex',
      accessToken: 'a',
      refreshToken: 'r',
      keyB64: KEY,
      expiresAt: due,
    });
    await claimRefreshLock(db, refLocked.id, now);
    // Due but needs_reauth → excluded.
    const refReauth = await createOAuthSession(db, {
      providerKind: 'codex',
      accessToken: 'a',
      refreshToken: 'r',
      keyB64: KEY,
      expiresAt: due,
    });
    await markNeedsReauth(db, refReauth.id);
    // Far-future expiry (outside lead) → excluded.
    await createOAuthSession(db, {
      providerKind: 'codex',
      accessToken: 'a',
      refreshToken: 'r',
      keyB64: KEY,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
    });

    const rows = await listRefreshableSessions(db, now, leadMs);
    const ids = rows.map((r) => r.secretRefId);
    expect(ids).toContain(refDue.id);
    expect(ids).not.toContain(refLocked.id);
    expect(ids).not.toContain(refReauth.id);
    expect(rows.length).toBe(1);
  });
});

describe('resolveSecretRef provider=oauth (S1.3)', () => {
  afterEach(() => {
    // Never leak the master key across cases.
    delete process.env.SECRET_ENCRYPTION_KEY;
  });

  it('resolves a valid active oauth session to its decrypted access token', async () => {
    const ref = await createOAuthSession(db, {
      providerKind: 'codex',
      accessToken: 'live-access-token',
      refreshToken: 'live-refresh-token',
      keyB64: KEY,
    });
    process.env.SECRET_ENCRYPTION_KEY = KEY;
    expect(await resolveSecretRef(db, ref.id)).toBe('live-access-token');
  });

  it('resolves to undefined once the session needs re-auth', async () => {
    const ref = await createOAuthSession(db, {
      providerKind: 'codex',
      accessToken: 'live-access-token',
      refreshToken: 'live-refresh-token',
      keyB64: KEY,
    });
    await markNeedsReauth(db, ref.id);
    process.env.SECRET_ENCRYPTION_KEY = KEY;
    expect(await resolveSecretRef(db, ref.id)).toBeUndefined();
  });

  it('resolves to undefined (no throw) when SECRET_ENCRYPTION_KEY is absent', async () => {
    const ref = await createOAuthSession(db, {
      providerKind: 'codex',
      accessToken: 'live-access-token',
      refreshToken: 'live-refresh-token',
      keyB64: KEY,
    });
    delete process.env.SECRET_ENCRYPTION_KEY;
    await expect(resolveSecretRef(db, ref.id)).resolves.toBeUndefined();
  });
});
