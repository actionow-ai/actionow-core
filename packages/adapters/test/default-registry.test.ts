import { describe, expect, it } from 'vitest';

import { createDefaultRegistry } from '../src/default-registry.js';

const ALL_PROVIDER_TYPES = [
  'openai',
  'anthropic',
  'gemini',
  'async-media',
  'async-media-mock',
  'dify-workflow',
  'mock-stream',
  'mock-chat',
] as const;

describe('createDefaultRegistry', () => {
  it('resolves all eight built-in provider_types', () => {
    const registry = createDefaultRegistry();
    for (const providerType of ALL_PROVIDER_TYPES) {
      expect(registry.has(providerType)).toBe(true);
      expect(registry.get(providerType).providerType).toBe(providerType);
    }
  });

  it('throws for an unregistered provider_type', () => {
    const registry = createDefaultRegistry();
    expect(() => registry.get('does-not-exist')).toThrow();
  });

  it('passes asyncMedia.readyAfterPolls through to the async-media-mock adapter', async () => {
    const registry = createDefaultRegistry({ asyncMedia: { readyAfterPolls: 0 } });
    const adapter = registry.get('async-media-mock');
    expect(typeof adapter.poll).toBe('function');

    const handle = await adapter.submit({
      resourceId: 'media:mock/video',
      modality: 'video',
      inputs: {},
      execMode: 'async-poll',
      ctx: {
        providerType: 'async-media-mock',
        http: { request: () => Promise.reject(new Error('no network in test')) },
      },
    });
    expect(handle.kind).toBe('async');
    if (handle.kind !== 'async') {
      throw new Error('expected an async handle');
    }

    // readyAfterPolls=0 → succeeds on the first poll.
    const poll = adapter.poll?.(handle.upstreamJobId, {
      providerType: 'async-media-mock',
      http: { request: () => Promise.reject(new Error('no network in test')) },
    });
    expect(poll).toBeDefined();
    await expect(poll).resolves.toMatchObject({ status: 'succeeded' });
  });

  it('returns independent registries per call', () => {
    const a = createDefaultRegistry();
    const b = createDefaultRegistry();
    expect(a).not.toBe(b);
    expect(a.get('openai')).not.toBe(b.get('async-media-mock'));
  });
});
