// Shared signer aspect (§6 签名器为全通道共享切面): deterministic under an
// injected nowMs, canonicalization behavior, and OUR OWN snapshot vectors —
// the regression baseline the batch-2 conformance gate reuses for the
// credential-injection byte comparison (no official public vectors for these
// providers; recorded from this implementation, reviewed against the legacy
// engine algorithm semantics).
import { describe, expect, it } from 'vitest';

import type { SignerInput, WireRequestDraft } from '../src/index.js';
import { signerCredentialInjection, SIGNERS } from '../src/index.js';

const NOW_MS = 1_752_000_000_000; // 2025-07-08T18:40:00.000Z

function volcInput(overrides: Partial<SignerInput> = {}): SignerInput {
  return {
    method: 'POST',
    url: 'https://visual.volcengineapi.com/?Action=CVSync2AsyncSubmitTask&Version=2022-08-31',
    headers: {},
    body: '{"req_key":"jimeng_t2i_v30","prompt":"a cat"}',
    credentials: {
      access_key: 'AKLT-test-ak',
      secret_key: 'test-sk',
      region: 'cn-north-1',
      service: 'cv',
    },
    nowMs: NOW_MS,
    ...overrides,
  };
}

function tencentInput(): SignerInput {
  return {
    method: 'POST',
    url: 'https://hunyuan.tencentcloudapi.com/',
    headers: { 'content-type': 'application/json' },
    body: '{"Model":"hunyuan-turbo"}',
    credentials: { access_key: 'AKID-test', secret_key: 'tc3-test-sk', service: 'hunyuan' },
    nowMs: NOW_MS,
  };
}

function klingInput(): SignerInput {
  return {
    method: 'POST',
    url: 'https://api.klingai.com/v1/videos/text2video',
    headers: {},
    body: '{"model_name":"kling-v1"}',
    credentials: { access_key: 'kling-ak', secret_key: 'kling-sk' },
    nowMs: NOW_MS,
  };
}

describe('determinism (nowMs injection)', () => {
  it.each(['volc-v4', 'tencent-tc3', 'kling-jwt'] as const)(
    '%s: same input → identical output',
    (strategy) => {
      const input =
        strategy === 'volc-v4'
          ? volcInput()
          : strategy === 'tencent-tc3'
            ? tencentInput()
            : klingInput();
      expect(SIGNERS[strategy](input)).toEqual(SIGNERS[strategy]({ ...input }));
    },
  );
});

describe('volc-v4 canonicalization', () => {
  it('is insensitive to query-param ORDER (canonical request sorts the query)', () => {
    const a = SIGNERS['volc-v4'](
      volcInput({ url: 'https://visual.volcengineapi.com/?Version=2022-08-31&Action=Submit' }),
    );
    const b = SIGNERS['volc-v4'](
      volcInput({ url: 'https://visual.volcengineapi.com/?Action=Submit&Version=2022-08-31' }),
    );
    expect(a.headers.Authorization).toBe(b.headers.Authorization);
  });

  it('is sensitive to query VALUES and to the body (signature binds both)', () => {
    const base = SIGNERS['volc-v4'](volcInput());
    const differentQuery = SIGNERS['volc-v4'](
      volcInput({ url: 'https://visual.volcengineapi.com/?Action=Other&Version=2022-08-31' }),
    );
    const differentBody = SIGNERS['volc-v4'](volcInput({ body: '{"prompt":"a dog"}' }));
    expect(differentQuery.headers.Authorization).not.toBe(base.headers.Authorization);
    expect(differentBody.headers.Authorization).not.toBe(base.headers.Authorization);
    expect(differentBody.headers['X-Content-Sha256']).not.toBe(base.headers['X-Content-Sha256']);
  });
});

