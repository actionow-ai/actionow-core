import { z } from 'zod';

/**
 * The S3-compatible object-storage providers Actionow drives through a single
 * `@aws-sdk/client-s3` v3 client. `aws-s3` is genuine AWS S3; every other kind
 * is an S3-API-compatible service (Cloudflare R2, MinIO, Aliyun OSS, Tencent
 * COS, Volcano TOS) that requires the non-AWS checksum opt-out in the infra
 * provider.
 */
export const STORAGE_PROVIDERS = [
  'aws-s3',
  'r2',
  'minio',
  'aliyun-oss',
  'tencent-cos',
  'volcano-tos',
] as const;
export type StorageProviderKind = (typeof STORAGE_PROVIDERS)[number];

/** Connection + credential config for a single {@link StorageProvider}. */
export interface StorageProviderConfig {
  kind: StorageProviderKind;
  bucket: string;
  region: string;
  /** Custom S3 endpoint; omitted for `aws-s3` (the SDK derives it from region). */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style addressing (required by MinIO); defaults to virtual-host style. */
  forcePathStyle?: boolean;
  /** Optional CDN/public base URL for unsigned public reads. */
  publicBaseUrl?: string;
}

/** A presigned URL the client can `PUT` object bytes to. */
export interface PutPresign {
  url: string;
  key: string;
  expiresIn: number;
}

/** A presigned URL the client can `GET` object bytes from. */
export interface GetPresign {
  url: string;
  expiresIn: number;
}

/** The result of a `HEAD` on an object key. */
export interface HeadResult {
  exists: boolean;
  size?: number;
  contentType?: string;
  etag?: string;
}

/**
 * A storage backend abstraction over one S3-compatible bucket. Implemented by
 * `createS3StorageProvider` in `@actionow/infra`; the contracts package only
 * declares the shape so other packages can depend on it without pulling in the
 * AWS SDK.
 */
export interface StorageProvider {
  readonly kind: StorageProviderKind;
  presignPut(key: string, opts?: { contentType?: string; expiresIn?: number }): Promise<PutPresign>;
  presignGet(key: string, opts?: { expiresIn?: number }): Promise<GetPresign>;
  head(key: string): Promise<HeadResult>;
  delete(key: string): Promise<void>;
}

/**
 * Validates a {@link StorageProviderConfig}: the `kind` must be a known
 * provider and the bucket/region/credentials must be non-empty. Optional
 * fields (`endpoint`, `forcePathStyle`, `publicBaseUrl`) are passed through
 * when present.
 */
export const storageProviderConfigSchema = z.object({
  kind: z.enum(STORAGE_PROVIDERS),
  bucket: z.string().min(1),
  region: z.string().min(1),
  endpoint: z.string().url().optional(),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  forcePathStyle: z.boolean().optional(),
  publicBaseUrl: z.string().url().optional(),
});

/**
 * The parsed output of {@link storageProviderConfigSchema}. Structurally
 * compatible with {@link StorageProviderConfig} (optional fields are widened to
 * `T | undefined` by zod's `.optional()`, which is what consumers building a
 * provider from parsed env config receive).
 */
export type ParsedStorageProviderConfig = z.infer<typeof storageProviderConfigSchema>;
