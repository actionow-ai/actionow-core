import { describe, expect, it } from 'vitest';

import { provisionSchema } from './admin-requests.js';
import { provisionViewSchema } from './admin-views.js';

describe('one-step provision contracts', () => {
  it('provisionSchema requires a tenant name; the rest is optional', () => {
    expect(provisionSchema.parse({ name: 'Acme' })).toEqual({ name: 'Acme' });
    expect(
      provisionSchema.parse({
        name: 'Acme',
        isolationMode: 'schema',
        credits: 100,
        resourceAllowlist: ['openai-gpt'],
        rateLimit: 120,
      }),
    ).toMatchObject({ name: 'Acme', credits: 100 });
    expect(() => provisionSchema.parse({ name: '' })).toThrow();
    expect(() => provisionSchema.parse({})).toThrow();
    // credits is a HUMAN number (converted to µcredits server-side), never a string.
    expect(() => provisionSchema.parse({ name: 'x', credits: '100' })).toThrow();
  });

  it('provisionViewSchema composes tenant + account + the one-time api key', () => {
    const v = {
      tenant: {
        id: 't1',
        name: 'Acme',
        isolation_mode: 'field',
        created_at: '2026-06-20T00:00:00Z',
      },
      account: {
        id: 'a1',
        tenant_id: 't1',
        credit_balance: '100000000',
        credit_held: '0',
        created_at: '2026-06-20T00:00:00Z',
      },
      api_key: { id: 'k1', plaintext: 'ak_xxx' },
    };
    expect(provisionViewSchema.parse(v)).toEqual(v);
    // the plaintext key is required (it is returned ONCE).
    expect(() => provisionViewSchema.parse({ ...v, api_key: { id: 'k1' } })).toThrow();
  });
});
