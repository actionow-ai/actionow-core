import { describe, expect, it } from 'vitest';

import { createAdminTokenSchema } from './admin-requests.js';
import { adminTokenViewSchema } from './admin-views.js';

describe('admin service-token contracts (single source of truth for FE + BE)', () => {
  it('adminTokenViewSchema accepts a valid view (expires_at nullable) and rejects a missing field', () => {
    const v = {
      id: 'tok1',
      name: 'ci-bot',
      created_by: 'u1',
      status: 'active',
      expires_at: null,
      created_at: '2026-06-20T00:00:00Z',
      updated_at: '2026-06-20T00:00:00Z',
    };
    expect(adminTokenViewSchema.parse(v)).toEqual(v);
    // expires_at may be an ISO string when the token has an expiry.
    expect(adminTokenViewSchema.parse({ ...v, expires_at: '2027-01-01T00:00:00Z' })).toBeTruthy();
    expect(() => adminTokenViewSchema.parse({ ...v, name: undefined })).toThrow();
  });

  it('createAdminTokenSchema requires a non-empty name and accepts an optional ISO expiresAt', () => {
    expect(createAdminTokenSchema.parse({ name: 'svc' })).toEqual({ name: 'svc' });
    expect(
      createAdminTokenSchema.parse({ name: 'svc', expiresAt: '2027-01-01T00:00:00Z' }),
    ).toEqual({ name: 'svc', expiresAt: '2027-01-01T00:00:00Z' });
    expect(() => createAdminTokenSchema.parse({ name: '' })).toThrow();
    expect(() => createAdminTokenSchema.parse({})).toThrow();
    expect(() => createAdminTokenSchema.parse({ name: 'svc', expiresAt: 'not-a-date' })).toThrow();
  });
});
