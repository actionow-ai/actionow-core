import type { SubmitResult, UnifiedError, UsageVector } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { AdapterRegistry } from '../src/registry.js';
import type { ProviderAdapter } from '../src/types.js';

const stubAdapter = (providerType: string): ProviderAdapter => ({
  providerType,
  submit: (): Promise<SubmitResult> => Promise.resolve({ kind: 'sync', output: {}, usage: {} }),
  extractUsage: (): UsageVector => ({}),
  mapError: (): UnifiedError => ({
    code: 'internal_error',
    message: 'x',
    retryable: false,
  }),
});

describe('AdapterRegistry', () => {
  it('registers and retrieves an adapter by provider_type', () => {
    const reg = new AdapterRegistry();
    const a = stubAdapter('openai');
    reg.register(a);
    expect(reg.get('openai')).toBe(a);
  });

  it('reports presence via has()', () => {
    const reg = new AdapterRegistry();
    expect(reg.has('openai')).toBe(false);
    reg.register(stubAdapter('openai'));
    expect(reg.has('openai')).toBe(true);
  });

  it('throws a descriptive error for an unknown provider_type', () => {
    const reg = new AdapterRegistry();
    expect(() => reg.get('nope')).toThrow('no adapter for provider_type "nope"');
  });

  it('overwrites a prior registration for the same provider_type', () => {
    const reg = new AdapterRegistry();
    const first = stubAdapter('openai');
    const second = stubAdapter('openai');
    reg.register(first);
    reg.register(second);
    expect(reg.get('openai')).toBe(second);
  });

  it('keeps distinct adapters separate', () => {
    const reg = new AdapterRegistry();
    const openai = stubAdapter('openai');
    const anthropic = stubAdapter('anthropic');
    reg.register(openai);
    reg.register(anthropic);
    expect(reg.get('openai')).toBe(openai);
    expect(reg.get('anthropic')).toBe(anthropic);
  });

  it('accepts a fully-typed ProviderAdapter with optional poll/parseCallback', () => {
    const reg = new AdapterRegistry();
    const adapter: ProviderAdapter = {
      ...stubAdapter('async-media-mock'),
      poll: () => Promise.resolve({ status: 'running' as const }),
      parseCallback: () => ({ upstreamJobId: 'j', status: 'succeeded' as const }),
    };
    reg.register(adapter);
    const got = reg.get('async-media-mock');
    expect(typeof got.poll).toBe('function');
    expect(typeof got.parseCallback).toBe('function');
  });
});
