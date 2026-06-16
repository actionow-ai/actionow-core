import { describe, expect, it } from 'vitest';

import { loadEnv, storageConfigFromEnv } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://localhost:5432/app',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadEnv ADMIN_JWT_SECRET', () => {
  it('supplies a dev default outside production', () => {
    const env = loadEnv({ ...base, NODE_ENV: 'development' });
    expect(env.ADMIN_JWT_SECRET).toBeTypeOf('string');
    expect(env.ADMIN_JWT_SECRET.length).toBeGreaterThan(0);
  });

  it('uses the provided secret when set', () => {
    const env = loadEnv({
      ...base,
      NODE_ENV: 'production',
      ADMIN_JWT_SECRET: 'a-real-prod-secret',
    });
    expect(env.ADMIN_JWT_SECRET).toBe('a-real-prod-secret');
  });

  it('requires ADMIN_JWT_SECRET in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow();
  });

  it('still exposes the rate-limit defaults', () => {
    const env = loadEnv({ ...base });
    expect(env.RATE_LIMIT_TENANT_PER_MIN).toBeGreaterThan(0);
    expect(env.RATE_LIMIT_RESOURCE_PER_MIN).toBeGreaterThan(0);
  });
});

describe('storageConfigFromEnv + STORAGE_PUBLIC_BASE_URL', () => {
  const storageEnv = {
    ...base,
    STORAGE_PROVIDER: 'r2',
    STORAGE_BUCKET: 'actionow',
    STORAGE_REGION: 'auto',
    STORAGE_ACCESS_KEY_ID: 'ak',
    STORAGE_SECRET_ACCESS_KEY: 'sk',
    STORAGE_ENDPOINT: 'https://acc.r2.cloudflarestorage.com',
    STORAGE_PUBLIC_BASE_URL: 'https://asset.actionow.ai',
  };

  it('returns null when STORAGE_* is unconfigured', () => {
    expect(storageConfigFromEnv(loadEnv({ ...base }))).toBeNull();
  });

  it('assembles a config from the STORAGE_* fields, including the endpoint', () => {
    const cfg = storageConfigFromEnv(loadEnv(storageEnv));
    expect(cfg).toEqual({
      kind: 'r2',
      bucket: 'actionow',
      region: 'auto',
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      endpoint: 'https://acc.r2.cloudflarestorage.com',
    });
  });

  it('parses STORAGE_PUBLIC_BASE_URL (optional URL)', () => {
    expect(loadEnv({ ...base }).STORAGE_PUBLIC_BASE_URL).toBeUndefined();
    expect(loadEnv(storageEnv).STORAGE_PUBLIC_BASE_URL).toBe('https://asset.actionow.ai');
  });
});

describe('ALLOW_DEV_TENANT_HEADER (Track B Task 5)', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/d',
    REDIS_URL: 'redis://localhost:6379',
    ADMIN_JWT_SECRET: 'x',
  };
  it('defaults to false', () => {
    expect(loadEnv({ ...base }).ALLOW_DEV_TENANT_HEADER).toBe(false);
  });
  it('coerces the string "true"', () => {
    expect(loadEnv({ ...base, ALLOW_DEV_TENANT_HEADER: 'true' }).ALLOW_DEV_TENANT_HEADER).toBe(
      true,
    );
  });
});
