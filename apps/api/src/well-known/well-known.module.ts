import { Module } from '@nestjs/common';

import { WellKnownController } from './well-known.controller.js';

/**
 * Hosts the unauthenticated `/.well-known/jwks.json` endpoint. `JWT_KEYS` is
 * resolved by the @Global {@link AuthCryptoModule}, so the controller injects it
 * without re-importing anything here.
 */
@Module({
  controllers: [WellKnownController],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class WellKnownModule {}
