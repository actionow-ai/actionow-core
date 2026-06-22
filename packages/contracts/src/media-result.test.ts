import { describe, expect, it } from 'vitest';

import { assetSchema, mediaResultSchema, pluginResultSchema } from './media-result.js';

describe('media-result contract', () => {
  it('accepts a url image asset', () => {
    const r = mediaResultSchema.parse({
      kind: 'media',
      assets: [{ role: 'primary', modality: 'image', url: 'https://x/y.png', mime: 'image/png' }],
      usage: { images: 1 },
    });
    expect(r.assets[0]?.modality).toBe('image');
    expect(r.assets[0]?.role).toBe('primary'); // role defaults to 'primary'
  });

  it('accepts an inline b64 asset with media metadata', () => {
    const a = assetSchema.parse({
      modality: 'video',
      b64: 'AAAA',
      mime: 'video/mp4',
      duration: 5,
      width: 1280,
      height: 720,
      size: 1024,
      etag: 'abc',
    });
    expect(a.duration).toBe(5);
    expect(a.role).toBe('primary');
  });

  it('rejects an asset with neither url nor b64', () => {
    expect(() => assetSchema.parse({ modality: 'image', mime: 'image/png' })).toThrow();
  });

  it('discriminates the union on kind', () => {
    const s = pluginResultSchema.parse({
      kind: 'struct',
      data: { vec: [0.1] },
      usage: { tokens: 3 },
    });
    expect(s.kind).toBe('struct');
  });
});
