import 'reflect-metadata';

import { loadEnv } from '@actionow/infra';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { UnifiedErrorFilter } from './common/unified-error.filter.js';
import { setupSwagger } from './swagger.js';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  // `rawBody: true` makes the exact request bytes available as `req.rawBody`
  // (a Buffer) on every route while still JSON-parsing the body normally. The
  // `/v1/callbacks/:provider` ingress recomputes the HMAC over these exact
  // bytes — re-serializing the parsed JSON would not byte-match the signature.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  // Run NestJS lifecycle hooks (onModuleDestroy) on SIGTERM/SIGINT so a routine
  // deploy drains gracefully — e.g. BullmqJobQueue.close() quits its Redis client
  // instead of being hard-killed mid-flight.
  app.enableShutdownHooks();
  // Belt-and-suspenders: the filter is also registered via APP_FILTER in
  // AppModule (so it applies under the test harness). Registering here keeps
  // it active even if the DI registration is ever removed.
  app.useGlobalFilters(new UnifiedErrorFilter());
  setupSwagger(app);
  await app.listen(env.API_PORT);
}

void bootstrap();
