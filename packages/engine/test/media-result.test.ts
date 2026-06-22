import type { MediaResult } from '@actionow/contracts';
import { describe, expect, it, vi } from 'vitest';

import { meterMedia, persistMediaResult } from '../src/media-result.js';

function baseInput() {
  return {
    storage: {
      kind: 'r2' as const,
      presignPut: vi.fn((key: string) =>
        Promise.resolve({ url: `https://put/${key}`, key, expiresIn: 60 }),
      ),
      presignGet: vi.fn(),
      head: vi.fn(),
      delete: vi.fn(),
    },
    publicBaseUrl: 'https://cdn.x',
    tenantId: 't1',
    jobId: 'j1',
    fetchBytes: vi.fn(() =>
      Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' }),
    ),
    putBytes: vi.fn(() => Promise.resolve(undefined)),
  };
}
function mr(assets: MediaResult['assets']): MediaResult {
  return { kind: 'media', assets, usage: { images: assets.length } };
}

describe('persistMediaResult', () => {
  it('persists a single url asset and rewrites it', async () => {
    const input = baseInput();
    const out = await persistMediaResult({
      ...input,
      result: mr([
        { role: 'primary', modality: 'image', url: 'https://up/a.png', mime: 'image/png' },
      ]),
    });
    expect(out.persisted).toBe(true);
    expect(out.result.assets[0]?.url).toBe('https://cdn.x/t1/j1.png');
    expect(out.objects).toHaveLength(1);
    expect(out.objects[0]?.size).toBe(3);
    expect(input.putBytes).toHaveBeenCalledOnce();
  });

  it('decodes and uploads a b64 asset, dropping inline bytes', async () => {
    const input = baseInput();
    const out = await persistMediaResult({
      ...input,
      result: mr([
        {
          role: 'primary',
          modality: 'image',
          b64: Buffer.from([9, 9]).toString('base64'),
          mime: 'image/png',
        },
      ]),
    });
    expect(out.result.assets[0]?.url).toBe('https://cdn.x/t1/j1.png');
    expect(out.result.assets[0]?.b64).toBeUndefined();
    expect(input.fetchBytes).not.toHaveBeenCalled();
  });

  it('persists a batch under -{i} keys and carries duration metadata', async () => {
    const input = baseInput();
    const out = await persistMediaResult({
      ...input,
      result: mr([
        {
          role: 'primary',
          modality: 'video',
          url: 'https://up/1.mp4',
          mime: 'video/mp4',
          duration: 6,
        },
        {
          role: 'primary',
          modality: 'video',
          url: 'https://up/2.mp4',
          mime: 'video/mp4',
          duration: 7,
        },
      ]),
    });
    expect(out.result.assets.map((a) => a.url)).toEqual([
      'https://cdn.x/t1/j1-0.mp4',
      'https://cdn.x/t1/j1-1.mp4',
    ]);
    expect(out.objects[0]?.duration).toBe(6);
    expect(out.objects[1]?.duration).toBe(7);
  });

  it('is best-effort: a fetch error leaves the result untouched', async () => {
    const input = baseInput();
    input.fetchBytes = vi.fn(() => Promise.reject(new Error('network')));
    const result = mr([
      { role: 'primary', modality: 'image', url: 'https://up/a.png', mime: 'image/png' },
    ]);
    const out = await persistMediaResult({ ...input, result });
    expect(out.persisted).toBe(false);
    expect(out.result).toBe(result);
    expect(out.objects).toEqual([]);
  });
});

describe('meterMedia', () => {
  it('computes provider_cost = Σ usage[dim] × costPerUnit[dim] in µUSD bigint', () => {
    expect(meterMedia({ images: 2 }, { images: 1500 })).toBe(3000n);
  });
  it('sums multiple dimensions and ignores unknown dims', () => {
    expect(meterMedia({ duration_seconds: 6, foo: 9 }, { duration_seconds: 100 })).toBe(600n);
  });
  it('returns undefined when no costPerUnit configured', () => {
    expect(meterMedia({ images: 2 }, undefined)).toBeUndefined();
  });
});
