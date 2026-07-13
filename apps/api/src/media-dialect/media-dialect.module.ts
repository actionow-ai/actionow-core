import { Module } from '@nestjs/common';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { GatewayModule } from '../gateway/gateway.module.js';
import { AudioController } from './audio.controller.js';
import { ImagesController } from './images.controller.js';
import { MediaDialectService } from './media-dialect.service.js';

/**
 * The OpenAI-compatible MEDIA dialects: `POST /v1/images/generations` +
 * `POST /v1/audio/speech`. 批次6 D2: both ride the NEW supply gateway
 * ({@link GatewayModule}'s exported {@link GatewayService}) — operation
 * `images.generation` / `tts`, model-addressed, §3 自动升格 for slow models.
 * The old execution world (RunService/ExecutionService/JobRunner) is gone.
 */
@Module({
  imports: [GatewayModule],
  controllers: [ImagesController, AudioController],
  providers: [MediaDialectService, AuthService, ApiKeyGuard],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class MediaDialectModule {}
