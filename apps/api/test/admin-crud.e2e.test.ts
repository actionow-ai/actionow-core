import type { HttpClient, HttpRequest, HttpResponse } from '@actionow/contracts';
import {
  createOAuthSession,
  createUser,
  getDecryptedOAuthSession,
  listRefreshableSessions,
  resolveSecretRef,
  schema,
} from '@actionow/db';
import { hashPassword } from '@actionow/infra';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DB, ENV, HTTP } from '../src/common/tokens.js';
import { resetDb } from './reset-db.js';

/**
 * A controllable fake {@link HttpClient}: captures the last request (so tests can
 * assert the form-encoded exchange body) and a call count (so the gate-off test
 * can prove the upstream was never hit), and returns a canned response.
 */
class FakeHttpClient implements HttpClient {
  calls = 0;
  lastRequest: HttpRequest | undefined;
  next: HttpResponse = { status: 200, ok: true, body: {}, text: '' };

  request(req: HttpRequest): Promise<HttpResponse> {
    this.calls += 1;
    this.lastRequest = req;
    return Promise.resolve(this.next);
  }

  reset(): void {
    this.calls = 0;
    this.lastRequest = undefined;
    this.next = { status: 200, ok: true, body: {}, text: '' };
  }
}

const fakeHttp = new FakeHttpClient();

const ADMIN_SECRET = 'e2e-admin-secret';
const ADMIN_EMAIL = 'admin@actionow.local';
const ADMIN_PASSWORD = 'hunter2';
/** A deterministic 32-byte base64 AES-256 master key for the secrets endpoint. */
const SECRET_KEY_B64 = Buffer.alloc(32, 3).toString('base64');

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
      NODE_ENV: 'production',
      CREDIT_RATE: 1000,
      DATABASE_URL: container.getConnectionUri(),
      REDIS_URL: 'redis://localhost:6379',
      API_PORT: 3000,
      LOG_LEVEL: 'info',
      DEV_TENANT_ID: undefined,
      RATE_LIMIT_TENANT_PER_MIN: 600,
      RATE_LIMIT_RESOURCE_PER_MIN: 120,
      ADMIN_JWT_SECRET: ADMIN_SECRET,
      SECRET_ENCRYPTION_KEY: SECRET_KEY_B64,
      ENABLE_OAUTH_CHANNELS: true,
    })
    .overrideProvider(HTTP)
    .useValue(fakeHttp)
    .compile();

  app = moduleRef.createNestApplication();
  await app.init();
}, 180_000);

afterAll(async () => {
  await app.close();
  await client.end();
  await container.stop();
});

let token: string;

beforeEach(async () => {
  await createUser(db, {
    email: ADMIN_EMAIL,
    passwordHash: hashPassword(ADMIN_PASSWORD),
    role: 'admin',
    emailVerified: true,
  });
  const res = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    .expect(200);
  token = res.body.token as string;
});

afterEach(async () => {
  await resetDb(
    () =>
      client`TRUNCATE TABLE request_idempotency, route_group_channel, route_group, api_key, sub_account, subject, ledger_txn, dify_binding, redemption_code, pricebook_entry, upstream_channel, resource_version, resource, modifier, account, tenant, oauth_session, secret_material, secret_ref, "user" RESTART IDENTITY CASCADE`,
  );
});

function auth(req: request.Test): request.Test {
  return req.set('authorization', `Bearer ${token}`);
}

