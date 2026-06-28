import {
  memberChangePasswordSchema,
  memberCreateApiKeySchema,
  memberUpdateMeSchema,
} from '@actionow/contracts';
import type { z } from 'zod';

/**
 * Zod request schemas for the end-user self-service **member** surface
 * (`/member/*` write side). Mirrors the console DTO style. The caller's
 * `subjectId`/`tenantId` are NEVER part of any body — both are supplied by the
 * {@link MemberGuard} from the verified member token, so these schemas carry
 * neither.
 *
 * CONTRACT-FIRST (request bodies): the POST/PATCH **body** schemas live ONCE in
 * `@actionow/contracts` (`member-requests.ts`) — re-exported here so the
 * controller resolves `import { memberUpdateMeSchema } from './dto/member.dto.js'`,
 * with `MemberXxxDto` inferred-type aliases kept.
 */
export { memberChangePasswordSchema, memberCreateApiKeySchema, memberUpdateMeSchema };

export type MemberUpdateMeDto = z.infer<typeof memberUpdateMeSchema>;
export type MemberChangePasswordDto = z.infer<typeof memberChangePasswordSchema>;
export type MemberCreateApiKeyDto = z.infer<typeof memberCreateApiKeySchema>;
