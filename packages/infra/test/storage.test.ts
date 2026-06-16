import type { StorageProviderConfig, StorageProviderKind } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { createS3StorageProvider, providerDefaults } from '../src/storage.js';

/** Build a config for `kind`, merging overrides over sensible test defaults. */
function makeConfig(
  kind: StorageProviderKind,
  overrides: Partial<StorageProviderConfig> = {},
): StorageProviderConfig {
  return {
    kind,
    bucket: 'test-bucket',
    region: 'us-east-1',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
    ...overrides,
  };
}

/**
 * aws-sdk v3 normalizes scalar client-config values into provider functions, so
 * resolve a possibly-async config value to its concrete value for assertions.
 */
async function resolveConfig<T>(value: T | (() => T | Promise<T>)): Promise<T> {
  return typeof value === 'function' ? (value as () => T | Promise<T>)() : value;
}

describe('createS3StorageProvider — per-kind client config', () => {
  it('applies the non-AWS checksum fix for r2 (WHEN_REQUIRED, no path-style)', async () => {
    const { client } = createS3StorageProvider(
      makeConfig('r2', { region: 'auto', endpoint: 'https://acct.r2.cloudflarestorage.com' }),
    );
    expect(client.config.forcePathStyle).toBe(false);
    expect(await resolveConfig(client.config.requestChecksumCalculation)).toBe('WHEN_REQUIRED');
    expect(await resolveConfig(client.config.responseChecksumValidation)).toBe('WHEN_REQUIRED');
  });

  it('applies the checksum fix and forcePathStyle for minio', async () => {
    const { client } = createS3StorageProvider(
      makeConfig('minio', { endpoint: 'http://localhost:9000', forcePathStyle: true }),
    );
    expect(client.config.forcePathStyle).toBe(true);
    expect(await resolveConfig(client.config.requestChecksumCalculation)).toBe('WHEN_REQUIRED');
    expect(await resolveConfig(client.config.responseChecksumValidation)).toBe('WHEN_REQUIRED');
  });

  it.each<StorageProviderKind>(['aliyun-oss', 'tencent-cos', 'volcano-tos'])(
    'applies the checksum fix for %s',
    async (kind) => {
      const { client } = createS3StorageProvider(
        makeConfig(kind, { endpoint: 'https://example.com' }),
      );
      expect(await resolveConfig(client.config.requestChecksumCalculation)).toBe('WHEN_REQUIRED');
      expect(await resolveConfig(client.config.responseChecksumValidation)).toBe('WHEN_REQUIRED');
    },
  );

  it('leaves aws-s3 on SDK defaults (no checksum override, no endpoint)', async () => {
    const provider = createS3StorageProvider(makeConfig('aws-s3', { region: 'us-west-2' }));
    expect(provider.kind).toBe('aws-s3');
    expect(provider.client.config.forcePathStyle).toBe(false);
    // The SDK default is WHEN_SUPPORTED; we must NOT have downgraded it.
    expect(await resolveConfig(provider.client.config.requestChecksumCalculation)).toBe(
      'WHEN_SUPPORTED',
    );
    expect(await resolveConfig(provider.client.config.responseChecksumValidation)).toBe(
      'WHEN_SUPPORTED',
    );
  });
});

describe('providerDefaults', () => {
  it('maps r2 region to auto', () => {
    expect(providerDefaults('r2').region).toBe('auto');
  });
  it('forces path style for minio', () => {
    expect(providerDefaults('minio').forcePathStyle).toBe(true);
  });
  it('uses the s3.oss-<region> endpoint template for aliyun-oss', () => {
    expect(providerDefaults('aliyun-oss').endpointTemplate).toContain('s3.oss-<region>');
  });
  it('uses a virtual-host endpoint for tencent-cos', () => {
    expect(providerDefaults('tencent-cos').endpointTemplate).toContain('<region>');
  });
  it('uses the tos-s3-<region> endpoint template for volcano-tos', () => {
    expect(providerDefaults('volcano-tos').endpointTemplate).toContain('tos-s3-<region>');
  });
  it('has no overrides for aws-s3', () => {
    expect(providerDefaults('aws-s3')).toEqual({});
  });
});

describe('createS3StorageProvider — presign URL inspection (no network)', () => {
  const provider = createS3StorageProvider(
    makeConfig('minio', { endpoint: 'http://localhost:9000', forcePathStyle: true }),
  );

  it('presignPut returns a URL containing the key and a signature, default 900s', async () => {
    const presign = await provider.presignPut('tenant-x/object-123.png', {
      contentType: 'image/png',
    });
    expect(presign.key).toBe('tenant-x/object-123.png');
    expect(presign.expiresIn).toBe(900);
    // Path-style addressing: bucket + key in the path, key slashes unescaped.
    expect(presign.url).toContain('/test-bucket/tenant-x/object-123.png');
    expect(presign.url).toContain('X-Amz-Signature');
    expect(presign.url).toContain('X-Amz-Expires=900');
  });

  it('presignGet returns a signed URL with the key, default 3600s', async () => {
    const presign = await provider.presignGet('tenant-x/object-123.png');
    expect(presign.expiresIn).toBe(3600);
    expect(presign.url).toContain('/test-bucket/tenant-x/object-123.png');
    expect(presign.url).toContain('X-Amz-Signature');
    expect(presign.url).toContain('X-Amz-Expires=3600');
  });

  it('honors a custom expiry on presignPut', async () => {
    const presign = await provider.presignPut('k.txt', { expiresIn: 120 });
    expect(presign.expiresIn).toBe(120);
    expect(presign.url).toContain('X-Amz-Expires=120');
  });
});
