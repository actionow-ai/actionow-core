import type { IntentResult, PaymentProviderKind, VerifiedEvent } from '@actionow/contracts';
import { createSubUser, findUserByEmail, schema } from '@actionow/db';
import type { JobQueuePort } from '@actionow/engine';
import { PaymentService } from '@actionow/engine';
import { FakeRateLimitRedis, hashPassword, RedisRateLimiter } from '@actionow/infra';
import type { PaymentProvider, PaymentRegistry } from '@actionow/payments';
import { SignatureVerificationError } from '@actionow/payments';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DB, ENV, JOB_QUEUE, PAYMENTS, RATE_LIMITER } from '../src/common/tokens.js';

const CREDIT_RATE = 10_000n;
const PROVIDER_REF = 'sess_console_users_e2e';
const EVENT_ID = 'evt_console_users_e2e';
const ADMIN_SECRET = 'console-users-e2e-secret';

let pg: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;
let app: INestApplication;
const jwt = new JwtService({ secret: ADMIN_SECRET });

const noopQueue: JobQueuePort = {
  enqueueExec: () => Promise.reject(new Error('console path must not enqueue')),
};

const fakeProvider: PaymentProvider = {
  kind: 'stripe',
  createIntent(): Promise<IntentResult> {
    return Promise.resolve({
      providerRef: PROVIDER_REF,
      redirectUrl: 'https://checkout.example/console',
    });
  },
  verifyWebhook(rawBody: Buffer | string): Promise<VerifiedEvent> {
    const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    if (body.includes('forged')) return Promise.reject(new SignatureVerificationError());
    return Promise.resolve({
      eventId: EVENT_ID,
      type: 'checkout.session.completed',
      providerRef: PROVIDER_REF,
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
    .overrideProvider(JOB_QUEUE)
    .useValue(noopQueue)
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
      STORAGE_PUBLIC_BASE_URL: 'https://asset.example',
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
  await client`TRUNCATE TABLE file_object, api_key, ledger_txn, payment_intent, payment_event, job, resource, account, tenant, "user" RESTART IDENTITY CASCADE`;
});

const server = (): ReturnType<typeof app.getHttpServer> => app.getHttpServer();

/**
 * Self-register a brand-new user via `/auth/register` (provisions a tenant +
 * account, and the registrant is its tenant ADMIN per the rbac self-register
 * change). Returns its USER JWT and the resolved tenant id.
 */
async function registerAdmin(
  email: string,
  password = 'sup3rSecret',
): Promise<{ token: string; tenantId: string }> {
  const res = await request(server()).post('/auth/register').send({ email, password }).expect(200);
  const me = await request(server())
    .get('/console/me')
    .set('authorization', `Bearer ${res.body.token as string}`)
    .expect(200);
  return { token: res.body.token as string, tenantId: me.body.tenant_id as string };
}

/**
 * Seed a tenant MEMBER (role=user, tenant_role=member) directly under an existing
 * tenant and sign its USER JWT (`{sub, role:'user'}` against ADMIN_JWT_SECRET) —
 * the same claim shape the ConsoleGuard accepts. The member is the non-admin seat
 * used to assert the TenantAdminGuard 403s.
 */
async function seedMemberToken(
  tenantId: string,
  email: string,
  password = 'memberPass1',
): Promise<string> {
  await createSubUser(db, { tenantId, email, passwordHash: hashPassword(password) });
  const member = await findUserByEmail(db, email);
  if (member === undefined) throw new Error('seeded member not found');
  return jwt.sign({ sub: member.id, role: 'user' });
}

describe('/console/users (rbac sub-user crud + tenant-admin gate)', () => {
  it('a tenant ADMIN can create + list sub-users', async () => {
    const { token: adminToken } = await registerAdmin('admin@example.com');

    const created = await request(server())
      .post('/console/users')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ email: 'member@example.com', password: 'memberPass1' })
      .expect(201);
    expect(created.body.id).toBeTypeOf('string');
    expect(created.body.email).toBe('member@example.com');
    expect(created.body).not.toHaveProperty('plaintext');
    expect(created.body).not.toHaveProperty('password');

    const listed = await request(server())
      .get('/console/users')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);
    // The admin (self-register) + the new member = 2 tenant users.
    expect(listed.body.data).toHaveLength(2);
    const roles = (listed.body.data as { tenant_role: string }[]).map((u) => u.tenant_role).sort();
    expect(roles).toEqual(['admin', 'member']);
    const emails = (listed.body.data as { email: string }[]).map((u) => u.email);
    expect(emails).toContain('member@example.com');
    expect(listed.body.data[0]).toHaveProperty('created_at');
    expect(listed.body.data[0]).not.toHaveProperty('password_hash');
  });

  it('an admin can promote/demote + disable a sub-user', async () => {
    const { token: adminToken, tenantId } = await registerAdmin('admin2@example.com');
    const member = await createSubUser(db, {
      tenantId,
      email: 'm2@example.com',
      passwordHash: hashPassword('memberPass1'),
    });
    const memberId = member.id;

    const promoted = await request(server())
      .patch(`/console/users/${memberId}`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({ tenantRole: 'admin' })
      .expect(200);
    expect(promoted.body.tenant_role).toBe('admin');

    const disabled = await request(server())
      .delete(`/console/users/${memberId}`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(disabled.body).toEqual({ id: memberId, status: 'disabled' });
  });

  it('a tenant MEMBER is 403 on admin writes but 200 on own-account reads/writes', async () => {
    const { token: adminToken, tenantId } = await registerAdmin(
      'admin3@example.com',
      'oldPassw0rd',
    );
    const memberToken = await seedMemberToken(tenantId, 'm3@example.com', 'memberPass1');

    // Member is forbidden on every gated administrative write.
    for (const [method, path, body] of [
      ['post', '/console/api-keys', {}],
      [
        'post',
        '/console/payments/intents',
        { provider: 'stripe', amount_minor: 100, currency: 'usd' },
      ],
      ['post', '/console/users', { email: 'x@example.com', password: 'whateverPass1' }],
    ] as const) {
      const res = await request(server())
        [method](path)
        .set('authorization', `Bearer ${memberToken}`)
        .send(body)
        .expect(403);
      expect(res.body.error.code).toBe('forbidden');
    }

    // But the member CAN read usage and change their own password.
    await request(server())
      .get('/console/usage')
      .set('authorization', `Bearer ${memberToken}`)
      .expect(200);
    await request(server())
      .patch('/console/settings')
      .set('authorization', `Bearer ${memberToken}`)
      .send({ currentPassword: 'memberPass1', newPassword: 'newMemberPass1' })
      .expect(200);

    // The admin remains able to mint a key (the gate lets admins through).
    await request(server())
      .post('/console/api-keys')
      .set('authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(201);
  });
});
