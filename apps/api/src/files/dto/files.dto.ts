import { z } from 'zod';

/**
 * `POST /v1/files/presign-upload` body. The declared `size` is the client's
 * stated upload size in bytes; it is bounded against `STORAGE_MAX_UPLOAD_BYTES`
 * in {@link FilesService}. An empty filename is rejected here so a server-side
 * key extension can always be derived.
 */
export const presignUploadSchema = z.object({
  filename: z.string().min(1),
  content_type: z.string().min(1),
  size: z.number().int().positive(),
});
export type PresignUploadDto = z.infer<typeof presignUploadSchema>;
