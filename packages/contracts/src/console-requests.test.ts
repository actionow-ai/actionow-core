import { describe, expect, it } from 'vitest';

import {
  consoleChangePasswordSchema,
  consoleCreateApiKeySchema,
  consoleCreateIntentSchema,
  consoleCreateUserSchema,
  consoleUpdateUserSchema,
  redeemCodeRequestSchema,
} from './console-requests.js';

describe('console request contracts', () => {
  it('consoleCreateApiKeySchema carries no tenantId and is all-optional', () => {
    expect(consoleCreateApiKeySchema.parse({})).toEqual({});
    expect(consoleCreateApiKeySchema.parse({ rateLimit: 60 })).toEqual({ rateLimit: 60 });
    expect(() => consoleCreateApiKeySchema.parse({ rateLimit: 0 })).toThrow();
  });

  it('consoleCreateApiKeySchema accepts an optional uuid subjectId (key→subject binding)', () => {
    const sid = '00000000-0000-0000-0000-000000000001';
    expect(consoleCreateApiKeySchema.parse({ subjectId: sid })).toEqual({ subjectId: sid });
    expect(() => consoleCreateApiKeySchema.parse({ subjectId: 'not-a-uuid' })).toThrow();
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

  it('consoleCreateUserSchema requires a valid email + an 8..256 initial password', () => {
    const body = { email: 'sub@x.com', password: 'initialpw1' };
    expect(consoleCreateUserSchema.parse(body)).toEqual(body);
    expect(() => consoleCreateUserSchema.parse({ ...body, email: 'not-an-email' })).toThrow();
    expect(() => consoleCreateUserSchema.parse({ ...body, password: 'short' })).toThrow();
  });

  it('consoleUpdateUserSchema is all-optional and narrows status/tenantRole to known enums', () => {
    expect(consoleUpdateUserSchema.parse({})).toEqual({});
    expect(consoleUpdateUserSchema.parse({ status: 'disabled' })).toEqual({ status: 'disabled' });
    expect(consoleUpdateUserSchema.parse({ tenantRole: 'admin' })).toEqual({ tenantRole: 'admin' });
    expect(() => consoleUpdateUserSchema.parse({ status: 'banned' })).toThrow();
    expect(() => consoleUpdateUserSchema.parse({ tenantRole: 'owner' })).toThrow();
  });

  it('redeemCodeRequestSchema trims a non-empty code and rejects blank/whitespace', () => {
    expect(redeemCodeRequestSchema.parse({ code: '  GIFT-123  ' })).toEqual({ code: 'GIFT-123' });
    expect(() => redeemCodeRequestSchema.parse({ code: '' })).toThrow();
    expect(() => redeemCodeRequestSchema.parse({ code: '   ' })).toThrow();
    expect(() => redeemCodeRequestSchema.parse({})).toThrow();
  });
});
