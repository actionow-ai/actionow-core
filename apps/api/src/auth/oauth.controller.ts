import type { AppEnv } from '@actionow/infra';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { AdminGuard, type AdminRequest } from '../admin/auth/admin.guard.js';
import { engineInvalidInput, engineUnauthorized } from '../common/errors.js';
import { ENV } from '../common/tokens.js';
import { OauthService } from './oauth.service.js';

/** Cookie names carrying the CSRF state + (Google) PKCE verifier between hops. */
const STATE_COOKIE = 'oauth_state';
const VERIFIER_COOKIE = 'oauth_verifier';

/** Short cookie lifetime — the round-trip to the provider takes seconds. */
const COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

/** The `POST /auth/link/:provider` body. */
interface LinkBody {
  code?: unknown;
  codeVerifier?: unknown;
  state?: unknown;
}

/**
 * Google/GitHub OAuth routes (Phase 9). `GET /auth/oauth/:provider` starts the
 * flow — it stashes the CSRF `state` (+ Google PKCE verifier) in short-lived
 * HttpOnly cookies and 302-redirects to the provider. `GET
 * /auth/oauth/:provider/callback` re-asserts `state` against the cookie (a
 * mismatch is a 400), exchanges the code, and returns `{token}` (a real
 * frontend redirect is a follow-up). `POST /auth/link/:provider` (behind the JWT
 * guard) attaches an identity to the current user.
 *
 * Cookies are HttpOnly + SameSite=Lax, and Secure in production; the
 * state/verifier are single-use and cleared on callback. No code/token/secret
 * is ever logged.
 */
@ApiTags('auth')
@Controller('auth')
export class OauthController {
  constructor(
    private readonly oauth: OauthService,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  @Get('oauth/:provider')
  @ApiOperation({ summary: 'Begin a Google/GitHub OAuth login (redirects to the provider)' })
  start(@Param('provider') provider: string, @Res() res: Response): void {
    const { url, state, codeVerifier } = this.oauth.start(provider);
    res.cookie(STATE_COOKIE, state, this.cookieOptions());
    if (codeVerifier !== undefined) {
      res.cookie(VERIFIER_COOKIE, codeVerifier, this.cookieOptions());
    }
    res.redirect(302, url);
  }

  @Get('oauth/:provider/callback')
  @ApiOperation({ summary: 'OAuth callback: verify state, exchange the code, return a JWT' })
  async callback(
    @Param('provider') provider: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const cookies = parseCookies(req);
    const expectedState = cookies[STATE_COOKIE];
    const codeVerifier = cookies[VERIFIER_COOKIE];

    // The cookies are single-use: clear them before doing any work.
    res.clearCookie(STATE_COOKIE, this.cookieOptions());
    res.clearCookie(VERIFIER_COOKIE, this.cookieOptions());

    // CSRF: the round-tripped `state` MUST match the cookie we set on `start`.
    if (
      typeof state !== 'string' ||
      state === '' ||
      expectedState === undefined ||
      state !== expectedState
    ) {
      throw engineInvalidInput('oauth state mismatch');
    }
    if (typeof code !== 'string' || code === '') {
      throw engineInvalidInput('missing oauth code');
    }

    const result = await this.oauth.callback(provider, code, codeVerifier);
    res.status(200).json(result);
  }

  @Post('link/:provider')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Link a Google/GitHub identity to the authenticated user' })
  async link(
    @Param('provider') provider: string,
    @Body() body: LinkBody,
    @Req() req: AdminRequest,
  ): Promise<{ linked: true }> {
    const currentUserId = req.admin?.adminId;
    if (currentUserId === undefined) throw engineUnauthorized('missing authenticated user');

    const { code, codeVerifier } = body;
    if (typeof code !== 'string' || code === '') {
      throw engineInvalidInput('code is required');
    }
    const verifier =
      typeof codeVerifier === 'string' && codeVerifier !== '' ? codeVerifier : undefined;
    await this.oauth.link(provider, code, verifier, currentUserId);
    return { linked: true };
  }

  /** HttpOnly + SameSite=Lax cookie; Secure only in production (https). */
  private cookieOptions(): {
    httpOnly: true;
    sameSite: 'lax';
    secure: boolean;
    maxAge: number;
    path: string;
  } {
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.env.NODE_ENV === 'production',
      maxAge: COOKIE_MAX_AGE_MS,
      path: '/',
    };
  }
}

/**
 * Parse the request `Cookie` header into a name→value map. We parse manually
 * (rather than add `cookie-parser`) to keep the OAuth surface self-contained;
 * only the two short-lived OAuth cookies are ever read here.
 */
function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return {};
  const out: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name !== '') out[name] = decodeURIComponent(value);
  }
  return out;
}
