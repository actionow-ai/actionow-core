import type { HttpClient, HttpRequest, HttpResponse } from '@actionow/contracts';
import {
  createUser,
  getDecryptedOAuthSession,
  listRefreshableSessions,
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

/** The §7.1 sample BYO workflow: a model node + an image tool node. */
const WORKFLOW_DSL = `
app: { mode: workflow, name: 小红书文案配图, icon: "🎨" }
kind: app
version: "0.1.5"
workflow:
  graph:
    nodes:
      - { id: start, data: { type: start, variables: [
            { variable: topic, label: 主题, type: text-input, required: true, max_length: 100 } ] } }
      - { id: llm1, data: { type: llm, model: { provider: openai, name: gpt-4o-mini } } }
      - { id: img1, data: { type: tool, provider_type: builtin, tool_name: dalle3 } }
      - { id: end, data: { type: end, outputs: [
            { variable: caption,   value_selector: [llm1, text] },
            { variable: image_url, value_selector: [img1, image] } ] } }
`;

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
  await client`TRUNCATE TABLE api_key, ledger_txn, dify_binding, pricebook_entry, upstream_channel, resource_version, resource, modifier, account, tenant, oauth_session, secret_material, secret_ref, "user" RESTART IDENTITY CASCADE`;
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
    expect(tenantsList.body.map((t: { id: string }) => t.id)).toContain(tenantId);

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
    expect(keyList.body).toHaveLength(1);
    expect(keyList.body[0]).not.toHaveProperty('hash');
    expect(keyList.body[0].resource_allowlist).toEqual(['xhs']);

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
    expect(pbList.body).toHaveLength(1);

    // ledger endpoint returns the topup row
    const ledgerView = await auth(
      request(app.getHttpServer()).get('/admin/ledger').query({ tenantId }),
    ).expect(200);
    expect(ledgerView.body.transactions[0].type).toBe('topup');
    expect(ledgerView.body.transactions[0].credits_delta).toBe('100000000');
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
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(channelId);
    expect(list.body[0].status).toBe('disabled');
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
    expect(list.body).toHaveLength(2);
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

describe('POST /admin/dify/import', () => {
  it('registers a BYO fixed workflow and returns its io_schema', async () => {
    const tenantRes = await auth(
      request(app.getHttpServer()).post('/admin/tenants').send({ name: 'dify' }),
    ).expect(201);
    const tenantId = tenantRes.body.id as string;

    const res = await auth(
      request(app.getHttpServer()).post('/admin/dify/import').send({
        tenantId,
        resourceId: 'xhs',
        yaml: WORKFLOW_DSL,
        endpoint: 'https://dify.example/v1',
        pricingModel: 'fixed',
      }),
    ).expect(200);

    expect(res.body.resource_id).toBe('xhs');
    expect(res.body.version).toBe(1);
    expect(res.body.io_schema.inputs.map((i: { key: string }) => i.key)).toEqual(['topic']);
    expect(res.body.io_schema.outputs.map((o: { key: string }) => o.key)).toEqual([
      'caption',
      'image_url',
    ]);

    // persisted: resource + binding rows exist
    const [resRow] = await db.select().from(schema.resource);
    expect(resRow?.id).toBe('xhs');
    expect(resRow?.providerType).toBe('dify-workflow');
    const [bindRow] = await db.select().from(schema.difyBinding);
    expect(bindRow?.pricingModel).toBe('fixed');
  });

  it('rejects a BYO + metered import with a 400 metered_not_allowed envelope', async () => {
    const tenantRes = await auth(
      request(app.getHttpServer()).post('/admin/tenants').send({ name: 'metered' }),
    ).expect(201);
    const tenantId = tenantRes.body.id as string;

    const res = await auth(
      request(app.getHttpServer()).post('/admin/dify/import').send({
        tenantId,
        resourceId: 'metered-xhs',
        yaml: WORKFLOW_DSL,
        endpoint: 'https://dify.example/v1',
        pricingModel: 'metered',
      }),
    ).expect(400);

    expect(res.body.error.code).toBe('invalid_input');
    expect(res.body.error.message).toMatch(/metered_not_allowed/);

    // nothing persisted
    const resources = await db.select().from(schema.resource);
    expect(resources).toHaveLength(0);
  });
});
