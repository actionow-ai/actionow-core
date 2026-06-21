import { describe, expect, it } from 'vitest';

import {
  consoleChangePasswordSchema,
  consoleCreateApiKeySchema,
  consoleCreateIntentSchema,
} from './console-requests.js';

describe('console request contracts', () => {
  it('consoleCreateApiKeySchema carries no tenantId and is all-optional', () => {
    expect(consoleCreateApiKeySchema.parse({})).toEqual({});
    expect(consoleCreateApiKeySchema.parse({ rateLimit: 60 })).toEqual({ rateLimit: 60 });
    expect(() => consoleCreateApiKeySchema.parse({ rateLimit: 0 })).toThrow();
  });

  it('consoleCreateIntentSchema requires a known provider enum + positive minor amount', () => {
    const body = { provider: 'stripe' as const, amount_minor: 1000, currency: 'usd' };
    expect(consoleCreateIntentSchema.parse(body)).toEqual(body);
    expect(() => consoleCreateIntentSchema.parse({ ...body, provider: 'paypal' })).toThrow();
    expect(() => consoleCreateIntentSchema.parse({ ...body, amount_minor: -1 })).toThrow();
  });

  it('consoleChangePasswordSchema enforces the 8..256 new-password policy', () => {
    const body = { currentPassword: 'old', newPassword: 'newpassword' };
    expect(consoleChangePasswordSchema.parse(body)).toEqual(body);
    expect(() =>
      consoleChangePasswordSchema.parse({ currentPassword: 'x', newPassword: 'short' }),
    ).toThrow();
  });
});
