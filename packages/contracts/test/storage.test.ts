import { describe, expect, it } from 'vitest';

import { STORAGE_PROVIDERS, storageProviderConfigSchema } from '../src/storage.js';

describe('storage provider config', () => {
  it('lists the six supported provider kinds', () => {
    expect(STORAGE_PROVIDERS).toEqual([
      'aws-s3',
      'r2',
      'minio',
      'aliyun-oss',
      'tencent-cos',
      'volcano-tos',
    ]);
  });

  it('accepts a valid minio config (path-style, custom endpoint)', () => {
    const cfg = storageProviderConfigSchema.parse({
      kind: 'minio',
      bucket: 'actionow',
      region: 'us-east-1',
      endpoint: 'http://localhost:9000',
      accessKeyId: 'actionow',
      secretAccessKey: 'actionow123',
      forcePathStyle: true,
    });
    expect(cfg.kind).toBe('minio');
    expect(cfg.forcePathStyle).toBe(true);
  });

  it('accepts an aws-s3 config without an endpoint', () => {
    const cfg = storageProviderConfigSchema.parse({
      kind: 'aws-s3',
      bucket: 'prod-assets',
      region: 'us-west-2',
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
    });
    expect(cfg.endpoint).toBeUndefined();
  });

  it('rejects an unknown provider kind', () => {
    expect(() =>
      storageProviderConfigSchema.parse({
        kind: 'gcs',
        bucket: 'b',
        region: 'r',
        accessKeyId: 'a',
        secretAccessKey: 's',
      }),
    ).toThrow();
  });

  it('rejects empty credentials', () => {
    expect(() =>
      storageProviderConfigSchema.parse({
        kind: 'r2',
        bucket: 'b',
        region: 'auto',
        accessKeyId: '',
        secretAccessKey: 's',
      }),
    ).toThrow();
  });
});
