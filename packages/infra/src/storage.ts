import type {
  GetPresign,
  HeadResult,
  PutPresign,
  StorageProvider,
  StorageProviderConfig,
  StorageProviderKind,
} from '@actionow/contracts';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** Default presigned-PUT lifetime (seconds). */
const DEFAULT_PUT_EXPIRES_IN = 900;
/** Default presigned-GET lifetime (seconds). */
const DEFAULT_GET_EXPIRES_IN = 3600;

/**
 * Provider-specific connection conventions, returned by {@link providerDefaults}
 * and merged into a partial config by config builders/tests.
 *
 * - `r2` — region must be `auto`; endpoint is account-scoped so it is supplied
 *   per-account, not here.
 * - `aliyun-oss` — virtual-host endpoint `https://s3.oss-<region>.aliyuncs.com`
 *   (the S3-compatible host; uses virtual-host addressing).
 * - `tencent-cos` — virtual-host addressing; endpoint `https://cos.<region>.myqcloud.com`.
 * - `volcano-tos` — S3-compatible endpoint `https://tos-s3-<region>.volces.com`.
 * - `minio` — path-style addressing (`forcePathStyle: true`); endpoint is the
 *   local/self-hosted host, supplied per-deployment.
 * - `aws-s3` — SDK defaults (virtual-host, region-derived endpoint, AWS checksums).
 */
export interface ProviderDefaults {
  /** A fixed region the provider requires (e.g. r2 `auto`), if any. */
  region?: string;
  /**
   * A template for the S3-compatible endpoint where `<region>` is substituted.
   * `undefined` when the endpoint is account/deployment-scoped and must be
   * supplied explicitly (r2, minio, aws-s3).
   */
  endpointTemplate?: string;
  /** Whether the provider needs path-style addressing (MinIO). */
  forcePathStyle?: boolean;
}

const PROVIDER_DEFAULTS: Record<StorageProviderKind, ProviderDefaults> = {
  'aws-s3': {},
  r2: { region: 'auto' },
  minio: { forcePathStyle: true },
  'aliyun-oss': { endpointTemplate: 'https://s3.oss-<region>.aliyuncs.com' },
  // Tencent COS uses virtual-host addressing against the regional host.
  'tencent-cos': { endpointTemplate: 'https://cos.<region>.myqcloud.com' },
  'volcano-tos': { endpointTemplate: 'https://tos-s3-<region>.volces.com' },
};

/**
 * The connection defaults for a provider kind: fixed region (r2 `auto`),
 * endpoint template (`<region>` substituted by the caller), and whether
 * path-style addressing is required (minio). Pure data, no network.
 */
export function providerDefaults(kind: StorageProviderKind): ProviderDefaults {
  return PROVIDER_DEFAULTS[kind];
}

/**
 * Build the `S3Client` config for a provider config.
 *
 * **The critical non-AWS fix:** for every `kind !== 'aws-s3'`, opt out of the
 * v3.729+ default CRC32 checksum behaviour by setting
 * `requestChecksumCalculation` / `responseChecksumValidation` to
 * `'WHEN_REQUIRED'`. Without this the default checksum trailer/headers make
 * R2 / MinIO / OSS / COS / TOS reject presigned PUTs with HTTP 400.
 */
function buildClientConfig(cfg: StorageProviderConfig): S3ClientConfig {
  const base: S3ClientConfig = {
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle ?? false,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  };
  if (cfg.endpoint !== undefined) {
    base.endpoint = cfg.endpoint;
  }
  if (cfg.kind !== 'aws-s3') {
    base.requestChecksumCalculation = 'WHEN_REQUIRED';
    base.responseChecksumValidation = 'WHEN_REQUIRED';
  }
  return base;
}

/** A {@link StorageProvider} that also exposes its underlying `S3Client`. */
export interface S3StorageProvider extends StorageProvider {
  /** The configured S3 client, exposed for bucket setup/inspection in tests. */
  readonly client: S3Client;
}

/**
 * Construct an S3-backed {@link StorageProvider} for one bucket. A single
 * `@aws-sdk/client-s3` v3 client drives all six provider kinds; the non-AWS
 * checksum opt-out (see {@link buildClientConfig}) is applied automatically.
 */
export function createS3StorageProvider(cfg: StorageProviderConfig): S3StorageProvider {
  const client = new S3Client(buildClientConfig(cfg));
  const bucket = cfg.bucket;

  return {
    kind: cfg.kind,
    client,

    async presignPut(key, opts): Promise<PutPresign> {
      const expiresIn = opts?.expiresIn ?? DEFAULT_PUT_EXPIRES_IN;
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(opts?.contentType !== undefined ? { ContentType: opts.contentType } : {}),
      });
      const url = await getSignedUrl(client, command, { expiresIn });
      return { url, key, expiresIn };
    },

    async presignGet(key, opts): Promise<GetPresign> {
      const expiresIn = opts?.expiresIn ?? DEFAULT_GET_EXPIRES_IN;
      const command = new GetObjectCommand({ Bucket: bucket, Key: key });
      const url = await getSignedUrl(client, command, { expiresIn });
      return { url, expiresIn };
    },

    async head(key): Promise<HeadResult> {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        const result: HeadResult = { exists: true };
        if (res.ContentLength !== undefined) result.size = res.ContentLength;
        if (res.ContentType !== undefined) result.contentType = res.ContentType;
        if (res.ETag !== undefined) result.etag = res.ETag;
        return result;
      } catch (err: unknown) {
        if (isNotFound(err)) return { exists: false };
        throw err;
      }
    },

    async delete(key): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

/** True when an S3 error represents a missing object (404 / NotFound / NoSuchKey). */
function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {
    name?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (e.name === 'NotFound' || e.name === 'NoSuchKey') return true;
  if (e.Code === 'NotFound' || e.Code === 'NoSuchKey') return true;
  return e.$metadata?.httpStatusCode === 404;
}
