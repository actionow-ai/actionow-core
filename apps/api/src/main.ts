import 'reflect-metadata';

import { loadEnv } from '@actionow/infra';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule);
  await app.listen(env.API_PORT);
}

void bootstrap();
