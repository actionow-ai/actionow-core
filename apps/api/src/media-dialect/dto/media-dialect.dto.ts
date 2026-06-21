import { z } from 'zod';

/**
 * OpenAI-wire request schemas for the media dialect endpoints. Like the chat
 * dialects, these parse the EXTERNAL OpenAI API wire body (not an actionow
 * contract) for `ZodBody` validation; the {@link MediaDialectService} maps them
 * onto a run of the seeded `image-relay` / `audio-relay` resource. Unknown extra
 * fields are stripped (forward-compatible with OpenAI request growth).
 */

/** `POST /v1/images/generations` (OpenAI Images API). We always return `url`s. */
export const imagesGenerationSchema = z.object({
  model: z.string().optional(),
  prompt: z.string().min(1),
  /** Number of images (1..10); the relay meters per image. */
  n: z.number().int().min(1).max(10).optional(),
  size: z.string().optional(),
  /** Only `url` is supported (the relay persists to object storage). */
  response_format: z.enum(['url']).optional(),
  user: z.string().optional(),
});
export type ImagesGenerationDto = z.infer<typeof imagesGenerationSchema>;

/** `POST /v1/audio/speech` (OpenAI TTS API). Returns raw audio BYTES (binary). */
export const audioSpeechSchema = z.object({
  model: z.string().optional(),
  input: z.string().min(1),
  voice: z.string().optional(),
  /** Output container; defaults to mp3. */
  response_format: z.enum(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']).optional(),
  speed: z.number().min(0.25).max(4).optional(),
});
export type AudioSpeechDto = z.infer<typeof audioSpeechSchema>;
