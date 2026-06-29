import type { StorageProviderConfig } from '@actionow/contracts';
import { createApiKey, schema } from '@actionow/db';
import type { JobQueuePort } from '@actionow/engine';
import { createS3StorageProvider, FakeRateLimitRedis, RedisRateLimiter } from '@actionow/infra';
import { CreateBucketCommand } from '@aws-sdk/client-s3';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import request from 'supertest';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import type { TenantContext } from '../src/auth/auth.service.js';
import { DB, ENV, JOB_QUEUE, RATE_LIMITER, STORAGE } from '../src/common/tokens.js';
import { FilesService } from '../src/files/files.service.js';

const { account, tenant } = schema;

const MINIO_USER = 'actionow';
const MINIO_PASSWORD = 'actionow123';
const BUCKET = 'actionow-files-test';

let pg: StartedPostgreSqlContainer;
let minio: StartedTestContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;
let app: INestApplication;
let filesService: FilesService;

const noopQueue: JobQueuePort = {
  enqueueExec: () => Promise.reject(new Error('files path must not enqueue')),
};

beforeAll(async () => {
  // Real Postgres + real MinIO via Testcontainers (random host ports).
  pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  minio = await new GenericContainer('minio/minio:latest')
    .withCommand(['server', '/data'])
    .withExposedPorts(9000)
    .withEnvironment({ MINIO_ROOT_USER: MINIO_USER, MINIO_ROOT_PASSWORD: MINIO_PASSWORD })
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000).forStatusCode(200))
    .start();

  client = postgres(pg.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });

  // Build the real MinIO-backed storage provider the API will inject, and
  // create its bucket up front.
  const endpoint = `http://${minio.getHost()}:${String(minio.getMappedPort(9000))}`;
  const storageCfg: StorageProviderConfig = {
    kind: 'minio',
    bucket: BUCKET,
    region: 'us-east-1',
    endpoint,
    accessKeyId: MINIO_USER,
    secretAccessKey: MINIO_PASSWORD,
    forcePathStyle: true,
  };
  const storage = createS3StorageProvider(storageCfg);
  await storage.client.send(new CreateBucketCommand({ Bucket: BUCKET }));

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(STORAGE)
    .useValue(storage)
    .overrideProvider(JOB_QUEUE)
    .useValue(noopQueue)
    .overrideProvider(RATE_LIMITER)
    .useValue(new RedisRateLimiter(new FakeRateLimitRedis()))
    .overrideProvider(ENV)
    .useValue({
      // 'production' so the x-tenant-id dev fallback is OFF — a real key is required.
      NODE_ENV: 'production',
      CREDIT_RATE: 1000,
      DATABASE_URL: pg.getConnectionUri(),
      REDIS_URL: 'redis://localhost:6379',
      API_PORT: 0,
      LOG_LEVEL: 'info',
      DEV_TENANT_ID: undefined,
      RATE_LIMIT_TENANT_PER_MIN: 600,
      RATE_LIMIT_RESOURCE_PER_MIN: 120,
      ADMIN_JWT_SECRET: 'test-admin-secret',
      STORAGE_PROVIDER: 'minio',
      STORAGE_BUCKET: BUCKET,
      STORAGE_REGION: 'us-east-1',
      STORAGE_ENDPOINT: endpoint,
      STORAGE_ACCESS_KEY_ID: MINIO_USER,
      STORAGE_SECRET_ACCESS_KEY: MINIO_PASSWORD,
      STORAGE_FORCE_PATH_STYLE: true,
      STORAGE_MAX_UPLOAD_BYTES: 1024,
    })
    .compile();

  app = moduleRef.createNestApplication();
  await app.init();
  filesService = app.get(FilesService);
}, 180_000);

afterAll(async () => {
  await app.close();
  await client.end();
  await Promise.all([pg.stop(), minio.stop()]);
});

/** Seed a tenant + its billing account (the ApiKeyGuard requires an account). */
async function seedTenant(name: string): Promise<string> {
  const [t] = await db.insert(tenant).values({ name }).returning();
  if (!t) throw new Error('tenant insert returned no row');
  await db.insert(account).values({ tenantId: t.id, creditBalance: 1_000_000n, creditHeld: 0n });
  return t.id;
}

