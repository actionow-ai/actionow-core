import { z } from 'zod';

/** One produced asset. Exactly one of `url`/`b64` is present. */
export const assetSchema = z
  .object({
    role: z.enum(['primary', 'thumbnail', 'cover', 'aux']).default('primary'),
    modality: z.enum(['image', 'video', 'audio', 'model3d']),
    format: z.string().optional(),
    url: z.string().optional(),
    b64: z.string().optional(),
    mime: z.string(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    duration: z.number().optional(),
    size: z.number().int().optional(),
    etag: z.string().optional(),
  })
  .refine((a) => a.url !== undefined || a.b64 !== undefined, {
    message: 'asset requires url or b64',
  });
export type Asset = z.infer<typeof assetSchema>;

/** Per-unit billing dimensions (images / duration_seconds / characters / …). */
export const usageVectorSchema = z.record(z.number());

/** Canonical media result — what every media plugin/adapter mapResponse returns. */
export const mediaResultSchema = z.object({
  kind: z.literal('media'),
  assets: z.array(assetSchema),
  usage: usageVectorSchema,
  raw: z.unknown().optional(),
});
export type MediaResult = z.infer<typeof mediaResultSchema>;

/** RESERVED (spec D6) — defined for forward-compat; not produced by the engine in P1. */
export const structuredResultSchema = z.object({
  kind: z.literal('struct'),
  data: z.unknown(),
  usage: usageVectorSchema,
  raw: z.unknown().optional(),
});
export type StructuredResult = z.infer<typeof structuredResultSchema>;

export const pluginResultSchema = z.discriminatedUnion('kind', [
  mediaResultSchema,
  structuredResultSchema,
]);
export type PluginResult = z.infer<typeof pluginResultSchema>;
