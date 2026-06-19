import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createOAuthSession, createUser, getModelByName, schema } from '@actionow/db';
import { hashPassword } from '@actionow/infra';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DB, ENV } from '../src/common/tokens.js';

/**
 * E2E for `POST /admin/resources/:id/channels/:channelId/sync-models` — sync a
 * codex-oauth channel's available models into `model` rows (multi-model routing).
 *
 * A local fake "codex backend" serves the official `GET /backend-api/codex/models`
 * catalog JSON. The REAL `codex-oauth` adapter (`listModels`, registered in the
 * default registry) hits `${channel.endpoint}/models?client_version=<v>` with the
 * real cli-impersonation headers + the LIVE oauth access token (decrypted by the
 * `oauth` branch of `resolveSecretRef`, which reads `SECRET_ENCRYPTION_KEY` from
 * `process.env`). We assert: the upstream saw `client_version` + the `Bearer
 * <token>`; the synced `model` rows exist (prices 3/7, the right resourceId +
 * capabilities); and a SECOND sync with DIFFERENT defaults PRESERVES the existing
 * prices (price is never overwritten) while a brand-new model gets the new default.
 */

const CHAT_RESOURCE = 'chat-codex-sync';
const ACCOUNT_ID = 'acct_codex_sync';
const OAUTH_ACCESS = 'oat-sync-live';
const KEY = randomBytes(32).toString('base64');

const ADMIN_SECRET = 'sync-admin-secret';
const ADMIN_EMAIL = 'admin-sync@actionow.local';
const ADMIN_PASSWORD = 'hunter2';

/** The codex `GET /models` reply the fake backend returns. */
const CATALOG = {
  models: [
    {
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5',
      description: 'flagship',
      context_window: 272000,
      max_context_window: 272000,
      input_modalities: ['text', 'image'],
      supports_parallel_tool_calls: true,
      visibility: 'list',
      priority: 9,
    },
    {
      slug: 'gpt-5.4-mini',
      display_name: 'GPT-5.4 mini',
      input_modalities: ['text'],
      supports_parallel_tool_calls: false,
    },
  ],
};

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;
let app: INestApplication;
let channelId: string;

/** What the fake upstream saw on its last `GET /models` request. */
interface SeenRequest {
  url: string;
  authorization: string | undefined;
}
let seen: SeenRequest | undefined;

let upstream: Server | undefined;
let fakeBase: string;

beforeAll(async () => {
  // Fake codex backend: serve the catalog on GET /backend-api/codex/models and
  // capture the query (client_version) + the Authorization header (Bearer token).
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen = { url: req.url ?? '', authorization: req.headers.authorization };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(CATALOG));
  });
  await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', resolve));
  const port = String((upstream.address() as AddressInfo).port);
  fakeBase = `http://127.0.0.1:${port}/backend-api/codex`;

  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const uri = container.getConnectionUri();
  client = postgres(uri, { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });

  // The `oauth` branch of resolveSecretRef reads SECRET_ENCRYPTION_KEY from process.env.
  process.env.SECRET_ENCRYPTION_KEY = KEY;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(ENV)
    .useValue({
      NODE_ENV: 'production',
      CREDIT_RATE: 1000,
      DATABASE_URL: uri,
      REDIS_URL: 'redis://localhost:6379',
      API_PORT: 0,
      LOG_LEVEL: 'info',
      RATE_LIMIT_TENANT_PER_MIN: 600,
      RATE_LIMIT_RESOURCE_PER_MIN: 600,
      ADMIN_JWT_SECRET: ADMIN_SECRET,
      SECRET_ENCRYPTION_KEY: KEY,
      ENABLE_OAUTH_CHANNELS: true,
    })
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();

  // Admin user → JWT.
  await createUser(db, {
    email: ADMIN_EMAIL,
    passwordHash: hashPassword(ADMIN_PASSWORD),
    role: 'admin',
    emailVerified: true,
  });

  // Tenant, encrypted oauth session, codex-oauth chat resource + channel.
  const [t] = await db.insert(schema.tenant).values({ name: 'codex-sync-tenant' }).returning();
  if (!t) throw new Error('no tenant');
  const ref = await createOAuthSession(db, {
    providerKind: 'codex-oauth',
    accessToken: OAUTH_ACCESS,
    refreshToken: 'oat-ref',
    accountId: ACCOUNT_ID,
    keyB64: KEY,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  await db.insert(schema.resource).values({
    id: CHAT_RESOURCE,
    tenantId: t.id,
    kind: 'model',
    modality: 'chat',
    providerType: 'codex-oauth',
    execModes: ['stream', 'blocking'],
    currentVersion: 1,
  });
  await db.insert(schema.resourceVersion).values({
    resourceId: CHAT_RESOURCE,
    version: 1,
    ioSchema: { inputs: [], outputs: [] },
  });
  // The codex-oauth channel WITHOUT a single-model override (multi-model) — its
  // endpoint points at the fake backend, credentials via the encrypted session.
  const [ch] = await db
    .insert(schema.upstreamChannel)
    .values({
      resourceId: CHAT_RESOURCE,
      providerType: 'codex-oauth',
      credentialRef: ref.id,
      config: { chatgptAccountId: ACCOUNT_ID },
      endpoint: fakeBase,
      weight: 1,
      status: 'active',
    })
    .returning();
  if (!ch) throw new Error('no channel');
  channelId = ch.id;
}, 180_000);

