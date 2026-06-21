import type { AdminTokenRecord, Database } from '@actionow/db';
import { hashAdminToken } from '@actionow/db';
import { describe, expect, it } from 'vitest';

import {
  type AdminTokenAuthRepo,
  AdminTokenAuthService,
} from '../src/admin/auth/admin-token-auth.service.js';

const base: AdminTokenRecord = {
  id: 'tok-1',
  createdBy: 'admin-9',
  status: 'active',
  expiresAt: null,
};

function serviceWith(record: AdminTokenRecord | undefined): AdminTokenAuthService {
  const repo: AdminTokenAuthRepo = {
    findAdminTokenByHash: () => Promise.resolve(record),
  };
  return new AdminTokenAuthService({} as Database, repo);
}

describe('AdminTokenAuthService.verify', () => {
  it('accepts an active, unexpired token and attributes it to the minting admin', async () => {
    const ctx = await serviceWith(base).verify('at_whatever');
    expect(ctx).toEqual({ adminId: 'admin-9', role: 'admin' });
  });

  it('rejects an unknown token (no row)', async () => {
    expect(await serviceWith(undefined).verify('at_unknown')).toBeUndefined();
  });

  it('rejects a disabled token', async () => {
    expect(await serviceWith({ ...base, status: 'disabled' }).verify('at_x')).toBeUndefined();
  });

  it('rejects an expired token', async () => {
    const past = new Date(Date.now() - 1000);
    expect(await serviceWith({ ...base, expiresAt: past }).verify('at_x')).toBeUndefined();
  });

  it('accepts a token whose expiry is in the future', async () => {
    const future = new Date(Date.now() + 60_000);
    const ctx = await serviceWith({ ...base, expiresAt: future }).verify('at_x');
    expect(ctx).toEqual({ adminId: 'admin-9', role: 'admin' });
  });

  it('looks the token up by its sha256 hash, never the plaintext', async () => {
    let seenHash: string | undefined;
    const repo: AdminTokenAuthRepo = {
      findAdminTokenByHash: (_db, hash) => {
        seenHash = hash;
        return Promise.resolve(base);
      },
    };
    await new AdminTokenAuthService({} as Database, repo).verify('at_secret');
    expect(seenHash).toBe(hashAdminToken('at_secret'));
    expect(seenHash).not.toContain('at_secret');
  });
});