describe('admin CRUD flow', () => {
  it('rejects unauthenticated admin requests with 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/tenants')
      .send({ name: 'acme' })
      .expect(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('drives create tenant → account → topup → api-key → resource → pricebook', async () => {
    // 1. tenant
    const tenantRes = await auth(
      request(app.getHttpServer()).post('/admin/tenants').send({ name: 'acme' }),
    ).expect(201);
    const tenantId = tenantRes.body.id as string;
    expect(tenantId).toBeTypeOf('string');

    const tenantsList = await auth(request(app.getHttpServer()).get('/admin/tenants')).expect(200);
    expect(tenantsList.body.data.map((t: { id: string }) => t.id)).toContain(tenantId);

    // 2. account with a 50-credit opening balance → stored as 50_000_000 µcredits
    const acctRes = await auth(
      request(app.getHttpServer()).post('/admin/accounts').send({ tenantId, credits: 50 }),
    ).expect(201);
    const accountId = acctRes.body.id as string;
    expect(acctRes.body.credit_balance).toBe('50000000');

    // 3. topup 100 credits → +100_000_000 µcredits → balance 150_000_000
    const topupRes = await auth(
      request(app.getHttpServer())
        .post(`/admin/accounts/${accountId}/topup`)
        .send({ credits: 100 }),
    ).expect(200);
    expect(topupRes.body.balance).toBe('150000000');

    // ledger has a topup row with the µcredit delta
    const [ledgerRow] = await db.select().from(schema.ledgerTxn);
    expect(ledgerRow?.type).toBe('topup');
    expect(ledgerRow?.creditsDelta).toBe(100_000_000n);

    // 4. api key — plaintext returned ONCE; only the hash is stored
    const keyRes = await auth(
      request(app.getHttpServer())
        .post('/admin/api-keys')
        .send({ tenantId, resourceAllowlist: ['xhs'] }),
    ).expect(201);
    expect(keyRes.body.plaintext).toMatch(/^ak_/);
    const [keyRow] = await db.select().from(schema.apiKey);
    expect(keyRow?.hash).toBeTypeOf('string');
    expect(keyRow?.hash).not.toContain(keyRes.body.plaintext);

    const keyList = await auth(
      request(app.getHttpServer()).get('/admin/api-keys').query({ tenantId }),
    ).expect(200);
    expect(keyList.body.data).toHaveLength(1);
    expect(keyList.body.has_more).toBe(false);
    expect(keyList.body.next_cursor).toBeNull();
    expect(keyList.body.data[0]).not.toHaveProperty('hash');
    expect(keyList.body.data[0].resource_allowlist).toEqual(['xhs']);

    // 5. resource
    const resourceRes = await auth(
      request(app.getHttpServer())
        .post('/admin/resources')
        .send({
          id: 'gpt',
          tenantId,
          kind: 'model',
          modality: 'text',
          providerType: 'openai',
          execModes: ['blocking'],
          ioSchema: {
            inputs: [{ key: 'prompt', type: 'string', required: true }],
            outputs: [{ key: 'text', type: 'string' }],
          },
        }),
    ).expect(201);
    expect(resourceRes.body.id).toBe('gpt');
    expect(resourceRes.body.current_version).toBe(1);

    // channel
    await auth(
      request(app.getHttpServer())
        .post('/admin/resources/gpt/channels')
        .send({ providerType: 'openai', weight: 1 }),
    ).expect(201);

    // 6. pricebook — a fixed 2-credit entry → stored as 2_000_000 µcredits
    const pbRes = await auth(
      request(app.getHttpServer()).post('/admin/pricebook').send({
        resourceId: 'gpt',
        resourceVersion: 1,
        version: 1,
        method: 'fixed',
        timing: 'pre',
        spec: {},
        fixedCredits: 2,
      }),
    ).expect(201);
    expect(pbRes.body.spec.amount).toBe('2000000');

    const pbList = await auth(
      request(app.getHttpServer()).get('/admin/pricebook').query({ resourceId: 'gpt' }),
    ).expect(200);
    expect(pbList.body.data).toHaveLength(1);

    // ledger endpoint returns the topup row
    const ledgerView = await auth(
      request(app.getHttpServer()).get('/admin/ledger').query({ tenantId }),
    ).expect(200);
    expect(ledgerView.body.data[0].type).toBe('topup');
    expect(ledgerView.body.data[0].credits_delta).toBe('100000000');
  });

  it('manages channels: create with routing fields, patch, and list (P0b)', async () => {
    const tenantRes = await auth(
      request(app.getHttpServer()).post('/admin/tenants').send({ name: 'chan' }),
    ).expect(201);
    const tenantId = tenantRes.body.id as string;
    await auth(
      request(app.getHttpServer())
        .post('/admin/resources')
        .send({
          id: 'chat-res',
          tenantId,
          kind: 'model',
          modality: 'text',
          providerType: 'openai',
          execModes: ['stream'],
          ioSchema: { inputs: [], outputs: [] },
        }),
    ).expect(201);

    // create with the full routing field set the engine honors
    const created = await auth(
      request(app.getHttpServer())
        .post('/admin/resources/chat-res/channels')
        .send({
          providerType: 'openai',
          endpoint: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
          proxyRef: 'upstream_proxy',
          config: { region: 'us' },
          weight: 2,
        }),
    ).expect(201);
    expect(created.body.endpoint).toBe('https://api.deepseek.com/v1');
    expect(created.body.model).toBe('deepseek-chat');
    expect(created.body.proxy_ref).toBe('upstream_proxy');
    expect(created.body.config).toEqual({ region: 'us' });
    const channelId = created.body.id as string;

    // patch weight + status + endpoint; other fields untouched
    const patched = await auth(
      request(app.getHttpServer())
        .patch(`/admin/resources/chat-res/channels/${channelId}`)
        .send({ weight: 5, status: 'disabled', endpoint: 'https://api.openai.com/v1' }),
    ).expect(200);
    expect(patched.body.weight).toBe(5);
    expect(patched.body.status).toBe('disabled');
    expect(patched.body.endpoint).toBe('https://api.openai.com/v1');
    expect(patched.body.model).toBe('deepseek-chat');

    // list includes the now-disabled channel (operator view)
    const list = await auth(
      request(app.getHttpServer()).get('/admin/resources/chat-res/channels'),
    ).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].id).toBe(channelId);
    expect(list.body.data[0].status).toBe('disabled');
  });

  it('creates a scope-aware modifier with a µcredit value', async () => {
    const tenantRes = await auth(
      request(app.getHttpServer()).post('/admin/tenants').send({ name: 'mod' }),
    ).expect(201);
    const tenantId = tenantRes.body.id as string;

    // flat_off 3 credits → stored as 3_000_000 µcredits
    const modRes = await auth(
      request(app.getHttpServer())
        .post('/admin/modifiers')
        .send({ scope: `tenant:${tenantId}`, op: 'flat_off', value: 3, priority: 5 }),
    ).expect(201);
    expect(modRes.body.value).toBe('3000000');

    // percent_off keeps the raw whole-percent integer
    const pctRes = await auth(
      request(app.getHttpServer())
        .post('/admin/modifiers')
        .send({ scope: 'global', op: 'percent_off', value: 10 }),
    ).expect(201);
    expect(pctRes.body.value).toBe('10');

    const list = await auth(request(app.getHttpServer()).get('/admin/modifiers')).expect(200);
    expect(list.body.data).toHaveLength(2);
  });

  it('creates an encrypted secret and never echoes the plaintext (F0)', async () => {
    const secret = await auth(
      request(app.getHttpServer())
        .post('/admin/secrets')
        .send({ value: 'sk-live-xyz', label: 'openai' }),
    ).expect(201);
    expect(secret.body.provider).toBe('enc');
    expect(secret.body.id).toMatch(/^[0-9a-f-]{36}$/); // a uuid usable as a channel credentialRef
    expect(JSON.stringify(secret.body)).not.toContain('sk-live-xyz'); // plaintext never returned
  });

  it('rejects a malformed body with 400 invalid_input', async () => {
    const res = await auth(
      request(app.getHttpServer()).post('/admin/tenants').send({ name: '' }),
    ).expect(400);
    expect(res.body.error.code).toBe('invalid_input');
  });
});

/**
 * Craft a (NOT verified) ChatGPT id_token: `header.<base64url(claims)>.sig`.
 * The service reads `chatgpt_account_id` under the `https://api.openai.com/auth`
 * claim and the top-level `email` via `parseChatgptIdentity`.
 */
function craftIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('POST /admin/oauth-sessions (paste-auth, ToS-gated)', () => {
  const idToken = craftIdToken({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_codex_1' },
    email: 'op@example.com',
  });

  it('registers a codex oauth session, derives the account id, never echoes tokens', async () => {
    const res = await auth(
      request(app.getHttpServer())
        .post('/admin/oauth-sessions')
        .send({
          providerKind: 'codex-oauth',
          authJson: {
            access_token: 'oat-acc',
            refresh_token: 'oat-ref',
            id_token: idToken,
            expires_in: 3600,
          },
          acknowledgeUpstreamTos: true,
        }),
    ).expect(201);

    expect(res.body.provider_kind).toBe('codex-oauth');
    expect(res.body.account_id).toBe('acct_codex_1'); // derived from the id_token
    expect(res.body.account_label).toBe('op@example.com');
    expect(JSON.stringify(res.body)).not.toContain('oat-acc'); // tokens never returned
    expect(JSON.stringify(res.body)).not.toContain('oat-ref');
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/); // a secret_ref id usable as a credentialRef

    // persisted: an encrypted oauth_session with a derived account id + an expiry
    // the refresh sweep can pick up (expires_in → expires_at).
    const [row] = await db.select().from(schema.oauthSession);
    expect(row?.providerKind).toBe('codex-oauth');
    expect(row?.accountId).toBe('acct_codex_1');
    expect(row?.expiresAt).toBeInstanceOf(Date);
    // ciphertext only — neither plaintext token is persisted in the clear.
    expect(row?.accessEnc).not.toContain('oat-acc');
    expect(row?.refreshEnc).not.toContain('oat-ref');
  });

  it('rejects a missing ToS acknowledgement with 400 invalid_input', async () => {
    const res = await auth(
      request(app.getHttpServer())
        .post('/admin/oauth-sessions')
        .send({
          providerKind: 'codex-oauth',
          authJson: { access_token: 'oat-acc', refresh_token: 'oat-ref', expires_in: 3600 },
        }),
    ).expect(400);
    expect(res.body.error.code).toBe('invalid_input');
  });

  it('persists an already-expired session when expiry is absent (refresh sweep claims it)', async () => {
    await auth(
      request(app.getHttpServer())
        .post('/admin/oauth-sessions')
        .send({
          providerKind: 'codex-oauth',
          // NO expires_in AND NO expired → an absent expiry.
          authJson: { access_token: 'oat-acc', refresh_token: 'oat-ref', id_token: idToken },
          acknowledgeUpstreamTos: true,
        }),
    ).expect(201);

    // expires_at must be UNCONDITIONAL: an absent expiry falls back to an
    // already-expired timestamp so the next sweep tick refreshes it.
    const now = new Date();
    const [row] = await db.select().from(schema.oauthSession);
    expect(row?.expiresAt).toBeInstanceOf(Date);
    expect(row?.expiresAt?.getTime()).toBeLessThanOrEqual(now.getTime());

    // and the refresh sweep actually picks it up (the bug was a NULL expires_at
    // filtered out by listRefreshableSessions' isNotNull guard).
    const refreshable = await listRefreshableSessions(db, now, 0);
    expect(refreshable.map((r) => r.secretRefId)).toContain(row?.secretRefId);
  });

  it('rejects a malformed `expired` with 400 invalid_input and persists nothing', async () => {
    const res = await auth(
      request(app.getHttpServer())
        .post('/admin/oauth-sessions')
        .send({
          providerKind: 'codex-oauth',
          authJson: {
            access_token: 'oat-acc',
            refresh_token: 'oat-ref',
            id_token: idToken,
            expired: 'not-a-date',
          },
          acknowledgeUpstreamTos: true,
        }),
    ).expect(400);
    expect(res.body.error.code).toBe('invalid_input');

    // a bad paste must NOT leave a half-written session/secret_ref behind.
    const rows = await db.select().from(schema.oauthSession);
    expect(rows).toHaveLength(0);
  });
});

/**
 * Build a second app instance with `ENABLE_OAUTH_CHANNELS` UNSET, sharing the
 * same db + fake http, so the gate-off cases prove the env flag refuses the
 * login routes before any upstream call. Returns a freshly-authed token too.
 */
async function buildDisabledApp(): Promise<{ app: INestApplication; token: string }> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(ENV)
    .useValue({
      NODE_ENV: 'production',
      CREDIT_RATE: 1000,
      DATABASE_URL: container.getConnectionUri(),
      REDIS_URL: 'redis://localhost:6379',
      API_PORT: 3000,
      LOG_LEVEL: 'info',
      DEV_TENANT_ID: undefined,
      RATE_LIMIT_TENANT_PER_MIN: 600,
      RATE_LIMIT_RESOURCE_PER_MIN: 120,
      ADMIN_JWT_SECRET: ADMIN_SECRET,
      SECRET_ENCRYPTION_KEY: SECRET_KEY_B64,
      // ENABLE_OAUTH_CHANNELS intentionally UNSET → oauth login is gated off.
    })
    .overrideProvider(HTTP)
    .useValue(fakeHttp)
    .compile();
  const disabledApp = moduleRef.createNestApplication();
  await disabledApp.init();
  const res = await request(disabledApp.getHttpServer())
    .post('/admin/auth/login')
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    .expect(200);
  return { app: disabledApp, token: res.body.token as string };
}

describe('GET /admin/oauth-sessions (token-free listing, gated)', () => {
  it('lists registered sessions token-free and never leaks the tokens', async () => {
    await createOAuthSession(db, {
      providerKind: 'codex-oauth',
      accessToken: 'list-at-1',
      refreshToken: 'list-rt-1',
      accountLabel: 'work',
      accountId: 'acct_list_1',
      keyB64: SECRET_KEY_B64,
      expiresAt: new Date('2026-06-17T01:00:00.000Z'),
    });
    await createOAuthSession(db, {
      providerKind: 'codex',
      accessToken: 'list-at-2',
      refreshToken: 'list-rt-2',
      accountLabel: 'home',
      accountId: 'acct_list_2',
      keyB64: SECRET_KEY_B64,
    });

    const res = await auth(request(app.getHttpServer()).get('/admin/oauth-sessions')).expect(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.has_more).toBe(false);
    for (const item of res.body.data) {
      expect(item.id).toMatch(/^[0-9a-f-]{36}$/); // the secret_ref id usable as a credentialRef
      expect(item.provider_kind).toBeTypeOf('string');
      expect(item.account_id).toBeTypeOf('string');
      expect(item.status).toBe('active');
    }
    // NEITHER access nor refresh plaintext leaks anywhere in the response body.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('list-at-1');
    expect(serialized).not.toContain('list-at-2');
    expect(serialized).not.toContain('list-rt-1');
    expect(serialized).not.toContain('list-rt-2');
  });

  it('refuses when ENABLE_OAUTH_CHANNELS is off (same 400 invalid_input as the create path)', async () => {
    const disabled = await buildDisabledApp();
    try {
      const res = await request(disabled.app.getHttpServer())
        .get('/admin/oauth-sessions')
        .set('authorization', `Bearer ${disabled.token}`)
        .expect(400);
      expect(res.body.error.code).toBe('invalid_input');
    } finally {
      await disabled.app.close();
    }
  });
});

