import { type AppEnv, createHttpClient } from '@actionow/infra';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { LoginThrottleGuard } from '../auth/login-throttle.guard.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { ENV, HTTP, KNOWN_MODELS } from '../common/tokens.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { AdminDifyController } from './admin-dify.controller.js';
import { AdminDifyService } from './admin-dify.service.js';
import { AdminTokenService } from './admin-token.service.js';
import { AdminGuard } from './auth/admin.guard.js';
import { AdminAuthController } from './auth/admin-auth.controller.js';
import {
  ADMIN_AUTH_REPO,
  AdminAuthService,
  defaultAdminAuthRepo,
} from './auth/admin-auth.service.js';
import {
  ADMIN_TOKEN_AUTH_REPO,
  AdminTokenAuthService,
  defaultAdminTokenAuthRepo,
} from './auth/admin-token-auth.service.js';
import { ModelTestService } from './model-test.service.js';

/**
 * Admin surface (Phase 5). `POST /admin/auth/login` issues a JWT; the
 * {@link AdminGuard} + `@Roles` decorator protect the admin CRUD routes
 * ({@link AdminController}) and the dify-import endpoint
 * ({@link AdminDifyController}). The JWT secret is read from `ADMIN_JWT_SECRET`
 * via the global env. `KNOWN_MODELS` (the dify compat-report model allowlist)
 * defaults to empty here and is overridable in tests.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: AppEnv) => ({ secret: env.ADMIN_JWT_SECRET }),
    }),
  ],
  controllers: [AdminAuthController, AdminController, AdminDifyController],
  providers: [
    AdminAuthService,
    AdminService,
    AdminDifyService,
    AdminTokenService,
    ModelTestService,
    AdminGuard,
    // M2M service-token auth: the guard delegates `at_`-prefixed credentials to
    // this service, which looks them up via the (overridable) repo.
    AdminTokenAuthService,
    // Per-IP throttle on POST /admin/auth/login (credential-stuffing defense).
    LoginThrottleGuard,
    // Track D5: resolved by `@UseInterceptors(IdempotencyInterceptor)` on the
    // admin controllers; injects the global DB handle + Reflector.
    IdempotencyInterceptor,
    { provide: ADMIN_AUTH_REPO, useValue: defaultAdminAuthRepo },
    { provide: ADMIN_TOKEN_AUTH_REPO, useValue: defaultAdminTokenAuthRepo },
    { provide: KNOWN_MODELS, useValue: new Set<string>() },
    // The shared HttpClient for the codex OAuth code-exchange; overridable in
    // tests (the OAuth-login e2e injects a fake — no real network call).
    { provide: HTTP, useValue: createHttpClient() },
  ],
  // AdminTokenAuthService is exported alongside AdminGuard: any module that reuses
  // the guard (e.g. PaymentsModule) must be able to resolve the guard's deps.
  exports: [AdminGuard, AdminTokenAuthService, JwtModule],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class AdminModule {}
