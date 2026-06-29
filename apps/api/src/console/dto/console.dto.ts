import {
  appendMessageSchema,
  consoleChangePasswordSchema,
  consoleCreateApiKeySchema,
  consoleCreateIntentSchema,
  createConversationSchema,
  createLimitPlanRequestSchema,
  redeemCodeRequestSchema,
  setLimitPlanRequestSchema,
  updateConversationSchema,
  updateLimitPlanRequestSchema,
} from '@actionow/contracts';
import { z } from 'zod';

/**
 * Zod request schemas for the tenant-scoped console surface. Mirrors the admin
 * DTO style. The caller's tenant is NEVER part of any body — it is supplied by
 * the ConsoleGuard from the authenticated principal, so these schemas carry no
 * `tenantId`.
 *
 * CONTRACT-FIRST (request bodies): the POST/PATCH **body** schemas now live ONCE
 * in `@actionow/contracts` (`console-requests.ts`) — re-exported here so the
 * controller's `import { consoleCreateApiKeySchema } from './dto/console.dto.js'`
 * still resolves, with the `ConsoleCreateXxxDto` inferred-type aliases kept. The
 * `consoleAnalyticsUsageSchema` is a GET query (no body twin) and stays local.
 */

// --- Request-body schemas (single source of truth in @actionow/contracts) ---
export {
  // Playground conversation bodies (create / rename+re-model / append a turn).
  appendMessageSchema,
  consoleChangePasswordSchema,
  consoleCreateApiKeySchema,
  consoleCreateIntentSchema,
  createConversationSchema,
  // The 额度套餐 (limit-plan) create/update/bind bodies are SHARED with the admin
  // surface — same shape, tenant injected server-side. Re-exported so the console
  // controller resolves them from `./dto/console.dto.js` like its other schemas.
  createLimitPlanRequestSchema,
  // `POST /console/redeem` body — claim a gift code for the caller's own tenant.
  redeemCodeRequestSchema,
  setLimitPlanRequestSchema,
  updateConversationSchema,
  updateLimitPlanRequestSchema,
};

export type ConsoleCreateApiKeyDto = z.infer<typeof consoleCreateApiKeySchema>;
export type ConsoleCreateIntentDto = z.infer<typeof consoleCreateIntentSchema>;
export type ConsoleChangePasswordDto = z.infer<typeof consoleChangePasswordSchema>;
export type ConsoleCreateConversationDto = z.infer<typeof createConversationSchema>;
export type ConsoleUpdateConversationDto = z.infer<typeof updateConversationSchema>;
export type ConsoleAppendMessageDto = z.infer<typeof appendMessageSchema>;
export type ConsoleCreateLimitPlanDto = z.infer<typeof createLimitPlanRequestSchema>;
export type ConsoleUpdateLimitPlanDto = z.infer<typeof updateLimitPlanRequestSchema>;
export type ConsoleSetLimitPlanDto = z.infer<typeof setLimitPlanRequestSchema>;
export type ConsoleRedeemCodeDto = z.infer<typeof redeemCodeRequestSchema>;

/**
 * `GET /console/analytics/usage` — tenant-scoped usage rollups. Unlike the admin
 * schema there is NO `tenantId` (the guard supplies it) and no `tenant` groupBy
 * (a tenant only has itself); `from`/`to` are ISO 8601.
 */
export const consoleAnalyticsUsageSchema = z.object({
  groupBy: z.enum(['minute', 'hour', 'day', 'model', 'channel', 'api_key']),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type ConsoleAnalyticsUsageDto = z.infer<typeof consoleAnalyticsUsageSchema>;
