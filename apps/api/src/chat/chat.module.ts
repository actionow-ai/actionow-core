import { Module } from '@nestjs/common';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { GatewayModule } from '../gateway/gateway.module.js';
import { AnthropicChatController } from './anthropic.controller.js';
import { EmbeddingsController } from './embeddings.controller.js';
import { GeminiChatController } from './gemini.controller.js';
import {
  MODEL_RESOLVER,
  ModelResolverService,
  realModelResolverPort,
} from './model-resolver.service.js';
import { ModelsController } from './models.controller.js';
import { ModerationsController } from './moderations.controller.js';
import { OpenAIChatController } from './openai.controller.js';
import { RerankController } from './rerank.controller.js';
import { TranscriptionsController } from './transcriptions.controller.js';

/**
 * The OpenAI/Anthropic/Gemini-compatible sync surfaces
 * (`POST /v1/chat/completions`, `POST /v1/messages`,
 * `POST /v1beta/models/{model}:generateContent[:streamGenerateContent]`,
 * `POST /v1/embeddings`, `POST /v1/rerank`, `POST /v1/moderations`,
 * `POST /v1/audio/transcriptions`), each served END TO END by the exported
 * {@link GatewayChatV2Service} (批次6 D2 — the legacy relay world is deleted;
 * the 切换预案②③ gray-release branches are collapsed to always-new).
 *
 * `GET /v1/models` (OpenAI-shaped discovery over the OLD catalog's
 * `listVisibleModels`) survives until the resource/model tables drop (D3);
 * the new discovery face is `GET /v1/gateway/models`.
 */
@Module({
  imports: [GatewayModule],
  controllers: [
    OpenAIChatController,
    AnthropicChatController,
    GeminiChatController,
    EmbeddingsController,
    RerankController,
    ModerationsController,
    TranscriptionsController,
    ModelsController,
  ],
  providers: [
    ModelResolverService,
    AuthService,
    ApiKeyGuard,
    { provide: MODEL_RESOLVER, useValue: realModelResolverPort },
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class ChatModule {}
