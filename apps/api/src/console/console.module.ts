import type { AppEnv } from '@actionow/infra';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { ENV } from '../common/tokens.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { ConsoleController } from './console.controller.js';
import { CONSOLE_REPO, ConsoleGuard, defaultConsoleRepo } from './console.guard.js';
import { ConsoleService } from './console.service.js';
import { fakeModelsPort, MODELS_PORT } from './models.port.js';

/**
 * The tenant self-service console (`/console`, Track B capstone). The
 * {@link ConsoleGuard} verifies a USER JWT against `ADMIN_JWT_SECRET` (the same
 * secret + `{sub, role}` claims the {@link LocalAuthService} signs), so the
 * `JwtModule` is registered with that secret here — mirroring the
 * {@link AdminModule} shape. The engine `PaymentService` (token `PAYMENTS`) for
 * self-topup is provided by the {@link PaymentsModule} (which `exports` it);
 * `DB`/`ENV` come from the global `DbModule`. `MODELS_PORT` defaults to the empty
 * fake (Track C wires the real catalog port later).
 */
@Module({
  imports: [
    PaymentsModule,
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: AppEnv) => ({ secret: env.ADMIN_JWT_SECRET }),
    }),
  ],
  controllers: [ConsoleController],
  providers: [
    ConsoleService,
    ConsoleGuard,
    { provide: CONSOLE_REPO, useValue: defaultConsoleRepo },
    { provide: MODELS_PORT, useValue: fakeModelsPort },
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class ConsoleModule {}
