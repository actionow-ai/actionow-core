import { describe, expect, it } from 'vitest';

import {
  accountViewSchema,
  bulkResultViewSchema,
  latestAuditViewSchema,
  subjectViewSchema,
  tenantViewSchema,
} from './admin-views.js';

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
      limit_plan_id: null,
      created_at: '2026-01-01T00:00:00Z',
    };
    expect(accountViewSchema.parse(v)).toEqual(v);
    // money is a µcredit decimal STRING, never a JS number — guard against drift.
    expect(() => accountViewSchema.parse({ ...v, credit_balance: 0 })).toThrow();
  });

  it('subjectViewSchema accepts a view with nullable identity fields', () => {
    const v = {
      id: 's1',
      tenant_id: 't1',
      external_id: 'end-user-1',
      email: null,
      display_name: 'Alice',
      limit_plan_id: null,
      status: 'active',
      created_at: '2026-01-01T00:00:00Z',
    };
    expect(subjectViewSchema.parse(v)).toEqual(v);
    expect(() => subjectViewSchema.parse({ ...v, status: undefined })).toThrow();
  });

  it('bulkResultViewSchema accepts a partial-success result and rejects a malformed failure', () => {
    const v = {
      succeeded: ['m1', 'm2'],
      failed: [{ id: 'nope', error: 'not found' }],
    };
    expect(bulkResultViewSchema.parse(v)).toEqual(v);
    // an empty batch result is valid (no ids in either bucket).
    expect(bulkResultViewSchema.parse({ succeeded: [], failed: [] })).toEqual({
      succeeded: [],
      failed: [],
    });
    // a failure row MUST carry both id + error string.
    expect(() => bulkResultViewSchema.parse({ succeeded: [], failed: [{ id: 'x' }] })).toThrow();
  });

  it('latestAuditViewSchema accepts a row and allows a null actor_id (system action)', () => {
    const v = {
      target_id: 'chan-X',
      actor_type: 'operator',
      actor_id: 'op-1',
      action: 'channel.disable',
      created_at: '2026-06-03T00:00:00Z',
    };
    expect(latestAuditViewSchema.parse(v)).toEqual(v);
    // a system action carries a null actor_id.
    expect(latestAuditViewSchema.parse({ ...v, actor_type: 'system', actor_id: null })).toEqual({
      ...v,
      actor_type: 'system',
      actor_id: null,
    });
    // target_id is required (the FE keys the response Map by it).
    expect(() => latestAuditViewSchema.parse({ ...v, target_id: undefined })).toThrow();
  });
});
