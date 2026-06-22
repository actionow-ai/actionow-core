import {
  consoleChangePasswordSchema,
  consoleCreateApiKeySchema,
  consoleCreateIntentSchema,
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
export { consoleChangePasswordSchema, consoleCreateApiKeySchema, consoleCreateIntentSchema };

export type ConsoleCreateApiKeyDto = z.infer<typeof consoleCreateApiKeySchema>;
export type ConsoleCreateIntentDto = z.infer<typeof consoleCreateIntentSchema>;
export type ConsoleChangePasswordDto = z.infer<typeof consoleChangePasswordSchema>;

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
