import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { AdminModule } from './admin/admin.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AuthCryptoModule } from './auth/auth-crypto.module.js';
import { CallbacksModule } from './callbacks/callbacks.module.js';
import { ChatModule } from './chat/chat.module.js';
import { UnifiedErrorFilter } from './common/unified-error.filter.js';
import { ConsoleModule } from './console/console.module.js';
import { DbModule } from './db/db.module.js';
import { ExecutionModule } from './execution/execution.module.js';
import { FilesModule } from './files/files.module.js';
import { GatewayModule } from './gateway/gateway.module.js';
import { HealthController } from './health/health.controller.js';
import { HealthService } from './health/health.service.js';
import { JobsModule } from './jobs/jobs.module.js';
import { MediaDialectModule } from './media-dialect/media-dialect.module.js';
import { MemberModule } from './member/member.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { WellKnownModule } from './well-known/well-known.module.js';

@Module({
  imports: [
    DbModule,
    // @Global shared auth crypto (TokenIssuer/TokenVerifier/SessionService + RS256
    // keys). Listed first among auth modules so the global registration runs before
    // the guards that inject it. RS256/JWKS is opt-in (env); default is HS256.
    AuthCryptoModule,
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
    // NEW gateway face (model-supply greenfield 批次4 slice3) — 双面并存:
    // new paths only (/v1/tasks 族 + /v1/videos|audio creates + /v1/gateway/models).
    GatewayModule,
    SettingsModule,
    WellKnownModule,
  ],
  controllers: [HealthController],
  // Register the §4.7 filter globally via DI so it also applies under the
  // NestJS `Test` harness (where `useGlobalFilters` in main.ts is bypassed).
  providers: [HealthService, { provide: APP_FILTER, useClass: UnifiedErrorFilter }],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class AppModule {}
