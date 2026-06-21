import { Module } from '@nestjs/common';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { RateLimitGuard } from '../auth/rate-limit.guard.js';
import { SecretResolver } from '../common/secret-resolver.js';
import { ExecutionModule } from '../execution/execution.module.js';
import { FilesModule } from '../files/files.module.js';
import { AudioController } from './audio.controller.js';
import { ImagesController } from './images.controller.js';
import { MediaDialectService } from './media-dialect.service.js';

/**
 * The OpenAI-compatible MEDIA dialects: `POST /v1/images/generations` +
 * `POST /v1/audio/speech`. Both relay onto the seeded `image-relay` / `audio-relay`
 * resources synchronously (the {@link MediaDialectService} drives the async job to
 * terminal in-process). Reuses `RunService` (from {@link ExecutionModule}) to build
 * the run; `DB`/`ADAPTERS`/`ENV`/`STORAGE` come from the global DbModule.
 */
@Module({
  imports: [ExecutionModule, FilesModule],
  controllers: [ImagesController, AudioController],
  providers: [MediaDialectService, AuthService, SecretResolver, ApiKeyGuard, RateLimitGuard],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class MediaDialectModule {}
