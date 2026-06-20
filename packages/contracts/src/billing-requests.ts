import { z } from 'zod';

/**
 * Single source of truth for the **billing & routing** control-plane **request
 * bodies** (route groups, group channel memberships, official model prices —
 * Track 2/3). Same contract-first pattern as the `*-views.ts` files, but for the
 * write side: the backend admin DTO re-exports these schemas (so `ZodBody`
 * validates against them) and the frontend imports the inferred TYPE only
 * (`import type`), so no zod ships to the browser. These schemas flow into
 * `openapi.json` → `@actionow/sdk` as request bodies.
 *
 * MONEY CONVENTION (write side): `groupRatioBps` is an integer basis-point ratio
 * (`10000 = 1.0×`), entered directly. The official-price `*UsdPer1m` fields are
 * HUMAN USD per 1M tokens (e.g. `1.25`) → µUSD/1M in the service. Unlike RESPONSE
 * money (always a string), request money/ratio fields stay `number`.
 */

/**
 * `POST /admin/route-groups` — create a route group (分组; Track 3). `groupRatioBps`
 * is the customer-price ratio in integer BASIS POINTS (`10000 = 1.0×`); entered
 * directly as bps (NOT a float), defaults to 10000. `(name)` is unique among LIVE
 * groups (the service maps a collision to a clean 400).
 */
export const createRouteGroupSchema = z.object({
  name: z.string().min(1),
  /** Customer-price ratio in basis points (`10000 = 1.0×`). Defaults to 10000. */
  groupRatioBps: z.number().int().positive().optional(),
  description: z.string().optional(),
  status: z.enum(['active', 'disabled']).optional(),
});
export type CreateRouteGroupBody = z.infer<typeof createRouteGroupSchema>;

/**
 * `PATCH /admin/route-groups/:id` — update a route group. Every field is optional
 * (omitted = unchanged). `groupRatioBps` stays integer basis points (same
 * convention as create). `description` may be set to `null` to clear it.
 */
export const updateRouteGroupSchema = z.object({
  name: z.string().min(1).optional(),
  groupRatioBps: z.number().int().positive().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  description: z.string().nullable().optional(),
});
export type UpdateRouteGroupBody = z.infer<typeof updateRouteGroupSchema>;

/**
 * `PUT /admin/route-groups/:id/channels/:channelId` — add (or update) a channel's
 * membership in a group with its per-(group,channel) routing knobs. The `:id`
 * (group) and `:channelId` come from the PATH; the BODY carries only `priority`
 * (HIGHER = tried first) and `weight` (weighted-random within a tier), which
 * default to 0/1. A PUT for an already-member channel upserts (updates
 * priority/weight) — the PUT verb makes the upsert idempotent on the membership
 * URL.
 */
export const addGroupChannelSchema = z.object({
  /** HIGHER = tried first (fallback tier). Defaults to 0. */
  priority: z.number().int().optional(),
  /** Weighted-random weight within a priority tier. Defaults to 1. */
  weight: z.number().int().positive().optional(),
});
export type AddGroupChannelBody = z.infer<typeof addGroupChannelSchema>;

/**
 * `POST /admin/official-prices` — add a row to the official model price catalog
 * (Track 2; spec D7). The three price fields are HUMAN USD-per-1M-tokens (e.g.
 * `1.25` = $1.25 per 1M tokens, like the provider's published list price); the
 * service converts each to integer µUSD/1M = `round(usd × 1_000_000)` before
 * persisting (the boundary conversion mirrors `creditsToMicro`). `modelSlug` is
 * normalized to the catalog's canonical form by the service. `provider` is the
 * catalog provider key (`openai`/`anthropic`/`google`/…).
 */
export const createOfficialPriceSchema = z.object({
  provider: z.string().min(1),
  modelSlug: z.string().min(1),
  displayName: z.string().min(1).optional(),
  /** HUMAN USD per 1M input tokens (e.g. 1.25) → µUSD/1M in the service. */
  inputUsdPer1m: z.number().positive(),
  /** HUMAN USD per 1M output tokens. */
  outputUsdPer1m: z.number().positive(),
  /** Optional HUMAN USD per 1M cached-input tokens. */
  cachedInputUsdPer1m: z.number().positive().optional(),
  sourceUrl: z.string().url().optional(),
  effectiveAt: z.string().datetime().optional(), // ISO 8601
  notes: z.string().optional(),
});
export type CreateOfficialPriceBody = z.infer<typeof createOfficialPriceSchema>;

/**
 * `PATCH /admin/official-prices/:id` — update a catalog row. Every field is
 * optional (omitted = unchanged). The USD-per-1M price fields are converted to
 * µUSD/1M by the service (same convention as create). `cachedInputUsdPer1m` /
 * `displayName` / `sourceUrl` / `effectiveAt` / `notes` may be cleared with
 * `null`. `provider`/`modelSlug` are NOT patchable (a re-slug is a new row).
 */
export const updateOfficialPriceSchema = z.object({
  displayName: z.string().min(1).nullable().optional(),
  inputUsdPer1m: z.number().positive().optional(),
  outputUsdPer1m: z.number().positive().optional(),
  cachedInputUsdPer1m: z.number().positive().nullable().optional(),
  sourceUrl: z.string().url().nullable().optional(),
  effectiveAt: z.string().datetime().nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type UpdateOfficialPriceBody = z.infer<typeof updateOfficialPriceSchema>;
