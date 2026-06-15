import 'reflect-metadata';

import { loadEnv } from '@actionow/infra';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { UnifiedErrorFilter } from './common/unified-error.filter.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule);
  // Belt-and-suspenders: the filter is also registered via APP_FILTER in
  // AppModule (so it applies under the test harness). Registering here keeps
  // it active even if the DI registration is ever removed.
  app.useGlobalFilters(new UnifiedErrorFilter());
  await app.listen(env.API_PORT);
}

void bootstrap();
