import { createHash } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createSession,
  createUser,
  findLiveSessionByHash,
  findSessionByHashAnyState,
  generateRefreshToken,
  hashRefreshToken,
  revokeFamily,
  revokeSession,
  revokeSessionsForPrincipal,
  rotateSession,
  sweepExpiredSessions,
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
}, 180_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

afterEach(async () => {
  await client`TRUNCATE TABLE session, "user", tenant RESTART IDENTITY CASCADE`;
});

/** Create a user row → return its id (for `principal_kind='user'` linkage). */
async function makeUser(email = 'u@x.com'): Promise<string> {
  const u = await createUser(db, { email, role: 'user', tenantRole: 'admin', passwordHash: 'x' });
  return u.id;
}

const FUTURE = (): Date => new Date(Date.now() + 60 * 60 * 1000);
const PAST = (): Date => new Date(Date.now() - 60 * 60 * 1000);

describe('generateRefreshToken / hashRefreshToken', () => {
  it('mints an rt_ prefixed plaintext and hashes to sha256 hex', () => {
    const plain = generateRefreshToken();
    expect(plain).toMatch(/^rt_[A-Za-z0-9_-]+$/);
    expect(hashRefreshToken(plain)).toBe(createHash('sha256').update(plain).digest('hex'));
  });

  it('mints distinct tokens each call', () => {
    expect(generateRefreshToken()).not.toBe(generateRefreshToken());
  });
});

describe('createSession', () => {
  it('persists ONLY the hash (never the plaintext)', async () => {
    const userId = await makeUser();
    const plain = generateRefreshToken();
    const hash = hashRefreshToken(plain);
    const row = await createSession(db, {
      principalKind: 'user',
      userId,
      refreshHash: hash,
      familyId: crypto.randomUUID(),
      expiresAt: FUTURE(),
    });
    const [stored] = await db.select().from(schema.session).where(eq(schema.session.id, row.id));
    expect(stored?.refreshHash).toBe(hash);
    expect(stored?.refreshHash).not.toContain(plain);
    expect(stored?.principalKind).toBe('user');
    expect(stored?.userId).toBe(userId);
    expect(stored?.revokedAt).toBeNull();
  });
});

describe('findLiveSessionByHash', () => {
  it('returns a live session, ignores expired and revoked', async () => {
    const userId = await makeUser();
    const familyId = crypto.randomUUID();

    // live
    const livePlain = generateRefreshToken();
    await createSession(db, {
      principalKind: 'user',
      userId,
      refreshHash: hashRefreshToken(livePlain),
      familyId,
      expiresAt: FUTURE(),
    });
    expect(await findLiveSessionByHash(db, hashRefreshToken(livePlain))).toBeDefined();

    // expired
    const expPlain = generateRefreshToken();
    await createSession(db, {
      principalKind: 'user',
      userId,
      refreshHash: hashRefreshToken(expPlain),
      familyId,
      expiresAt: PAST(),
    });
    expect(await findLiveSessionByHash(db, hashRefreshToken(expPlain))).toBeUndefined();

    // revoked
    const revPlain = generateRefreshToken();
    const rev = await createSession(db, {
      principalKind: 'user',
      userId,
      refreshHash: hashRefreshToken(revPlain),
      familyId,
      expiresAt: FUTURE(),
    });
    await revokeSession(db, rev.id);
    expect(await findLiveSessionByHash(db, hashRefreshToken(revPlain))).toBeUndefined();
    // but it is still present via the any-state lookup (reuse-detection input)
    expect(await findSessionByHashAnyState(db, hashRefreshToken(revPlain))).toBeDefined();
  });
});

