import { z } from 'zod';

/**
 * Single source of truth for the end-user self-service **member** wire views
 * (`/member/*`, served behind `MemberGuard` and locked to the token's own
 * `subjectId` — the subject is NEVER taken from the body/path). Read-only in v1.
 *
 * Same contract-first pattern as `console-views.ts`: the backend `toView` mappers
 * `.parse()` against these schemas; the frontend imports the inferred TYPE only
 * (`import type`), so no zod ships to the browser. Money is always a µ-unit
 * decimal **string** (bigint serialized), never a JS number.
 *
 * These views deliberately OMIT `subject_id`: the token already scopes every row
 * to the caller's own subject, so echoing it back would be redundant (and zod
 * strips it if a mapper passes one through). Keys are masked (`last4` only) — a
 * member never sees plaintext or a hash.
 */

/** The caller's own identity (`GET /member/me`). `tenant_id` is always present (token-scoped). */
export const memberMeViewSchema = z.object({
  id: z.string(),
  status: z.string(),
  tenant_id: z.string(),
  external_id: z.string().nullable(),
  email: z.string().nullable(),
  display_name: z.string().nullable(),
});
export type MemberMeView = z.infer<typeof memberMeViewSchema>;

/**
 * One of the caller-subject's own usage-log rows (`GET /member/usage` → `data`).
 * Mirrors `consoleUsageLogViewSchema` minus `subject_id` (always self). `cost` is
 * a µUSD decimal **string**; token counts/latency are numbers.
 */
export const memberUsageRowSchema = z.object({
  id: z.string(),
  model: z.string(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cost: z.string(),
  latency_ms: z.number().nullable(),
  status: z.string(),
  created_at: z.string(),
});
export type MemberUsageRow = z.infer<typeof memberUsageRowSchema>;

/** A keyset page of the caller-subject's usage rows (`GET /member/usage`). */
export const memberUsageListSchema = z.object({
  data: z.array(memberUsageRowSchema),
  next_cursor: z.string().nullable(),
});
export type MemberUsageList = z.infer<typeof memberUsageListSchema>;

/**
 * The caller-subject's wallet (`GET /member/balance`). `mode:'hard'` → a dedicated
 * sub-account (`balance`/`held` are its own µUSD); `mode:'shared'` → no hard wallet
 * (the subject draws from the tenant pool, so `balance`/`held` are `"0"`).
 */
export const memberBalanceViewSchema = z.object({
  mode: z.enum(['shared', 'hard']),
  balance: z.string(),
  held: z.string(),
});
export type MemberBalanceView = z.infer<typeof memberBalanceViewSchema>;

/** One of the caller-subject's own API keys (`GET /member/api-keys`) — masked, never plaintext. */
export const memberKeyViewSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  status: z.string(),
  created_at: z.string(),
  /** Last 4 chars of the key for recognition; the full key is never returned. */
  last4: z.string(),
});
export type MemberKeyView = z.infer<typeof memberKeyViewSchema>;

/**
 * One effective governance rule for the caller-subject's bound plan paired with
 * its current usage (`GET /member/limits` → `rules`). `cap`/`used` are decimal
 * **strings** (bigint: µUSD for `spend`, else a count); live `rpm`/`concurrency`
 * have no stored total so `used` is `"0"`. Mirrors `consoleLimitRuleViewSchema`.
 */
export const memberLimitRuleViewSchema = z.object({
  dimension: z.string(),
  period: z.string().nullable(),
  cap: z.string(),
  used: z.string(),
  model_scope: z.string().nullable(),
  alert_pct: z.number().nullable(),
  enforce: z.string(),
});
export type MemberLimitRuleView = z.infer<typeof memberLimitRuleViewSchema>;

/**
 * The caller-subject's governance status (`GET /member/limits`): the effective
 * plan name (`null` when no plan is bound → "unlimited") and its rules-with-usage
 * (the usage-vs-cap bars). Reuses the limit-status computation, scoped to self.
 */
export const memberLimitsViewSchema = z.object({
  plan: z.object({ id: z.string(), name: z.string() }).nullable(),
  rules: z.array(memberLimitRuleViewSchema),
});
export type MemberLimitsView = z.infer<typeof memberLimitsViewSchema>;