describe('POST /admin/oauth-sessions/codex/login/start (turnkey, ToS-gated)', () => {
  beforeEach(() => {
    fakeHttp.reset();
  });

  it('refuses when ENABLE_OAUTH_CHANNELS is off', async () => {
    const disabled = await buildDisabledApp();
    try {
      const res = await request(disabled.app.getHttpServer())
        .post('/admin/oauth-sessions/codex/login/start')
        .set('authorization', `Bearer ${disabled.token}`)
        .send({ acknowledgeUpstreamTos: true })
        .expect(400);
      expect(res.body.error.code).toBe('invalid_input');
    } finally {
      await disabled.app.close();
    }
  });

  it('rejects a missing ToS acknowledgement with 400 invalid_input', async () => {
    const res = await auth(
      request(app.getHttpServer()).post('/admin/oauth-sessions/codex/login/start').send({}),
    ).expect(400);
    expect(res.body.error.code).toBe('invalid_input');
  });

  it('returns an authorize_url + sealed state with the codex PKCE params', async () => {
    const res = await auth(
      request(app.getHttpServer())
        .post('/admin/oauth-sessions/codex/login/start')
        .send({ acknowledgeUpstreamTos: true }),
    ).expect(200);

    expect(res.body.state).toBeTypeOf('string');
    expect(res.body.state.length).toBeGreaterThan(0);
    const url = new URL(res.body.authorize_url as string);
    expect(url.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    // the response state is exactly the URL's state param (sealed verifier).
    expect(url.searchParams.get('state')).toBe(res.body.state);
  });
});

describe('POST /admin/oauth-sessions/codex/login/complete (turnkey, ToS-gated)', () => {
  const idToken = craftIdToken({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct_login_1', chatgpt_plan_type: 'pro' },
    email: 'op@example.com',
  });

  /** Run start and return the sealed state to pass back to complete. */
  async function startLogin(): Promise<string> {
    const res = await auth(
      request(app.getHttpServer())
        .post('/admin/oauth-sessions/codex/login/start')
        .send({ acknowledgeUpstreamTos: true }),
    ).expect(200);
    return res.body.state as string;
  }

  beforeEach(() => {
    fakeHttp.reset();
  });

  it('exchanges the code, persists encrypted tokens, and never echoes them', async () => {
    const state = await startLogin();
    fakeHttp.next = {
      status: 200,
      ok: true,
      body: {
        access_token: 'login-at',
        refresh_token: 'login-rt',
        id_token: idToken,
        expires_in: 3600,
      },
      text: '',
    };

    const res = await auth(
      request(app.getHttpServer())
        .post('/admin/oauth-sessions/codex/login/complete')
        .send({ acknowledgeUpstreamTos: true, code: 'authcode', state }),
    ).expect(201);

    expect(res.body.provider_kind).toBe('codex-oauth');
    expect(res.body.account_id).toBe('acct_login_1');
    expect(res.body.account_label).toBe('op@example.com');
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    // tokens NEVER returned in the view.
    expect(JSON.stringify(res.body)).not.toContain('login-at');
    expect(JSON.stringify(res.body)).not.toContain('login-rt');

    // the upstream exchange saw a form-encoded authorization_code grant carrying
    // the recovered PKCE verifier.
    const body = String(fakeHttp.lastRequest?.body);
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=authcode');
    expect(body).toContain('code_verifier=');

    // a real oauth_session row exists; decrypting it round-trips the access token.
    const [row] = await db.select().from(schema.oauthSession);
    expect(row?.providerKind).toBe('codex-oauth');
    const secretRefId = row?.secretRefId ?? '';
    const dec = await getDecryptedOAuthSession(db, secretRefId, SECRET_KEY_B64);
    expect(dec?.accessToken).toBe('login-at');
  });

  it('rejects a tampered state with 400 invalid_input and persists nothing', async () => {
    const res = await auth(
      request(app.getHttpServer())
        .post('/admin/oauth-sessions/codex/login/complete')
        .send({ acknowledgeUpstreamTos: true, code: 'authcode', state: 'garbage' }),
    ).expect(400);
    expect(res.body.error.code).toBe('invalid_input');

    const rows = await db.select().from(schema.oauthSession);
    expect(rows).toHaveLength(0);
  });

  it('maps a rejected exchange to 400 invalid_input and persists nothing', async () => {
    const state = await startLogin();
    fakeHttp.next = { status: 400, ok: false, body: {}, text: '' };

    const res = await auth(
      request(app.getHttpServer())
        .post('/admin/oauth-sessions/codex/login/complete')
        .send({ acknowledgeUpstreamTos: true, code: 'badcode', state }),
    ).expect(400);
    expect(res.body.error.code).toBe('invalid_input');

    const rows = await db.select().from(schema.oauthSession);
    expect(rows).toHaveLength(0);
  });

  it('refuses when ENABLE_OAUTH_CHANNELS is off WITHOUT calling upstream', async () => {
    const disabled = await buildDisabledApp();
    try {
      const res = await request(disabled.app.getHttpServer())
        .post('/admin/oauth-sessions/codex/login/complete')
        .set('authorization', `Bearer ${disabled.token}`)
        .send({ acknowledgeUpstreamTos: true, code: 'authcode', state: 'whatever' })
        .expect(400);
      expect(res.body.error.code).toBe('invalid_input');
      // the gate runs BEFORE the exchange — the upstream was never hit.
      expect(fakeHttp.calls).toBe(0);
    } finally {
      await disabled.app.close();
    }
  });
});

describe('Track D1: credential revocation (soft-delete) denies access', () => {
  it('a revoked api_key is rejected with 401 on /v1/* (guard treats soft-deleted as absent)', async () => {
    // a tenant WITH an account — the ApiKeyGuard resolves the account on success.
    const tenantRes = await auth(
      request(app.getHttpServer()).post('/admin/tenants').send({ name: 'revoke-key' }),
    ).expect(201);
    const tenantId = tenantRes.body.id as string;
    await auth(
      request(app.getHttpServer()).post('/admin/accounts').send({ tenantId, credits: 10 }),
    ).expect(201);

    // mint a key (no allowlist → may run any resource, incl. /v1/models discovery)
    const keyRes = await auth(
      request(app.getHttpServer()).post('/admin/api-keys').send({ tenantId }),
    ).expect(201);
    const keyId = keyRes.body.id as string;
    const plaintext = keyRes.body.plaintext as string;

    // the LIVE key authenticates on a guarded /v1/* route.
    await request(app.getHttpServer())
      .get('/v1/models')
      .set('authorization', `Bearer ${plaintext}`)
      .expect(200);

    // revoke = soft-delete → 204.
    await auth(request(app.getHttpServer()).delete(`/admin/api-keys/${keyId}`)).expect(204);

    // the SAME key is now rejected — the guard's lookup filters deleted_at, so a
    // revoked key authenticates as absent (401 unauthorized), proving revocation
    // actually denies access.
    const denied = await request(app.getHttpServer())
      .get('/v1/models')
      .set('authorization', `Bearer ${plaintext}`)
      .expect(401);
    expect(denied.body.error.code).toBe('unauthorized');

    // it also drops out of the tenant's key listing.
    const list = await auth(
      request(app.getHttpServer()).get('/admin/api-keys').query({ tenantId }),
    ).expect(200);
    expect(list.body.data.map((k: { id: string }) => k.id)).not.toContain(keyId);

    // a second revoke is a 404 (no live row to delete).
    await auth(request(app.getHttpServer()).delete(`/admin/api-keys/${keyId}`)).expect(404);
  });

  it('a revoked oauth_session no longer resolves and is delisted', async () => {
    // seed an oauth session directly (the same path the relay resolves against).
    const ref = await createOAuthSession(db, {
      providerKind: 'codex-oauth',
      accessToken: 'revoke-oauth-at',
      refreshToken: 'revoke-oauth-rt',
      accountLabel: 'to-revoke',
      keyB64: SECRET_KEY_B64,
      expiresAt: new Date('2026-06-17T01:00:00.000Z'),
    });

    // BEFORE: the credential resolver returns the live access token, and the
    // session is listed.
    process.env.SECRET_ENCRYPTION_KEY = SECRET_KEY_B64;
    await expect(resolveSecretRef(db, ref.id)).resolves.toBe('revoke-oauth-at');
    await expect(getDecryptedOAuthSession(db, ref.id, SECRET_KEY_B64)).resolves.toMatchObject({
      accessToken: 'revoke-oauth-at',
    });
    const before = await auth(request(app.getHttpServer()).get('/admin/oauth-sessions')).expect(
      200,
    );
    expect(before.body.data.map((s: { id: string }) => s.id)).toContain(ref.id);

    // revoke via the admin endpoint → 204.
    await auth(request(app.getHttpServer()).delete(`/admin/oauth-sessions/${ref.id}`)).expect(204);

    // AFTER: channel resolution now returns undefined (the access token is no
    // longer reachable), and the session is gone from the listing.
    await expect(resolveSecretRef(db, ref.id)).resolves.toBeUndefined();
    const after = await auth(request(app.getHttpServer()).get('/admin/oauth-sessions')).expect(200);
    expect(after.body.data.map((s: { id: string }) => s.id)).not.toContain(ref.id);

    // a second revoke is a 404.
    await auth(request(app.getHttpServer()).delete(`/admin/oauth-sessions/${ref.id}`)).expect(404);
  });

  it('a revoked secret no longer resolves and is delisted', async () => {
    process.env.SECRET_ENCRYPTION_KEY = SECRET_KEY_B64;
    const created = await auth(
      request(app.getHttpServer())
        .post('/admin/secrets')
        .send({ value: 'sk-revoke-secret', label: 'revoke' }),
    ).expect(201);
    const id = created.body.id as string;

    // BEFORE: resolves to the encrypted-then-decrypted plaintext, and is listed.
    await expect(resolveSecretRef(db, id)).resolves.toBe('sk-revoke-secret');
    const before = await auth(request(app.getHttpServer()).get('/admin/secrets')).expect(200);
    expect(before.body.data.map((s: { id: string }) => s.id)).toContain(id);

    // revoke → 204.
    await auth(request(app.getHttpServer()).delete(`/admin/secrets/${id}`)).expect(204);

    // AFTER: resolution returns undefined and the secret is delisted.
    await expect(resolveSecretRef(db, id)).resolves.toBeUndefined();
    const after = await auth(request(app.getHttpServer()).get('/admin/secrets')).expect(200);
    expect(after.body.data.map((s: { id: string }) => s.id)).not.toContain(id);
    await auth(request(app.getHttpServer()).get(`/admin/secrets/${id}`)).expect(404);

    // a second revoke is a 404.
    await auth(request(app.getHttpServer()).delete(`/admin/secrets/${id}`)).expect(404);
  });
});

describe('Track D1: secrets list / get (metadata only, never the material)', () => {
  it('paginates the list, exposes only metadata, and gets one by id', async () => {
    const s1 = await auth(
      request(app.getHttpServer())
        .post('/admin/secrets')
        .send({ value: 'sk-list-1', label: 'one' }),
    ).expect(201);
    const s2 = await auth(
      request(app.getHttpServer())
        .post('/admin/secrets')
        .send({ value: 'sk-list-2', label: 'two' }),
    ).expect(201);
    const id1 = s1.body.id as string;
    const id2 = s2.body.id as string;

    // page 1 of size 1 → has_more=true, a non-null next_cursor, and NO material.
    const page1 = await auth(
      request(app.getHttpServer()).get('/admin/secrets').query({ limit: 1 }),
    ).expect(200);
    expect(page1.body.data).toHaveLength(1);
    expect(page1.body.has_more).toBe(true);
    expect(page1.body.next_cursor).toBeTypeOf('string');
    const serialized1 = JSON.stringify(page1.body);
    expect(serialized1).not.toContain('sk-list-1');
    expect(serialized1).not.toContain('sk-list-2');
    // metadata-only shape: id/provider/locator/timestamps, no `value`/`material`.
    const item = page1.body.data[0];
    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('provider', 'enc');
    expect(item).toHaveProperty('locator');
    expect(item).toHaveProperty('created_at');
    expect(item).not.toHaveProperty('value');
    expect(item).not.toHaveProperty('material');

    // page 2 via the cursor → the remaining secret, has_more=false.
    const page2 = await auth(
      request(app.getHttpServer())
        .get('/admin/secrets')
        .query({ limit: 1, cursor: page1.body.next_cursor }),
    ).expect(200);
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.has_more).toBe(false);
    const seen = [page1.body.data[0].id, page2.body.data[0].id];
    expect(new Set(seen)).toEqual(new Set([id1, id2]));

    // get-by-id returns metadata only.
    const got = await auth(request(app.getHttpServer()).get(`/admin/secrets/${id1}`)).expect(200);
    expect(got.body.id).toBe(id1);
    expect(got.body.provider).toBe('enc');
    expect(JSON.stringify(got.body)).not.toContain('sk-list-1');
    expect(got.body).not.toHaveProperty('value');

    // a missing id → 404.
    const missing = await auth(
      request(app.getHttpServer()).get('/admin/secrets/00000000-0000-0000-0000-000000000000'),
    ).expect(404);
    expect(missing.body.error.code).toBe('resource_not_found');
  });

  it('stores an optional human name and rejects a duplicate LIVE name with 400', async () => {
    const created = await auth(
      request(app.getHttpServer())
        .post('/admin/secrets')
        .send({ value: 'sk-named-1', name: 'Primary OpenAI' }),
    ).expect(201);
    expect(created.body.name).toBe('Primary OpenAI');

    // A second credential with the SAME live name hits `secret_ref_name_idx` →
    // 23505, mapped to a clean invalid_input 400 (never a 500).
    const dup = await auth(
      request(app.getHttpServer())
        .post('/admin/secrets')
        .send({ value: 'sk-named-2', name: 'Primary OpenAI' }),
    ).expect(400);
    expect(dup.body.error.code).toBe('invalid_input');
    expect(dup.body.error.message).toContain('Primary OpenAI');

    // Revoking the first frees the name (partial index excludes tombstoned rows).
    await auth(
      request(app.getHttpServer()).delete(`/admin/secrets/${created.body.id as string}`),
    ).expect(204);
    const reused = await auth(
      request(app.getHttpServer())
        .post('/admin/secrets')
        .send({ value: 'sk-named-3', name: 'Primary OpenAI' }),
    ).expect(201);
    expect(reused.body.name).toBe('Primary OpenAI');
  });

  it('renaming a credential onto a taken LIVE name is a clean 400 (not a 500)', async () => {
    await auth(
      request(app.getHttpServer())
        .post('/admin/secrets')
        .send({ value: 'sk-rn-1', name: 'Taken Name' }),
    ).expect(201);
    const other = await auth(
      request(app.getHttpServer())
        .post('/admin/secrets')
        .send({ value: 'sk-rn-2', name: 'Free Name' }),
    ).expect(201);

    // PATCH the second onto the first's name → hits `secret_ref_name_idx` → 400.
    const conflict = await auth(
      request(app.getHttpServer())
        .patch(`/admin/secrets/${other.body.id as string}`)
        .send({ name: 'Taken Name' }),
    ).expect(400);
    expect(conflict.body.error.code).toBe('invalid_input');
    expect(conflict.body.error.message).toContain('Taken Name');
  });
});

