import { describe, expect, it } from 'vitest';

import { applySigner, type SignerInput } from '../src/signers.js';

const NOW = Date.UTC(2026, 5, 23, 12, 0, 0); // 2026-06-23T12:00:00Z

function base(over: Partial<SignerInput> = {}): SignerInput {
  return {
    method: 'POST',
    url: 'https://api.example.com/v1/x',
    headers: { 'content-type': 'application/json' },
    body: '{"a":1}',
    credentials: {},
    nowMs: NOW,
    ...over,
  };
}

describe('simple signers', () => {
  it('bearer sets Authorization: Bearer', () => {
    const out = applySigner('bearer', base({ credentials: { api_key: 'sk-1' } }));
    expect(out.headers.Authorization).toBe('Bearer sk-1');
  });
  it('custom-header uses header_name (default x-api-key)', () => {
    expect(
      applySigner(
        'custom-header',
        base({ credentials: { api_key: 'k', header_name: 'xi-api-key' } }),
      ).headers['xi-api-key'],
    ).toBe('k');
    expect(
      applySigner('custom-header', base({ credentials: { api_key: 'k' } })).headers['x-api-key'],
    ).toBe('k');
  });
  it('query-key appends ?key= to the URL', () => {
    const out = applySigner(
      'query-key',
      base({ url: 'https://g.example/v1:gen', credentials: { api_key: 'AIz' } }),
    );
    expect(out.url).toContain('key=AIz');
  });
  it('token uses literal Token scheme (not Bearer)', () => {
    expect(
      applySigner('token', base({ credentials: { api_key: 'tk' } })).headers.Authorization,
    ).toBe('Token tk');
  });
  it('none is a passthrough', () => {
    const out = applySigner('none', base());
    expect(out.headers.Authorization).toBeUndefined();
  });
});

describe('klingJwt', () => {
  it('produces a Bearer HS256 JWT with iss/exp/nbf claims', () => {
    const out = applySigner(
      'klingJwt',
      base({ credentials: { access_key: 'AK', secret_key: 'SK' } }),
    );
    const jwt = out.headers.Authorization?.replace('Bearer ', '') ?? '';
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    const [h, p, s] = parts as [string, string, string];
    expect(h).toBeTruthy();
    expect(s).toBeTruthy();
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(payload.iss).toBe('AK');
    expect(payload.exp).toBe(Math.floor(NOW / 1000) + 1800);
    expect(payload.nbf).toBe(Math.floor(NOW / 1000) - 5);
  });
});

describe('volcSignV4', () => {
  const input = base({
    url: 'https://visual.volcengineapi.com/?Action=CVProcess&Version=2022-08-31',
    credentials: { ak: 'AKID', sk: 'SECRET', region: 'cn-north-1', service: 'cv' },
  });
  it('emits a SigV4-style Authorization with the expected scope + signed headers', () => {
    const out = applySigner('volcSignV4', input);
    expect(out.headers.Authorization).toMatch(
      /^HMAC-SHA256 Credential=AKID\/20260623\/cn-north-1\/cv\/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/,
    );
    expect(out.headers['X-Date']).toBe('20260623T120000Z');
    expect(out.headers['X-Content-Sha256']).toMatch(/^[0-9a-f]{64}$/);
  });
  it('is deterministic for a fixed clock + body', () => {
    expect(applySigner('volcSignV4', input).headers.Authorization).toBe(
      applySigner('volcSignV4', input).headers.Authorization,
    );
  });
  it('the signature changes when the body changes (body-dependent)', () => {
    const a = applySigner('volcSignV4', input).headers.Authorization;
    const b = applySigner('volcSignV4', { ...input, body: '{"a":2}' }).headers.Authorization;
    expect(a).not.toBe(b);
  });
});

describe('tencentTC3', () => {
  const input = base({
    url: 'https://hunyuan.tencentcloudapi.com/',
    credentials: { secret_id: 'AKIDz', secret_key: 'Gu5t', service: 'hunyuan' },
  });
  it('emits a TC3-HMAC-SHA256 Authorization with content-type;host signed headers', () => {
    const out = applySigner('tencentTC3', input);
    expect(out.headers.Authorization).toMatch(
      /^TC3-HMAC-SHA256 Credential=AKIDz\/2026-06-23\/hunyuan\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/,
    );
    expect(out.headers['X-TC-Timestamp']).toBe(String(Math.floor(NOW / 1000)));
  });
  it('is body-dependent', () => {
    const a = applySigner('tencentTC3', input).headers.Authorization;
    const b = applySigner('tencentTC3', { ...input, body: '{"a":2}' }).headers.Authorization;
    expect(a).not.toBe(b);
  });
});
