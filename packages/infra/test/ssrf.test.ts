import { describe, expect, it } from 'vitest';

import { assertEgressAllowed, EgressBlockedError } from '../src/ssrf.js';

/** A fake DNS lookup so hostname tests are deterministic (no real network). */
function fakeLookup(map: Record<string, string[]>) {
  return (host: string): Promise<{ address: string; family: number }[]> => {
    const addrs = map[host];
    if (addrs === undefined) return Promise.reject(new Error(`ENOTFOUND ${host}`));
    return Promise.resolve(
      addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    );
  };
}

describe('assertEgressAllowed', () => {
  it('rejects the cloud metadata IP (169.254.169.254)', async () => {
    await expect(
      assertEgressAllowed('http://169.254.169.254/latest/meta-data/'),
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it('rejects loopback, private, link-local, and unspecified literals', async () => {
    for (const url of [
      'http://127.0.0.1/hook',
      'http://10.0.0.1/hook',
      'http://172.16.5.4/hook',
      'http://192.168.1.10/hook',
      'http://169.254.1.1/hook',
      'http://0.0.0.0/hook',
      'http://[::1]/hook',
      'http://[fe80::1]/hook',
      'http://[fc00::1]/hook',
    ]) {
      await expect(assertEgressAllowed(url)).rejects.toBeInstanceOf(EgressBlockedError);
    }
  });

  it('rejects non-http(s) schemes (file/gopher/ftp)', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://1.1.1.1/', 'ftp://1.1.1.1/x']) {
      await expect(assertEgressAllowed(url)).rejects.toBeInstanceOf(EgressBlockedError);
    }
  });

  it('rejects a hostname that RESOLVES to a private address (DNS check)', async () => {
    await expect(
      assertEgressAllowed('https://evil.example.com/hook', {
        lookup: fakeLookup({ 'evil.example.com': ['10.0.0.5'] }),
      }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it('allows a public literal IP over https/http', async () => {
    await expect(assertEgressAllowed('https://1.1.1.1/hook')).resolves.toBeUndefined();
    await expect(assertEgressAllowed('http://8.8.8.8/hook')).resolves.toBeUndefined();
  });

  it('allows a hostname that resolves to a public address', async () => {
    await expect(
      assertEgressAllowed('https://hook.example.com/x', {
        lookup: fakeLookup({ 'hook.example.com': ['93.184.216.34'] }),
      }),
    ).resolves.toBeUndefined();
  });

  it('permits private/loopback targets when allowPrivateTargets is set (operator opt-in)', async () => {
    await expect(
      assertEgressAllowed('http://127.0.0.1:9000/hook', { allowPrivateTargets: true }),
    ).resolves.toBeUndefined();
    await expect(
      assertEgressAllowed('http://10.0.0.1/hook', { allowPrivateTargets: true }),
    ).resolves.toBeUndefined();
  });

  it('rejects a malformed URL', async () => {
    await expect(assertEgressAllowed('not a url')).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it('allows (does not block) a host that fails to resolve — DNS failure is not an SSRF signal', async () => {
    await expect(
      assertEgressAllowed('https://nope.invalid/hook', {
        lookup: () => Promise.reject(new Error('ENOTFOUND nope.invalid')),
      }),
    ).resolves.toBeUndefined();
  });
});
