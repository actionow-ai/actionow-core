import { Body, Controller, HttpCode, Post } from '@nestjs/common';

import { engineInvalidInput } from '../../common/errors.js';
import type { LoginResult } from './admin-auth.service.js';
import { AdminAuthService } from './admin-auth.service.js';

/** The `POST /admin/auth/login` request body. */
interface LoginBody {
  email?: unknown;
  password?: unknown;
}

@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  /**
   * Exchange admin email + password for a JWT. Invalid credentials map to a 401
   * `unauthorized` envelope (via the service + {@link UnifiedErrorFilter}); a
   * malformed body is a 400 `invalid_input`.
   */
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: LoginBody): Promise<LoginResult> {
    const { email, password } = body;
    if (typeof email !== 'string' || email === '' || typeof password !== 'string') {
      throw engineInvalidInput('email and password are required');
    }
    return this.auth.login(email, password);
  }
}
