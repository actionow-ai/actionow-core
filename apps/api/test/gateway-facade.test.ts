// 批次4 slice3 — facade §4.1 layer-1 canonical 归一 unit tests: explicit vs
// default isDefault marking, canonical type/domain validation, media-ref
// extraction, envelope/options mapping and the §5 body fingerprint.
import type { ModelOperation } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { fingerprintBody, toGatewayRequest } from '../src/gateway/facade.js';

const CONTRACT: ModelOperation = {
  operation: 'video.generation',
  paradigms: ['task'],
  slow: false,
  params: [
    { name: 'prompt', type: 'string', billingRelevant: false, required: true },
    {
      name: 'resolution',
      type: 'enum',
      billingRelevant: true,
      required: false,
      default: '720p',
      values: ['720p', '1080p'],
    },
    {
      name: 'duration',
      type: 'int',
      billingRelevant: true,
      required: false,
      min: 1,
      max: 10,
    },
    {
      name: 'reference_image',
      type: 'media',
      billingRelevant: false,
      required: false,
      mediaKinds: ['image'],
    },
  ],
};

const AUTH = { tenantId: 'tenant-1', apiKeyId: 'key-1' };

function parse(body: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return toGatewayRequest({
    operation: 'video.generation',
    modelName: 'seedance-pro',
    contract: CONTRACT,
    body: { model: 'seedance-pro', ...body },
    auth: AUTH,
    ...extra,
  });
}

describe('gateway facade — §4.1 layer-1 canonical 归一', () => {
  it('marks explicit params isDefault:false and omitted-with-default isDefault:true', () => {
    const result = parse({ prompt: 'a cat', duration: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.params.prompt).toEqual({ value: 'a cat', isDefault: false });
    // resolution omitted → canonical default rides along, tagged default (§4.1).
    expect(result.request.params.resolution).toEqual({ value: '720p', isDefault: true });
    expect(result.request.params.duration).toEqual({ value: 5, isDefault: false });
    // no default + not required + omitted → NOT in params at all.
    expect(result.request.params.reference_image).toBeUndefined();
  });

  it('rejects a missing required param (invalid_input)', () => {
    const result = parse({ resolution: '1080p' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_input');
    expect(result.error.message).toContain("'prompt'");
  });

  it('rejects unknown params, naming them in details', () => {
    const result = parse({ prompt: 'x', style: 'anime', wat: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_input');
    expect(result.error.details?.unknownParams).toEqual(['style', 'wat']);
  });

  it('rejects a canonical enum-domain violation', () => {
    const result = parse({ prompt: 'x', resolution: '4k' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_input');
    expect(result.error.details?.param).toBe('resolution');
  });

  it('rejects numeric range violations and non-integer ints', () => {
    expect(parse({ prompt: 'x', duration: 11 }).ok).toBe(false);
    expect(parse({ prompt: 'x', duration: 2.5 }).ok).toBe(false);
    expect(parse({ prompt: 'x', duration: 'long' }).ok).toBe(false);
  });

  it('extracts media params into mediaRefs (url / file_id / base64 detection)', () => {
    const result = parse({ prompt: 'x', reference_image: 'https://cdn.example.com/ref.png' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.mediaRefs).toEqual([
      { param: 'reference_image', source: 'url', data: 'https://cdn.example.com/ref.png' },
    ]);
    // the param value ALSO rides params as an explicit canonical param.
    expect(result.request.params.reference_image).toEqual({
      value: 'https://cdn.example.com/ref.png',
      isDefault: false,
    });

    const fileRef = parse({ prompt: 'x', reference_image: 'file_abc123' });
    if (fileRef.ok) expect(fileRef.request.mediaRefs[0]?.source).toBe('file_id');
    const b64 = parse({ prompt: 'x', reference_image: 'aGVsbG8=' });
    if (b64.ok) expect(b64.request.mediaRefs[0]?.source).toBe('base64');
  });

  it('maps envelope keys to options (never params) and threads the route tag', () => {
    const result = parse(
      {
        prompt: 'x',
        stream: true,
        callback_url: 'https://hooks.example.com/cb',
        artifact_mode: 'public',
        require_persist: true,
      },
      { routeTag: 'canary' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.options).toEqual({
      stream: true,
      callbackUrl: 'https://hooks.example.com/cb',
      artifactMode: 'public',
      requirePersist: true,
      routeTag: 'canary',
    });
    expect(result.request.params.stream).toBeUndefined();
    expect(result.request.params.model).toBeUndefined();
  });

  it('carries idempotency {key, bodyFingerprint} only when a key was presented', () => {
    const body = { prompt: 'x' };
    const withKey = parse(body, { idempotencyKey: 'idem-1' });
    expect(withKey.ok).toBe(true);
    if (!withKey.ok) return;
    expect(withKey.request.idempotency?.key).toBe('idem-1');
    expect(withKey.request.idempotency?.bodyFingerprint).toBe(
      fingerprintBody({ model: 'seedance-pro', prompt: 'x' }),
    );
    const withoutKey = parse(body);
    if (withoutKey.ok) expect(withoutKey.request.idempotency).toBeUndefined();
  });
});

describe('fingerprintBody — §5 规范化请求体指纹', () => {
  it('is key-order insensitive (canonicalized JSON)', () => {
    expect(fingerprintBody({ a: 1, b: { c: 2, d: [3, 4] } })).toBe(
      fingerprintBody({ b: { d: [3, 4], c: 2 }, a: 1 }),
    );
  });

  it('differs for different bodies (the 409 discriminator)', () => {
    expect(fingerprintBody({ prompt: 'a' })).not.toBe(fingerprintBody({ prompt: 'b' }));
  });
});
