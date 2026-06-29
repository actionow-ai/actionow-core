import { createUser, schema } from '@actionow/db';
import { hashPassword } from '@actionow/infra';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { decodeProtectedHeader, exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DB, ENV } from '../src/common/tokens.js';

const ADMIN_SECRET = 'e2e-jwks-secret';

let container: StartedPostgreSqlContainer;
let client: ReturnType<typeof postgres>;
let db: PostgresJsDatabase<typeof schema>;

const baseEnv = (extra: Record<string, unknown>): Record<string, unknown> => ({
  NODE_ENV: 'production',
  CREDIT_RATE: 1000,
  REDIS_URL: 'redis://localhost:6379',
  API_PORT: 3000,
  LOG_LEVEL: 'info',
  RATE_LIMIT_TENANT_PER_MIN: 600,
  RATE_LIMIT_RESOURCE_PER_MIN: 120,
  ADMIN_JWT_SECRET: ADMIN_SECRET,
  ...extra,
});

/** Build an app with a custom ENV (DB shared); JWT_KEYS re-resolves from this ENV. */
async function buildApp(extraEnv: Record<string, unknown>): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(ENV)
    .useValue(baseEnv({ DATABASE_URL: container.getConnectionUri(), ...extraEnv }))
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  client = postgres(container.getConnectionUri(), { max: 10 });
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: '../../packages/db/drizzle' });
}, 180_000);

afterAll(async () => {
  await client.end();
  await container.stop();
});

describe('GET /.well-known/jwks.json — default HS256 config', () => {
  it('returns an empty key array (never exposes the HMAC secret)', async () => {
    const app = await buildApp({}); // HS256 default
    try {
      const res = await request(app.getHttpServer()).get('/.well-known/jwks.json').expect(200);
      expect(res.body).toEqual({ keys: [] });
    } finally {
      await app.close();
    }
  });
});

describe('GET /.well-known/jwks.json — RS256 configured', () => {
  it('publishes a JWK whose kid matches an issued token header kid', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const pem = await exportPKCS8(privateKey);
    const app = await buildApp({ JWT_SIGNING_ALG: 'RS256', JWT_PRIVATE_KEY: pem });
    try {
      // Clean slate so the admin login below is deterministic.
      await client`TRUNCATE TABLE session, "user", tenant RESTART IDENTITY CASCADE`;
      await createUser(db, {
        email: 'jwks-admin@actionow.local',
        passwordHash: hashPassword('hunter2'),
        role: 'admin',
        emailVerified: true,
      });

      const jwks = await request(app.getHttpServer()).get('/.well-known/jwks.json').expect(200);
      expect(Array.isArray(jwks.body.keys)).toBe(true);
      expect(jwks.body.keys).toHaveLength(1);
      const publishedKid = jwks.body.keys[0].kid as string;
      expect(jwks.body.keys[0].alg).toBe('RS256');
      expect(jwks.body.keys[0]).not.toHaveProperty('d'); // public-only

      // An issued RS256 access token's header kid matches the published JWK.
      const login = await request(app.getHttpServer())
        .post('/admin/auth/login')
        .send({ email: 'jwks-admin@actionow.local', password: 'hunter2' })
        .expect(200);
      const header = decodeProtectedHeader(login.body.accessToken as string);
      expect(header.alg).toBe('RS256');
      expect(header.kid).toBe(publishedKid);

      // And the RS256 token actually gates the admin plane (verifier accepts it).
      await request(app.getHttpServer())
        .get('/admin/tenants')
        .set('authorization', `Bearer ${login.body.accessToken as string}`)
        .expect(200);
    } finally {
      await app.close();
    }
  });
});
