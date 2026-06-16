import { createUser, createUserIdentity, schema } from '@actionow/db';
import { hashPassword } from '@actionow/infra';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DB, ENV } from '../src/common/tokens.js';

const ADMIN_SECRET = 'e2e-oauth-secret';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;
let app: INestApplication;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(ENV)
    .useValue({
      NODE_ENV: 'test',
      DATABASE_URL: container.getConnectionUri(),
      REDIS_URL: 'redis://localhost:6379',
      API_PORT: 3000,
      LOG_LEVEL: 'info',
      DEV_TENANT_ID: undefined,
      RATE_LIMIT_TENANT_PER_MIN: 600,
      RATE_LIMIT_RESOURCE_PER_MIN: 120,
      ADMIN_JWT_SECRET: ADMIN_SECRET,
      GOOGLE_CLIENT_ID: 'google-client-id',
      GOOGLE_CLIENT_SECRET: 'google-client-secret',
      GITHUB_CLIENT_ID: 'github-client-id',
      GITHUB_CLIENT_SECRET: 'github-client-secret',
      OAUTH_REDIRECT_BASE: 'http://localhost:3000',
    })
    .compile();

  app = moduleRef.createNestApplication();
  await app.init();
}, 180_000);

afterAll(async () => {
  await app.close();
  await client.end();
  await container.stop();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await client`TRUNCATE TABLE api_key, account, user_identity, "user", tenant RESTART IDENTITY CASCADE`;
});

function claimsOf(token: string): { sub: string; role: string } {
  return new JwtService({ secret: ADMIN_SECRET }).verify<{ sub: string; role: string }>(token);
}

/** Base64url-encode (no padding) a UTF-8 string. */
function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

/**
 * Build a fake (unsigned) id_token JWT that arctic's `decodeIdToken` can decode.
 * It only base64url-decodes the payload — header/signature are inert.
 */
function fakeIdToken(claims: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  const sig = b64url('signature');
  return `${header}.${payload}.${sig}`;
}

/** A canned JSON `Response` (the only shape arctic + our fetches read). */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** The argument shapes our stubbed fetch sees (arctic passes a `Request`). */
type FetchInput = Request | string | URL;

/** Resolve the request URL whether fetch is called with a string or a Request. */
function urlOf(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return String(input);
}

/**
 * Stub global fetch for a Google flow: the token endpoint returns an id_token
 * carrying the given claims. (GitHub `api.github.com` is never hit for Google.)
 */
function stubGoogle(claims: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: FetchInput) => {
      const url = urlOf(input);
      if (url.includes('oauth2.googleapis.com') || url.includes('googleapis.com/token')) {
        return Promise.resolve(
          jsonResponse({
            access_token: 'g-access-token',
            token_type: 'Bearer',
            expires_in: 3600,
            id_token: fakeIdToken(claims),
          }),
        );
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }),
  );
}

/**
 * Stub global fetch for a GitHub flow: the token endpoint returns an
 * access_token; `/user` returns the id; `/user/emails` returns the email list.
 */
function stubGithub(id: number, email: string, verified: boolean): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: FetchInput) => {
      const url = urlOf(input);
      if (url.includes('github.com/login/oauth/access_token')) {
        return Promise.resolve(
          jsonResponse({ access_token: 'gh-access-token', token_type: 'bearer', scope: '' }),
        );
      }
      if (url === 'https://api.github.com/user') {
        return Promise.resolve(jsonResponse({ id, login: `user${String(id)}` }));
      }
      if (url === 'https://api.github.com/user/emails') {
        return Promise.resolve(jsonResponse([{ email, primary: true, verified }]));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }),
  );
}

/** Read the `oauth_state` / `oauth_verifier` cookie values off a `start` 302. */
function startFlow(setCookie: string[] | undefined): { state: string; verifier?: string } {
  const cookies = setCookie ?? [];
  let state = '';
  let verifier: string | undefined;
  for (const c of cookies) {
    const m = /^oauth_state=([^;]+)/.exec(c);
    if (m?.[1] !== undefined) state = decodeURIComponent(m[1]);
    const v = /^oauth_verifier=([^;]+)/.exec(c);
    if (v?.[1] !== undefined) verifier = decodeURIComponent(v[1]);
  }
  return verifier === undefined ? { state } : { state, verifier };
}

/** Issue a JWT for an existing user id (to act as an authenticated caller). */
function tokenFor(sub: string, role: string): string {
  return new JwtService({ secret: ADMIN_SECRET }).sign({ sub, role });
}