/** Create a tenant + a chat resource the catalog rows can attach to. */
async function seedTenantResource(name: string, resourceId: string): Promise<string> {
  const t = await auth(request(app.getHttpServer()).post('/admin/tenants').send({ name })).expect(
    201,
  );
  const tenantId = t.body.id as string;
  await auth(
    request(app.getHttpServer())
      .post('/admin/resources')
      .send({
        id: resourceId,
        tenantId,
        kind: 'model',
        modality: 'text',
        providerType: 'openai',
        execModes: ['blocking'],
        ioSchema: { inputs: [], outputs: [] },
      }),
  ).expect(201);
  return tenantId;
}

describe('D3: tenant get / patch', () => {
  it('GET-by-id → PATCH isolationMode → GET reflects it', async () => {
    const tenantId = await seedTenantResource('tn-d3', 'tn-d3-res');

    const got = await auth(request(app.getHttpServer()).get(`/admin/tenants/${tenantId}`)).expect(
      200,
    );
    expect(got.body.id).toBe(tenantId);
    expect(got.body.isolation_mode).toBe('field');

    const patched = await auth(
      request(app.getHttpServer())
        .patch(`/admin/tenants/${tenantId}`)
        .send({ isolationMode: 'schema' }),
    ).expect(200);
    expect(patched.body.isolation_mode).toBe('schema');

    await auth(
      request(app.getHttpServer()).get('/admin/tenants/00000000-0000-0000-0000-000000000000'),
    ).expect(404);
  });
});

