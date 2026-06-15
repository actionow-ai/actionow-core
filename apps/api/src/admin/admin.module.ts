import type { AppEnv } from '@actionow/infra';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { ENV } from '../common/tokens.js';
import { AdminGuard } from './auth/admin.guard.js';
import { AdminAuthController } from './auth/admin-auth.controller.js';
import {
  ADMIN_AUTH_REPO,
  AdminAuthService,
  defaultAdminAuthRepo,
} from './auth/admin-auth.service.js';

/**
 * Admin surface (Phase 5, Task 3): `POST /admin/auth/login` issues a JWT; the
 * {@link AdminGuard} + `@Roles` decorator protect the (forthcoming) admin CRUD
 * routes. The JWT secret is read from `ADMIN_JWT_SECRET` via the global env.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: AppEnv) => ({ secret: env.ADMIN_JWT_SECRET }),
    }),
  ],
  controllers: [AdminAuthController],
  providers: [
    AdminAuthService,
    AdminGuard,
    { provide: ADMIN_AUTH_REPO, useValue: defaultAdminAuthRepo },
  ],
  exports: [AdminGuard, JwtModule],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class AdminModule {}