describe('GET /auth/oauth/:provider (start)', () => {
  it('302-redirects to Google with PKCE + sets oauth_state + oauth_verifier cookies', async () => {
    const res = await request(app.getHttpServer()).get('/auth/oauth/google').expect(302);
    const url = new URL(String(res.headers.location));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    expect(setCookie.some((c) => c.startsWith('oauth_state='))).toBe(true);
    expect(setCookie.some((c) => c.startsWith('oauth_verifier='))).toBe(true);
    expect(setCookie.every((c) => c.includes('HttpOnly'))).toBe(true);
  });

  it('302-redirects to GitHub with state + no verifier cookie', async () => {
    const res = await request(app.getHttpServer()).get('/auth/oauth/github').expect(302);
    const url = new URL(String(res.headers.location));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    expect(setCookie.some((c) => c.startsWith('oauth_state='))).toBe(true);
    expect(setCookie.some((c) => c.startsWith('oauth_verifier='))).toBe(false);
  });

  it('400 invalid_input for an unknown provider', async () => {
    const res = await request(app.getHttpServer()).get('/auth/oauth/facebook').expect(400);
    expect(res.body.error.code).toBe('invalid_input');
  });
});

describe('GET /auth/oauth/:provider/callback (find-or-create)', () => {
  it('NEW (provider,sub) → creates user + identity + tenant/account, returns a user token', async () => {
    const start = await request(app.getHttpServer()).get('/auth/oauth/github').expect(302);
    const { state } = startFlow(start.headers['set-cookie'] as unknown as string[]);
    stubGithub(424242, 'gh-new@example.com', true);

    const res = await request(app.getHttpServer())
      .get('/auth/oauth/github/callback')
      .query({ code: 'gh-code', state })
      .set('Cookie', `oauth_state=${state}`)
      .expect(200);

    expect(res.body.token).toBeTypeOf('string');
    const claims = claimsOf(res.body.token as string);
    expect(claims.role).toBe('user');

    // The identity row keys on (provider, sub) and points at the new user.
    const identities = await db
      .select()
      .from(schema.userIdentity)
      .where(eq(schema.userIdentity.providerUserId, '424242'));
    expect(identities).toHaveLength(1);
    expect(identities[0]?.provider).toBe('github');
    expect(identities[0]?.userId).toBe(claims.sub);

    // A tenant + account were provisioned for the lightweight-registered user.
    const [user] = await db.select().from(schema.user).where(eq(schema.user.id, claims.sub));
    expect(user?.passwordHash).toBeNull();
    expect(user?.tenantId).toBeTypeOf('string');
    const [account] = await db
      .select()
      .from(schema.account)
      .where(eq(schema.account.tenantId, user?.tenantId ?? ''));
    expect(account?.id).toBeTypeOf('string');
  });

  it('EXISTING identity → logs in the SAME user, no duplicate identity row', async () => {
    // First callback creates the user + identity.
    const first = await request(app.getHttpServer()).get('/auth/oauth/github').expect(302);
    const { state: s1 } = startFlow(first.headers['set-cookie'] as unknown as string[]);
    stubGithub(777, 'gh-existing@example.com', true);
    const r1 = await request(app.getHttpServer())
      .get('/auth/oauth/github/callback')
      .query({ code: 'c1', state: s1 })
      .set('Cookie', `oauth_state=${s1}`)
      .expect(200);
    const id1 = claimsOf(r1.body.token as string).sub;

    // Second callback with the SAME (provider, sub) logs the same user in.
    const second = await request(app.getHttpServer()).get('/auth/oauth/github').expect(302);
    const { state: s2 } = startFlow(second.headers['set-cookie'] as unknown as string[]);
    stubGithub(777, 'gh-existing@example.com', true);
    const r2 = await request(app.getHttpServer())
      .get('/auth/oauth/github/callback')
      .query({ code: 'c2', state: s2 })
      .set('Cookie', `oauth_state=${s2}`)
      .expect(200);
    const id2 = claimsOf(r2.body.token as string).sub;

    expect(id2).toBe(id1);
    const identities = await db
      .select()
      .from(schema.userIdentity)
      .where(eq(schema.userIdentity.providerUserId, '777'));
    expect(identities).toHaveLength(1);
  });

  it('VERIFIED provider email matching a VERIFIED existing user → auto-links (same user id)', async () => {
    const existing = await createUser(db, {
      email: 'shared@example.com',
      passwordHash: hashPassword('localpass'),
      role: 'user',
      emailVerified: true,
    });

    const start = await request(app.getHttpServer()).get('/auth/oauth/google').expect(302);
    const { state } = startFlow(start.headers['set-cookie'] as unknown as string[]);
    stubGoogle({
      sub: 'google-sub-1',
      email: 'shared@example.com',
      email_verified: true,
      name: 'Shared',
    });

    const res = await request(app.getHttpServer())
      .get('/auth/oauth/google/callback')
      .query({ code: 'g-code', state })
      .set('Cookie', `oauth_state=${state}; oauth_verifier=ignored`)
      .expect(200);

    // Same user id — the identity was attached to the existing account.
    expect(claimsOf(res.body.token as string).sub).toBe(existing.id);
    const identities = await db
      .select()
      .from(schema.userIdentity)
      .where(eq(schema.userIdentity.userId, existing.id));
    expect(identities).toHaveLength(1);
    expect(identities[0]?.provider).toBe('google');
  });

  it('UNVERIFIED provider email does NOT auto-link → a separate new user', async () => {
    const existing = await createUser(db, {
      email: 'noauto@example.com',
      passwordHash: hashPassword('localpass'),
      role: 'user',
      emailVerified: true,
    });

    const start = await request(app.getHttpServer()).get('/auth/oauth/google').expect(302);
    const { state } = startFlow(start.headers['set-cookie'] as unknown as string[]);
    stubGoogle({
      sub: 'google-sub-unverified',
      email: 'noauto@example.com',
      email_verified: false,
      name: 'NoAuto',
    });

    const res = await request(app.getHttpServer())
      .get('/auth/oauth/google/callback')
      .query({ code: 'g-code', state })
      .set('Cookie', `oauth_state=${state}; oauth_verifier=ignored`)
      .expect(200);

    // A DIFFERENT user id — no auto-link on an unverified provider email.
    const newUserId = claimsOf(res.body.token as string).sub;
    expect(newUserId).not.toBe(existing.id);
    const existingIdentities = await db
      .select()
      .from(schema.userIdentity)
      .where(eq(schema.userIdentity.userId, existing.id));
    expect(existingIdentities).toHaveLength(0);
  });

  it('400 invalid_input when the callback state does not match the cookie', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth/oauth/github/callback')
      .query({ code: 'gh-code', state: 'attacker-state' })
      .set('Cookie', `oauth_state=real-state`)
      .expect(400);
    expect(res.body.error.code).toBe('invalid_input');
  });
});

