import { Module } from '@nestjs/common';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { GovernanceGuard } from '../auth/governance.guard.js';
import { ChannelRoutingService } from '../common/channel-routing.service.js';
import { SecretResolver } from '../common/secret-resolver.js';
import { AnthropicChatController } from './anthropic.controller.js';
import { ChatRelayService } from './chat-relay.service.js';
import { EmbedRelayService } from './embed-relay.service.js';
import { EmbeddingsController } from './embeddings.controller.js';
import { GeminiChatController } from './gemini.controller.js';
import {
  MODEL_RESOLVER,
  ModelResolverService,
  realModelResolverPort,
} from './model-resolver.service.js';
import { ModelsController } from './models.controller.js';
import { ModerationRelayService } from './moderation-relay.service.js';
import { ModerationsController } from './moderations.controller.js';
import { OpenAIChatController } from './openai.controller.js';
import { RerankController } from './rerank.controller.js';
import { RerankRelayService } from './rerank-relay.service.js';
import { SttRelayService } from './stt-relay.service.js';
import { TranscriptionsController } from './transcriptions.controller.js';

/**
 * Wires the OpenAI/Anthropic/Gemini chat-relay surface
 * (`POST /v1/chat/completions`, `POST /v1/messages`,
 * `POST /v1beta/models/{model}:generateContent[:streamGenerateContent]`), the
 * OpenAI-compatible embeddings relay (`POST /v1/embeddings`, billed per input
 * token via {@link EmbedRelayService}), the Cohere/Jina-compatible rerank relay
 * (`POST /v1/rerank` via {@link RerankRelayService}) and the OpenAI-compatible
 * moderations relay (`POST /v1/moderations` via {@link ModerationRelayService}),
 * each billed per input token; the {@link ChatRelayService} that funnels each
 * dialect into the engine, and the {@link ModelResolverService} resolving model
 * names via the REAL Track C `resolveModelForTenant` ({@link realModelResolverPort}).
 * Tests override {@link MODEL_RESOLVER} with a fake; production uses the real binding.
 */
@Module({
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
    ChatRelayService,
    EmbedRelayService,
    RerankRelayService,
    ModerationRelayService,
    SttRelayService,
    ModelResolverService,
    AuthService,
    SecretResolver,
    ChannelRoutingService,
    ApiKeyGuard,
    GovernanceGuard,
    { provide: MODEL_RESOLVER, useValue: realModelResolverPort },
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class ChatModule {}