describe('POST/GET /v1/files over real MinIO', () => {
  it('round-trips a file: presign-upload → PUT → confirm → get-url → GET returns the bytes', async () => {
    const tenantId = await seedTenant('acme');
    const { plaintext: key } = await createApiKey(db, { tenantId });
    const body = new TextEncoder().encode('the quick brown fox');
    const contentType = 'text/plain';

    // 1. presign-upload
    const presign = await request(app.getHttpServer())
      .post('/v1/files/presign-upload')
      .set('authorization', `Bearer ${key}`)
      .send({ filename: 'fox.txt', content_type: contentType, size: body.byteLength })
      .expect(200);
    expect(presign.body.file_id).toBeTruthy();
    expect(presign.body.upload_url).toContain('X-Amz-Signature');
    expect(presign.body.key).toMatch(new RegExp(`^${tenantId}/.+\\.txt$`));
    expect(presign.body.expires_in).toBeGreaterThan(0);

    // 2. real PUT to MinIO (global fetch). Without the non-AWS checksum fix this
    //    400s — so a 200 here also proves the fix end-to-end through the API.
    const putRes = await fetch(presign.body.upload_url, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body,
    });
    expect(putRes.status).toBe(200);

    // 3. confirm: head finds the object → status ready + observed metadata.
    const confirm = await request(app.getHttpServer())
      .post(`/v1/files/${String(presign.body.file_id)}/confirm`)
      .set('authorization', `Bearer ${key}`)
      .expect(200);
    expect(confirm.body.id).toBe(presign.body.file_id);
    expect(confirm.body.status).toBe('ready');
    expect(confirm.body.size).toBe(body.byteLength);
    expect(confirm.body.etag).toBeTruthy();

    // 4. get-url → real GET returns the exact bytes.
    const urlRes = await request(app.getHttpServer())
      .get(`/v1/files/${String(presign.body.file_id)}/url`)
      .set('authorization', `Bearer ${key}`)
      .expect(200);
    expect(urlRes.body.url).toContain('X-Amz-Signature');

    const getRes = await fetch(String(urlRes.body.url));
    expect(getRes.status).toBe(200);
    const downloaded = new Uint8Array(await getRes.arrayBuffer());
    expect(new TextDecoder().decode(downloaded)).toBe('the quick brown fox');
  });

  it('confirm 400 invalid_input when the upload never landed', async () => {
    const tenantId = await seedTenant('ghost');
    const { plaintext: key } = await createApiKey(db, { tenantId });
    const presign = await request(app.getHttpServer())
      .post('/v1/files/presign-upload')
      .set('authorization', `Bearer ${key}`)
      .send({ filename: 'missing.bin', content_type: 'application/octet-stream', size: 10 })
      .expect(200);

    // Never PUT the bytes — confirm must report the object as missing.
    const res = await request(app.getHttpServer())
      .post(`/v1/files/${String(presign.body.file_id)}/confirm`)
      .set('authorization', `Bearer ${key}`)
      .expect(400);
    expect(res.body.error.code).toBe('invalid_input');
  });

  it("404 resource_not_found for another tenant's file_id (isolation)", async () => {
    // Tenant A uploads a file; tenant B must not be able to confirm or read it.
    const tenantA = await seedTenant('owner');
    const { plaintext: keyA } = await createApiKey(db, { tenantId: tenantA });
    const tenantB = await seedTenant('intruder');
    const { plaintext: keyB } = await createApiKey(db, { tenantId: tenantB });

    const presign = await request(app.getHttpServer())
      .post('/v1/files/presign-upload')
      .set('authorization', `Bearer ${keyA}`)
      .send({ filename: 'secret.txt', content_type: 'text/plain', size: 5 })
      .expect(200);
    const fileId = String(presign.body.file_id);

    // Cross-tenant confirm → 404.
    const confirmRes = await request(app.getHttpServer())
      .post(`/v1/files/${fileId}/confirm`)
      .set('authorization', `Bearer ${keyB}`)
      .expect(404);
    expect(confirmRes.body.error.code).toBe('resource_not_found');

    // Cross-tenant get-url → 404.
    const urlRes = await request(app.getHttpServer())
      .get(`/v1/files/${fileId}/url`)
      .set('authorization', `Bearer ${keyB}`)
      .expect(404);
    expect(urlRes.body.error.code).toBe('resource_not_found');
  });

  it('presign-upload 400 invalid_input when size exceeds the configured max', async () => {
    const tenantId = await seedTenant('oversize');
    const { plaintext: key } = await createApiKey(db, { tenantId });
    const res = await request(app.getHttpServer())
      .post('/v1/files/presign-upload')
      .set('authorization', `Bearer ${key}`)
      // STORAGE_MAX_UPLOAD_BYTES is overridden to 1024 in the test env.
      .send({ filename: 'big.bin', content_type: 'application/octet-stream', size: 2048 })
      .expect(400);
    expect(res.body.error.code).toBe('invalid_input');
  });

  it('presign-upload 400 invalid_input on an empty filename', async () => {
    const tenantId = await seedTenant('emptyname');
    const { plaintext: key } = await createApiKey(db, { tenantId });
    const res = await request(app.getHttpServer())
      .post('/v1/files/presign-upload')
      .set('authorization', `Bearer ${key}`)
      .send({ filename: '', content_type: 'text/plain', size: 10 })
      .expect(400);
    expect(res.body.error.code).toBe('invalid_input');
  });

  it('401 unauthorized when no API key is presented', async () => {
    await request(app.getHttpServer())
      .post('/v1/files/presign-upload')
      .send({ filename: 'x.txt', content_type: 'text/plain', size: 1 })
      .expect(401);
  });

  it('GET /v1/files lists the caller-tenant files (keyset envelope, created_at, status filter, tenant-scoped)', async () => {
    const tenantId = await seedTenant('lister');
    const { plaintext: key } = await createApiKey(db, { tenantId });
    const other = await seedTenant('lister-other');

    await db.insert(schema.fileObject).values([
      {
        tenantId,
        provider: 'minio',
        bucket: BUCKET,
        key: `${tenantId}/one.png`,
        status: 'ready',
        contentType: 'image/png',
        size: 10,
        createdAt: new Date('2026-02-01Z'),
      },
      {
        tenantId,
        provider: 'minio',
        bucket: BUCKET,
        key: `${tenantId}/two.png`,
        status: 'ready',
        contentType: 'image/png',
        size: 20,
        createdAt: new Date('2026-02-02Z'),
      },
      {
        tenantId,
        provider: 'minio',
        bucket: BUCKET,
        key: `${tenantId}/p.png`,
        status: 'pending',
        contentType: 'image/png',
        createdAt: new Date('2026-02-03Z'),
      },
      {
        tenantId: other,
        provider: 'minio',
        bucket: BUCKET,
        key: `${other}/secret.png`,
        status: 'ready',
        contentType: 'image/png',
        size: 5,
        createdAt: new Date('2026-02-04Z'),
      },
    ]);

    // Unfiltered: every caller file (pending + ready), newest-first; the other tenant excluded.
    const all = await request(app.getHttpServer())
      .get('/v1/files')
      .set('authorization', `Bearer ${key}`)
      .expect(200);
    expect(all.body.data).toHaveLength(3);
    expect(all.body.data[0].created_at).toBeTruthy();
    expect(all.body.data[0]).toHaveProperty('etag');
    expect(all.body).toHaveProperty('next_cursor');
    expect(all.body).toHaveProperty('has_more', false);

    // status=ready narrows to the two ready files.
    const ready = await request(app.getHttpServer())
      .get('/v1/files?status=ready')
      .set('authorization', `Bearer ${key}`)
      .expect(200);
    expect(ready.body.data).toHaveLength(2);
    for (const f of ready.body.data as { status: string }[]) expect(f.status).toBe('ready');

    // Anonymous → 401.
    await request(app.getHttpServer()).get('/v1/files').expect(401);
  });
});

