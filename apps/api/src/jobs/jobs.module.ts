import { Module } from '@nestjs/common';

import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { JobStreamService } from './job-stream.service.js';
import { JobsController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';

/**
 * Wires the `/v1/jobs` lifecycle endpoints (get/list/cancel + SSE stream) and
 * their deps. The `JOB_PROGRESS` bus that {@link JobStreamService} injects is
 * provided/exported by the `@Global` {@link DbModule}.
 */
@Module({
  controllers: [JobsController],
  providers: [JobsService, JobStreamService, AuthService, ApiKeyGuard],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class JobsModule {}
