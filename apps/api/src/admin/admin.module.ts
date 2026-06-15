import type { AppEnv } from '@actionow/infra';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { ENV, KNOWN_MODELS } from '../common/tokens.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { AdminDifyController } from './admin-dify.controller.js';
import { AdminDifyService } from './admin-dify.service.js';
import { AdminGuard } from './auth/admin.guard.js';
import { AdminAuthController } from './auth/admin-auth.controller.js';
import {
  ADMIN_AUTH_REPO,
  AdminAuthService,
  defaultAdminAuthRepo,
} from './auth/admin-auth.service.js';

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
    AdminGuard,
    { provide: ADMIN_AUTH_REPO, useValue: defaultAdminAuthRepo },
    { provide: KNOWN_MODELS, useValue: new Set<string>() },
  ],
  exports: [AdminGuard, JwtModule],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class AdminModule {}
