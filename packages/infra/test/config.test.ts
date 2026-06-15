import { describe, expect, it } from 'vitest';

import { loadEnv } from '../src/config.js';

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
