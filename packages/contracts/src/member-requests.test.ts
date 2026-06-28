import { describe, expect, it } from 'vitest';

import {
  memberChangePasswordSchema,
  memberCreateApiKeySchema,
  memberKeyCreatedViewSchema,
  memberUpdateMeSchema,
} from './member-requests.js';

describe('member request contracts', () => {
  it('memberUpdateMeSchema accepts a 1..256 display_name or null, carries no ids', () => {
    expect(memberUpdateMeSchema.parse({ display_name: 'Ada' })).toEqual({ display_name: 'Ada' });
    expect(memberUpdateMeSchema.parse({ display_name: null })).toEqual({ display_name: null });
    expect(() => memberUpdateMeSchema.parse({ display_name: '' })).toThrow();
    expect(() => memberUpdateMeSchema.parse({})).toThrow();
    // subject/tenant ids are NEVER part of the body — they are stripped.
    expect(
      memberUpdateMeSchema.parse({ display_name: 'Ada', subjectId: 'x', tenantId: 'y' }),
    ).toEqual({ display_name: 'Ada' });
  });

  it('memberChangePasswordSchema enforces the 8..256 new-password policy', () => {
    const body = { current_password: 'old', new_password: 'newpassword' };
    expect(memberChangePasswordSchema.parse(body)).toEqual(body);
    expect(() =>
      memberChangePasswordSchema.parse({ current_password: '', new_password: 'newpassword' }),
    ).toThrow();
    expect(() =>
      memberChangePasswordSchema.parse({ current_password: 'old', new_password: 'short' }),
    ).toThrow();
  });

  it('memberCreateApiKeySchema is all-optional and carries no subject/tenant id', () => {
    expect(memberCreateApiKeySchema.parse({})).toEqual({});
    expect(memberCreateApiKeySchema.parse({ resourceAllowlist: ['gpt'] })).toEqual({
      resourceAllowlist: ['gpt'],
    });
    expect(() => memberCreateApiKeySchema.parse({ resourceAllowlist: 'gpt' })).toThrow();
  });

  it('memberKeyCreatedViewSchema is the one-time {id, plaintext} mint view', () => {
    expect(memberKeyCreatedViewSchema.parse({ id: 'k1', plaintext: 'ak_xxx' })).toEqual({
      id: 'k1',
      plaintext: 'ak_xxx',
    });
  });
});
