import { type AppEnv, createHttpClient } from '@actionow/infra';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuditModule } from '../audit/audit.module.js';
import { LoginThrottleGuard } from '../auth/login-throttle.guard.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { ENV, HTTP } from '../common/tokens.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
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
import { OfferingLifecycleService } from './offering-lifecycle.service.js';
import { ReconciliationController } from './reconciliation.controller.js';
import { SupplyAdminController } from './supply.controller.js';
import { SupplyAdminService } from './supply.service.js';
import { SupplyOnboardingService } from './supply-onboarding.service.js';

/**
 * Admin surface (Phase 5). `POST /admin/auth/login` issues a JWT; the
 * {@link AdminGuard} + `@Roles` decorator protect the admin CRUD routes
 * ({@link AdminController}). The JWT secret is read from `ADMIN_JWT_SECRET`
 * via the global env.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: AppEnv) => ({ secret: env.ADMIN_JWT_SECRET }),
    }),
    AuditModule,
  ],
  controllers: [
    AdminAuthController,
    AdminController,
    SupplyAdminController,
    // §9.2 reconciliation report (批次4 slice6, read-only).
    ReconciliationController,
  ],
  providers: [
    AdminAuthService,
    AdminService,
    AdminTokenService,
    ModelTestService,
    // NEW-WORLD supply skeleton CRUD (/admin/supply/*, model-supply 批次1).
    SupplyAdminService,
    // 批次5 slice1: golden probe + enable 双门 (/admin/supply/offerings/:id/
    // probe|enable). Builds its own SPI registry + probe HttpClient by default;
    // PROBE_DIALECTS / PROBE_HTTP (supply.tokens.ts) are @Optional overrides
    // for tests (no real egress).
    OfferingLifecycleService,
    // 批次5 slice2: 发现与批建 (/admin/supply/channels/:id/discover |
    // offerings/batch | offerings/probe-and-enable). Shares the lifecycle
    // service's enable path (one probe budget); DISCOVERY_PACKS is the
    // @Optional test seam for DSL discovery declarations.
    SupplyOnboardingService,
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
