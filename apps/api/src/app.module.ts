import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { UnifiedErrorFilter } from './common/unified-error.filter.js';
import { DbModule } from './db/db.module.js';
import { ExecutionModule } from './execution/execution.module.js';
import { HealthController } from './health/health.controller.js';
import { JobsModule } from './jobs/jobs.module.js';

@Module({
  imports: [DbModule, ExecutionModule, JobsModule],
  controllers: [HealthController],
  // Register the §4.7 filter globally via DI so it also applies under the
  // NestJS `Test` harness (where `useGlobalFilters` in main.ts is bypassed).
  providers: [{ provide: APP_FILTER, useClass: UnifiedErrorFilter }],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class AppModule {}
