import type { ProviderAdapter } from '@actionow/adapters';
import { AdapterRegistry } from '@actionow/adapters';
import type { SubmitInput, SubmitResult, UnifiedError, UsageVector } from '@actionow/contracts';
import { schema } from '@actionow/db';
import { hashPassword } from '@actionow/infra';
import { FakeRateLimitRedis, RedisRateLimiter } from '@actionow/infra';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { ADAPTERS, DB, ENV, RATE_LIMITER } from '../src/common/tokens.js';
import { resetDb } from './reset-db.js';

const ADMIN_SECRET = 'member-writes-e2e-secret';

let pg: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;
let app: INestApplication;
const jwt = new JwtService({ secret: ADMIN_SECRET });

/** A trivial sync LLM so a self-minted key can be exercised end-to-end on /v1. */
const fakeLlm: ProviderAdapter = {
  providerType: 'fake-llm',
  submit(input: SubmitInput): Promise<SubmitResult> {
    return Promise.resolve({
      kind: 'sync',
      output: { text: `echo: ${String(input.inputs.prompt)}` },
      usage: { tokens: 300 },
    });
  },
  extractUsage(): UsageVector {
    return {};
  },
  mapError(): UnifiedError {
    return { code: 'upstream_error', message: 'fake', retryable: false };
  },
};

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(pg.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });

  const adapters = new AdapterRegistry();
  adapters.register(fakeLlm);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(ADAPTERS)
    .useValue(adapters)
    .overrideProvider(RATE_LIMITER)
    .useValue(new RedisRateLimiter(new FakeRateLimitRedis()))
    .overrideProvider(ENV)
    .useValue({
      // 'production' so the x-tenant-id dev fallback is OFF — a real key is required.
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
  // Let any fire-and-forget audit inserts drain before the FK-cascade TRUNCATE.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await resetDb(
    () =>
      client`TRUNCATE TABLE audit_log, sub_account, subject, file_object, api_key, ledger_txn, usage_log, payment_intent, payment_event, job, idempotency_key, pricebook_entry, upstream_channel, resource_version, resource, account, tenant, "user" RESTART IDENTITY CASCADE`,
  );
});

const server = (): ReturnType<typeof app.getHttpServer> => app.getHttpServer();

/** First row of a query result or a hard failure (keeps the tests assertion-free). */
function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('expected at least one row');
  return row;
}

/** Poll for a value (the `@Audit` interceptor writes fire-and-forget, after the response). */
async function pollFor<T>(fn: () => Promise<T | undefined>, tries = 40): Promise<T | undefined> {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}

/** Self-register a tenant admin; returns its operator JWT + the resolved tenant id. */
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

/** Create a subject (end-user) under `token`'s tenant; returns its id. */
async function makeSubject(token: string, externalId: string): Promise<string> {
  const created = await request(server())
    .post('/console/subjects')
    .set('authorization', `Bearer ${token}`)
    .send({ externalId })
    .expect(201);
  return created.body.id as string;
}

/** Sign a MEMBER JWT (`{sub, tenant_id, typ:'subject'}`) the MemberGuard accepts. */
function memberToken(subjectId: string, tenantId: string): string {
  return jwt.sign({ sub: subjectId, tenant_id: tenantId, typ: 'subject' });
}

/** Seed a `/v1` resource (fake-llm, unit pricing) for the tenant so keys can run. */
async function seedResource(tenantId: string, resourceId: string): Promise<void> {
  await db.insert(schema.resource).values({
    id: resourceId,
    tenantId,
    kind: 'model',
    modality: 'text',
    providerType: 'fake-llm',
    execModes: ['blocking'],
    currentVersion: 1,
  });
  await db.insert(schema.resourceVersion).values({
    resourceId,
    version: 1,
    ioSchema: {
      inputs: [{ key: 'prompt', type: 'string', required: true }],
      outputs: [{ key: 'text', type: 'string' }],
    },
  });
  await db.insert(schema.pricebookEntry).values({
    resourceId,
    resourceVersion: 1,
    version: 1,
    method: 'unit',
    timing: 'post',
    spec: { method: 'unit', dimensions: { tokens: { rate: 1 } } },
    active: true,
  });
  await db.insert(schema.upstreamChannel).values({
    resourceId,
    providerType: 'fake-llm',
    weight: 1,
    status: 'active',
  });
}

