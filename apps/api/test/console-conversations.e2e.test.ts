import type { IntentResult, PaymentProviderKind, VerifiedEvent } from '@actionow/contracts';
import { schema } from '@actionow/db';
import { PaymentService } from '@actionow/engine';
import { FakeRateLimitRedis, RedisRateLimiter } from '@actionow/infra';
import type { PaymentProvider, PaymentRegistry } from '@actionow/payments';
import { SignatureVerificationError } from '@actionow/payments';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DB, ENV, PAYMENTS, RATE_LIMITER } from '../src/common/tokens.js';
import { resetDb } from './reset-db.js';

const CREDIT_RATE = 10_000n;
const ADMIN_SECRET = 'console-conversations-e2e-secret';

let pg: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;
let app: INestApplication;

const fakeProvider: PaymentProvider = {
  kind: 'stripe',
  createIntent(): Promise<IntentResult> {
    return Promise.resolve({ providerRef: 'sess', redirectUrl: 'https://checkout.example/x' });
  },
  verifyWebhook(rawBody: Buffer | string): Promise<VerifiedEvent> {
    const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    if (body.includes('forged')) return Promise.reject(new SignatureVerificationError());
    return Promise.resolve({
      eventId: 'evt',
      type: 'checkout.session.completed',
      providerRef: 'sess',
      status: 'succeeded',
    });
  },
};

const fakeRegistry: PaymentRegistry = {
  get(kind: PaymentProviderKind): PaymentProvider {
    if (kind !== 'stripe') throw new Error(`unexpected provider ${kind}`);
    return fakeProvider;
  },
  has(kind: PaymentProviderKind): boolean {
    return kind === 'stripe';
  },
  configuredKinds(): PaymentProviderKind[] {
    return ['stripe'];
  },
};

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(pg.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });

  const paymentsService = new PaymentService({
    db,
    providers: fakeRegistry,
    creditRate: CREDIT_RATE,
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(PAYMENTS)
    .useValue(paymentsService)
    .overrideProvider(RATE_LIMITER)
    .useValue(new RedisRateLimiter(new FakeRateLimitRedis()))
    .overrideProvider(ENV)
    .useValue({
      NODE_ENV: 'production',
      DATABASE_URL: pg.getConnectionUri(),
      REDIS_URL: 'redis://localhost:6379',
      API_PORT: 0,
      LOG_LEVEL: 'info',
      ALLOW_DEV_TENANT_HEADER: false,
      RATE_LIMIT_TENANT_PER_MIN: 600,
      RATE_LIMIT_RESOURCE_PER_MIN: 600,
      ADMIN_JWT_SECRET: ADMIN_SECRET,
      STORAGE_MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
      AUTH_RATE_LIMIT_PER_MIN: 1000,
      CREDIT_RATE: 10000,
    })
    .compile();

  app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();
}, 180_000);

afterAll(async () => {
  await app.close();
  await client.end();
  await pg.stop();
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await resetDb(
    () =>
      client`TRUNCATE TABLE audit_log, message, conversation, api_key, ledger_txn, account, tenant, "user" RESTART IDENTITY CASCADE`,
  );
});

const server = (): ReturnType<typeof app.getHttpServer> => app.getHttpServer();

/** Self-register a tenant admin; returns its USER JWT. */
async function registerAdmin(email: string, password = 'sup3rSecret'): Promise<string> {
  const res = await request(server()).post('/auth/register').send({ email, password }).expect(200);
  return res.body.token as string;
}

