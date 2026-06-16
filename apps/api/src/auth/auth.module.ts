import type { AppEnv } from '@actionow/infra';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { ENV } from '../common/tokens.js';
import { LocalAuthController } from './local-auth.controller.js';
import { defaultLocalAuthRepo, LOCAL_AUTH_REPO, LocalAuthService } from './local-auth.service.js';

/**
 * Unified local auth surface (Phase 9): `POST /auth/register` + `/auth/login`.
 * Shares the `ADMIN_JWT_SECRET` signer with the admin login so a single
 * `{sub, role}` JWT gates every authenticated route. The {@link LocalAuthService}
 * is exported so the admin auth repoint can delegate its login to it.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: AppEnv) => ({ secret: env.ADMIN_JWT_SECRET }),
    }),
  ],
  controllers: [LocalAuthController],
  providers: [LocalAuthService, { provide: LOCAL_AUTH_REPO, useValue: defaultLocalAuthRepo }],
  exports: [LocalAuthService, JwtModule],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class AuthModule {}
