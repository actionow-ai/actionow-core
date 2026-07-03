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
  // CORS: the `/v1` API is Bearer-key authed (no cookies), so browser clients — a
  // local test/demo page, a web SDK, a third-party app front-end — can call it
  // cross-origin. `origin: true` reflects the caller's origin; we set NO
  // credentials mode, so cookies are never sent cross-origin (no CSRF surface on
  // the cookieless bearer endpoints). Preflight caches for a day.
  app.enableCors({ origin: true, maxAge: 86400 });
  setupSwagger(app);
  await app.listen(env.API_PORT);
}

void bootstrap();