describe('D3: account get (no PATCH/DELETE — balance is ledger-owned)', () => {
  it('GET returns the balance/held view; topup is the only mover', async () => {
    const tenantId = await seedTenantResource('acct-d3', 'acct-d3-res');
    const acct = await auth(
      request(app.getHttpServer()).post('/admin/accounts').send({ tenantId, credits: 10 }),
    ).expect(201);
    const accountId = acct.body.id as string;

    const got = await auth(request(app.getHttpServer()).get(`/admin/accounts/${accountId}`)).expect(
      200,
    );
    expect(got.body.credit_balance).toBe('10000000');
    expect(got.body.credit_held).toBe('0');

    await auth(
      request(app.getHttpServer()).get('/admin/accounts/00000000-0000-0000-0000-000000000000'),
    ).expect(404);
  });
});

describe('D3: account list (paginated balance/held view)', () => {
  it('GET /admin/accounts lists accounts with tenant_id + balance/held', async () => {
    const tenantId = await seedTenantResource('acct-list', 'acct-list-res');
    const created = await auth(
      request(app.getHttpServer()).post('/admin/accounts').send({ tenantId, credits: 25 }),
    ).expect(201);
    const accountId = created.body.id as string;

    const list = await auth(request(app.getHttpServer()).get('/admin/accounts')).expect(200);
    const row = (
      list.body.data as {
        id: string;
        tenant_id: string;
        credit_balance: string;
        credit_held: string;
      }[]
    ).find((a) => a.id === accountId);

    expect(row).toBeDefined();
    expect(row?.tenant_id).toBe(tenantId);
    expect(row?.credit_balance).toBe('25000000');
    expect(row?.credit_held).toBe('0');
  });
});

describe('D3: resource get / patch (status only)', () => {
  it('GET → PATCH status → GET reflects it; key fields untouched', async () => {
    await seedTenantResource('res-d3', 'res-d3');

    const got = await auth(request(app.getHttpServer()).get('/admin/resources/res-d3')).expect(200);
    expect(got.body.status).toBe('active');
    expect(got.body.kind).toBe('model');

    const patched = await auth(
      request(app.getHttpServer()).patch('/admin/resources/res-d3').send({ status: 'disabled' }),
    ).expect(200);
    expect(patched.body.status).toBe('disabled');
    expect(patched.body.kind).toBe('model'); // immutable key field

    await auth(request(app.getHttpServer()).get('/admin/resources/nope')).expect(404);
  });
});