afterAll(async () => {
  await app.close();
  await client.end();
  await container.stop();
  if (upstream !== undefined)
    await new Promise<void>((r) =>
      upstream?.close(() => {
        r();
      }),
    );
  delete process.env.SECRET_ENCRYPTION_KEY;
});

async function login(): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/admin/auth/login')
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
    .expect(200);
  return res.body.token as string;
}

describe('admin sync-models e2e (codex-oauth over a fake catalog endpoint)', () => {
  it('syncs upstream models into model rows, then preserves their prices on re-sync', async () => {
    const token = await login();

    // ── First sync: defaults 3/7. Both slugs are new → inserted.
    const first = await request(app.getHttpServer())
      .post(`/admin/resources/${CHAT_RESOURCE}/channels/${channelId}/sync-models`)
      .set('authorization', `Bearer ${token}`)
      .send({ defaultInputPrice: 3, defaultOutputPrice: 7 })
      .expect(200);

    expect(first.body.resource_id).toBe(CHAT_RESOURCE);
    expect((first.body.created as string[]).sort()).toEqual(['gpt-5.4-mini', 'gpt-5.5']);
    expect(first.body.updated).toEqual([]);
    expect(first.body.total).toBe(2);

    // ── The fake upstream saw the client_version query + the LIVE bearer token.
    expect(seen?.url).toContain('/backend-api/codex/models?client_version=');
    expect(seen?.authorization).toBe(`Bearer ${OAUTH_ACCESS}`);

    // ── The synced model rows exist with the right resource/prices/capabilities.
    const flagship = await getModelByName(db, 'gpt-5.5');
    expect(flagship?.resourceId).toBe(CHAT_RESOURCE);
    expect(flagship?.inputPrice).toBe(3n);
    expect(flagship?.outputPrice).toBe(7n);
    expect(flagship?.display).toBe('GPT-5.5');
    expect(flagship?.visibility).toBe('public');
    expect(flagship?.status).toBe('active');
    expect(flagship?.capabilities).toEqual({
      vision: true,
      tools: true,
      json: true,
      stream: true,
      audio: false,
    });

    const mini = await getModelByName(db, 'gpt-5.4-mini');
    expect(mini?.capabilities).toEqual({
      vision: false,
      tools: false,
      json: true,
      stream: true,
      audio: false,
    });

    // ── A second sync with DIFFERENT defaults: both slugs now exist → updated,
    //    and the prices set on the first sync must be PRESERVED (never overwritten).
    const second = await request(app.getHttpServer())
      .post(`/admin/resources/${CHAT_RESOURCE}/channels/${channelId}/sync-models`)
      .set('authorization', `Bearer ${token}`)
      .send({ defaultInputPrice: 99, defaultOutputPrice: 99 })
      .expect(200);

    expect((second.body.updated as string[]).sort()).toEqual(['gpt-5.4-mini', 'gpt-5.5']);
    expect(second.body.created).toEqual([]);

    const flagshipAfter = await getModelByName(db, 'gpt-5.5');
    expect(flagshipAfter?.inputPrice).toBe(3n);
    expect(flagshipAfter?.outputPrice).toBe(7n);
  });
});