describe('snapshot vectors (regression baseline for the conformance gate)', () => {
  it('volc-v4', () => {
    const out = SIGNERS['volc-v4'](volcInput());
    expect(out.url).toBe(volcInput().url); // header-based: URL untouched
    expect(out.headers['X-Date']).toMatchInlineSnapshot(`"20250708T184000Z"`);
    expect(out.headers['X-Content-Sha256']).toMatchInlineSnapshot(
      `"bfab69fb5361a5af769744a0592c3e1bee34e2aa5d7fdfc85bb486582d30c9c0"`,
    );
    expect(out.headers.Authorization).toMatchInlineSnapshot(
      `"HMAC-SHA256 Credential=AKLT-test-ak/20250708/cn-north-1/cv/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=7026de3cdd79c054a45f8f33d560faef7153b6c773931ca3064d50f480096a5d"`,
    );
  });

  it('tencent-tc3', () => {
    const out = SIGNERS['tencent-tc3'](tencentInput());
    expect(out.headers['X-TC-Timestamp']).toMatchInlineSnapshot(`"1752000000"`);
    expect(out.headers.Authorization).toMatchInlineSnapshot(
      `"TC3-HMAC-SHA256 Credential=AKID-test/2025-07-08/hunyuan/tc3_request, SignedHeaders=content-type;host, Signature=374be4ed370bae3ee6748489f9ebd05d6928a6db7257f84998bf36e6776243fc"`,
    );
  });

  it('kling-jwt', () => {
    const out = SIGNERS['kling-jwt'](klingInput());
    expect(out.headers.Authorization).toMatchInlineSnapshot(
      `"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJrbGluZy1hayIsImV4cCI6MTc1MjAwMTgwMCwibmJmIjoxNzUxOTk5OTk1fQ.q3afXcvvZ1QlTq_hQUU3ALiExfJPVUXI0uZj92un8dY"`,
    );
  });
});

describe('signerCredentialInjection (aspect ③ wrapper)', () => {
  const draft: WireRequestDraft = {
    method: 'POST',
    path: 'https://visual.volcengineapi.com/',
    query: { Action: 'CVSync2AsyncSubmitTask', Version: '2022-08-31' },
    headers: {},
    bodyKind: 'json',
    body: { req_key: 'jimeng_t2i_v30', prompt: 'a cat' },
  };

  it('maps the ak_sk secret + ctx.config knobs into a signed draft (deterministic)', () => {
    const aspect = signerCredentialInjection('volc-v4');
    const signed = aspect.injectCredential(
      draft,
      { scheme: 'ak_sk', access_key: 'AKLT-test-ak', secret_key: 'test-sk', region: 'cn-north-1' },
      { nowMs: NOW_MS, config: { service: 'cv' } },
    );
    expect(signed.headers?.Authorization).toContain('HMAC-SHA256 Credential=AKLT-test-ak/');
    expect(signed.headers?.Authorization).toContain('/cn-north-1/cv/request');
    // Deterministic: signing the same draft again yields the same bytes.
    const again = aspect.injectCredential(
      draft,
      { scheme: 'ak_sk', access_key: 'AKLT-test-ak', secret_key: 'test-sk', region: 'cn-north-1' },
      { nowMs: NOW_MS, config: { service: 'cv' } },
    );
    expect(again).toEqual(signed);
    // The wrapper preserves path/query (none of the registered signers rewrite URLs).
    expect(signed.path).toBe('https://visual.volcengineapi.com/');
    expect(signed.query).toEqual(draft.query);
    expect(signed.body).toEqual(draft.body);
  });

  it('signs the EXACT json serialization the transport will send (body binds)', () => {
    const aspect = signerCredentialInjection('volc-v4');
    const secret = { scheme: 'ak_sk', access_key: 'ak', secret_key: 'sk' } as const;
    const ctx = { nowMs: NOW_MS, config: { service: 'cv' } };
    const a = aspect.injectCredential(draft, secret, ctx);
    const b = aspect.injectCredential(
      { ...draft, body: { req_key: 'jimeng_t2i_v30', prompt: 'a DOG' } },
      secret,
      ctx,
    );
    expect(a.headers?.Authorization).not.toBe(b.headers?.Authorization);
  });

  it('rejects non-ak_sk secrets loudly', () => {
    const aspect = signerCredentialInjection('kling-jwt');
    expect(() =>
      aspect.injectCredential(draft, { scheme: 'bearer', api_key: 'sk-x' }, { nowMs: NOW_MS }),
    ).toThrow(/requires an ak_sk credential secret/);
  });

  it('kling-jwt via the wrapper mints the deterministic bearer JWT', () => {
    const aspect = signerCredentialInjection('kling-jwt');
    const signed = aspect.injectCredential(
      { ...draft, path: 'https://api.klingai.com/v1/videos/text2video', query: {} },
      { scheme: 'ak_sk', access_key: 'kling-ak', secret_key: 'kling-sk' },
      { nowMs: NOW_MS },
    );
    const direct = SIGNERS['kling-jwt'](klingInput());
    expect(signed.headers?.Authorization).toBe(direct.headers.Authorization);
  });
});
