import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { AdminModule } from './admin/admin.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CallbacksModule } from './callbacks/callbacks.module.js';
import { ChatModule } from './chat/chat.module.js';
import { UnifiedErrorFilter } from './common/unified-error.filter.js';
import { ConsoleModule } from './console/console.module.js';
import { DbModule } from './db/db.module.js';
import { ExecutionModule } from './execution/execution.module.js';
import { FilesModule } from './files/files.module.js';
import { HealthController } from './health/health.controller.js';
import { JobsModule } from './jobs/jobs.module.js';
import { MediaDialectModule } from './media-dialect/media-dialect.module.js';
import { MemberModule } from './member/member.module.js';
import { PaymentsModule } from './payments/payments.module.js';

@Module({
  imports: [
    DbModule,
    ExecutionModule,
    JobsModule,
    AdminModule,
    AuthModule,
    FilesModule,
    CallbacksModule,
    PaymentsModule,
    ConsoleModule,
    MemberModule,
    ChatModule,
    MediaDialectModule,
  ],
  controllers: [HealthController],
  // Register the §4.7 filter globally via DI so it also applies under the
  // NestJS `Test` harness (where `useGlobalFilters` in main.ts is bypassed).
  providers: [{ provide: APP_FILTER, useClass: UnifiedErrorFilter }],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class AppModule {}
