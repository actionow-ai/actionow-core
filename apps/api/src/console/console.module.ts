import type { AppEnv } from '@actionow/infra';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuditModule } from '../audit/audit.module.js';
import { ENV } from '../common/tokens.js';
import { FilesModule } from '../files/files.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { ConsoleController } from './console.controller.js';
import { CONSOLE_REPO, ConsoleGuard, defaultConsoleRepo } from './console.guard.js';
import { ConsoleService } from './console.service.js';
import { MODELS_PORT, realModelsPort } from './models.port.js';
import { TenantAdminGuard } from './tenant-admin.guard.js';

/**
 * The tenant self-service console (`/console`, Track B capstone). The
 * {@link ConsoleGuard} verifies a USER JWT against `ADMIN_JWT_SECRET` (the same
 * secret + `{sub, role}` claims the {@link LocalAuthService} signs), so the
 * `JwtModule` is registered with that secret here — mirroring the
 * {@link AdminModule} shape. The engine `PaymentService` (token `PAYMENTS`) for
 * self-topup is provided by the {@link PaymentsModule} (which `exports` it);
 * `DB`/`ENV` come from the global `DbModule`. `MODELS_PORT` is bound to the real
 * Track C catalog port (`listVisibleModels` over `DB`).
 */
@Module({
  imports: [
    PaymentsModule,
    // Reuse FilesService (exported) for the tenant console upload presign/confirm.
    FilesModule,
    AuditModule,
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: AppEnv) => ({ secret: env.ADMIN_JWT_SECRET }),
    }),
  ],
  controllers: [ConsoleController],
  providers: [
    ConsoleService,
    ConsoleGuard,
    TenantAdminGuard,
    { provide: CONSOLE_REPO, useValue: defaultConsoleRepo },
    { provide: MODELS_PORT, useValue: realModelsPort },
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class ConsoleModule {}
