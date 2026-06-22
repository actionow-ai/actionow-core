import { describe, expect, it } from 'vitest';

import { inferModality, toMediaResult } from './async-media.js';

describe('toMediaResult', () => {
  it('maps a batch of image_urls to image assets + images usage', () => {
    const r = toMediaResult(
      { image_urls: ['https://a/1.png', 'https://a/2.png'], image_count: 2 },
      'image',
    );
    expect(r.kind).toBe('media');
    expect(r.assets.map((a) => a.url)).toEqual(['https://a/1.png', 'https://a/2.png']);
    expect(r.assets[0]?.modality).toBe('image');
    expect(r.assets[0]?.mime).toBe('image/png');
    expect(r.usage).toEqual({ images: 2 });
  });

  it('maps a video_url + duration to a video asset + duration_seconds usage', () => {
    const r = toMediaResult({ video_url: 'https://a/v.mp4', duration: 6 }, 'video');
    expect(r.assets[0]).toMatchObject({ modality: 'video', url: 'https://a/v.mp4', duration: 6 });
    expect(r.assets[0]?.mime).toBe('video/mp4');
    expect(r.usage).toEqual({ duration_seconds: 6 });
  });

  it('maps audio character_count to characters usage', () => {
    const r = toMediaResult({ audio_url: 'https://a/a.mp3', character_count: 42 }, 'audio');
    expect(r.assets[0]?.modality).toBe('audio');
    expect(r.assets[0]?.mime).toBe('audio/mpeg');
    expect(r.usage).toEqual({ characters: 42 });
  });

  it('falls back to images:1 / tasks:1 when no dimension present', () => {
    expect(toMediaResult({ image_url: 'https://a/x.png' }, 'image').usage).toEqual({ images: 1 });
    expect(toMediaResult({}, 'image').usage).toEqual({ tasks: 1 });
  });
});

describe('inferModality', () => {
  it('infers from the present url key', () => {
    expect(inferModality({ video_url: 'x' })).toBe('video');
    expect(inferModality({ audio_url: 'x' })).toBe('audio');
    expect(inferModality({ image_url: 'x' })).toBe('image');
    expect(inferModality(undefined)).toBe('image');
  });
});