describe('D3: channel get / soft-delete (nested under resource)', () => {
  it('create → GET-by-id → DELETE (204) → GET 404 + list excludes; channel ∉ resource → 404', async () => {
    await seedTenantResource('ch-d3', 'ch-d3-res');
    const created = await auth(
      request(app.getHttpServer())
        .post('/admin/resources/ch-d3-res/channels')
        .send({ providerType: 'openai', weight: 1 }),
    ).expect(201);
    const channelId = created.body.id as string;

    // GET-by-id within its resource.
    const got = await auth(
      request(app.getHttpServer()).get(`/admin/resources/ch-d3-res/channels/${channelId}`),
    ).expect(200);
    expect(got.body.id).toBe(channelId);

    // a channel queried under the WRONG resource → 404.
    await auth(
      request(app.getHttpServer()).get(`/admin/resources/other-res/channels/${channelId}`),
    ).expect(404);

    // DELETE → 204
    await auth(
      request(app.getHttpServer()).delete(`/admin/resources/ch-d3-res/channels/${channelId}`),
    ).expect(204);

    // GET now 404 AND the list excludes it.
    await auth(
      request(app.getHttpServer()).get(`/admin/resources/ch-d3-res/channels/${channelId}`),
    ).expect(404);
    const list = await auth(
      request(app.getHttpServer()).get('/admin/resources/ch-d3-res/channels'),
    ).expect(200);
    expect(list.body.data).toHaveLength(0);

    // second delete → 404 (idempotent).
    await auth(
      request(app.getHttpServer()).delete(`/admin/resources/ch-d3-res/channels/${channelId}`),
    ).expect(404);
  });
});

describe('D3: pricebook get / patch / delete', () => {
  it('create → GET → PATCH (µcredit conversion) → DELETE (204) → 404 + delisted', async () => {
    await seedTenantResource('pb-d3', 'pb-d3-res');
    const created = await auth(
      request(app.getHttpServer()).post('/admin/pricebook').send({
        resourceId: 'pb-d3-res',
        resourceVersion: 1,
        version: 1,
        method: 'fixed',
        timing: 'pre',
        spec: {},
        fixedCredits: 2,
      }),
    ).expect(201);
    const id = created.body.id as string;
    expect(created.body.spec.amount).toBe('2000000');

    await auth(request(app.getHttpServer()).get(`/admin/pricebook/${id}`)).expect(200);

    // PATCH fixedCredits 5 → µcredit spec.amount 5_000_000 + timing flips.
    const patched = await auth(
      request(app.getHttpServer())
        .patch(`/admin/pricebook/${id}`)
        .send({ timing: 'post', fixedCredits: 5, active: false }),
    ).expect(200);
    expect(patched.body.timing).toBe('post');
    expect(patched.body.spec.amount).toBe('5000000');
    expect(patched.body.active).toBe(false);

    await auth(request(app.getHttpServer()).delete(`/admin/pricebook/${id}`)).expect(204);
    await auth(request(app.getHttpServer()).get(`/admin/pricebook/${id}`)).expect(404);
    const list = await auth(
      request(app.getHttpServer()).get('/admin/pricebook').query({ resourceId: 'pb-d3-res' }),
    ).expect(200);
    expect(list.body.data).toHaveLength(0);
    await auth(request(app.getHttpServer()).delete(`/admin/pricebook/${id}`)).expect(404);
  });
});

describe('D3: modifier get / patch / delete', () => {
  it('create → GET → PATCH (credit-op value → µcredits) → DELETE (204) → 404 + delisted', async () => {
    const created = await auth(
      request(app.getHttpServer())
        .post('/admin/modifiers')
        .send({ scope: 'global', op: 'flat_off', value: 3, priority: 1 }),
    ).expect(201);
    const id = created.body.id as string;
    expect(created.body.value).toBe('3000000');

    await auth(request(app.getHttpServer()).get(`/admin/modifiers/${id}`)).expect(200);

    // PATCH a credit op value 5 credits → 5_000_000 µcredits; priority bumps.
    const patched = await auth(
      request(app.getHttpServer())
        .patch(`/admin/modifiers/${id}`)
        .send({ value: 5, priority: 9, active: false }),
    ).expect(200);
    expect(patched.body.value).toBe('5000000');
    expect(patched.body.priority).toBe(9);
    expect(patched.body.active).toBe(false);

    // switching to a percent op keeps the raw whole-percent int.
    const pct = await auth(
      request(app.getHttpServer())
        .patch(`/admin/modifiers/${id}`)
        .send({ op: 'percent_off', value: 15 }),
    ).expect(200);
    expect(pct.body.op).toBe('percent_off');
    expect(pct.body.value).toBe('15');

    await auth(request(app.getHttpServer()).delete(`/admin/modifiers/${id}`)).expect(204);
    await auth(request(app.getHttpServer()).get(`/admin/modifiers/${id}`)).expect(404);
    const list = await auth(request(app.getHttpServer()).get('/admin/modifiers')).expect(200);
    expect(list.body.data.map((m: { id: string }) => m.id)).not.toContain(id);
    await auth(request(app.getHttpServer()).delete(`/admin/modifiers/${id}`)).expect(404);
  });
});

describe('D4: redemption-code list (status filter, paginated)', () => {
  it('mints codes then lists them filtered by status', async () => {
    await auth(
      request(app.getHttpServer())
        .post('/admin/redemption-codes')
        .send({ count: 2, creditsPerCode: 5 }),
    ).expect(201);

    const all = await auth(request(app.getHttpServer()).get('/admin/redemption-codes')).expect(200);
    expect(all.body.data).toHaveLength(2);
    expect(all.body.data[0].credit_amount).toBe('5000000');
    expect(all.body.data[0].status).toBe('unused');
    expect(all.body.data[0]).toHaveProperty('code'); // admin mint listing returns the code

    // a status filter that matches nothing returns an empty page.
    const redeemed = await auth(
      request(app.getHttpServer()).get('/admin/redemption-codes').query({ status: 'redeemed' }),
    ).expect(200);
    expect(redeemed.body.data).toHaveLength(0);

    // a bad status enum → 400 invalid_input.
    const bad = await auth(
      request(app.getHttpServer()).get('/admin/redemption-codes').query({ status: 'bogus' }),
    ).expect(400);
    expect(bad.body.error.code).toBe('invalid_input');
  });
});

