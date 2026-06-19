import { Module } from '@nestjs/common';

import { FilesModule } from '../files/files.module.js';
import { CallbacksController } from './callbacks.controller.js';
import { CallbacksService } from './callbacks.service.js';

/**
 * Wires `POST /v1/callbacks/:provider` — the signed async-callback ingress.
 * Intentionally has NO ApiKeyGuard: the per-channel HMAC over the raw body is
 * the auth (see {@link CallbacksService}). `DB`/`ADAPTERS`/`SecretResolver` come
 * from the global {@link DbModule}; `STORAGE` (for best-effort media persistence
 * on the webhook settle path) is re-used from {@link FilesModule}'s export.
 */
@Module({
  imports: [FilesModule],
  controllers: [CallbacksController],
  providers: [CallbacksService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class CallbacksModule {}
