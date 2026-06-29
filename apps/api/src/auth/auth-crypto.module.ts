import type { AppEnv } from '@actionow/infra';
import { Global, Module, type Provider } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { ENV } from '../common/tokens.js';
import { loadRs256Keys, type Rs256Keys } from './jwt-keys.js';
import { JWT_KEYS } from './jwt-keys.token.js';
import { SessionService } from './session.service.js';
import { TokenIssuerService } from './token-issuer.service.js';
import { TokenVerifierService } from './token-verifier.service.js';

/**
 * Resolve the RS256 key material ONCE at module init from env (PEM/base64-PEM,
 * deriving the public key when absent). `null` when no private key is configured
 * → the HS256 path stays active. The async factory keeps key import off the hot
 * path (it runs at bootstrap, not per request). Never logs the private key.
 */
const jwtKeysProvider: Provider = {
  provide: JWT_KEYS,
  inject: [ENV],
  useFactory: (env: AppEnv): Promise<Rs256Keys | null> => loadRs256Keys(env),
};

/**
 * Shared crypto for platform sessions (auth-sessions slice). Provides the single
 * alg-aware {@link TokenIssuerService} (every access-token mint site delegates to
 * it) and {@link TokenVerifierService} (every guard's JWT branch delegates to it),
 * plus the resolved {@link JWT_KEYS}. `@Global` so the admin/console/member modules
 * inject the verifier without each re-importing this module — but it is ALSO listed
 * explicitly in `app.module` imports so the global registration runs. The local
 * `JwtModule` (ADMIN_JWT_SECRET) backs the HS256 sign/verify legs. {@link SessionService}
 * lives here too (global) so both the user (AuthModule) and admin (AdminModule)
 * login paths inject it without a circular module import.
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: AppEnv) => ({ secret: env.ADMIN_JWT_SECRET }),
    }),
  ],
  providers: [jwtKeysProvider, TokenIssuerService, TokenVerifierService, SessionService],
  exports: [JWT_KEYS, TokenIssuerService, TokenVerifierService, SessionService],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class AuthCryptoModule {}
