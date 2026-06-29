import { z } from 'zod';

import { priceSpecSchema } from './pricing.js';

/**
 * Single source of truth for the **billing & routing** control-plane wire views
 * (route groups, group channel memberships, official model prices — Track 2/3).
 * Same contract-first pattern as `admin-views.ts`: the backend `toView` mappers
 * `.parse()` against these schemas; the frontend imports the inferred TYPE only
 * (`import type`), so no zod ships to the browser.
 *
 * Note: `group_ratio_bps` is an integer basis-point ratio (`10000 = 1.0×`), a
 * plain int32 — NOT bigint money — so it stays `z.number()`. The official-price
 * `*_per_1m` fields ARE money (µUSD per 1M tokens) and are decimal **strings**.
 */

/**
 * A route group (分组; Track 3) as served by `GET /admin/route-groups`.
 * `group_ratio_bps` is the customer-price ratio in integer basis points.
 */
export const routeGroupViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  group_ratio_bps: z.number(),
  /** Cross-group failover target (弹性2.0): cascade here when this group's channels are exhausted; null → no fallback. */
  fallback_group_id: z.string().nullable(),
  status: z.string(),
  description: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type RouteGroupView = z.infer<typeof routeGroupViewSchema>;

/**
 * One channel membership of a route group (`GET /admin/route-groups/:id/channels`):
 * the `channel_id` plus its per-(group,channel) routing knobs `priority` (HIGHER
 * = tried first) + `weight`.
 */
export const routeGroupChannelViewSchema = z.object({
  group_id: z.string(),
  channel_id: z.string(),
  priority: z.number(),
  weight: z.number(),
  created_at: z.string(),
});
export type RouteGroupChannelView = z.infer<typeof routeGroupChannelViewSchema>;

/**
 * One official model price (Track 2 catalog) as served by `GET /admin/official-prices`.
 * The `*_price_per_1m` fields are µUSD per 1M tokens, serialized as decimal
 * **strings** (never coerced through a float).
 */
export const officialPriceViewSchema = z.object({
  id: z.string(),
  provider: z.string(),
  model_slug: z.string(),
  display_name: z.string().nullable(),
  input_price_per_1m: z.string(),
  output_price_per_1m: z.string(),
  cached_input_price_per_1m: z.string().nullable(),
  /** The full `PriceSpec` (media/credits/matrix) when this row prices off a spec; null = plain per-token. */
  scheme: priceSpecSchema.nullable(),
  source_url: z.string().nullable(),
  effective_at: z.string().nullable(),
  notes: z.string().nullable(),
  updated_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type OfficialPriceView = z.infer<typeof officialPriceViewSchema>;
