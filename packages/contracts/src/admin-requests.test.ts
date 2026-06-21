import { describe, expect, it } from 'vitest';

import {
  createApiKeySchema,
  createTenantSchema,
  generateCodesSchema,
  topupSchema,
  updateApiKeyGroupSchema,
} from './admin-requests.js';

describe('admin request contracts', () => {
  it('createTenantSchema accepts a valid body and rejects an empty name', () => {
    const body = { name: 'acme', isolationMode: 'field' as const };
    expect(createTenantSchema.parse(body)).toEqual(body);
    expect(() => createTenantSchema.parse({ name: '' })).toThrow();
  });

  it('topupSchema requires a positive credit number', () => {
    expect(topupSchema.parse({ credits: 100 })).toEqual({ credits: 100 });
    expect(() => topupSchema.parse({ credits: 0 })).toThrow();
    expect(() => topupSchema.parse({ credits: '100' })).toThrow();
  });

  it('createApiKeySchema requires a uuid tenantId', () => {
    const ok = { tenantId: '11111111-1111-1111-1111-111111111111', rateLimit: 60 };
    expect(createApiKeySchema.parse(ok)).toEqual(ok);
    expect(() => createApiKeySchema.parse({ tenantId: 'not-a-uuid' })).toThrow();
  });

  it('updateApiKeyGroupSchema accepts an explicit null (unbind) but rejects omission', () => {
    expect(updateApiKeyGroupSchema.parse({ routeGroupId: null })).toEqual({ routeGroupId: null });
    expect(() => updateApiKeyGroupSchema.parse({})).toThrow();
  });

  it('generateCodesSchema clamps count to 1..1000', () => {
    const ok = { count: 5, creditsPerCode: 10 };
    expect(generateCodesSchema.parse(ok)).toEqual(ok);
    expect(() => generateCodesSchema.parse({ count: 0, creditsPerCode: 10 })).toThrow();
    expect(() => generateCodesSchema.parse({ count: 1001, creditsPerCode: 10 })).toThrow();
  });
});
