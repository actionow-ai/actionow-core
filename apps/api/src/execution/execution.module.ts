import { Module } from '@nestjs/common';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { GovernanceGuard } from '../auth/governance.guard.js';
import { ChannelRoutingService } from '../common/channel-routing.service.js';
import { FilesModule } from '../files/files.module.js';
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
  imports: [FilesModule],
  controllers: [RunController, ResourcesController],
  providers: [
    RunService,
    ResourcesService,
    AuthService,
    ChannelRoutingService,
    ApiKeyGuard,
    GovernanceGuard,
  ],
  // Exported so the OpenAI media dialect (MediaDialectModule) can reuse
  // `RunService.resolveRunRequest` to build a run for its in-process sync runner.
  exports: [RunService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class ExecutionModule {}
