import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { DB, ENV } from '../src/common/tokens.js';

let app: INestApplication;

// The health endpoints touch no infrastructure, but `AppModule` now wires the
// global `DbModule` whose factories read env / create a db handle. Override
// those tokens with inert stubs so this stays a pure, network-free smoke test.
beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue({
      NODE_ENV: 'test',
      CREDIT_RATE: 1000,
      DATABASE_URL: 'postgresql://localhost/none',
      REDIS_URL: 'redis://localhost:6379',
      API_PORT: 3000,
      LOG_LEVEL: 'info',
    })
    .overrideProvider(DB)
    .useValue({})
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app.close();
});

it('GET /health returns ok', async () => {
  await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
});
