import { describe, expect, it } from 'vitest';

import { accountViewSchema, tenantViewSchema } from './admin-views.js';

describe('admin view contracts (single source of truth for FE + BE)', () => {
  it('tenantViewSchema accepts a valid view and rejects a missing field', () => {
    const v = {
      id: 't1',
      name: 'acme',
      isolation_mode: 'field',
      created_at: '2026-01-01T00:00:00Z',
    };
    expect(tenantViewSchema.parse(v)).toEqual(v);
    expect(() => tenantViewSchema.parse({ ...v, isolation_mode: undefined })).toThrow();
  });

  it('accountViewSchema accepts a valid view and rejects a wrong-typed money field', () => {
    const v = {
      id: 'a1',
      tenant_id: 't1',
      credit_balance: '0',
      credit_held: '0',
      created_at: '2026-01-01T00:00:00Z',
    };
    expect(accountViewSchema.parse(v)).toEqual(v);
    // money is a µcredit decimal STRING, never a JS number — guard against drift.
    expect(() => accountViewSchema.parse({ ...v, credit_balance: 0 })).toThrow();
  });
});
