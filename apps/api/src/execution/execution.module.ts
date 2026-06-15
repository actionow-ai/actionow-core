import { Module } from '@nestjs/common';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { RateLimitGuard } from '../auth/rate-limit.guard.js';
import { RunController } from './run.controller.js';
import { RunService } from './run.service.js';

/** Wires `POST /v1/run/:resourceId` (the {@link RunController}) and its deps. */
@Module({
  controllers: [RunController],
  providers: [RunService, AuthService, ApiKeyGuard, RateLimitGuard],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class ExecutionModule {}