describe('/console/conversations (playground transcript persistence)', () => {
  it('creates, appends turns (seq-ordered), renames, and soft-deletes a conversation', async () => {
    const token = await registerAdmin('pg-admin@example.com');
    const auth = (r: request.Test): request.Test => r.set('authorization', `Bearer ${token}`);

    // Create with an explicit model; title defaults server-side.
    const created = await auth(
      request(server()).post('/console/conversations').send({ model: 'deepseek-chat' }),
    ).expect(201);
    expect(created.body.id).toBeTypeOf('string');
    expect(created.body.model).toBe('deepseek-chat');
    expect(created.body.title).toBe('新对话');
    const id = created.body.id as string;

    // Append a user turn, then an assistant turn with reasoning + usage + latency.
    await auth(
      request(server())
        .post(`/console/conversations/${id}/messages`)
        .send({ role: 'user', content: 'hello' }),
    ).expect(201);
    const assistant = await auth(
      request(server())
        .post(`/console/conversations/${id}/messages`)
        .send({
          role: 'assistant',
          content: 'Hi there!',
          reasoning: 'a brief thought',
          usage: { input: 6, output: 3 },
          latency_ms: 1234,
          model: 'deepseek-chat',
        }),
    ).expect(201);
    expect(assistant.body.seq).toBe(1); // user=0, assistant=1
    expect(assistant.body.usage).toEqual({ input: 6, output: 3 });
    expect(assistant.body.reasoning).toBe('a brief thought');
    expect(assistant.body.latency_ms).toBe(1234);

    // Detail returns the transcript in seq order.
    const detail = await auth(request(server()).get(`/console/conversations/${id}`)).expect(200);
    expect(detail.body.messages).toHaveLength(2);
    expect(detail.body.messages[0]).toMatchObject({ seq: 0, role: 'user', content: 'hello' });
    expect(detail.body.messages[1]).toMatchObject({
      seq: 1,
      role: 'assistant',
      content: 'Hi there!',
    });
    expect(detail.body.messages[0].usage).toBeNull();

    // List shows the one conversation.
    const listed = await auth(request(server()).get('/console/conversations')).expect(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].id).toBe(id);

    // Rename + re-model.
    const renamed = await auth(
      request(server())
        .patch(`/console/conversations/${id}`)
        .send({ title: 'My chat', model: 'xiaomi-mimo' }),
    ).expect(200);
    expect(renamed.body.title).toBe('My chat');
    expect(renamed.body.model).toBe('xiaomi-mimo');

    // Soft-delete → 204, then gone from the list + 404 on get.
    await auth(request(server()).delete(`/console/conversations/${id}`)).expect(204);
    const afterDelete = await auth(request(server()).get('/console/conversations')).expect(200);
    expect(afterDelete.body.data).toHaveLength(0);
    await auth(request(server()).get(`/console/conversations/${id}`)).expect(404);
  });

  it("a tenant cannot touch another tenant's conversation (cross-tenant → 404)", async () => {
    const tokenA = await registerAdmin('pg-a@example.com');
    const tokenB = await registerAdmin('pg-b@example.com');
    const authA = (r: request.Test): request.Test => r.set('authorization', `Bearer ${tokenA}`);
    const authB = (r: request.Test): request.Test => r.set('authorization', `Bearer ${tokenB}`);

    const created = await authA(
      request(server()).post('/console/conversations').send({ model: 'deepseek-chat' }),
    ).expect(201);
    const id = created.body.id as string;

    // Tenant B's list excludes A's conversation.
    const listedB = await authB(request(server()).get('/console/conversations')).expect(200);
    expect(listedB.body.data).toHaveLength(0);

    // Every B-addressed route at A's conversation → 404 (never leaks / mutates).
    await authB(request(server()).get(`/console/conversations/${id}`)).expect(404);
    await authB(
      request(server()).patch(`/console/conversations/${id}`).send({ title: 'hijack' }),
    ).expect(404);
    await authB(request(server()).delete(`/console/conversations/${id}`)).expect(404);
    await authB(
      request(server())
        .post(`/console/conversations/${id}/messages`)
        .send({ role: 'user', content: 'sneaky' }),
    ).expect(404);

    // A's conversation is intact (no turn was written by B).
    const detailA = await authA(request(server()).get(`/console/conversations/${id}`)).expect(200);
    expect(detailA.body.messages).toHaveLength(0);
  });
});
