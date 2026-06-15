import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, it } from 'vitest';

import { AppModule } from '../src/app.module.js';

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app.close();
});

it('GET /health returns ok', async () => {
  await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
});
