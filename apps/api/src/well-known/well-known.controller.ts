import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { type Rs256Keys } from '../auth/jwt-keys.js';
import { JWT_KEYS } from '../auth/jwt-keys.token.js';

/** The JWKS document: a JWK ARRAY so future multi-kid rotation stays non-breaking. */
interface JwksDocument {
  keys: Record<string, unknown>[];
}

/**
 * Publishes the platform's JSON Web Key Set at `/.well-known/jwks.json`. Bare,
 * UNAUTHENTICATED `@Controller` (mirrors {@link HealthController}) — a JWKS is
 * public by design (it holds only PUBLIC key material). When RS256 is configured
 * it returns the public JWK array (each carrying `kid`/`use:'sig'`/`alg:'RS256'`)
 * so resource servers can verify tokens by `kid`. In the default HS256 config (no
 * public key) it returns `{ keys: [] }` — NEVER the HMAC secret.
 */
@ApiTags('well-known')
@Controller()
export class WellKnownController {
  constructor(@Inject(JWT_KEYS) private readonly rs256: Rs256Keys | null) {}

  @Get('.well-known/jwks.json')
  @ApiOperation({ summary: 'Public JWK set for verifying RS256 access tokens (empty under HS256)' })
  jwks(): JwksDocument {
    if (this.rs256 === null) return { keys: [] };
    // publicJwk already carries kid/use/alg and is PUBLIC-only (no private fields).
    return { keys: [this.rs256.publicJwk as unknown as Record<string, unknown>] };
  }
}
