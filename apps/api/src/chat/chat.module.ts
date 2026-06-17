import { Module } from '@nestjs/common';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { RateLimitGuard } from '../auth/rate-limit.guard.js';
import { SecretResolver } from '../common/secret-resolver.js';
import { AnthropicChatController } from './anthropic.controller.js';
import { ChatRelayService } from './chat-relay.service.js';
import { GeminiChatController } from './gemini.controller.js';
import {
  MODEL_RESOLVER,
  ModelResolverService,
  realModelResolverPort,
} from './model-resolver.service.js';
import { ModelsController } from './models.controller.js';
import { OpenAIChatController } from './openai.controller.js';

/**
 * Wires the OpenAI/Anthropic/Gemini chat-relay surface
 * (`POST /v1/chat/completions`, `POST /v1/messages`,
 * `POST /v1beta/models/{model}:generateContent[:streamGenerateContent]`), the
 * {@link ChatRelayService} that funnels each dialect into the engine, and the
 * {@link ModelResolverService} resolving model names via the REAL Track C
 * `resolveModelForTenant` ({@link realModelResolverPort}). Tests override
 * {@link MODEL_RESOLVER} with a fake; production uses the real binding.
 */
@Module({
  controllers: [
    OpenAIChatController,
    AnthropicChatController,
    GeminiChatController,
    ModelsController,
  ],
  providers: [
    ChatRelayService,
    ModelResolverService,
    AuthService,
    SecretResolver,
    ApiKeyGuard,
    RateLimitGuard,
    { provide: MODEL_RESOLVER, useValue: realModelResolverPort },
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class ChatModule {}