describe('DELETE + usage + quota', () => {
  async function presignPutConfirm(
    key: string,
    filename: string,
    bytes: Uint8Array,
  ): Promise<string> {
    const presign = await request(app.getHttpServer())
      .post('/v1/files/presign-upload')
      .set('authorization', `Bearer ${key}`)
      .send({ filename, content_type: 'text/plain', size: bytes.byteLength })
      .expect(200);
    const fileId = String(presign.body.file_id);
    await fetch(presign.body.upload_url, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: bytes,
    });
    await request(app.getHttpServer())
      .post(`/v1/files/${fileId}/confirm`)
      .set('authorization', `Bearer ${key}`)
      .expect(200);
    return fileId;
  }

  it('delete tombstones a file: 204, then gone from get-url / list / usage', async () => {
    const tenantId = await seedTenant('deleter');
    const { plaintext: key } = await createApiKey(db, { tenantId });
    const body = new TextEncoder().encode('bye');
    const fileId = await presignPutConfirm(key, 'gone.txt', body);

    const u1 = await request(app.getHttpServer())
      .get('/v1/files/usage')
      .set('authorization', `Bearer ${key}`)
      .expect(200);
    expect(u1.body).toMatchObject({ bytes: body.byteLength, count: 1 });

    await request(app.getHttpServer())
      .delete(`/v1/files/${fileId}`)
      .set('authorization', `Bearer ${key}`)
      .expect(204);

    await request(app.getHttpServer())
      .get(`/v1/files/${fileId}/url`)
      .set('authorization', `Bearer ${key}`)
      .expect(404);
    const list = await request(app.getHttpServer())
      .get('/v1/files')
      .set('authorization', `Bearer ${key}`)
      .expect(200);
    expect(list.body.data).toHaveLength(0);
    const u2 = await request(app.getHttpServer())
      .get('/v1/files/usage')
      .set('authorization', `Bearer ${key}`)
      .expect(200);
    expect(u2.body).toMatchObject({ bytes: 0, count: 0, quota_bytes: null });
  });

  it('presign-upload 400 when the per-tenant storage quota would be exceeded', async () => {
    const tenantId = await seedTenant('quota');
    const { plaintext: key } = await createApiKey(db, { tenantId });
    // Confirm a 50-byte file so live usage is 50.
    await presignPutConfirm(key, 'a.txt', new TextEncoder().encode('x'.repeat(50)));

    // A 100-byte per-tenant cap; a further 60 bytes → 110 > 100 → reject at presign.
    await db
      .update(account)
      .set({ config: { storage_quota_bytes: 100 } })
      .where(eq(account.tenantId, tenantId));
    const res = await request(app.getHttpServer())
      .post('/v1/files/presign-upload')
      .set('authorization', `Bearer ${key}`)
      .send({ filename: 'b.txt', content_type: 'text/plain', size: 60 })
      .expect(400);
    expect(res.body.error.code).toBe('invalid_input');
  });
});