describe('/member/* write self-service (subject-scoped)', () => {
  it('PATCH /member/me updates the caller-subject own display_name', async () => {
    const { token: adminToken, tenantId } = await registerAdmin('mw-profile@example.com');
    const subjectId = await makeSubject(adminToken, 'mw-profile-subj');
    const token = memberToken(subjectId, tenantId);

    const res = await request(server())
      .patch('/member/me')
      .set('authorization', `Bearer ${token}`)
      .send({ display_name: 'Ada Lovelace' })
      .expect(200);
    expect(res.body.id).toBe(subjectId);
    expect(res.body.display_name).toBe('Ada Lovelace');
    expect(res.body).not.toHaveProperty('password_hash');

    // Persisted: GET /member/me reflects it.
    const me = await request(server())
      .get('/member/me')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(me.body.display_name).toBe('Ada Lovelace');

    // An empty display_name is rejected by the contract (invalid_input 400).
    const bad = await request(server())
      .patch('/member/me')
      .set('authorization', `Bearer ${token}`)
      .send({ display_name: '' })
      .expect(400);
    expect(bad.body.error.code).toBe('invalid_input');
  });

  it('POST /member/me/password changes the password; wrong current → 400; Model-B → 400', async () => {
    const { token: adminToken, tenantId } = await registerAdmin('mw-pw@example.com');

    // Model-A subject WITH a password_hash (seeded directly — Model-A login subject).
    const inserted = await db
      .insert(schema.subject)
      .values({
        tenantId,
        email: 'enduser-a@example.com',
        passwordHash: hashPassword('oldPassword1'),
      })
      .returning({ id: schema.subject.id });
    const subjectA = firstRow(inserted).id;
    const tokenA = memberToken(subjectA, tenantId);

    // Wrong current password → 400 invalid_input (hash unchanged).
    const wrong = await request(server())
      .post('/member/me/password')
      .set('authorization', `Bearer ${tokenA}`)
      .send({ current_password: 'notTheRightOne', new_password: 'brandNewPass1' })
      .expect(400);
    expect(wrong.body.error.code).toBe('invalid_input');

    // Correct current password → 200 ok; the stored hash now verifies the new pw.
    await request(server())
      .post('/member/me/password')
      .set('authorization', `Bearer ${tokenA}`)
      .send({ current_password: 'oldPassword1', new_password: 'brandNewPass1' })
      .expect(200);
    const refreshed = await db
      .select({ hash: schema.subject.passwordHash })
      .from(schema.subject)
      .where(eq(schema.subject.id, subjectA));
    const newHash = firstRow(refreshed).hash;
    expect(newHash).not.toBeNull();
    expect(newHash).not.toBe(hashPassword('oldPassword1')); // salted → differs anyway

    // A passwordless Model-B subject (no password_hash) → 400 invalid_input.
    const subjectB = await makeSubject(adminToken, 'mw-pw-modelb');
    const tokenB = memberToken(subjectB, tenantId);
    const modelB = await request(server())
      .post('/member/me/password')
      .set('authorization', `Bearer ${tokenB}`)
      .send({ current_password: 'anything', new_password: 'brandNewPass1' })
      .expect(400);
    expect(modelB.body.error.code).toBe('invalid_input');

    // A weak new password is rejected by the contract regardless.
    const weak = await request(server())
      .post('/member/me/password')
      .set('authorization', `Bearer ${tokenA}`)
      .send({ current_password: 'brandNewPass1', new_password: 'short' })
      .expect(400);
    expect(weak.body.error.code).toBe('invalid_input');
  });

  it('POST /member/api-keys self-mints a subject-scoped key that runs on /v1', async () => {
    const { token: adminToken, tenantId } = await registerAdmin('mw-mint@example.com');
    // Fund the tenant pool so the subject (shared mode) can pay for the run.
    await db
      .update(schema.account)
      .set({ creditBalance: 50_000_000n })
      .where(eq(schema.account.tenantId, tenantId));
    await seedResource(tenantId, 'openai-gpt');

    const subjectId = await makeSubject(adminToken, 'mw-mint-subj');
    const token = memberToken(subjectId, tenantId);

    const mint = await request(server())
      .post('/member/api-keys')
      .set('authorization', `Bearer ${token}`)
      .send({})
      .expect(201);
    const plaintext = mint.body.plaintext as string;
    expect(plaintext.startsWith('ak_')).toBe(true);
    expect(mint.body.id).toBeTypeOf('string');

    // The minted key is bound to THIS subject (verified in the db).
    const row = await db
      .select({ subjectId: schema.apiKey.subjectId })
      .from(schema.apiKey)
      .where(eq(schema.apiKey.id, mint.body.id as string));
    expect(firstRow(row).subjectId).toBe(subjectId);

    // The self-minted key authenticates on the /v1 data plane (批次6 D2: the
    // old /v1/run face is gone — the task-center list is the auth probe).
    const tasks = await request(server())
      .get('/v1/tasks')
      .set('authorization', `Bearer ${plaintext}`)
      .expect(200);
    expect(Array.isArray(tasks.body.data)).toBe(true);

    // It shows up in the member's own (masked) key list.
    const keys = await request(server())
      .get('/member/api-keys')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(keys.body.some((k: { id: string }) => k.id === (mint.body.id as string))).toBe(true);

    // 记录系统: the self-mint emitted a MEMBER-attributed audit_log row (the /member
    // plane was previously unaudited). Fire-and-forget → poll for it.
    const auditRow = await pollFor(async () => {
      const rows = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, 'member.api_key.create'));
      return rows[0];
    });
    expect(auditRow?.actorType).toBe('member');
    expect(auditRow?.actorId).toBe(subjectId);
    expect(auditRow?.subjectId).toBe(subjectId);
    expect(auditRow?.tenantId).toBe(tenantId);
    expect(auditRow?.targetId).toBe(mint.body.id as string);
  });

  it('DELETE /member/api-keys/:id revokes OWN key (it stops authing); a sibling key → 404', async () => {
    const { token: adminToken, tenantId } = await registerAdmin('mw-revoke@example.com');
    await db
      .update(schema.account)
      .set({ creditBalance: 50_000_000n })
      .where(eq(schema.account.tenantId, tenantId));
    await seedResource(tenantId, 'openai-gpt');

    const subjectA = await makeSubject(adminToken, 'mw-revoke-a');
    const subjectB = await makeSubject(adminToken, 'mw-revoke-b');
    const tokenA = memberToken(subjectA, tenantId);
    const tokenB = memberToken(subjectB, tenantId);

    // A self-mints a key; B self-mints a key.
    const keyA = await request(server())
      .post('/member/api-keys')
      .set('authorization', `Bearer ${tokenA}`)
      .send({})
      .expect(201);
    const keyB = await request(server())
      .post('/member/api-keys')
      .set('authorization', `Bearer ${tokenB}`)
      .send({})
      .expect(201);

    // The admin also mints a TENANT-LEVEL key (subject_id NULL).
    const tenantKey = await request(server())
      .post('/console/api-keys')
      .set('authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(201);

    // CROSS-SUBJECT ISOLATION: A cannot revoke B's key → 404 (B's key still works).
    const crossSubject = await request(server())
      .delete(`/member/api-keys/${keyB.body.id as string}`)
      .set('authorization', `Bearer ${tokenA}`)
      .expect(404);
    expect(crossSubject.body.error.code).toBe('resource_not_found');

    // A cannot revoke the TENANT-LEVEL key either → 404 (subject_id mismatch).
    await request(server())
      .delete(`/member/api-keys/${tenantKey.body.id as string}`)
      .set('authorization', `Bearer ${tokenA}`)
      .expect(404);

    // B's key still authenticates after A's failed cross-subject revoke attempt.
    await request(server())
      .get('/v1/tasks')
      .set('authorization', `Bearer ${keyB.body.plaintext as string}`)
      .expect(200);

    // A revokes its OWN key → 200; the revoked key then stops authenticating (401).
    const revoked = await request(server())
      .delete(`/member/api-keys/${keyA.body.id as string}`)
      .set('authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(revoked.body.status).toBe('revoked');

    const afterRevoke = await request(server())
      .get('/v1/tasks')
      .set('authorization', `Bearer ${keyA.body.plaintext as string}`)
      .expect(401);
    expect(afterRevoke.body.error.code).toBe('unauthorized');

    // A second revoke of the now-deleted key is an idempotent 404.
    await request(server())
      .delete(`/member/api-keys/${keyA.body.id as string}`)
      .set('authorization', `Bearer ${tokenA}`)
      .expect(404);

    // The revoked key no longer appears in A's masked key list.
    const list = await request(server())
      .get('/member/api-keys')
      .set('authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(list.body.some((k: { id: string }) => k.id === (keyA.body.id as string))).toBe(false);

    // B never lost its key (the cross-subject attempt above was a no-op revoke):
    // exactly one LIVE key remains for B in this tenant.
    const liveForB = await db
      .select({ id: schema.apiKey.id })
      .from(schema.apiKey)
      .where(and(eq(schema.apiKey.subjectId, subjectB), eq(schema.apiKey.tenantId, tenantId)));
    expect(liveForB).toHaveLength(1);
    expect(firstRow(liveForB).id).toBe(keyB.body.id as string);
  });
});