describe('G-A: tenant subjects (end-users) CRUD', () => {
  async function makeTenant(name: string): Promise<string> {
    const res = await auth(
      request(app.getHttpServer()).post('/admin/tenants').send({ name }),
    ).expect(201);
    return res.body.id as string;
  }

  it('creates → lists → gets → patches → deletes a subject under a tenant', async () => {
    const tenantId = await makeTenant('subj-crud');

    // create (Model-B: external_id). password_hash is never exposed.
    const created = await auth(
      request(app.getHttpServer())
        .post(`/admin/tenants/${tenantId}/users`)
        .send({ externalId: 'end-user-1', displayName: 'Alice' }),
    ).expect(201);
    expect(created.body.tenant_id).toBe(tenantId);
    expect(created.body.external_id).toBe('end-user-1');
    expect(created.body.display_name).toBe('Alice');
    expect(created.body.status).toBe('active');
    expect(created.body).not.toHaveProperty('password_hash');
    const sid = created.body.id as string;

    // list
    const list = await auth(
      request(app.getHttpServer()).get(`/admin/tenants/${tenantId}/users`),
    ).expect(200);
    expect(list.body.data.map((s: { id: string }) => s.id)).toContain(sid);
    expect(list.body.has_more).toBe(false);

    // get-by-id
    const got = await auth(
      request(app.getHttpServer()).get(`/admin/tenants/${tenantId}/users/${sid}`),
    ).expect(200);
    expect(got.body.id).toBe(sid);

    // patch displayName + status
    const patched = await auth(
      request(app.getHttpServer())
        .patch(`/admin/tenants/${tenantId}/users/${sid}`)
        .send({ displayName: 'Alice B', status: 'disabled' }),
    ).expect(200);
    expect(patched.body.display_name).toBe('Alice B');
    expect(patched.body.status).toBe('disabled');

    // delete → 204, then get 404, list excludes
    await auth(
      request(app.getHttpServer()).delete(`/admin/tenants/${tenantId}/users/${sid}`),
    ).expect(204);
    await auth(request(app.getHttpServer()).get(`/admin/tenants/${tenantId}/users/${sid}`)).expect(
      404,
    );
    const after = await auth(
      request(app.getHttpServer()).get(`/admin/tenants/${tenantId}/users`),
    ).expect(200);
    expect(after.body.data.map((s: { id: string }) => s.id)).not.toContain(sid);

    // second delete → 404 (idempotent)
    await auth(
      request(app.getHttpServer()).delete(`/admin/tenants/${tenantId}/users/${sid}`),
    ).expect(404);
  });

  it('rejects a subject with neither external_id nor email (400)', async () => {
    const tenantId = await makeTenant('subj-bad');
    const res = await auth(
      request(app.getHttpServer())
        .post(`/admin/tenants/${tenantId}/users`)
        .send({ displayName: 'no identity' }),
    ).expect(400);
    expect(res.body.error.code).toBe('invalid_input');
  });

  it('is tenant-scoped: a subject is not visible under another tenant', async () => {
    const a = await makeTenant('subj-a');
    const b = await makeTenant('subj-b');
    const created = await auth(
      request(app.getHttpServer()).post(`/admin/tenants/${a}/users`).send({ externalId: 'x' }),
    ).expect(201);
    const sid = created.body.id as string;
    await auth(request(app.getHttpServer()).get(`/admin/tenants/${b}/users/${sid}`)).expect(404);
  });

  it('mints a subject-scoped api key and surfaces subject_id on the key view (G-B)', async () => {
    const tenantId = await makeTenant('subj-key');
    const created = await auth(
      request(app.getHttpServer())
        .post(`/admin/tenants/${tenantId}/users`)
        .send({ externalId: 'eu' }),
    ).expect(201);
    const sid = created.body.id as string;

    const keyRes = await auth(
      request(app.getHttpServer()).post('/admin/api-keys').send({ tenantId, subjectId: sid }),
    ).expect(201);
    expect(keyRes.body.plaintext).toMatch(/^ak_/);

    const list = await auth(
      request(app.getHttpServer()).get('/admin/api-keys').query({ tenantId }),
    ).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].subject_id).toBe(sid);

    // a subject from another tenant cannot be bound → 404.
    const other = await makeTenant('subj-key-other');
    await auth(
      request(app.getHttpServer())
        .post('/admin/api-keys')
        .send({ tenantId: other, subjectId: sid }),
    ).expect(404);
  });

  it('opens, tops up, and transfers a subject sub-wallet (G-E)', async () => {
    const tenantId = await makeTenant('subj-wallet');
    await auth(
      request(app.getHttpServer()).post('/admin/accounts').send({ tenantId, credits: 100 }),
    ).expect(201);
    const created = await auth(
      request(app.getHttpServer())
        .post(`/admin/tenants/${tenantId}/users`)
        .send({ externalId: 'w' }),
    ).expect(201);
    const sid = created.body.id as string;

    // open a sub-wallet with a 10-credit opening balance → 10_000_000 µcredits
    const sub = await auth(
      request(app.getHttpServer())
        .post(`/admin/tenants/${tenantId}/users/${sid}/sub-account`)
        .send({ credits: 10 }),
    ).expect(201);
    expect(sub.body.subject_id).toBe(sid);
    expect(sub.body.credit_balance).toBe('10000000');

    // topup +5 → 15
    const topped = await auth(
      request(app.getHttpServer())
        .post(`/admin/tenants/${tenantId}/users/${sid}/sub-account/topup`)
        .send({ credits: 5 }),
    ).expect(200);
    expect(topped.body.credit_balance).toBe('15000000');

    // transfer 20 from the tenant pool → sub-wallet → 35
    const moved = await auth(
      request(app.getHttpServer())
        .post(`/admin/tenants/${tenantId}/users/${sid}/sub-account/transfer`)
        .send({ credits: 20, direction: 'to_subject' }),
    ).expect(200);
    expect(moved.body.credit_balance).toBe('35000000');

    // GET reflects the final balance
    const got = await auth(
      request(app.getHttpServer()).get(`/admin/tenants/${tenantId}/users/${sid}/sub-account`),
    ).expect(200);
    expect(got.body.credit_balance).toBe('35000000');
  });
});
