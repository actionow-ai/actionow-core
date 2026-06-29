import type { AppEnv } from '@actionow/infra';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AdminModule } from '../admin/admin.module.js';
import { ENV } from '../common/tokens.js';
import { LocalAuthController } from './local-auth.controller.js';
import { defaultLocalAuthRepo, LOCAL_AUTH_REPO, LocalAuthService } from './local-auth.service.js';
import { LoginThrottleGuard } from './login-throttle.guard.js';
import { OauthController } from './oauth.controller.js';
import {
  defaultOauthRepo,
  defaultProfileResolver,
  OAUTH_REPO,
  OauthService,
  PROFILE_RESOLVER,
} from './oauth.service.js';

/**
 * Unified local auth surface (Phase 9): `POST /auth/register` + `/auth/login`,
 * plus Google/GitHub OAuth (`GET /auth/oauth/:provider[/callback]`, `POST
 * /auth/link/:provider`). Shares the `ADMIN_JWT_SECRET` signer with the admin
 * login so a single `{sub, role}` JWT gates every authenticated route. The
 * {@link LocalAuthService} is exported so the admin auth repoint can delegate its
 * login to it. {@link AdminModule} is imported to reuse its `AdminGuard` (which,
 * with no `@Roles`, just requires any valid JWT) on the link endpoint.
 */
@Module({
  imports: [
    AdminModule,
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: AppEnv) => ({ secret: env.ADMIN_JWT_SECRET }),
    }),
  ],
  controllers: [LocalAuthController, OauthController],
  providers: [
    LocalAuthService,
    OauthService,
    // Per-IP throttle on POST /auth/login + /auth/register (credential-stuffing defense).
    LoginThrottleGuard,
    { provide: LOCAL_AUTH_REPO, useValue: defaultLocalAuthRepo },
    { provide: OAUTH_REPO, useValue: defaultOauthRepo },
    { provide: PROFILE_RESOLVER, useValue: defaultProfileResolver },
  ],
  // SessionService + TokenIssuerService come from the @Global AuthCryptoModule.
  exports: [LocalAuthService, JwtModule],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class AuthModule {}
