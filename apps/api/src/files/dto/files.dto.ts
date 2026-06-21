/**
 * `POST /v1/files/presign-upload` body. The single source of truth lives in
 * @actionow/contracts (`presignUploadSchema`); re-exported here so the controller's
 * `ZodBody(presignUploadSchema)` + `PresignUploadDto` type imports are unchanged and
 * the SDK type cannot drift from what the controller validates. The declared `size`
 * is bounded against `STORAGE_MAX_UPLOAD_BYTES` in {@link FilesService}.
 */
export {
  type PresignUploadBody as PresignUploadDto,
  presignUploadSchema,
} from '@actionow/contracts';
