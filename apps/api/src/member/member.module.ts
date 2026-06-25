import type { AppEnv } from '@actionow/infra';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { ENV } from '../common/tokens.js';
import { defaultMemberRepo, MEMBER_REPO, MemberGuard } from './member.guard.js';

/**
 * The end-user self-service plane (`/member`, Part B). The {@link MemberGuard}
 * verifies a MEMBER JWT against `ADMIN_JWT_SECRET` (the same secret + the
 * `{sub, tenant_id, typ:'subject'}` claims `LocalAuthService.issueMemberToken`
 * signs), so the `JwtModule` is registered with that secret here — mirroring the
 * {@link ConsoleModule} shape. `DB`/`ENV` come from the global `DbModule`. The
 * read-only `/member/*` controller + service land in Task 7.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: AppEnv) => ({ secret: env.ADMIN_JWT_SECRET }),
    }),
  ],
  providers: [MemberGuard, { provide: MEMBER_REPO, useValue: defaultMemberRepo }],
  exports: [MemberGuard],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are decorated empty classes
export class MemberModule {}
