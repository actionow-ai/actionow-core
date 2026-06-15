import { Module } from '@nestjs/common';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { RateLimitGuard } from '../auth/rate-limit.guard.js';
import { ResourcesController } from './resources.controller.js';
import { ResourcesService } from './resources.service.js';
import { RunController } from './run.controller.js';
import { RunService } from './run.service.js';

/**
 * Wires `POST /v1/run/:resourceId` ({@link RunController}) and the resource
 * discovery surface `GET /v1/resources[/:id]` ({@link ResourcesController}),
 * plus their shared auth/rate-limit deps.
 */
@Module({
  controllers: [RunController, ResourcesController],
  providers: [RunService, ResourcesService, AuthService, ApiKeyGuard, RateLimitGuard],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class ExecutionModule {}
