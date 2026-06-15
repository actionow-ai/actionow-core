import { Module } from '@nestjs/common';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { JobsController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';

/** Wires the `/v1/jobs` lifecycle endpoints (get/list/cancel) and their deps. */
@Module({
  controllers: [JobsController],
  providers: [JobsService, AuthService, ApiKeyGuard],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class JobsModule {}