describe('POST /auth/link/:provider (authenticated linking)', () => {
  it('adds an identity to the current user', async () => {
    const user = await createUser(db, {
      email: 'linker@example.com',
      passwordHash: hashPassword('pw'),
      role: 'user',
      emailVerified: true,
    });
    stubGithub(555, 'linker-gh@example.com', true);

    await request(app.getHttpServer())
      .post('/auth/link/github')
      .set('authorization', `Bearer ${tokenFor(user.id, 'user')}`)
      .send({ code: 'gh-code' })
      .expect(200);

    const identities = await db
      .select()
      .from(schema.userIdentity)
      .where(eq(schema.userIdentity.userId, user.id));
    expect(identities).toHaveLength(1);
    expect(identities[0]?.provider).toBe('github');
    expect(identities[0]?.providerUserId).toBe('555');
  });

  it('401 without a JWT', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/link/github')
      .send({ code: 'gh-code' })
      .expect(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('rejects linking a (provider,sub) already owned by another user', async () => {
    const owner = await createUser(db, {
      email: 'owner@example.com',
      role: 'user',
      emailVerified: true,
    });
    await createUserIdentity(db, { userId: owner.id, provider: 'github', providerUserId: '999' });

    const other = await createUser(db, {
      email: 'other@example.com',
      passwordHash: hashPassword('pw'),
      role: 'user',
      emailVerified: true,
    });
    stubGithub(999, 'owner-gh@example.com', true);

    const res = await request(app.getHttpServer())
      .post('/auth/link/github')
      .set('authorization', `Bearer ${tokenFor(other.id, 'user')}`)
      .send({ code: 'gh-code' })
      .expect(400);
    expect(res.body.error.code).toBe('invalid_input');

    // The owner still has exactly one identity; nothing was added to `other`.
    const otherIdentities = await db
      .select()
      .from(schema.userIdentity)
      .where(eq(schema.userIdentity.userId, other.id));
    expect(otherIdentities).toHaveLength(0);
  });
});
