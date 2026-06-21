import type { StorageProvider } from '@actionow/contracts';
import { describe, expect, it, vi } from 'vitest';

import { persistMediaOutput } from '../src/media-persistence.js';

const PUBLIC_BASE = 'https://asset.actionow.ai';

function fakeStorage(): StorageProvider & { puts: { key: string; contentType?: string }[] } {
  const puts: { key: string; contentType?: string }[] = [];
  return {
    kind: 'r2',
    puts,
    presignPut: (key, opts) => {
      puts.push(opts?.contentType !== undefined ? { key, contentType: opts.contentType } : { key });
      return Promise.resolve({ url: `https://r2.local/put/${key}`, key, expiresIn: 900 });
    },
    presignGet: (key) => Promise.resolve({ url: `https://r2.local/get/${key}`, expiresIn: 3600 }),
    head: () => Promise.resolve({ exists: true, size: 3, contentType: 'image/png', etag: 'e' }),
    delete: () => Promise.resolve(),
  };
}

describe('persistMediaOutput', () => {
  it('copies an image_url into R2 and rewrites it to the public URL', async () => {
    const storage = fakeStorage();
    // putBytes uploads bytes to a presigned URL; here it just succeeds.
    const putBytes = vi.fn().mockResolvedValue(undefined);
    const fetchBytes = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
    });

    const r = await persistMediaOutput({
      storage,
      publicBaseUrl: PUBLIC_BASE,
      fetchBytes,
      putBytes,
      tenantId: 'tenant-1',
      jobId: 'job-1',
      output: {
        image_url: 'https://cdn.example.com/a.png',
        image_urls: ['https://cdn.example.com/a.png'],
      },
    });

    expect(r.persisted).toBe(true);
    expect(r.output.image_url).toBe('https://asset.actionow.ai/tenant-1/job-1.png');
    expect(r.output.image_urls).toEqual(['https://asset.actionow.ai/tenant-1/job-1.png']);
    expect(r.objects).toHaveLength(1);
    expect(r.objects[0]).toMatchObject({ key: 'tenant-1/job-1.png', contentType: 'image/png' });
    expect(putBytes).toHaveBeenCalledTimes(1);
  });

  it('persists EACH distinct image in a batch to its own object, rewriting element-wise', async () => {
    const storage = fakeStorage();
    const putBytes = vi.fn().mockResolvedValue(undefined);
    const fetchBytes = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([1]),
      contentType: 'image/jpeg',
    });

    const r = await persistMediaOutput({
      storage,
      publicBaseUrl: PUBLIC_BASE,
      fetchBytes,
      putBytes,
      tenantId: 't',
      jobId: 'j',
      output: {
        image_url: 'https://cdn/a.jpg',
        image_urls: ['https://cdn/a.jpg', 'https://cdn/b.jpg', 'https://cdn/c.jpg'],
        image_count: 3,
      },
    });

    expect(r.persisted).toBe(true);
    expect(r.objects).toHaveLength(3);
    expect(r.objects.map((o) => o.key)).toEqual(['t/j-0.jpg', 't/j-1.jpg', 't/j-2.jpg']);
    expect(r.output.image_urls).toEqual([
      'https://asset.actionow.ai/t/j-0.jpg',
      'https://asset.actionow.ai/t/j-1.jpg',
      'https://asset.actionow.ai/t/j-2.jpg',
    ]);
    // The single `image_url` key maps to the FIRST persisted image (not all → one).
    expect(r.output.image_url).toBe('https://asset.actionow.ai/t/j-0.jpg');
    expect(fetchBytes).toHaveBeenCalledTimes(3);
    expect(putBytes).toHaveBeenCalledTimes(3);
  });

  it('derives the extension from a video_url and rewrites it', async () => {
    const storage = fakeStorage();
    const r = await persistMediaOutput({
      storage,
      publicBaseUrl: PUBLIC_BASE,
      fetchBytes: () => Promise.resolve({ bytes: new Uint8Array([0]), contentType: 'video/mp4' }),
      putBytes: () => Promise.resolve(),
      tenantId: 't',
      jobId: 'j',
      output: { video_url: 'https://cdn.example.com/v.mp4?token=abc' },
    });
    expect(r.output.video_url).toBe('https://asset.actionow.ai/t/j.mp4');
  });

  it('persists an audio_url, deriving the extension from the audio content-type', async () => {
    const storage = fakeStorage();
    const r = await persistMediaOutput({
      storage,
      publicBaseUrl: PUBLIC_BASE,
      // No extension in the URL path → the extension must come from the content-type.
      fetchBytes: () => Promise.resolve({ bytes: new Uint8Array([0]), contentType: 'audio/mpeg' }),
      putBytes: () => Promise.resolve(),
      tenantId: 't',
      jobId: 'j',
      output: { audio_url: 'https://cdn.example.com/generate?id=abc' },
    });
    expect(r.persisted).toBe(true);
    expect(r.output.audio_url).toBe('https://asset.actionow.ai/t/j.mp3');
    expect(r.objects[0]).toMatchObject({ key: 't/j.mp3', contentType: 'audio/mpeg' });
  });

  it('is a best-effort no-op when fetching the bytes fails (job still settles)', async () => {
    const storage = fakeStorage();
    const r = await persistMediaOutput({
      storage,
      publicBaseUrl: PUBLIC_BASE,
      fetchBytes: () => Promise.reject(new Error('cdn 404')),
      putBytes: () => Promise.resolve(),
      tenantId: 't',
      jobId: 'j',
      output: { image_url: 'https://cdn.example.com/a.png' },
    });
    expect(r.persisted).toBe(false);
    expect(r.output.image_url).toBe('https://cdn.example.com/a.png');
    expect(r.objects).toEqual([]);
  });

  it('passes through an output with no media URLs unchanged', async () => {
    const storage = fakeStorage();
    const r = await persistMediaOutput({
      storage,
      publicBaseUrl: PUBLIC_BASE,
      fetchBytes: () => Promise.reject(new Error('should not be called')),
      putBytes: () => Promise.resolve(),
      tenantId: 't',
      jobId: 'j',
      output: { text: 'hello' },
    });
    expect(r.persisted).toBe(false);
    expect(r.output).toEqual({ text: 'hello' });
    expect(r.objects).toEqual([]);
  });
});
