import { z } from 'zod';

/**
 * Single source of truth for the end-user self-service **member** wire request
 * bodies (`/member/*` write side, served behind `MemberGuard`). Same contract-
 * first pattern as `console-requests.ts`: the backend member DTO validates against
 * these via `ZodBody`, and the frontend imports the inferred TYPE only
 * (`import type`), so no zod ships to the browser.
 *
 * The caller's `subjectId`/`tenantId` are NEVER part of any body — the
 * {@link MemberGuard} supplies both from the verified member token, so these
 * schemas carry neither. A member can only ever mutate its OWN subject.
 */

/**
 * `PATCH /member/me` — update the caller-subject's own profile. Only
 * `display_name` is mutable here (email change is OUT of scope: it carries
 * per-tenant uniqueness + verification concerns). `null` clears the display name.
 */
export const memberUpdateMeSchema = z.object({
  display_name: z.string().min(1).max(256).nullable(),
});
export type MemberUpdateMeBody = z.infer<typeof memberUpdateMeSchema>;

/**
 * `POST /member/me/password` — change the caller-subject's own password. The new
 * password mirrors the registration policy (8–256 chars); the current one is
 * verified server-side against the stored scrypt hash before the swap. Only valid
 * for a Model-A subject that already HAS a `password_hash` (a passwordless Model-B
 * subject → `invalid_input`).
 */
export const memberChangePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8).max(256),
});
export type MemberChangePasswordBody = z.infer<typeof memberChangePasswordSchema>;

/**
 * `POST /member/api-keys` — self-mint a SUBJECT-SCOPED data-plane key. No
 * `subjectId`/`tenantId`: both come from the guard, so the minted key is always
 * bound to the caller's own subject. An optional `resourceAllowlist` narrows the
 * resources the key may run (omitted/empty → no restriction).
 */
export const memberCreateApiKeySchema = z.object({
  resourceAllowlist: z.array(z.string()).optional(),
});
export type MemberCreateApiKeyBody = z.infer<typeof memberCreateApiKeySchema>;

/**
 * The `{ id, plaintext }` returned ONCE when a member self-mints a key
 * (`POST /member/api-keys`). The plaintext is shown a single time and is never
 * re-derivable — only its hash is stored. Mirrors the console/admin mint view.
 */
export const memberKeyCreatedViewSchema = z.object({
  id: z.string(),
  plaintext: z.string(),
});
export type MemberKeyCreatedView = z.infer<typeof memberKeyCreatedViewSchema>;