describe('rotateSession', () => {
  it('inserts a new row in the SAME family and revokes the old with replaced_by', async () => {
    const userId = await makeUser();
    const familyId = crypto.randomUUID();
    const oldPlain = generateRefreshToken();
    const old = await createSession(db, {
      principalKind: 'user',
      userId,
      refreshHash: hashRefreshToken(oldPlain),
      familyId,
      expiresAt: FUTURE(),
    });

    const nextPlain = generateRefreshToken();
    const next = await rotateSession(db, old, {
      refreshHash: hashRefreshToken(nextPlain),
      expiresAt: FUTURE(),
    });

    expect(next.familyId).toBe(familyId);
    expect(next.id).not.toBe(old.id);
    // old row is now revoked + points at the new one
    const [reloaded] = await db.select().from(schema.session).where(eq(schema.session.id, old.id));
    expect(reloaded?.revokedAt).not.toBeNull();
    expect(reloaded?.replacedBy).toBe(next.id);
    // new refresh resolves live; old does not
    expect(await findLiveSessionByHash(db, hashRefreshToken(nextPlain))).toBeDefined();
    expect(await findLiveSessionByHash(db, hashRefreshToken(oldPlain))).toBeUndefined();
  });
});

describe('revokeFamily', () => {
  it('revokes every live row of a family', async () => {
    const userId = await makeUser();
    const familyId = crypto.randomUUID();
    for (let i = 0; i < 3; i++) {
      await createSession(db, {
        principalKind: 'user',
        userId,
        refreshHash: hashRefreshToken(generateRefreshToken()),
        familyId,
        expiresAt: FUTURE(),
      });
    }
    // a different family is unaffected
    const otherPlain = generateRefreshToken();
    await createSession(db, {
      principalKind: 'user',
      userId,
      refreshHash: hashRefreshToken(otherPlain),
      familyId: crypto.randomUUID(),
      expiresAt: FUTURE(),
    });

    const revoked = await revokeFamily(db, familyId);
    expect(revoked).toBe(3);
    // re-run is a no-op (nothing live left)
    expect(await revokeFamily(db, familyId)).toBe(0);
    // the other family is still live
    expect(await findLiveSessionByHash(db, hashRefreshToken(otherPlain))).toBeDefined();
  });
});

describe('revokeSessionsForPrincipal', () => {
  it('revokes every live session of a user across families; leaves other users', async () => {
    const userId = await makeUser('a@x.com');
    const otherUserId = await makeUser('b@x.com');

    // The target user has two sessions in DIFFERENT families (e.g. two devices).
    const p1 = generateRefreshToken();
    const p2 = generateRefreshToken();
    for (const p of [p1, p2]) {
      await createSession(db, {
        principalKind: 'user',
        userId,
        refreshHash: hashRefreshToken(p),
        familyId: crypto.randomUUID(),
        expiresAt: FUTURE(),
      });
    }
    // A different user's session must NOT be touched.
    const otherPlain = generateRefreshToken();
    await createSession(db, {
      principalKind: 'user',
      userId: otherUserId,
      refreshHash: hashRefreshToken(otherPlain),
      familyId: crypto.randomUUID(),
      expiresAt: FUTURE(),
    });

    const revoked = await revokeSessionsForPrincipal(db, { userId });
    expect(revoked).toBe(2);
    // both of the target user's sessions are dead across families…
    expect(await findLiveSessionByHash(db, hashRefreshToken(p1))).toBeUndefined();
    expect(await findLiveSessionByHash(db, hashRefreshToken(p2))).toBeUndefined();
    // …the other user is untouched…
    expect(await findLiveSessionByHash(db, hashRefreshToken(otherPlain))).toBeDefined();
    // …and a re-run is an idempotent no-op.
    expect(await revokeSessionsForPrincipal(db, { userId })).toBe(0);
  });
});

describe('sweepExpiredSessions', () => {
  it('hard-deletes rows past the cutoff', async () => {
    const userId = await makeUser();
    await createSession(db, {
      principalKind: 'user',
      userId,
      refreshHash: hashRefreshToken(generateRefreshToken()),
      familyId: crypto.randomUUID(),
      expiresAt: PAST(),
    });
    const livePlain = generateRefreshToken();
    await createSession(db, {
      principalKind: 'user',
      userId,
      refreshHash: hashRefreshToken(livePlain),
      familyId: crypto.randomUUID(),
      expiresAt: FUTURE(),
    });

    const deleted = await sweepExpiredSessions(db, new Date());
    expect(deleted).toBe(1);
    expect(await findLiveSessionByHash(db, hashRefreshToken(livePlain))).toBeDefined();
  });
});