describe('FilesService.resolveFileInputs', () => {
  it('replaces file / file_list inputs with presigned GET URLs (tenant + ready scoped)', async () => {
    const tenantId = await seedTenant('resolve');
    const { plaintext: key } = await createApiKey(db, { tenantId });
    const ctx: TenantContext = { tenantId, accountId: 'unused' };

    // Upload + confirm two ready files via the API so they are `ready`.
    const ids: string[] = [];
    for (const n of ['a', 'b']) {
      const body = new TextEncoder().encode(`file-${n}`);
      const presign = await request(app.getHttpServer())
        .post('/v1/files/presign-upload')
        .set('authorization', `Bearer ${key}`)
        .send({ filename: `${n}.txt`, content_type: 'text/plain', size: body.byteLength })
        .expect(200);
      await fetch(presign.body.upload_url, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body,
      });
      await request(app.getHttpServer())
        .post(`/v1/files/${String(presign.body.file_id)}/confirm`)
        .set('authorization', `Bearer ${key}`)
        .expect(200);
      ids.push(String(presign.body.file_id));
    }

    const ioSchema = {
      inputs: [
        { key: 'prompt', type: 'string' as const },
        { key: 'image', type: 'file' as const },
        { key: 'gallery', type: 'file_list' as const },
      ],
      outputs: [],
    };
    const resolved = await filesService.resolveFileInputs(
      ioSchema,
      { prompt: 'hello', image: ids[0], gallery: [ids[0], ids[1]] },
      ctx,
    );

    // Non-file field passes through; file/file_list become presigned GET URLs.
    expect(resolved.prompt).toBe('hello');
    expect(String(resolved.image)).toContain('X-Amz-Signature');
    expect(Array.isArray(resolved.gallery)).toBe(true);
    for (const url of resolved.gallery as string[]) {
      expect(url).toContain('X-Amz-Signature');
      const res = await fetch(url);
      expect(res.status).toBe(200);
    }
  });

  it('rejects an unknown / non-ready file id with invalid_input', async () => {
    const tenantId = await seedTenant('resolve-missing');
    const ctx: TenantContext = { tenantId, accountId: 'unused' };
    const ioSchema = {
      inputs: [{ key: 'image', type: 'file' as const }],
      outputs: [],
    };
    await expect(
      filesService.resolveFileInputs(
        ioSchema,
        { image: '00000000-0000-0000-0000-000000000000' },
        ctx,
      ),
    ).rejects.toMatchObject({ unified: { code: 'invalid_input' } });
  });
});
