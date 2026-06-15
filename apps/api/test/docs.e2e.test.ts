import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DB, ENV } from '../src/common/tokens.js';
import { setupSwagger } from '../src/swagger.js';

let app: INestApplication;

beforeAll(async () => {
  // The docs surface is a pure metadata route — no db/redis is touched, so a
  // stub DB token is enough to let the module graph compile.
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB)
    .useValue({})
    .overrideProvider(ENV)
    .useValue({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://stub',
      REDIS_URL: 'redis://localhost:6379',
      API_PORT: 3000,
      LOG_LEVEL: 'info',
      DEV_TENANT_ID: undefined,
      RATE_LIMIT_TENANT_PER_MIN: 600,
      RATE_LIMIT_RESOURCE_PER_MIN: 120,
      ADMIN_JWT_SECRET: 'e2e-docs-secret',
    })
    .compile();

  app = moduleRef.createNestApplication();
  setupSwagger(app);
  await app.init();
}, 60_000);

afterAll(async () => {
  await app.close();
});

describe('OpenAPI docs', () => {
  it('serves the Swagger UI at /docs', async () => {
    const res = await request(app.getHttpServer()).get('/docs').expect(200);
    expect(res.text).toContain('Swagger UI');
  });

  it('serves the OpenAPI JSON spec with the /v1 and /admin paths', async () => {
    const res = await request(app.getHttpServer()).get('/docs-json').expect(200);
    expect(res.body.openapi).toBeTypeOf('string');
    const paths = Object.keys(res.body.paths as Record<string, unknown>);
    expect(paths.some((p) => p.startsWith('/v1/run'))).toBe(true);
    expect(paths.some((p) => p.startsWith('/admin/tenants'))).toBe(true);
    expect(paths.some((p) => p.startsWith('/admin/dify/import'))).toBe(true);
    // both bearer schemes are declared
    const schemes = Object.keys(
      (res.body.components as { securitySchemes: Record<string, unknown> }).securitySchemes,
    );
    expect(schemes).toEqual(expect.arrayContaining(['api-key', 'jwt']));
  });
});
