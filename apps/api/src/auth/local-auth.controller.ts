import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { engineInvalidInput } from '../common/errors.js';
import type { AuthResult } from './local-auth.service.js';
import { LocalAuthService } from './local-auth.service.js';

/** The `POST /auth/register` and `/auth/login` request body. */
interface CredentialsBody {
  email?: unknown;
  password?: unknown;
}

/** Validate the shared `{email, password}` body, or throw `invalid_input`. */
function parseCredentials(body: CredentialsBody): { email: string; password: string } {
  const { email, password } = body;
  if (
    typeof email !== 'string' ||
    email === '' ||
    typeof password !== 'string' ||
    password === ''
  ) {
    throw engineInvalidInput('email and password are required');
  }
  return { email, password };
}

/**
 * Unified local auth (Phase 9). `POST /auth/register` provisions a tenant +
 * account for a brand-new user and returns a JWT; `POST /auth/login` exchanges
 * credentials for a JWT. A malformed body is `400 invalid_input`; a duplicate
 * registration is `400 invalid_input`; bad login credentials are `401
 * unauthorized` (uniform, via the service + {@link UnifiedErrorFilter}).
 */
@ApiTags('auth')
@Controller('auth')
export class LocalAuthController {
  constructor(private readonly auth: LocalAuthService) {}

  @Post('register')
  @HttpCode(200)
  @ApiOperation({ summary: 'Register a local user (provisions a tenant + account)' })
  async register(@Body() body: CredentialsBody): Promise<AuthResult> {
    return this.auth.register(parseCredentials(body));
  }

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange email + password for a JWT' })
  async login(@Body() body: CredentialsBody): Promise<AuthResult> {
    return this.auth.login(parseCredentials(body));
  }
}
