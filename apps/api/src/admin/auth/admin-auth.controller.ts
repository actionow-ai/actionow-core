import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { LoginThrottleGuard } from '../../auth/login-throttle.guard.js';
import { engineInvalidInput } from '../../common/errors.js';
import type { LoginResult } from './admin-auth.service.js';
import { AdminAuthService } from './admin-auth.service.js';

/** The `POST /admin/auth/login` request body. */
interface LoginBody {
  email?: unknown;
  password?: unknown;
}

@ApiTags('admin')
@Controller('admin/auth')
@UseGuards(LoginThrottleGuard)
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  /**
   * Exchange admin email + password for a JWT. Invalid credentials map to a 401
   * `unauthorized` envelope (via the service + {@link UnifiedErrorFilter}); a
   * malformed body is a 400 `invalid_input`.
   */
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange admin email + password for a JWT' })
  async login(@Body() body: LoginBody): Promise<LoginResult> {
    const { email, password } = body;
    if (typeof email !== 'string' || email === '' || typeof password !== 'string') {
      throw engineInvalidInput('email and password are required');
    }
    return this.auth.login(email, password);
  }
}
